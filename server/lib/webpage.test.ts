import { describe, it, expect, vi } from 'vitest'
import {
  BROWSER_USER_AGENT,
  decodeHtml,
  fetchWebpage,
  filenameForUrl,
  htmlToMarkdown,
  parseContentType,
  parseImportUrl,
  resolveMimetype,
  sniffHtmlCharset,
  WebpageImportError,
} from './webpage'

describe('parseImportUrl', () => {
  it('accepts http(s) URLs and strips the fragment', () => {
    expect(parseImportUrl('https://example.com/a?b=1#frag').toString()).toBe('https://example.com/a?b=1')
  })

  it('defaults to https when no scheme is given', () => {
    expect(parseImportUrl('  example.com/news/1.html ').toString()).toBe('https://example.com/news/1.html')
  })

  it.each([
    'ftp://example.com/file',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'http://localhost:8787/',
    'http://127.0.0.1/',
    'http://10.1.2.3/',
    'http://192.168.0.1/',
    'http://172.20.0.1/',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:10.0.0.1]/',
    'http://user:pw@example.com/',
    'not a url at all',
  ])('rejects %s', (raw) => {
    expect(() => parseImportUrl(raw)).toThrow(WebpageImportError)
  })

  it('allows IPv4-mapped IPv6 addresses of public hosts', () => {
    expect(parseImportUrl('http://[::ffff:8.8.8.8]/').hostname).toBe('[::ffff:808:808]')
  })

  it('does not mistake public hostnames for private IPv6 prefixes', () => {
    expect(parseImportUrl('https://fdsa.example.com/').hostname).toBe('fdsa.example.com')
  })
})

describe('parseContentType', () => {
  it('splits mimetype and charset', () => {
    expect(parseContentType('text/html; charset="GBK"')).toEqual({ mimetype: 'text/html', charset: 'gbk' })
    expect(parseContentType('application/pdf')).toEqual({ mimetype: 'application/pdf', charset: null })
    expect(parseContentType(null)).toEqual({ mimetype: 'application/octet-stream', charset: null })
  })
})

describe('decodeHtml', () => {
  // "中文" in GBK
  const gbkBytes = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4])
  const withMeta = (body: Uint8Array) =>
    new Uint8Array([...new TextEncoder().encode('<html><head><meta charset="gbk"></head><body>'), ...body])

  it('sniffs <meta charset>', () => {
    expect(sniffHtmlCharset(withMeta(gbkBytes))).toBe('gbk')
    expect(sniffHtmlCharset(new TextEncoder().encode('<meta http-equiv="Content-Type" content="text/html; charset=gb2312">'))).toBe('gb2312')
  })

  it('decodes GBK pages using the meta charset', () => {
    expect(decodeHtml(withMeta(gbkBytes))).toContain('中文')
  })

  it('prefers the header charset', () => {
    const bytes = new Uint8Array([...new TextEncoder().encode('<p>'), ...gbkBytes])
    expect(decodeHtml(bytes, 'gb18030')).toBe('<p>中文')
  })

  it('falls back to UTF-8 for unknown labels', () => {
    expect(decodeHtml(new TextEncoder().encode('<p>中文'), 'x-made-up')).toBe('<p>中文')
  })
})

describe('htmlToMarkdown', () => {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <title>李白的诗</title><meta property="og:site_name" content="诗词网"></head><body>
    <nav><a href="/">首页</a> <a href="/news">新闻</a> <a href="/about">关于</a></nav>
    <article><h1>李白的诗</h1>
      <p>李白是唐代著名诗人，被称为<a href="/wiki/诗仙">诗仙</a>。他的诗歌风格豪放飘逸，想象丰富。</p>
      <p>床前明月光，疑是地上霜。举头望明月，低头思故乡。这首《静夜思》家喻户晓。</p>
      <h2>生平</h2><p>李白出生于公元七〇一年，一生游历四方，留下了大量传世名作。</p>
    </article>
    <footer>版权所有 © 2024 诗词网</footer></body></html>`

  it('extracts main content as Markdown with absolute links and no chrome', async () => {
    const result = await htmlToMarkdown(html, 'https://poems.example.cn/libai.html')
    expect(result.title).toBe('李白的诗')
    expect(result.language).toBe('zh-CN')
    expect(result.markdown).toContain('床前明月光，疑是地上霜。')
    expect(result.markdown).toContain('## 生平')
    expect(result.markdown).toMatch(/\[诗仙\]\(https:\/\/poems\.example\.cn\/wiki\/.+\)/)
    expect(result.markdown).not.toContain('版权所有')
    expect(result.markdown).not.toContain('首页')
  })
})

describe('fetchWebpage', () => {
  it('sends a browser user agent and normalizes the response', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      expect(headers.get('user-agent')).toBe(BROWSER_USER_AGENT)
      expect(headers.get('accept-language')).toMatch(/^zh-CN/)
      return new Response('<html>你好</html>', {
        headers: { 'content-type': 'application/xhtml+xml; charset=utf-8' },
      })
    })
    const page = await fetchWebpage(new URL('https://example.cn/a'), fetchImpl as unknown as typeof fetch)
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(page.mimetype).toBe('text/html')
    expect(page.charset).toBe('utf-8')
    expect(new TextDecoder().decode(page.data)).toBe('<html>你好</html>')
  })

  it('infers the mimetype of generic binary downloads', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('%PDF-1.7 ...', { headers: { 'content-type': 'application/octet-stream' } })
    )
    const page = await fetchWebpage(new URL('https://example.cn/download?id=1'), fetchImpl as unknown as typeof fetch)
    expect(page.mimetype).toBe('application/pdf')
  })

  it('maps HTTP errors to a 502 import error', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 403 }))
    await expect(
      fetchWebpage(new URL('https://example.cn/a'), fetchImpl as unknown as typeof fetch)
    ).rejects.toMatchObject({ status: 502, message: expect.stringContaining('403') })
  })

  it('rejects bodies over the size limit', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('x', { headers: { 'content-length': String(100 * 1024 * 1024) } })
    )
    await expect(
      fetchWebpage(new URL('https://example.cn/a'), fetchImpl as unknown as typeof fetch)
    ).rejects.toMatchObject({ status: 413 })
  })
})

describe('resolveMimetype', () => {
  const bytes = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer

  it('trusts specific content types and normalizes xhtml', () => {
    expect(resolveMimetype('application/pdf', 'https://x.cn/a', bytes('x'))).toBe('application/pdf')
    expect(resolveMimetype('application/xhtml+xml', 'https://x.cn/a', bytes('x'))).toBe('text/html')
    // A specific type wins over a misleading extension.
    expect(resolveMimetype('text/html', 'https://x.cn/a.pdf', bytes('<html>'))).toBe('text/html')
  })

  it('sniffs PDF magic bytes for generic binary types', () => {
    expect(resolveMimetype('application/octet-stream', 'https://x.cn/dl?id=3', bytes('%PDF-1.4'))).toBe('application/pdf')
  })

  it('falls back to the URL extension for generic binary types', () => {
    expect(resolveMimetype('binary/octet-stream', 'https://x.cn/files/a.DOCX', bytes('PK..'))).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    )
  })

  it('leaves unknown generic binaries unresolved', () => {
    expect(resolveMimetype('application/octet-stream', 'https://x.cn/blob', bytes('\x00\x01'))).toBe('application/octet-stream')
  })
})

describe('filenameForUrl', () => {
  it('uses host + path for webpages', () => {
    expect(filenameForUrl('https://news.example.cn/2024/article-1.html', 'text/html')).toBe(
      'news.example.cn/2024/article-1'
    )
    expect(filenameForUrl('https://example.cn/', 'text/html')).toBe('example.cn')
  })

  it('keeps non-UTF-8 percent-encoding (e.g. GBK paths) instead of throwing', () => {
    expect(filenameForUrl('https://a.cn/%D6%D0%CE%C4.html', 'text/html')).toBe('a.cn/%D6%D0%CE%C4')
  })

  it('uses the last path segment for files', () => {
    expect(filenameForUrl('https://example.cn/files/%E6%8A%A5%E5%91%8A.pdf', 'application/pdf')).toBe('报告.pdf')
  })
})
