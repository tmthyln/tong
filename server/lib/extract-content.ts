import { decodeHtml, htmlToMarkdown, parseContentType } from './webpage'

// Mimetypes that can be passed directly as text
const TEXT_MIMETYPES = ['text/plain', 'text/markdown'] as const
type TextMimetype = (typeof TEXT_MIMETYPES)[number]

// Mimetypes supported by Cloudflare AI markdown conversion (env.AI.toMarkdown).
// Mirrors the "Rich format file types" list at
// https://developers.cloudflare.com/workers-ai/features/markdown-conversion/
const AI_CONVERTIBLE_MIMETYPES = [
  'application/pdf',
  // HTML / XML
  'text/html',
  'text/xml',
  'application/xml',
  // Tabular / plain
  'text/csv',
  // Microsoft Office
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
  'application/vnd.ms-excel.sheet.macroenabled.12', // xlsm
  'application/vnd.ms-excel.sheet.binary.macroenabled.12', // xlsb
  'application/vnd.ms-excel', // xls
  // OpenDocument
  'application/vnd.oasis.opendocument.spreadsheet', // ods
  'application/vnd.oasis.opendocument.text', // odt
  // Apple iWork
  'application/vnd.apple.numbers', // numbers
  // Images
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/svg+xml',
  'image/gif',
  'image/bmp',
] as const
type AiConvertibleMimetype = (typeof AI_CONVERTIBLE_MIMETYPES)[number]

function isTextMimetype(mimetype: string): mimetype is TextMimetype {
  return TEXT_MIMETYPES.includes(mimetype as TextMimetype)
}

function isAiConvertibleMimetype(mimetype: string): mimetype is AiConvertibleMimetype {
  return AI_CONVERTIBLE_MIMETYPES.includes(mimetype as AiConvertibleMimetype)
}

/** Whether the ingestion pipeline can extract text from this mimetype. */
export function isSupportedMimetype(mimetype: string): boolean {
  return isTextMimetype(mimetype) || isAiConvertibleMimetype(mimetype)
}

function getExtractedLocation(originalLocation: string): string {
  // Original format: originals/{hash[0:2]}/{hash[2:4]}/{hash}
  // Extract format: extracted/{hash[0:2]}/{hash[2:4]}/{hash}.md
  const parts = originalLocation.split('/')
  const hash = parts[parts.length - 1]
  return `extracted/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}.md`
}

export interface ExtractedContent {
  extractedLocation: string
  content: string
  title: string | null
}

function extractTitleFromMarkdown(content: string): { title: string | null; content: string } {
  const h1Matches = content.match(/^# (.+)$/gm)
  if (h1Matches && h1Matches.length === 1) {
    const titleMatch = content.match(/^# (.+)$/m)
    const title = titleMatch ? titleMatch[1] : null
    const contentWithoutH1 = content.replace(/^# .+\n?/m, '').trimStart()
    return { title, content: contentWithoutH1 }
  }
  return { title: null, content }
}

export async function loadExtractedContent(
  extractedLocation: string,
  env: Env
): Promise<string> {
  const object = await env.DOCUMENTS.get(extractedLocation)
  if (!object) {
    throw new Error(`Extracted file not found at location: ${extractedLocation}`)
  }
  return object.text()
}

async function convertWithAI(
  blob: Blob,
  filename: string,
  env: Env
): Promise<string> {
  const results = await env.AI.toMarkdown([
    {
      name: filename,
      blob: new Blob([await blob.arrayBuffer()], {
        type: 'application/octet-stream',
      }),
    },
  ])

  if (!results || results.length === 0) {
    throw new Error('AI markdown conversion returned no results')
  }

  const result = results[0]
  if ('error' in result && result.error) {
    throw new Error(`AI markdown conversion failed: ${result.error}`)
  }

  if (!('data' in result) || typeof result.data !== 'string') {
    throw new Error('AI markdown conversion returned invalid data')
  }

  return result.data
}

export async function extractContent(
  location: string,
  mimetype: string,
  env: Env
): Promise<ExtractedContent> {
  // Reject unsupported mimetypes before fetching the file
  if (!isTextMimetype(mimetype) && !isAiConvertibleMimetype(mimetype)) {
    throw new Error(`Unsupported mimetype: ${mimetype}`)
  }

  // Fetch original file from R2
  const object = await env.DOCUMENTS.get(location)
  if (!object) {
    throw new Error(`File not found at location: ${location}`)
  }

  let markdownContent: string
  const filename = location.split('/').pop() || 'document'

  let htmlTitle: string | null = null

  if (isTextMimetype(mimetype)) {
    // Text files can be used directly
    markdownContent = await object.text()
  } else if (mimetype === 'text/html') {
    // Webpages (imported by URL or uploaded): extract the main content with
    // Defuddle; fall back to AI conversion if that finds nothing.
    const bytes = new Uint8Array(await object.arrayBuffer())
    const sourceUrl = object.customMetadata?.sourceUrl
    const charset =
      object.customMetadata?.charset ?? parseContentType(object.httpMetadata?.contentType ?? null).charset
    const html = decodeHtml(bytes, charset)
    const converted = await htmlToMarkdown(html, sourceUrl).catch((err) => {
      console.warn('Defuddle HTML conversion failed; falling back to AI', err)
      return null
    })
    if (converted && converted.markdown) {
      markdownContent = converted.markdown
      htmlTitle = converted.title
    } else {
      markdownContent = await convertWithAI(new Blob([bytes]), `${filename}.html`, env)
    }
  } else if (isAiConvertibleMimetype(mimetype)) {
    // Use Cloudflare AI markdown conversion
    const blob = await object.blob()
    markdownContent = await convertWithAI(blob, filename, env)
  } else {
    throw new Error(`Unsupported mimetype: ${mimetype}`)
  }

  const extractedLocation = getExtractedLocation(location)

  // Extract title from markdown content
  const extracted = extractTitleFromMarkdown(markdownContent)
  const title = htmlTitle ?? extracted.title
  // Defuddle already removed the title heading (or demoted it); only strip a
  // lone H1 when it duplicates the page title or there is no page title.
  const finalContent =
    htmlTitle === null || extracted.title === htmlTitle ? extracted.content : markdownContent

  // Save extracted markdown to R2
  await env.DOCUMENTS.put(extractedLocation, finalContent, {
    httpMetadata: {
      contentType: 'text/markdown',
    },
  })

  return {
    extractedLocation,
    content: finalContent,
    title,
  }
}
