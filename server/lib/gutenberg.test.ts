import { describe, it, expect, vi } from 'vitest'
import {
  chapterDocument,
  chapterFilename,
  fetchGutenbergText,
  matchHeading,
  parseGutenbergId,
  parseGutenbergText,
  splitChapters,
  unwrapText,
} from './gutenberg'
import { WebpageImportError } from './webpage'

const LONG = '話說天下大勢，分久必合，合久必分。周末七國分爭，并入於秦。'

function book(body: string, header = 'Title: 西遊記\n\nAuthor: Cheng\'en Wu\n\nLanguage: Chinese\n') {
  return (
    '\uFEFFThe Project Gutenberg eBook of 西遊記\r\n\r\n' +
    header.replace(/\n/g, '\r\n') +
    '\r\n*** START OF THE PROJECT GUTENBERG EBOOK 西遊記 ***\r\n' +
    body.replace(/\n/g, '\r\n') +
    '\r\n*** END OF THE PROJECT GUTENBERG EBOOK 西遊記 ***\r\n\r\nSection 1. General Terms of Use\r\n'
  )
}

describe('parseGutenbergId', () => {
  it.each([
    ['https://gutenberg.org/ebooks/23962', 23962],
    ['https://www.gutenberg.org/ebooks/23962.txt.utf-8', 23962],
    ['www.gutenberg.org/cache/epub/23962/pg23962.txt', 23962],
    ['http://www.gutenberg.org/files/23962/23962-0.txt', 23962],
    [' 23962 ', 23962],
  ])('parses %s', (raw, id) => {
    expect(parseGutenbergId(raw)).toBe(id)
  })

  it.each(['https://example.com/ebooks/23962', 'https://gutenberg.org/browse/scores/top', 'not a url'])(
    'rejects %s',
    (raw) => {
      expect(() => parseGutenbergId(raw)).toThrow(WebpageImportError)
    }
  )

  it('rejects look-alike hosts', () => {
    expect(() => parseGutenbergId('https://evilgutenberg.org/ebooks/1')).toThrow(WebpageImportError)
  })
})

describe('parseGutenbergText', () => {
  it('reads header metadata and strips the boilerplate', () => {
    const parsed = parseGutenbergText(book(`\n第一回\n\n${LONG}\n`))
    expect(parsed).toMatchObject({ title: '西遊記', author: "Cheng'en Wu", language: 'Chinese' })
    expect(parsed.body).toContain(LONG)
    expect(parsed.body).not.toContain('START OF')
    expect(parsed.body).not.toContain('General Terms')
    expect(parsed.body).not.toContain('\r')
  })

  it('joins wrapped header fields', () => {
    const parsed = parseGutenbergText(book('x', 'Title: A Very Long\n       Title Indeed\n\nAuthor: Someone\n'))
    expect(parsed.title).toBe('A Very Long Title Indeed')
  })

  it('falls back to the whole text without markers', () => {
    expect(parseGutenbergText('just text').body).toBe('just text')
  })
})

describe('matchHeading', () => {
  it.each([
    ['第一回     靈根育孕源流出　心性修持大道生', '第一回', '靈根育孕源流出 心性修持大道生'],
    ['第一〇〇回     徑回東土　五聖成真', '第一〇〇回', '徑回東土 五聖成真'],
    ['第一回：宴桃園豪傑三結義，斬黃巾英雄首立功', '第一回', '宴桃園豪傑三結義，斬黃巾英雄首立功'],
    ['第三回', '第三回', null],
    ['第十二章 歸來', '第十二章', '歸來'],
    ['學而第一', '學而第一', null],
    ['CHAPTER II.', 'CHAPTER II', null],
    ['Chapter 3: The Ball', 'Chapter 3', 'The Ball'],
  ])('matches %s', (line, label, rest) => {
    expect(matchHeading(line)).toMatchObject({ label, rest })
  })

  it.each([
    '第四回中既將薛家母子在榮府內寄居等事略已表明', // prose, no separator after the ordinal
    '　　第一鎮，後將軍南陽太守袁術。', // not a heading suffix
    'Chapter I.]', // illustration caption
    '第一回 話說天下大勢分久必合。', // ends a sentence
  ])('rejects %s', (line) => {
    expect(matchHeading(line)).toBeNull()
  })
})

describe('unwrapText', () => {
  it('joins hard-wrapped CJK lines without spaces', () => {
    expect(unwrapText(['蓋聞天地之數，有十二萬', '、卯、辰'])).toBe('蓋聞天地之數，有十二萬、卯、辰')
  })

  it('joins Latin lines with a space', () => {
    expect(unwrapText(['It is a truth', 'universally acknowledged'])).toBe('It is a truth universally acknowledged')
  })

  it('keeps indented lines (verse, new paragraphs) separate and strips the indent', () => {
    expect(unwrapText(['　　詩曰：', '　　　　混沌未分天地亂，', '　　　　自從盤古破鴻濛，'])).toBe(
      '詩曰：\n\n混沌未分天地亂，\n\n自從盤古破鴻濛，'
    )
  })

  it('treats separator lines as paragraph breaks and escapes Markdown markers', () => {
    expect(unwrapText(['# not a heading', '-----', '> quote', '', '- item'])).toBe(
      '\\# not a heading\n\n\\> quote\n\n\\- item'
    )
  })
})

describe('splitChapters', () => {
  it('splits on 第N回 headings and keeps the most common heading family', () => {
    const body = `\nLanguage: Chinese\n\n\n第一回     甲　乙\n\n${LONG}\n卷二\n${LONG}\n\n第二回     丙　丁\n\n${LONG}\n`
    const chapters = splitChapters(body, '西遊記')
    expect(chapters.map((c) => c.title)).toEqual(['第一回 甲 乙', '第二回 丙 丁'])
    expect(chapters[0].markdown).toContain('卷二')
  })

  it('drops table-of-contents entries (headings with no text)', () => {
    const body = `第一回 甲\n第二回 乙\n\n第一回 甲\n\n${LONG}\n\n第二回 乙\n\n${LONG}\n`
    const chapters = splitChapters(body, 'x')
    expect(chapters.map((c) => c.title)).toEqual(['第一回 甲', '第二回 乙'])
    expect(chapters.every((c) => c.markdown.includes('話說'))).toBe(true)
  })

  it('takes the title from the next line under a bare heading', () => {
    const body = `${LONG}${LONG}\n第三回\n\n-----------\n\n　　　　 托內兄如海酬訓教　接外孫賈母惜孤女\n\n${LONG}\n\n第四回\n\n------\n薄命女偏逢薄命郎\n\n${LONG}\n`
    const chapters = splitChapters(body, 'x')
    expect(chapters.map((c) => c.title)).toEqual([
      'Front matter',
      '第三回 托內兄如海酬訓教 接外孫賈母惜孤女',
      '第四回 薄命女偏逢薄命郎',
    ])
    expect(chapters[1].markdown).not.toContain('托內兄')
  })

  it('accepts headings run into the text on one side', () => {
    const body = `第一則     介之推火封妒婦\n${LONG}\n${LONG}\n\n第二則      范少伯水葬西施\n范少伯水葬西施俗語云：${LONG}\n`
    const chapters = splitChapters(body, 'x')
    expect(chapters.map((c) => c.title)).toEqual(['第一則 介之推火封妒婦', '第二則 范少伯水葬西施'])
    // A title repeated at the start of the first line is removed.
    expect(chapters[1].markdown.startsWith('俗語云')).toBe(true)
  })

  it('returns the whole book as one document when there are no chapters', () => {
    const chapters = splitChapters(`\nProduced by Someone\n\n${LONG}\n`, '豆棚閒話')
    expect(chapters).toEqual([{ title: '豆棚閒話', markdown: LONG }])
  })

  it('omits trivial front matter', () => {
    const chapters = splitChapters(`Produced by X\n短\n\n學而第一\n\n${LONG}\n\n為政第二\n\n${LONG}`, '論語')
    expect(chapters.map((c) => c.title)).toEqual(['學而第一', '為政第二'])
  })
})

describe('chapterDocument / chapterFilename', () => {
  it('renders a single-H1 Markdown document', () => {
    expect(chapterDocument({ title: '第一回 甲', markdown: '正文' })).toBe('# 第一回 甲\n\n正文\n')
  })

  it('numbers filenames so they sort in reading order', () => {
    expect(chapterFilename('西遊記', 0, 100, '第一回 甲/乙')).toBe('西遊記 - 001 第一回 甲 乙.md')
    expect(chapterFilename('論語', 9, 20, '子罕第九')).toBe('論語 - 10 子罕第九.md')
  })
})

describe('fetchGutenbergText', () => {
  const ok = (body: string, type = 'text/plain; charset=utf-8') =>
    new Response(new TextEncoder().encode(body), { status: 200, headers: { 'content-type': type } })

  it('fetches the cached plain-text edition', async () => {
    const fetchImpl = vi.fn(async (_url: string) => ok('\uFEFF第一回'))
    const result = await fetchGutenbergText(23962, fetchImpl as unknown as typeof fetch)
    expect(fetchImpl.mock.calls[0][0]).toBe('https://www.gutenberg.org/cache/epub/23962/pg23962.txt')
    expect(result.text).toBe('第一回')
  })

  it('falls back to the /ebooks/<id>.txt.utf-8 URL', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes('/cache/') ? new Response('nope', { status: 404 }) : ok('text')
    )
    const result = await fetchGutenbergText(1, fetchImpl as unknown as typeof fetch)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(result.text).toBe('text')
  })

  it('reports a failure when no plain-text edition exists', async () => {
    const fetchImpl = vi.fn(async () => ok('<html></html>', 'text/html'))
    await expect(fetchGutenbergText(1, fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      /plain-text edition of ebook #1/
    )
  })
})
