import { describe, it, expect, vi, beforeEach } from 'vitest'
import { storeUploadedFile } from './documents'

// Helper to create a mock File
function createMockFile(
  content: string,
  name: string,
  type: string = 'text/plain'
): File {
  const blob = new Blob([content], { type })
  return new File([blob], name, { type })
}

// Helper to compute expected SHA-256 hash
async function computeSha256(content: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(content)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

describe('storeUploadedFile', () => {
  let mockEnv: Env
  let mockFirst: ReturnType<typeof vi.fn>
  let mockBind: ReturnType<typeof vi.fn>
  let mockPrepare: ReturnType<typeof vi.fn>
  let mockPut: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockFirst = vi.fn()
    mockBind = vi.fn(() => ({ first: mockFirst }))
    mockPrepare = vi.fn(() => ({ bind: mockBind }))
    mockPut = vi.fn().mockResolvedValue(undefined)

    mockEnv = {
      DB: {
        prepare: mockPrepare,
      },
      DOCUMENTS: {
        put: mockPut,
      },
    } as unknown as Env
  })

  it('stores new file in R2 with correct path structure', async () => {
    const content = 'hello world'
    const file = createMockFile(content, 'test.txt', 'text/plain')
    const expectedHash = await computeSha256(content)

    mockFirst.mockResolvedValue(null)

    const result = await storeUploadedFile(file, mockEnv)

    expect(result.alreadyExists).toBe(false)
    expect(result.location).toBe(
      `originals/${expectedHash.slice(0, 2)}/${expectedHash.slice(2, 4)}/${expectedHash}`
    )
    expect(mockPut).toHaveBeenCalledTimes(1)
    expect(mockPut).toHaveBeenCalledWith(
      result.location,
      expect.any(ArrayBuffer),
      {
        httpMetadata: {
          contentType: 'text/plain',
        },
        customMetadata: {
          originalFilename: 'test.txt',
          contentHash: expectedHash,
        },
      }
    )
  })

  it('returns existing ID without re-uploading for duplicate file', async () => {
    const content = 'duplicate content'
    const file = createMockFile(content, 'duplicate.txt', 'text/plain')
    const expectedHash = await computeSha256(content)

    mockFirst.mockResolvedValue({
      id: 42,
      original_doc_location: 'originals/ab/cd/abcdef123',
    })

    const result = await storeUploadedFile(file, mockEnv)

    expect(result.alreadyExists).toBe(true)
    if (result.alreadyExists) {
      expect(result.existingId).toBe(42)
      expect(result.location).toBe('originals/ab/cd/abcdef123')
    }
    expect(result.contentHash).toBe(expectedHash)
    expect(mockPut).not.toHaveBeenCalled()
  })

  it('computes SHA-256 content hash correctly', async () => {
    const content = 'test content for hashing'
    const file = createMockFile(content, 'hash-test.txt')
    const expectedHash = await computeSha256(content)

    mockFirst.mockResolvedValue(null)

    const result = await storeUploadedFile(file, mockEnv)

    expect(result.contentHash).toBe(expectedHash)
    expect(result.contentHash).toHaveLength(64) // SHA-256 produces 64 hex characters
    expect(mockPrepare).toHaveBeenCalledWith(
      'SELECT id, original_doc_location FROM document WHERE original_doc_content_hash = ?'
    )
    expect(mockBind).toHaveBeenCalledWith(expectedHash)
  })

  it('preserves filename and mimetype', async () => {
    const file = createMockFile('content', 'my-document.pdf', 'application/pdf')

    mockFirst.mockResolvedValue(null)

    const result = await storeUploadedFile(file, mockEnv)

    expect(result.filename).toBe('my-document.pdf')
    expect(result.mimetype).toBe('application/pdf')
  })

  it('uses default mimetype when file.type is empty', async () => {
    const blob = new Blob(['content'])
    const file = new File([blob], 'unknown-type.bin', { type: '' })

    mockFirst.mockResolvedValue(null)

    const result = await storeUploadedFile(file, mockEnv)

    expect(result.mimetype).toBe('application/octet-stream')
    expect(mockPut).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(ArrayBuffer),
      expect.objectContaining({
        httpMetadata: {
          contentType: 'application/octet-stream',
        },
      })
    )
  })
})