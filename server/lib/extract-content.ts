// Mimetypes that can be passed directly as text
const TEXT_MIMETYPES = ['text/plain', 'text/markdown'] as const
type TextMimetype = (typeof TEXT_MIMETYPES)[number]

// Mimetypes supported by Cloudflare AI markdown conversion
const AI_CONVERTIBLE_MIMETYPES = [
  'application/pdf',
  'text/html',
  'text/xml',
  'application/xml',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
  'application/vnd.ms-excel', // xls
  'application/vnd.oasis.opendocument.spreadsheet', // ods
  'application/vnd.oasis.opendocument.text', // odt
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/svg+xml',
] as const
type AiConvertibleMimetype = (typeof AI_CONVERTIBLE_MIMETYPES)[number]

function isTextMimetype(mimetype: string): mimetype is TextMimetype {
  return TEXT_MIMETYPES.includes(mimetype as TextMimetype)
}

function isAiConvertibleMimetype(mimetype: string): mimetype is AiConvertibleMimetype {
  return AI_CONVERTIBLE_MIMETYPES.includes(mimetype as AiConvertibleMimetype)
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
  // Fetch original file from R2
  const object = await env.DOCUMENTS.get(location)
  if (!object) {
    throw new Error(`File not found at location: ${location}`)
  }

  let markdownContent: string
  const filename = location.split('/').pop() || 'document'

  if (isTextMimetype(mimetype)) {
    // Text files can be used directly
    markdownContent = await object.text()
  } else if (isAiConvertibleMimetype(mimetype)) {
    // Use Cloudflare AI markdown conversion
    const blob = await object.blob()
    markdownContent = await convertWithAI(blob, filename, env)
  } else {
    throw new Error(`Unsupported mimetype: ${mimetype}`)
  }

  const extractedLocation = getExtractedLocation(location)

  // Extract title from markdown content
  const { title, content: finalContent } = extractTitleFromMarkdown(markdownContent)

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
