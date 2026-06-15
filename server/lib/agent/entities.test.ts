import { describe, it, expect, vi } from 'vitest'
import { createEntityFromText, deleteEntityCascade, searchEntities } from './entities'

type Route = { match: string; first?: unknown | (() => unknown); all?: unknown }

function dbFromRoutes(routes: Route[], batch = vi.fn().mockResolvedValue([])) {
  const prepare = vi.fn((sql: string) => {
    const r = routes.find((x) => sql.includes(x.match))
    return {
      bind: vi.fn(() => ({
        first: vi.fn().mockImplementation(async () =>
          typeof r?.first === 'function' ? (r.first as () => unknown)() : (r?.first ?? null),
        ),
        all: vi.fn().mockResolvedValue(r?.all ?? { results: [] }),
        run: vi.fn().mockResolvedValue({}),
      })),
    }
  })
  return { DB: { prepare, batch } } as unknown as Env
}

describe('createEntityFromText', () => {
  it('rejects empty text or entityType with 400', async () => {
    const env = dbFromRoutes([])
    expect(await createEntityFromText(env, { text: '  ', entityType: 'PERSON', chunkId: 1, documentId: 1 })).toEqual({
      ok: false,
      status: 400,
      error: 'text and entityType are required',
    })
  })

  it('returns 404 when the chunk does not exist', async () => {
    const env = dbFromRoutes([{ match: 'SELECT content FROM text_chunk', first: null }])
    expect(await createEntityFromText(env, { text: '鱼', entityType: 'X', chunkId: 9, documentId: 1 })).toEqual({
      ok: false,
      status: 404,
      error: 'Chunk not found',
    })
  })

  it('returns 422 when the text is not present in the chunk', async () => {
    const env = dbFromRoutes([{ match: 'SELECT content FROM text_chunk', first: { content: '其他内容' } }])
    expect(await createEntityFromText(env, { text: '鱼', entityType: 'X', chunkId: 1, documentId: 1 })).toEqual({
      ok: false,
      status: 422,
      error: 'Text not found in chunk content',
    })
  })

  it('inserts one entity per occurrence and returns their ids', async () => {
    let n = 0
    const env = dbFromRoutes([
      { match: 'SELECT content FROM text_chunk', first: { content: '我有鱼和鱼' } },
      { match: 'INSERT INTO extracted_entity', first: () => ({ id: ++n }) },
    ])
    const result = await createEntityFromText(env, { text: '鱼', entityType: 'ANIMAL', chunkId: 1, documentId: 2 })
    expect(result).toEqual({ ok: true, ids: [1, 2] })
  })
})

describe('deleteEntityCascade', () => {
  it('returns 404 when the entity does not exist', async () => {
    const env = dbFromRoutes([{ match: 'SELECT id, parent_id FROM extracted_entity', first: null }])
    expect(await deleteEntityCascade(env, 5)).toEqual({ ok: false, status: 404, error: 'Entity not found' })
  })

  it('cascades the delete and returns ok', async () => {
    const batch = vi.fn().mockResolvedValue([])
    const env = dbFromRoutes([{ match: 'SELECT id, parent_id FROM extracted_entity', first: { id: 5, parent_id: null } }], batch)
    expect(await deleteEntityCascade(env, 5)).toEqual({ ok: true })
    expect(batch).toHaveBeenCalledTimes(1)
  })
})

describe('searchEntities', () => {
  it('maps rows to camelCase hits', async () => {
    const env = dbFromRoutes([
      {
        match: 'FROM extracted_entity',
        all: {
          results: [
            { id: 1, label: '孔子', entity_type: 'PERSON', extracted_text: '孔子', preferred_translation: 'Confucius' },
          ],
        },
      },
    ])
    const hits = await searchEntities(env, { documentId: 1, query: '孔' })
    expect(hits).toEqual([
      { id: 1, label: '孔子', entityType: 'PERSON', extractedText: '孔子', preferredTranslation: 'Confucius' },
    ])
  })
})
