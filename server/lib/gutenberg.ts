// Project Gutenberg import: fetch a book's plain-text edition, strip the
// Gutenberg boilerplate, split it into chapters, and render each chapter as a
// Markdown document. The library route stores the chapters as documents in a
// new root-level `book` collection.
//
// The plain-text edition is used rather than the HTML one because it exists for
// every book and its structure is no worse: Chinese HTML editions are often a
// flat run of <p>s with no headings at all (e.g. #23962 西遊記), so chapters
// have to be recognized from heading lines either way.
import { fetchWebpage, decodeHtml, WebpageImportError, type FetchedWebpage } from './webpage'

export const GUTENBERG_ORIGIN = 'https://www.gutenberg.org'

/** Upper bound on chapters per import (each becomes a document + ingest workflow). */
export const MAX_GUTENBERG_CHAPTERS = 500

// ---------------------------------------------------------------------------
// Book IDs & fetching
// ---------------------------------------------------------------------------

/**
 * Extract the ebook number from a Gutenberg URL (`/ebooks/23962`,
 * `/ebooks/23962.txt.utf-8`, `/cache/epub/23962/pg23962.txt`,
 * `/files/23962/…`) or a bare number.
 */
export function parseGutenbergId(raw: string): number {
  const trimmed = raw.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed)
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`)
  } catch {
    throw new WebpageImportError('Invalid Project Gutenberg URL')
  }
  const host = url.hostname.toLowerCase()
  if (host !== 'gutenberg.org' && !host.endsWith('.gutenberg.org')) {
    throw new WebpageImportError('Not a Project Gutenberg URL (expected gutenberg.org/ebooks/<number>)')
  }
  const m = url.pathname.match(/^\/(?:ebooks|cache\/epub|files)\/(\d+)(?:[/.]|$)/)
  if (!m) {
    throw new WebpageImportError('Could not find an ebook number in the URL (expected /ebooks/<number>)')
  }
  return Number(m[1])
}

/** Candidate plain-text URLs for a book, most reliable first. */
export function gutenbergTextUrls(id: number): string[] {
  return [
    `${GUTENBERG_ORIGIN}/cache/epub/${id}/pg${id}.txt`,
    `${GUTENBERG_ORIGIN}/ebooks/${id}.txt.utf-8`,
  ]
}

export interface FetchedGutenbergText {
  url: string
  text: string
}

export async function fetchGutenbergText(
  id: number,
  fetchImpl: typeof fetch = fetch
): Promise<FetchedGutenbergText> {
  let lastError: unknown = null
  for (const candidate of gutenbergTextUrls(id)) {
    let page: FetchedWebpage
    try {
      page = await fetchWebpage(new URL(candidate), fetchImpl)
    } catch (err) {
      lastError = err
      continue
    }
    if (!page.mimetype.startsWith('text/plain')) {
      lastError = new WebpageImportError(`Unexpected content type ${page.mimetype} for ebook #${id}`, 502)
      continue
    }
    // Gutenberg text files are UTF-8 (usually with a BOM); decodeHtml honours a
    // declared charset and falls back to UTF-8.
    return { url: page.url, text: decodeHtml(new Uint8Array(page.data), page.charset) }
  }
  if (lastError instanceof WebpageImportError) {
    throw new WebpageImportError(
      `Could not fetch a plain-text edition of ebook #${id}: ${lastError.message}`,
      lastError.status
    )
  }
  throw lastError ?? new WebpageImportError(`Could not fetch ebook #${id}`, 502)
}

// ---------------------------------------------------------------------------
// Header / boilerplate
// ---------------------------------------------------------------------------

export interface GutenbergBook {
  title: string | null
  author: string | null
  language: string | null
  /** Text between the START and END markers, with \n line endings. */
  body: string
}

const START_MARKER = /^\s*\*{3}\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK.*$/im
const END_MARKER = /^\s*\*{3}\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK.*$/im

function headerField(header: string, name: string): string | null {
  // Fields can wrap onto indented continuation lines.
  const m = header.match(new RegExp(`^${name}:[ \\t]*(.*(?:\\n[ \\t]+\\S.*)*)`, 'm'))
  if (!m) return null
  const value = m[1].replace(/\s*\n\s*/g, ' ').trim()
  return value || null
}

export function parseGutenbergText(raw: string): GutenbergBook {
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const start = START_MARKER.exec(text)
  const end = END_MARKER.exec(text)
  const header = start ? text.slice(0, start.index) : ''
  const bodyStart = start ? start.index + start[0].length : 0
  const bodyEnd = end && end.index > bodyStart ? end.index : text.length

  const title =
    headerField(header, 'Title') ??
    header.match(/The Project Gutenberg e[Bb]ook of (.+)/)?.[1].replace(/,\s*by .*$/, '').trim() ??
    null

  return {
    title,
    author: headerField(header, 'Author'),
    language: headerField(header, 'Language'),
    body: text.slice(bodyStart, bodyEnd),
  }
}

// ---------------------------------------------------------------------------
// Chapter splitting
// ---------------------------------------------------------------------------

export interface BookChapter {
  title: string
  /** Chapter text as Markdown paragraphs (no heading). */
  markdown: string
}

// Unicode whitespace incl. the ideographic space (U+3000) used for indentation.
const WS = '\\s\\u3000'
const NUMERALS = '〇零一二三四五六七八九十百千廿卅兩两0-9０-９'
const SEPARATOR_LINE = /^[\s　]*([-=*_~─━·•.]\s*){3,}$/

// 第一回 / 第十二章 / 第三卷 … optionally followed by a title after a
// separator. The separator requirement rejects prose such as "第四回中既將…".
const CJK_ORDINAL_HEADING = new RegExp(
  `^第([${NUMERALS}]+)([回章卷則节節篇折集部])(?:$|[${WS}:：、.．·]+(.+)$)`
)
// 學而第一 / 為政第二 (classical chapter names).
const CJK_NAMED_HEADING = new RegExp(`^([\\u4e00-\\u9fff]{1,8})第([${NUMERALS}]+)$`)
// CHAPTER I. / Chapter 12: Title
const LATIN_HEADING =
  /^((?:CHAPTER|Chapter)\s+(?:[IVXLCDM]+|\d+|[A-Z][A-Za-z-]+))\.?(?:$|[\s.:—–-]+(.+)$)/

interface HeadingMatch {
  family: string
  label: string
  /** Title text after the ordinal, if any. */
  rest: string | null
}

const isBlank = (line: string) => line.replace(/[\s　]/g, '') === '' || SEPARATOR_LINE.test(line)
const trimAll = (s: string) => s.replace(/^[\s　]+|[\s　]+$/g, '')
const collapseWs = (s: string) => trimAll(s).replace(/[\s　]+/g, ' ')

export function matchHeading(line: string): HeadingMatch | null {
  const t = trimAll(line)
  // Headings are short and never end a sentence; brackets mark captions such
  // as "[Illustration: … Chapter I.]".
  if (!t || t.length > 60 || /[。！？]$|[[\]]/.test(t)) return null
  let m = t.match(CJK_ORDINAL_HEADING)
  if (m) {
    return { family: `第N${m[2]}`, label: `第${m[1]}${m[2]}`, rest: m[3] ? collapseWs(m[3]) : null }
  }
  m = t.match(CJK_NAMED_HEADING)
  if (m) return { family: '名第N', label: t, rest: null }
  m = t.match(LATIN_HEADING)
  if (m) {
    return { family: 'chapter', label: collapseWs(m[1]), rest: m[2] ? collapseWs(m[2]) : null }
  }
  return null
}

const CJK_CHAR = /[⺀-鿿豈-﫿︰-﹏＀-￯　-〿\u{20000}-\u{3134f}]/u

/**
 * Undo hard line wrapping. Paragraphs are separated by blank lines; within one,
 * a line that starts indented (verse, or an indented new paragraph) starts a
 * new line, and any other line continues the previous one — with no joining
 * space when either side is CJK. Each resulting line becomes a Markdown
 * paragraph.
 */
export function unwrapText(lines: string[]): string {
  const out: string[] = []
  let current: string | null = null
  const flush = () => {
    if (current !== null && trimAll(current)) out.push(trimAll(current))
    current = null
  }
  for (const line of lines) {
    if (isBlank(line)) {
      flush()
      continue
    }
    const indented = /^[\s　]/.test(line)
    const t = trimAll(line)
    if (current === null || indented) {
      flush()
      current = t
    } else {
      const prevChar = current.slice(-1)
      const joiner = CJK_CHAR.test(prevChar) || CJK_CHAR.test(t[0]) ? '' : ' '
      current += joiner + t
    }
  }
  flush()
  return out.map(escapeMarkdownLine).join('\n\n')
}

// Keep a line from being read as a heading/blockquote/list by the Markdown
// renderer (and from tripping the "single H1 = title" extraction).
function escapeMarkdownLine(line: string): string {
  return line.replace(/^([#>]|[-*+](?=\s))/, '\\$1')
}

const contentLength = (lines: string[]) => lines.join('').replace(/[\s　]/g, '').length

// A section shorter than this is a table-of-contents entry, not a chapter.
const MIN_CHAPTER_CHARS = 20
const MIN_FRONT_MATTER_CHARS = 40

// Producer credits and the stray language line some editions repeat after the
// START marker.
const BOILERPLATE_LINE = /^[\s　]*(Language:\s*\S+|Produced by\b.*|E-?text prepared by\b.*)$/i

export function splitChapters(body: string, fallbackTitle: string): BookChapter[] {
  const lines = body.replace(/\r\n?/g, '\n').split('\n')

  // A heading line must be set off by a blank (or separator) line, or the
  // start/end of the text, on at least one side — some editions run it
  // straight into the preceding (#24264) or following (#25328) text.
  const candidates: Array<HeadingMatch & { line: number }> = []
  for (let i = 0; i < lines.length; i++) {
    const blankBefore = i === 0 || isBlank(lines[i - 1])
    const blankAfter = i === lines.length - 1 || isBlank(lines[i + 1])
    if (!blankBefore && !blankAfter) continue
    const h = matchHeading(lines[i])
    if (h) candidates.push({ ...h, line: i })
  }

  // Use the most frequent heading family (e.g. 回 over 卷 in a book with both).
  const counts = new Map<string, number>()
  for (const c of candidates) counts.set(c.family, (counts.get(c.family) ?? 0) + 1)
  const [family, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0]
  const headings = count >= 2 ? candidates.filter((c) => c.family === family) : []

  const chapters: BookChapter[] = []
  const cleanFront = (ls: string[]) => ls.filter((l) => !BOILERPLATE_LINE.test(l))

  if (headings.length === 0) {
    const markdown = unwrapText(cleanFront(lines))
    return markdown ? [{ title: fallbackTitle, markdown }] : []
  }

  const front = cleanFront(lines.slice(0, headings[0].line))
  if (contentLength(front) >= MIN_FRONT_MATTER_CHARS) {
    chapters.push({ title: 'Front matter', markdown: unwrapText(front) })
  }

  for (let h = 0; h < headings.length; h++) {
    const heading = headings[h]
    const sectionLines = lines.slice(heading.line + 1, h + 1 < headings.length ? headings[h + 1].line : lines.length)
    if (contentLength(sectionLines) < MIN_CHAPTER_CHARS) continue

    let title = heading.rest ? `${heading.label} ${heading.rest}` : heading.label
    if (heading.rest) {
      // Some editions repeat the title at the start of the chapter's first
      // line, run into the text (#25328: "范少伯水葬西施俗語云：…").
      const first = sectionLines.findIndex((l) => !isBlank(l))
      if (first >= 0) {
        const line = trimAll(sectionLines[first])
        if (line.startsWith(heading.rest)) sectionLines[first] = line.slice(heading.rest.length)
      }
    } else {
      // A bare "第三回" with its title on the next line (e.g. #24264 紅樓夢).
      const first = sectionLines.findIndex((l) => !isBlank(l))
      const next = sectionLines[first + 1]
      const sub = first >= 0 ? trimAll(sectionLines[first]) : ''
      if (sub && sub.length <= 40 && (next === undefined || isBlank(next)) && !/[。．.！!？?」”]$|^\[/.test(sub)) {
        title = `${heading.label} ${collapseWs(sub)}`
        sectionLines.splice(first, 1)
      }
    }
    chapters.push({ title, markdown: unwrapText(sectionLines) })
  }
  return chapters
}

/** A chapter as a standalone Markdown document (its title as the single H1). */
export function chapterDocument(chapter: BookChapter): string {
  return `# ${chapter.title}\n\n${chapter.markdown}\n`
}

/** A filesystem-friendly filename, numbered so it sorts in reading order. */
export function chapterFilename(bookTitle: string, index: number, total: number, chapterTitle: string): string {
  const width = Math.max(2, String(total).length)
  const safe = (s: string) => s.replace(/[\\/:*?"<>|\n]+/g, ' ').replace(/\s+/g, ' ').trim()
  return `${safe(bookTitle).slice(0, 80)} - ${String(index + 1).padStart(width, '0')} ${safe(chapterTitle).slice(0, 80)}.md`
}
