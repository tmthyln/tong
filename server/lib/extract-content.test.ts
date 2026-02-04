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
    it('returns markdown content unchanged', async () => {
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

      expect(result.content).toBe(markdownContent)
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
        extractContent('originals/ab/cd/abcd1234', 'application/pdf', mockEnv)
      ).rejects.toThrow('Unsupported mimetype: application/pdf')
    })

    it('throws error for image mimetype', async () => {
      await expect(
        extractContent('originals/ab/cd/abcd1234', 'image/png', mockEnv)
      ).rejects.toThrow('Unsupported mimetype: image/png')
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
      const content = '# Test Content'
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