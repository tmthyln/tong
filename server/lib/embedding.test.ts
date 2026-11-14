import { describe, it, expect, vi, beforeEach } from 'vitest'
import { embedAndStoreChunk, embedTexts, EMBEDDING_MODEL, EMBEDDING_VERSION } from './embedding'

describe('embedAndStoreChunk', () => {
  let mockEnv: {
    AI: { run: ReturnType<typeof vi.fn> }
    CHUNK_VECTORS: { upsert: ReturnType<typeof vi.fn> }
    DB: { prepare: ReturnType<typeof vi.fn> }
  }
  let bind: ReturnType<typeof vi.fn>

  const mockEmbedding = [0.1, 0.2, 0.3, 0.4, 0.5]

  beforeEach(() => {
    mockEnv = {
      AI: {
        run: vi.fn().mockResolvedValue({ data: [{ index: 0, embedding: mockEmbedding }] }),
      },
      CHUNK_VECTORS: {
        upsert: vi.fn().mockResolvedValue(undefined),
      },
      DB: { prepare: vi.fn() },
    }
    bind = vi.fn().mockReturnValue({ run: vi.fn().mockResolvedValue({}) })
    mockEnv.DB.prepare.mockReturnValue({ bind })
  })

  it('embeds the chunk with embeddinggemma-2 as a document at 768 dims', async () => {
    const content = '这是一段中文文本'

    await embedAndStoreChunk(1, 100, content, mockEnv as unknown as Env)

    expect(EMBEDDING_MODEL).toBe('@cf/google/embeddinggemma-2')
    expect(mockEnv.AI.run).toHaveBeenCalledWith(EMBEDDING_MODEL, {
      input: [`title: none | text: ${content}`],
      dimensions: 768,
    })
  })

  it('records the embedding version on the chunk', async () => {
    await embedAndStoreChunk(42, 1, 'content', mockEnv as unknown as Env)
    expect(mockEnv.DB.prepare.mock.calls[0][0]).toMatch(/UPDATE text_chunk SET embedding_version/)
    expect(bind).toHaveBeenCalledWith(EMBEDDING_VERSION, 42)
  })

  it('throws instead of upserting when no embedding comes back', async () => {
    mockEnv.AI.run.mockResolvedValue({ data: [] })
    await expect(embedAndStoreChunk(1, 1, 'x', mockEnv as unknown as Env)).rejects.toThrow()
    expect(mockEnv.CHUNK_VECTORS.upsert).not.toHaveBeenCalled()
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
    mockEnv.AI.run.mockResolvedValue({ data: [{ index: 0, embedding: customEmbedding }] })

    await embedAndStoreChunk(1, 1, 'content', mockEnv as unknown as Env)

    const upsertCall = mockEnv.CHUNK_VECTORS.upsert.mock.calls[0][0]
    expect(upsertCall[0].values).toBe(customEmbedding)
  })
})

describe('embedTexts', () => {
  it('returns embeddings in input order using the response index', async () => {
    const run = vi.fn().mockResolvedValue({
      data: [
        { index: 1, embedding: [2] },
        { index: 0, embedding: [1] },
      ],
    })
    const env = { AI: { run } } as unknown as Env
    expect(await embedTexts(env, ['a', 'b'], 'query')).toEqual([[1], [2]])
    expect(run).toHaveBeenCalledWith(EMBEDDING_MODEL, {
      input: ['task: search result | query: a', 'task: search result | query: b'],
      dimensions: 768,
    })
  })

  it('skips the call for empty input', async () => {
    const run = vi.fn()
    expect(await embedTexts({ AI: { run } } as unknown as Env, [], 'query')).toEqual([])
    expect(run).not.toHaveBeenCalled()
  })
})
