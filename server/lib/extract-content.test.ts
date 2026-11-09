import { describe, it, expect, vi, beforeEach } from 'vitest'
import { extractContent, loadExtractedContent } from './extract-content'

// Mock R2ObjectBody with text() method
function createMockR2Object(content: string) {
  return {
    text: vi.fn().mockResolvedValue(content),
    body: new ReadableStream(),
    bodyUsed: false,
    key: 'test-key',
    version: '1',
    size: content.length,
    etag: 'test-etag',
  }
}

// Create mock env with DOCUMENTS R2 bucket
function createMockEnv() {
  return {
    DOCUMENTS: {
      get: vi.fn(),
      put: vi.fn().mockResolvedValue({}),
    },
  } as unknown as Env
}

describe('extractContent', () => {
  let mockEnv: Env

  beforeEach(() => {
    mockEnv = createMockEnv()
  })

  describe('text/markdown content', () => {
    it('returns markdown content unchanged when there is no lone title heading', async () => {
      // Content without a single top-level H1 passes through untouched
      const markdownContent = 'Intro paragraph.\n\n## Hello World\n\nThis is **markdown**.'
      const mockR2 = mockEnv.DOCUMENTS as unknown as {
        get: ReturnType<typeof vi.fn>
        put: ReturnType<typeof vi.fn>
      }
      mockR2.get.mockResolvedValue(createMockR2Object(markdownContent))

      const result = await extractContent(
        'originals/ab/cd/abcd1234',
        'text/markdown',
        mockEnv
      )

      expect(result.content).toBe(markdownContent)
      expect(result.title).toBeNull()
    })

    it('extracts a lone H1 as the title and strips it from the content', async () => {
      const markdownContent = '# Hello World\n\nThis is **markdown**.'
      const mockR2 = mockEnv.DOCUMENTS as unknown as {
        get: ReturnType<typeof vi.fn>
        put: ReturnType<typeof vi.fn>
      }
      mockR2.get.mockResolvedValue(createMockR2Object(markdownContent))

      const result = await extractContent(
        'originals/ab/cd/abcd1234',
        'text/markdown',
        mockEnv
      )

      expect(result.title).toBe('Hello World')
      expect(result.content).toBe('This is **markdown**.')
    })
  })

  describe('text/plain content', () => {
    it('returns plain text content as-is', async () => {
      const plainContent = 'This is plain text.\nNo formatting here.'
      const mockR2 = mockEnv.DOCUMENTS as unknown as {
        get: ReturnType<typeof vi.fn>
        put: ReturnType<typeof vi.fn>
      }
      mockR2.get.mockResolvedValue(createMockR2Object(plainContent))

      const result = await extractContent(
        'originals/ab/cd/abcd1234',
        'text/plain',
        mockEnv
      )

      expect(result.content).toBe(plainContent)
    })
  })

  describe('extracted location path', () => {
    it('derives extracted location correctly from original location', async () => {
      const mockR2 = mockEnv.DOCUMENTS as unknown as {
        get: ReturnType<typeof vi.fn>
        put: ReturnType<typeof vi.fn>
      }
      mockR2.get.mockResolvedValue(createMockR2Object('content'))

      const result = await extractContent(
        'originals/ab/cd/abcd1234efgh5678',
        'text/plain',
        mockEnv
      )

      expect(result.extractedLocation).toBe(
        'extracted/ab/cd/abcd1234efgh5678.md'
      )
    })

    it('handles hash with different prefix paths', async () => {
      const mockR2 = mockEnv.DOCUMENTS as unknown as {
        get: ReturnType<typeof vi.fn>
        put: ReturnType<typeof vi.fn>
      }
      mockR2.get.mockResolvedValue(createMockR2Object('content'))

      const result = await extractContent(
        'some/other/path/xyz123abc456',
        'text/markdown',
        mockEnv
      )

      expect(result.extractedLocation).toBe('extracted/xy/z1/xyz123abc456.md')
    })
  })

  describe('unsupported mimetype', () => {
    it('throws error for unsupported mimetype', async () => {
      await expect(
        extractContent('originals/ab/cd/abcd1234', 'application/json', mockEnv)
      ).rejects.toThrow('Unsupported mimetype: application/json')
    })

    it('throws error for audio mimetype', async () => {
      await expect(
        extractContent('originals/ab/cd/abcd1234', 'audio/mpeg', mockEnv)
      ).rejects.toThrow('Unsupported mimetype: audio/mpeg')
    })

    it('does not call R2 get for unsupported mimetype', async () => {
      const mockR2 = mockEnv.DOCUMENTS as unknown as {
        get: ReturnType<typeof vi.fn>
        put: ReturnType<typeof vi.fn>
      }

      await expect(
        extractContent('originals/ab/cd/abcd1234', 'application/json', mockEnv)
      ).rejects.toThrow()

      expect(mockR2.get).not.toHaveBeenCalled()
    })
  })

  describe('file not found', () => {
    it('throws error when file is not found in R2', async () => {
      const mockR2 = mockEnv.DOCUMENTS as unknown as {
        get: ReturnType<typeof vi.fn>
        put: ReturnType<typeof vi.fn>
      }
      mockR2.get.mockResolvedValue(null)

      await expect(
        extractContent('originals/ab/cd/abcd1234', 'text/plain', mockEnv)
      ).rejects.toThrow('File not found at location: originals/ab/cd/abcd1234')
    })
  })

  describe('R2 storage', () => {
    it('saves content to R2 with correct content-type', async () => {
      const content = 'Test content body.\n\n## Section'
      const mockR2 = mockEnv.DOCUMENTS as unknown as {
        get: ReturnType<typeof vi.fn>
        put: ReturnType<typeof vi.fn>
      }
      mockR2.get.mockResolvedValue(createMockR2Object(content))

      await extractContent(
        'originals/ab/cd/abcd1234',
        'text/markdown',
        mockEnv
      )

      expect(mockR2.put).toHaveBeenCalledWith(
        'extracted/ab/cd/abcd1234.md',
        content,
        {
          httpMetadata: {
            contentType: 'text/markdown',
          },
        }
      )
    })

    it('reads from correct R2 location', async () => {
      const mockR2 = mockEnv.DOCUMENTS as unknown as {
        get: ReturnType<typeof vi.fn>
        put: ReturnType<typeof vi.fn>
      }
      mockR2.get.mockResolvedValue(createMockR2Object('content'))

      await extractContent(
        'originals/xy/z1/xyz123456789',
        'text/plain',
        mockEnv
      )

      expect(mockR2.get).toHaveBeenCalledWith('originals/xy/z1/xyz123456789')
    })
  })
})

describe('loadExtractedContent', () => {
  let mockEnv: Env

  beforeEach(() => {
    mockEnv = createMockEnv()
  })

  it('loads content from R2 at the given location', async () => {
    const content = '# Extracted content'
    const mockR2 = mockEnv.DOCUMENTS as unknown as {
      get: ReturnType<typeof vi.fn>
    }
    mockR2.get.mockResolvedValue(createMockR2Object(content))

    const result = await loadExtractedContent(
      'extracted/ab/cd/abcd1234.md',
      mockEnv
    )

    expect(result).toBe(content)
    expect(mockR2.get).toHaveBeenCalledWith('extracted/ab/cd/abcd1234.md')
  })

  it('throws error when file is not found', async () => {
    const mockR2 = mockEnv.DOCUMENTS as unknown as {
      get: ReturnType<typeof vi.fn>
    }
    mockR2.get.mockResolvedValue(null)

    await expect(
      loadExtractedContent('extracted/ab/cd/missing.md', mockEnv)
    ).rejects.toThrow(
      'Extracted file not found at location: extracted/ab/cd/missing.md'
    )
  })
})
describe('extractContent text/html', () => {
  it('converts HTML with Defuddle, decoding the stored charset and resolving links against sourceUrl', async () => {
    const mockEnv = createMockEnv()
    const html =
      '<html><head><title>静夜思</title></head><body><article><h1>静夜思</h1>' +
      '<p>床前明月光，疑是地上霜。<a href="/libai">李白</a>的作品。</p>' +
      '<p>举头望明月，低头思故乡。这是一首非常有名的唐诗，几乎每个中国人都会背诵。</p></article></body></html>'
    const bytes = new TextEncoder().encode(html)
    const mockR2 = mockEnv.DOCUMENTS as unknown as {
      get: ReturnType<typeof vi.fn>
      put: ReturnType<typeof vi.fn>
    }
    mockR2.get.mockResolvedValue({
      arrayBuffer: vi.fn().mockResolvedValue(bytes.buffer),
      customMetadata: { sourceUrl: 'https://poems.example.cn/jys', charset: 'utf-8' },
      httpMetadata: { contentType: 'text/html' },
    })

    const result = await extractContent('originals/ab/cd/abcd1234', 'text/html', mockEnv)

    expect(result.title).toBe('静夜思')
    expect(result.content).toContain('床前明月光，疑是地上霜。')
    expect(result.content).toContain('[李白](https://poems.example.cn/libai)')
    expect(result.content).not.toMatch(/^# /m)
    expect(mockR2.put).toHaveBeenCalledWith(
      'extracted/ab/cd/abcd1234.md',
      result.content,
      expect.anything()
    )
  })
})
