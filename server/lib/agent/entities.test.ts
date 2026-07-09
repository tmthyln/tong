import { describe, it, expect, vi } from 'vitest'
import {
  createEntityFromText,
  deleteEntityCascade,
  rebuildDocumentScopeRelationships,
  searchEntities,
} from './entities'

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

// ── Stateful fake DB for rebuildDocumentScopeRelationships ──────────────────

interface ChunkEntity {
  id: number
  parent_id: number | null
  entity_type: string
  extracted_text: string | null
}
interface ChunkRel {
  from_entity_id: number
  to_entity_id: number
  edge_type: string
  explanation: string | null
}
interface RebuildState {
  chunkEntities: ChunkEntity[]
  chunkRels: ChunkRel[]
  docRelDeletes: number // count of DELETE ... scope='document' calls
  promotions: { id: number; entity_type: string; extracted_text: string | null }[]
  parentUpdates: { entityId: number; parentId: number }[]
  insertedDocRels: { from: number; to: number; edge_type: string; explanation: string | null }[]
  nextId: number
}

function makeRebuildEnv(state: RebuildState): Env {
  const runEffect = (sql: string, args: unknown[]) => {
    if (sql.includes('DELETE FROM extracted_relationship') && sql.includes("scope = 'document'")) {
      state.docRelDeletes++
    } else if (sql.includes('UPDATE extracted_entity SET parent_id')) {
      state.parentUpdates.push({ parentId: args[0] as number, entityId: args[1] as number })
    } else if (sql.includes('INSERT INTO extracted_relationship') && sql.includes("'document'")) {
      state.insertedDocRels.push({
        from: args[1] as number,
        to: args[2] as number,
        edge_type: args[3] as string,
        explanation: (args[4] ?? null) as string | null,
      })
    }
  }

  const prepare = (sql: string) => {
    const bind = (...args: unknown[]) => ({
      run: async () => {
        runEffect(sql, args)
        return {}
      },
      first: async <T>() => {
        if (sql.includes('INSERT INTO extracted_entity') && sql.includes("'document'")) {
          const id = state.nextId++
          state.promotions.push({
            id,
            entity_type: args[1] as string,
            extracted_text: (args[2] ?? null) as string | null,
          })
          return { id } as unknown as T
        }
        return null
      },
      all: async <T>() => {
        if (sql.includes('FROM extracted_relationship') && sql.includes("scope = 'chunk'")) {
          return { results: state.chunkRels as unknown as T[] }
        }
        if (sql.includes('FROM extracted_entity') && sql.includes("scope = 'chunk'")) {
          return { results: state.chunkEntities as unknown as T[] }
        }
        return { results: [] as T[] }
      },
    })
    return { bind }
  }

  const batch = async (stmts: Array<{ run: () => Promise<unknown> }>) => {
    for (const s of stmts) await s.run()
    return []
  }

  return { DB: { prepare, batch } } as unknown as Env
}

function freshRebuildState(overrides: Partial<RebuildState> = {}): RebuildState {
  return {
    chunkEntities: [],
    chunkRels: [],
    docRelDeletes: 0,
    promotions: [],
    parentUpdates: [],
    insertedDocRels: [],
    nextId: 1000,
    ...overrides,
  }
}

describe('rebuildDocumentScopeRelationships', () => {
  it('rebuilds every document-scope relationship from surviving chunk-scope rels, not just one window', async () => {
    const state = freshRebuildState({
      chunkEntities: [
        { id: 1, parent_id: 500, entity_type: 'PERSON', extracted_text: '张三' },
        { id: 2, parent_id: 500, entity_type: 'PERSON', extracted_text: '张三' },
        { id: 3, parent_id: null, entity_type: 'PLACE', extracted_text: '北京' }, // singleton → promote
        { id: 4, parent_id: 501, entity_type: 'PERSON', extracted_text: '李四' },
      ],
      chunkRels: [
        { from_entity_id: 1, to_entity_id: 3, edge_type: 'LIVES_IN', explanation: 'a' },
        { from_entity_id: 4, to_entity_id: 3, edge_type: 'VISITED', explanation: 'b' },
        { from_entity_id: 2, to_entity_id: 4, edge_type: 'KNOWS', explanation: 'c' },
        { from_entity_id: 1, to_entity_id: 2, edge_type: 'SELF', explanation: 'd' }, // 500→500, skipped
      ],
    })
    const env = makeRebuildEnv(state)

    await rebuildDocumentScopeRelationships(42, env)

    // Singleton 北京 promoted exactly once and reused across both its relationships.
    expect(state.promotions).toEqual([{ id: 1000, entity_type: 'PLACE', extracted_text: '北京' }])
    expect(state.parentUpdates).toEqual([{ entityId: 3, parentId: 1000 }])

    // Self-loop (500→500) dropped; the other three become document-scope rels.
    expect(state.insertedDocRels).toEqual([
      { from: 500, to: 1000, edge_type: 'LIVES_IN', explanation: 'a' },
      { from: 501, to: 1000, edge_type: 'VISITED', explanation: 'b' },
      { from: 500, to: 501, edge_type: 'KNOWS', explanation: 'c' },
    ])
    // Idempotency: cleared existing document-scope rels before rebuilding.
    expect(state.docRelDeletes).toBe(1)
  })

  it('deduplicates chunk rels that collapse to the same parent pair + edge', async () => {
    const state = freshRebuildState({
      chunkEntities: [
        { id: 1, parent_id: 500, entity_type: 'PERSON', extracted_text: '张三' },
        { id: 2, parent_id: 500, entity_type: 'PERSON', extracted_text: '张三' },
        { id: 3, parent_id: 600, entity_type: 'PERSON', extracted_text: '李四' },
        { id: 4, parent_id: 600, entity_type: 'PERSON', extracted_text: '李四' },
      ],
      chunkRels: [
        { from_entity_id: 1, to_entity_id: 3, edge_type: 'KNOWS', explanation: 'x' },
        { from_entity_id: 2, to_entity_id: 4, edge_type: 'KNOWS', explanation: 'y' },
      ],
    })
    const env = makeRebuildEnv(state)

    await rebuildDocumentScopeRelationships(7, env)

    expect(state.insertedDocRels).toEqual([{ from: 500, to: 600, edge_type: 'KNOWS', explanation: 'x' }])
  })

  it('clears stale document-scope rels and inserts nothing when there are no chunk rels', async () => {
    const state = freshRebuildState({ chunkRels: [] })
    const env = makeRebuildEnv(state)

    await rebuildDocumentScopeRelationships(3, env)

    expect(state.docRelDeletes).toBe(1)
    expect(state.insertedDocRels).toEqual([])
    expect(state.promotions).toEqual([])
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
