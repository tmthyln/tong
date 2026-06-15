import { describe, it, expect, vi } from 'vitest'
import { searchChunksByText } from './semantic-search'

function makeEnv(opts: {
  vector?: number[]
  matches?: { id: string; score: number }[]
  chunks?: { id: number; source_document_id: number | null; content: string }[]
}) {
  const run = vi.fn().mockResolvedValue({ data: opts.vector ? [opts.vector] : [[0.1, 0.2]] })
  const query = vi.fn().mockResolvedValue({ matches: opts.matches ?? [] })
  const all = vi.fn().mockResolvedValue({ results: opts.chunks ?? [] })
  const prepare = vi.fn(() => ({ bind: vi.fn(() => ({ all })) }))
  const env = { AI: { run }, CHUNK_VECTORS: { query }, DB: { prepare } } as unknown as Env
  return { env, run, query }
}

describe('searchChunksByText', () => {
  it('returns [] for an empty query without calling the model', async () => {
    const { env, run } = makeEnv({})
    expect(await searchChunksByText(env, { query: '  ' })).toEqual([])
    expect(run).not.toHaveBeenCalled()
  })

  it('resolves matches to chunk content, preserving similarity order', async () => {
    const { env } = makeEnv({
      matches: [
        { id: '5', score: 0.91 },
        { id: '3', score: 0.82 },
      ],
      chunks: [
        { id: 3, source_document_id: 1, content: 'chunk three' },
        { id: 5, source_document_id: 1, content: 'chunk five' },
      ],
    })

    const hits = await searchChunksByText(env, { query: '渔夫' })

    expect(hits).toEqual([
      { chunkId: 5, documentId: 1, content: 'chunk five', score: 0.91 },
      { chunkId: 3, documentId: 1, content: 'chunk three', score: 0.82 },
    ])
  })

  it('scopes to the current document via a metadata filter', async () => {
    const { env, query } = makeEnv({ matches: [], chunks: [] })
    await searchChunksByText(env, { query: '渔夫', documentId: 42 })
    expect(query).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      filter: { sourceDocumentId: { $eq: 42 } },
    }))
  })
})
