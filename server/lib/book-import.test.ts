import { describe, it, expect, vi } from 'vitest'
import { createSqliteD1, fixtures } from './testing/sqlite-d1'
import { importBook } from './book-import'

function setup() {
  const { db, d1 } = createSqliteD1()
  const objects = new Map<string, { body: string; customMetadata?: Record<string, string> }>()
  const DOCUMENTS = {
    put: vi.fn(async (key: string, data: ArrayBuffer, opts?: { customMetadata?: Record<string, string> }) => {
      objects.set(key, { body: new TextDecoder().decode(data), customMetadata: opts?.customMetadata })
    }),
  } as unknown as R2Bucket
  const createBatch = vi.fn(async (batch: unknown[]) => batch.map((_, i) => ({ id: `wf-${i}` })))
  const env = { DB: d1, DOCUMENTS, INGEST_DOCUMENT_WORKFLOW: { createBatch } } as unknown as Pick<
    Env,
    'DB' | 'DOCUMENTS' | 'INGEST_DOCUMENT_WORKFLOW'
  >
  return { db, env, objects, createBatch }
}

const chapters = [
  { title: '第一回 甲', markdown: '一回正文' },
  { title: '第二回 乙', markdown: '二回正文' },
  { title: '第十回 丙', markdown: '十回正文' },
]

describe('importBook', () => {
  it('creates a root-level book collection with one ordered document per chapter', async () => {
    const { db, env, objects, createBatch } = setup()
    const scope = fixtures.scope(db)
    const result = await importBook(env, {
      title: '西遊記',
      chapters,
      sourceUrl: 'https://www.gutenberg.org/ebooks/23962',
      knowledgeScopeId: scope,
    })
    expect(result).toMatchObject({ alreadyExists: false, skippedChapters: 0 })
    if (result.alreadyExists) throw new Error('unreachable')

    const folder = db.prepare('SELECT * FROM document_group WHERE id = ?').get(result.folderId)
    expect(folder).toMatchObject({ name: '西遊記', parent_id: null, group_type: 'book', knowledge_scope_id: scope })

    const docs = db
      .prepare('SELECT id, original_doc_filename, original_doc_mimetype, parent_id, knowledge_scope_id, sort_index FROM document ORDER BY sort_index')
      .all()
    expect(docs).toEqual([
      { id: result.documentIds[0], original_doc_filename: '西遊記 - 01 第一回 甲.md', original_doc_mimetype: 'text/markdown', parent_id: result.folderId, knowledge_scope_id: scope, sort_index: 0 },
      { id: result.documentIds[1], original_doc_filename: '西遊記 - 02 第二回 乙.md', original_doc_mimetype: 'text/markdown', parent_id: result.folderId, knowledge_scope_id: scope, sort_index: 1 },
      { id: result.documentIds[2], original_doc_filename: '西遊記 - 03 第十回 丙.md', original_doc_mimetype: 'text/markdown', parent_id: result.folderId, knowledge_scope_id: scope, sort_index: 2 },
    ])

    const stored = [...objects.values()]
    // R2 writes run concurrently, so compare in sorted order.
    expect(stored.map((o) => o.body).sort()).toEqual(['# 第一回 甲\n\n一回正文\n', '# 第二回 乙\n\n二回正文\n', '# 第十回 丙\n\n十回正文\n'])
    expect(stored[0].customMetadata?.sourceUrl).toBe('https://www.gutenberg.org/ebooks/23962')

    expect(createBatch).toHaveBeenCalledTimes(1)
    expect(createBatch.mock.calls[0][0]).toEqual(
      result.documentIds.map((documentId) =>
        expect.objectContaining({
          params: expect.objectContaining({ documentId, parentId: result.folderId, knowledgeScopeId: scope, mimetype: 'text/markdown' }),
        })
      )
    )
  })

  it('reports an already-imported book instead of creating an empty collection', async () => {
    const { db, env } = setup()
    const input = { title: '西遊記', chapters, sourceUrl: 'u', knowledgeScopeId: null }
    const first = await importBook(env, input)
    const second = await importBook(env, input)
    expect(second).toEqual({ alreadyExists: true, folderId: first.folderId, documentIds: first.documentIds })
    expect(db.prepare('SELECT COUNT(*) AS n FROM document_group').get()).toEqual({ n: 1 })
  })

  it('skips chapters that are already in the library', async () => {
    const { db, env } = setup()
    await importBook(env, { title: 'A', chapters: chapters.slice(0, 1), sourceUrl: 'u', knowledgeScopeId: null })
    const result = await importBook(env, { title: 'A', chapters, sourceUrl: 'u', knowledgeScopeId: null })
    expect(result).toMatchObject({ alreadyExists: false, skippedChapters: 1 })
    expect(result.documentIds).toHaveLength(2)
    const sortIndexes = db
      .prepare('SELECT sort_index FROM document WHERE parent_id = ? ORDER BY sort_index')
      .all(result.folderId)
      .map((r) => r.sort_index)
    // Reading-order positions are preserved even with a gap.
    expect(sortIndexes).toEqual([1, 2])
  })

  it('starts workflows in batches of at most 100', async () => {
    const { env, createBatch } = setup()
    const many = Array.from({ length: 130 }, (_, i) => ({ title: `第${i}章`, markdown: `正文${i}` }))
    const result = await importBook(env, { title: 'Big', chapters: many, sourceUrl: 'u', knowledgeScopeId: null })
    expect(result.documentIds).toHaveLength(130)
    expect(createBatch.mock.calls.map((c) => c[0].length)).toEqual([100, 30])
  })
})
