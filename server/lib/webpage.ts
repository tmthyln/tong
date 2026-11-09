// Webpage import (issue #8): fetch a URL, and convert HTML into clean Markdown.
//
// HTML → Markdown uses Defuddle (https://github.com/kepano/defuddle), the
// main-content extractor behind Obsidian Web Clipper, over a linkedom DOM
// (Workers have no native DOM). Defuddle strips nav/sidebars/footers/comments
// and standardizes footnotes, code blocks and headings before converting.
import { parseHTML } from 'linkedom'
import { Defuddle } from 'defuddle/node'

// A current desktop Chrome UA — many sites 403 or serve stripped pages to
// unknown/bot user agents.
export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'

export const MAX_WEBPAGE_BYTES = 20 * 1024 * 1024
const FETCH_TIMEOUT_MS = 20_000

export const HTML_MIMETYPES = ['text/html', 'application/xhtml+xml'] as const

export class WebpageImportError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413 | 415 | 502 = 400
  ) {
    super(message)
    this.name = 'WebpageImportError'
  }
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

function isPrivateIPv4(a: number, b: number): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  )
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (host.includes(':')) {
    // IPv4-mapped IPv6 (::ffff:a.b.c.d, which URL normalizes to ::ffff:XXXX:XXXX):
    // judge by the embedded IPv4 address.
    const mapped = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
    if (mapped) {
      const hi = parseInt(mapped[1], 16)
      return isPrivateIPv4(hi >> 8, hi & 0xff)
    }
    // Loopback, unspecified, unique-local (fc00::/7), link-local.
    return host === '::1' || host === '::' || /^f[cd]/.test(host) || host.startsWith('fe80')
  }
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  return v4 !== null && isPrivateIPv4(Number(v4[1]), Number(v4[2]))
}

/** Parse and validate a user-supplied URL: absolute http(s), public host. */
export function parseImportUrl(raw: string): URL {
  const trimmed = raw.trim()
  let url: URL
  try {
    // Allow "example.com/page" without a scheme.
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`)
  } catch {
    throw new WebpageImportError('Invalid URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebpageImportError('Only http and https URLs can be imported')
  }
  if (url.username || url.password) {
    throw new WebpageImportError('URLs with embedded credentials are not allowed')
  }
  if (isPrivateHostname(url.hostname)) {
    throw new WebpageImportError('URLs pointing at local or private addresses are not allowed')
  }
  url.hash = ''
  return url
}

// ---------------------------------------------------------------------------
// Fetching & decoding
// ---------------------------------------------------------------------------

/** Split a Content-Type header into a bare mimetype and optional charset. */
export function parseContentType(header: string | null): { mimetype: string; charset: string | null } {
  if (!header) return { mimetype: 'application/octet-stream', charset: null }
  const [type, ...params] = header.split(';')
  let charset: string | null = null
  for (const p of params) {
    const m = p.trim().match(/^charset\s*=\s*"?([^";\s]+)"?$/i)
    if (m) charset = m[1].toLowerCase()
  }
  return { mimetype: type.trim().toLowerCase() || 'application/octet-stream', charset }
}

/** Find a `<meta charset>` / `<meta http-equiv=content-type>` declaration in the first bytes. */
export function sniffHtmlCharset(bytes: Uint8Array): string | null {
  // Charset declarations must appear in the first 1024 bytes per the HTML spec;
  // be a little generous. Decoding as latin1 keeps ASCII intact for matching.
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096))
  const m =
    head.match(/<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_.:-]+)/i) ??
    head.match(/<\?xml[^>]+encoding\s*=\s*["']([a-z0-9_.:-]+)/i)
  return m ? m[1].toLowerCase() : null
}

/**
 * Decode HTML bytes to a string. Many Chinese sites still serve GBK/GB2312/
 * Big5, so honour the declared charset (header first, then BOM/meta sniff),
 * falling back to UTF-8.
 */
export function decodeHtml(bytes: Uint8Array, headerCharset: string | null = null): string {
  // A BOM is authoritative.
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes)
  }
  for (const label of [headerCharset, sniffHtmlCharset(bytes)]) {
    if (!label) continue
    try {
      return new TextDecoder(label).decode(bytes)
    } catch {
      // Unknown/unsupported label — try the next source.
    }
  }
  return new TextDecoder('utf-8').decode(bytes)
}

export interface FetchedWebpage {
  /** Final URL after redirects. */
  url: string
  data: ArrayBuffer
  /** Bare mimetype, normalized (xhtml → text/html) or inferred for generic binary types. */
  mimetype: string
  charset: string | null
}

// Content-Types servers use when they don't know (or won't say) what a file is.
const GENERIC_BINARY_MIMETYPES = new Set([
  'application/octet-stream',
  'binary/octet-stream',
  'application/download',
  'application/x-download',
  'application/force-download',
])

const EXTENSION_MIMETYPES: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroenabled.12',
  xlsb: 'application/vnd.ms-excel.sheet.binary.macroenabled.12',
  xls: 'application/vnd.ms-excel',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odt: 'application/vnd.oasis.opendocument.text',
  numbers: 'application/vnd.apple.numbers',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
  html: 'text/html',
  htm: 'text/html',
  xml: 'application/xml',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  gif: 'image/gif',
  bmp: 'image/bmp',
}

/**
 * Resolve the mimetype of a fetched resource. A specific Content-Type is
 * trusted; a missing or generic binary one (common for file download links) is
 * inferred from the file's magic bytes, then the URL's extension.
 */
export function resolveMimetype(contentType: string, url: string, data: ArrayBuffer): string {
  if ((HTML_MIMETYPES as readonly string[]).includes(contentType)) return 'text/html'
  if (!GENERIC_BINARY_MIMETYPES.has(contentType)) return contentType
  const head = new Uint8Array(data, 0, Math.min(5, data.byteLength))
  if (String.fromCharCode(...head) === '%PDF-') return 'application/pdf'
  const ext = new URL(url).pathname.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase()
  return (ext && EXTENSION_MIMETYPES[ext]) || contentType
}

async function readBodyWithLimit(response: Response, limit: number): Promise<ArrayBuffer> {
  const declared = Number(response.headers.get('content-length'))
  if (declared && declared > limit) {
    throw new WebpageImportError(`Page is too large (${declared} bytes)`, 413)
  }
  if (!response.body) return new ArrayBuffer(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel()
      throw new WebpageImportError(`Page is too large (over ${limit} bytes)`, 413)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out.buffer
}

export async function fetchWebpage(
  url: URL,
  fetchImpl: typeof fetch = fetch
): Promise<FetchedWebpage> {
  let response: Response
  try {
    response = await fetchImpl(url.toString(), {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,zh-TW;q=0.8,en;q=0.6',
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new WebpageImportError(`Failed to fetch URL: ${msg}`, 502)
  }

  if (!response.ok) {
    throw new WebpageImportError(`Fetching URL failed with HTTP ${response.status}`, 502)
  }

  const finalUrl = response.url || url.toString()
  // Re-check after redirects so a public URL can't bounce to a private host.
  parseImportUrl(finalUrl)

  const { mimetype: contentType, charset } = parseContentType(response.headers.get('content-type'))
  const data = await readBodyWithLimit(response, MAX_WEBPAGE_BYTES)
  if (data.byteLength === 0) {
    throw new WebpageImportError('URL returned an empty response', 502)
  }

  return { url: finalUrl, data, mimetype: resolveMimetype(contentType, finalUrl, data), charset }
}

// Paths percent-encoded in a legacy charset (e.g. GBK on older Chinese sites)
// are not valid UTF-8, and decodeURIComponent throws on them; keep them encoded.
function safeDecodeURIComponent(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** A human-readable filename for an imported URL (used until a title is extracted). */
export function filenameForUrl(url: string, mimetype: string): string {
  const u = new URL(url)
  let path = safeDecodeURIComponent(u.pathname).replace(/\/+$/, '')
  if (mimetype !== 'text/html') {
    // For files (e.g. a linked PDF) keep the last path segment as-is.
    const last = path.split('/').pop()
    if (last) return last
  }
  path = path.replace(/\.(s?html?|php|aspx?|jsp)$/i, '')
  return `${u.hostname}${path}`.slice(0, 200)
}

// ---------------------------------------------------------------------------
// HTML → Markdown
// ---------------------------------------------------------------------------

export interface WebpageMarkdown {
  markdown: string
  title: string | null
  author: string | null
  site: string | null
  published: string | null
  language: string | null
}

export async function htmlToMarkdown(html: string, url?: string): Promise<WebpageMarkdown> {
  const { document } = parseHTML(html)
  const result = await Defuddle(document as unknown as Parameters<typeof Defuddle>[0], url, {
    markdown: true,
    // Third-party API fallbacks (e.g. transcript services) are not wanted here.
    useAsync: false,
  })
  const markdown = (result.content ?? '').replace(/\n{3,}/g, '\n\n').trim()
  const orNull = (s: string | undefined) => (s && s.trim() ? s.trim() : null)
  return {
    markdown,
    title: orNull(result.title),
    author: orNull(result.author),
    site: orNull(result.site),
    published: orNull(result.published),
    language: orNull(result.language),
  }
}
