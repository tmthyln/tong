import { describe, it, expect, vi, beforeEach } from 'vitest'
import { embedAndStoreChunk } from './embedding'

describe('embedAndStoreChunk', () => {
  let mockEnv: {
    AI: { run: ReturnType<typeof vi.fn> }
    CHUNK_VECTORS: { upsert: ReturnType<typeof vi.fn> }
  }

  const mockEmbedding = [0.1, 0.2, 0.3, 0.4, 0.5]

  beforeEach(() => {
    mockEnv = {
      AI: {
        run: vi.fn().mockResolvedValue({ data: [mockEmbedding] }),
      },
      CHUNK_VECTORS: {
        upsert: vi.fn().mockResolvedValue(undefined),
      },
    }
  })

  it('calls AI with correct model and text', async () => {
    const content = '这是一段中文文本'

    await embedAndStoreChunk(1, 100, content, mockEnv as unknown as Env)

    expect(mockEnv.AI.run).toHaveBeenCalledWith('@cf/google/embeddinggemma-300m', {
      text: content,
    })
  })

  it('calls Vectorize upsert with correct id, values, namespace, and metadata', async () => {
    const chunkId = 42
    const documentId = 100
    const content = '测试内容'

    await embedAndStoreChunk(chunkId, documentId, content, mockEnv as unknown as Env)

    expect(mockEnv.CHUNK_VECTORS.upsert).toHaveBeenCalledWith([
      {
        id: '42',
        values: mockEmbedding,
        namespace: 'document',
        metadata: {
          sourceDocumentId: documentId,
          chunkId: chunkId,
          lang: 'zh',
          window: 1,
        },
      },
    ])
  })

  it('converts chunk ID to string for vector ID', async () => {
    const chunkId = 12345

    await embedAndStoreChunk(chunkId, 1, 'content', mockEnv as unknown as Env)

    const upsertCall = mockEnv.CHUNK_VECTORS.upsert.mock.calls[0][0]
    expect(upsertCall[0].id).toBe('12345')
    expect(typeof upsertCall[0].id).toBe('string')
  })

  it('includes all required metadata fields', async () => {
    const chunkId = 7
    const documentId = 42

    await embedAndStoreChunk(chunkId, documentId, 'content', mockEnv as unknown as Env)

    const upsertCall = mockEnv.CHUNK_VECTORS.upsert.mock.calls[0][0]
    const metadata = upsertCall[0].metadata

    expect(metadata).toHaveProperty('sourceDocumentId', documentId)
    expect(metadata).toHaveProperty('chunkId', chunkId)
    expect(metadata).toHaveProperty('lang', 'zh')
    expect(metadata).toHaveProperty('window', 1)
    expect(Object.keys(metadata)).toHaveLength(4)
  })

  it('uses the embedding returned by AI in the Vectorize upsert', async () => {
    const customEmbedding = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1]
    mockEnv.AI.run.mockResolvedValue({ data: [customEmbedding] })

    await embedAndStoreChunk(1, 1, 'content', mockEnv as unknown as Env)

    const upsertCall = mockEnv.CHUNK_VECTORS.upsert.mock.calls[0][0]
    expect(upsertCall[0].values).toBe(customEmbedding)
  })
})