import { describe, it, expect, vi } from 'vitest'
import { createSqliteD1, fixtures } from './testing/sqlite-d1'
import {
  batchChunks,
  reembedDocument,
  reembedStaleChunks,
  REEMBED_BATCH_CHARS,
  REEMBED_BATCH_SIZE,
} from './reembed'
import { EMBEDDING_MODEL, EMBEDDING_VERSION } from './embedding'

type EmbedArgs = { input: string[] }

function setup(chunkCount: number) {
  const { db, d1 } = createSqliteD1()
  const documentId = fixtures.document(db)
  const otherDoc = fixtures.document(db)
  fixtures.chunk(db, otherDoc, 0, 'other')
  const chunkIds = Array.from({ length: chunkCount }, (_, i) =>
    fixtures.chunk(db, documentId, i, `chunk ${i}`)
  )
  const run = vi.fn().mockImplementation((_m: string, args: EmbedArgs) =>
    Promise.resolve({
      data: args.input.map((text, index) => ({ index, embedding: [text.length] })),
    })
  )
  const upsert = vi.fn().mockResolvedValue(undefined)
  const env = { DB: d1, AI: { run }, CHUNK_VECTORS: { upsert } } as unknown as Env
  const runs = () =>
    db.prepare('SELECT * FROM document_enrichment_run').all() as Array<Record<string, unknown>>
  const versions = () =>
    db.prepare('SELECT id, embedding_version AS v FROM text_chunk ORDER BY id').all() as Array<{
      id: number
      v: string | null
    }>
  return { db, env, run, upsert, documentId, otherDoc, chunkIds, runs, versions }
}

describe('reembedDocument', () => {
  it("re-embeds only this document's chunks, in batches, as documents", async () => {
    const n = REEMBED_BATCH_SIZE + 3
    const { env, run, upsert, documentId, chunkIds } = setup(n)

    const result = await reembedDocument(env, documentId)

    expect(result).toEqual({ documentId, chunksEmbedded: n })
    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.calls[0][0]).toBe(EMBEDDING_MODEL)
    expect((run.mock.calls[0][1] as EmbedArgs).input[0]).toBe('title: none | text: chunk 0')
    const upserted = upsert.mock.calls.flatMap((c) => c[0])
    expect(upserted.map((v: VectorizeVector) => v.id)).toEqual(chunkIds.map(String))
    expect(upserted[0].metadata).toMatchObject({ sourceDocumentId: documentId })
  })

  it('records a completed chunk_embedding run with the model', async () => {
    const { env, documentId, runs } = setup(2)
    await reembedDocument(env, documentId)
    const [r] = runs()
    expect(r).toMatchObject({ kind: 'chunk_embedding', status: 'completed', model: EMBEDDING_MODEL })
    expect(JSON.parse(r.result_summary_json as string)).toEqual({ chunks_embedded: 2 })
  })

  it('marks the run failed and rethrows when the model returns too few vectors', async () => {
    const { env, run, upsert, documentId, runs } = setup(2)
    run.mockResolvedValue({ data: [{ index: 0, embedding: [1] }] })
    await expect(reembedDocument(env, documentId)).rejects.toThrow(/expected 2 embeddings/)
    expect(upsert).not.toHaveBeenCalled()
    expect(runs()[0]).toMatchObject({ status: 'failed' })
  })

  it('handles a document with no chunks', async () => {
    const { env, run, documentId } = setup(0)
    const result = await reembedDocument(env, documentId)
    expect(result.chunksEmbedded).toBe(0)
    expect(run).not.toHaveBeenCalled()
  })
})

describe('reembedStaleChunks', () => {
  it('re-embeds stale chunks across documents up to the limit, then catches up', async () => {
    const { env, upsert, versions } = setup(5) // 6 chunks total incl. the other doc

    expect(await reembedStaleChunks(env, 4)).toEqual({ chunksEmbedded: 4, chunksFailed: 0, remaining: 2 })
    expect(upsert.mock.calls.flatMap((c) => c[0])).toHaveLength(4)

    expect(await reembedStaleChunks(env, 4)).toEqual({ chunksEmbedded: 2, chunksFailed: 0, remaining: 0 })
    expect(versions().every((r) => r.v === EMBEDDING_VERSION)).toBe(true)
  })

  it('picks up chunks embedded with an older version, and skips current ones', async () => {
    const { db, env, run, chunkIds } = setup(2)
    db.prepare('UPDATE text_chunk SET embedding_version = ?').run(EMBEDDING_VERSION)
    db.prepare('UPDATE text_chunk SET embedding_version = ? WHERE id = ?').run(
      '@cf/google/embeddinggemma-300m:768:p0',
      chunkIds[1]
    )

    expect(await reembedStaleChunks(env)).toEqual({ chunksEmbedded: 1, chunksFailed: 0, remaining: 0 })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when nothing is stale', async () => {
    const { db, env, run } = setup(3)
    db.prepare('UPDATE text_chunk SET embedding_version = ?').run(EMBEDDING_VERSION)
    expect(await reembedStaleChunks(env)).toEqual({ chunksEmbedded: 0, chunksFailed: 0, remaining: 0 })
    expect(run).not.toHaveBeenCalled()
  })

  it('retries a failed batch chunk by chunk so one bad chunk only blocks itself', async () => {
    const { env, run, versions, chunkIds } = setup(3)
    const poison = 'chunk 1'
    const ok = run.getMockImplementation()!
    run.mockImplementation((m: string, args: EmbedArgs) =>
      args.input.some((t) => t.endsWith(poison)) ? Promise.reject(new Error('bad input')) : ok(m, args)
    )
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(await reembedStaleChunks(env)).toEqual({ chunksEmbedded: 3, chunksFailed: 1, remaining: 1 })
    const stale = versions().filter((r) => r.v !== EMBEDDING_VERSION).map((r) => r.id)
    expect(stale).toEqual([chunkIds[1]])
  })

  it('leaves chunks stale when the model is down, for the next tick', async () => {
    const { env, run, versions } = setup(2)
    const ok = run.getMockImplementation()!
    run.mockRejectedValue(new Error('AI busy'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(await reembedStaleChunks(env)).toEqual({ chunksEmbedded: 0, chunksFailed: 3, remaining: 3 })
    expect(versions().every((r) => r.v === null)).toBe(true)

    run.mockImplementation(ok)
    expect(await reembedStaleChunks(env)).toMatchObject({ chunksEmbedded: 3, remaining: 0 })
  })
})

describe('reembedDocument version tracking', () => {
  it("stamps only that document's chunks with the current version", async () => {
    const { env, documentId, otherDoc, versions, db } = setup(2)
    await reembedDocument(env, documentId)
    const otherChunk = db
      .prepare('SELECT id FROM text_chunk WHERE source_document_id = ?')
      .get(otherDoc) as { id: number }
    for (const r of versions()) {
      expect(r.v).toBe(r.id === otherChunk.id ? null : EMBEDDING_VERSION)
    }
  })
})

describe('batchChunks', () => {
  const chunk = (id: number, len: number) => ({ id, documentId: 1, content: 'x'.repeat(len) })
  const ids = (batches: Array<Array<{ id: number }>>) => batches.map((b) => b.map((c) => c.id))

  it('caps batches by count', () => {
    const chunks = Array.from({ length: REEMBED_BATCH_SIZE + 1 }, (_, i) => chunk(i, 1))
    expect(batchChunks(chunks).map((b) => b.length)).toEqual([REEMBED_BATCH_SIZE, 1])
  })

  it('caps batches by total characters', () => {
    const half = REEMBED_BATCH_CHARS / 2
    expect(ids(batchChunks([chunk(1, half), chunk(2, half), chunk(3, 1)]))).toEqual([[1, 2], [3]])
  })

  it('puts an oversized chunk in a batch of its own', () => {
    const big = REEMBED_BATCH_CHARS * 2
    expect(ids(batchChunks([chunk(1, 10), chunk(2, big), chunk(3, 10)]))).toEqual([[1], [2], [3]])
  })

  it('returns no batches for no chunks', () => {
    expect(batchChunks([])).toEqual([])
  })
})
