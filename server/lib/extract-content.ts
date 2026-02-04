const SUPPORTED_MIMETYPES = ['text/plain', 'text/markdown'] as const

type SupportedMimetype = (typeof SUPPORTED_MIMETYPES)[number]

function isSupportedMimetype(mimetype: string): mimetype is SupportedMimetype {
  return SUPPORTED_MIMETYPES.includes(mimetype as SupportedMimetype)
}

function convertToMarkdown(content: string, mimetype: SupportedMimetype): string {
  if (mimetype === 'text/markdown') {
    return content
  }
  // text/plain: return as-is since plain text is valid markdown
  return content
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

export async function extractContent(
  location: string,
  mimetype: string,
  env: Env
): Promise<ExtractedContent> {
  if (!isSupportedMimetype(mimetype)) {
    throw new Error(`Unsupported mimetype: ${mimetype}`)
  }

  // Fetch original file from R2
  const object = await env.DOCUMENTS.get(location)
  if (!object) {
    throw new Error(`File not found at location: ${location}`)
  }

  const originalContent = await object.text()
  const markdownContent = convertToMarkdown(originalContent, mimetype)
  const extractedLocation = getExtractedLocation(location)

  // Extract title from markdown files only (not plain text)
  const { title, content: finalContent } =
    mimetype === 'text/markdown'
      ? extractTitleFromMarkdown(markdownContent)
      : { title: null, content: markdownContent }

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