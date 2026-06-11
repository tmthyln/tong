import { describe, it, expect, vi } from 'vitest'
import {
  defaultIsCoreferent,
  groupCandidatesByComponent,
  classifyComponent,
  promoteDocumentToScope,
  promoteDocumentRelationshipsToScope,
} from './scope-promotion'

interface PromotionCandidate {
  id: number
  entityType: string
  label: string
  sourceDocumentId: number | null
}

const cand = (
  id: number,
  entityType: string,
  label: string,
  sourceDocumentId: number | null
): PromotionCandidate => ({ id, entityType, label, sourceDocumentId })

describe('defaultIsCoreferent', () => {
  it('matches identical labels of the same type', () => {
    expect(defaultIsCoreferent(cand(1, 'Person', '孔子', 1), cand(2, 'Person', '孔子', 2))).toBe(true)
  })

  it('rejects matches across types', () => {
    expect(defaultIsCoreferent(cand(1, 'Person', '北京', 1), cand(2, 'Place', '北京', 2))).toBe(false)
  })

  it('fuzzy-matches near-identical labels when both are length ≥ 3', () => {
    // 长安城 vs 长安市 — same type, length 3, edit distance 1/3 < 0.3? actually 1/3 ≈ 0.33; pick a closer pair
    expect(defaultIsCoreferent(cand(1, 'Place', '长安城', 1), cand(2, 'Place', '长安城邦', 2))).toBe(true)
  })

  it('rejects fuzzy match when either label is shorter than 3', () => {
    expect(defaultIsCoreferent(cand(1, 'Place', '北京市', 1), cand(2, 'Place', '北京', 2))).toBe(false)
  })

  it('rejects short fuzzy candidates', () => {
    expect(defaultIsCoreferent(cand(1, 'Place', '北', 1), cand(2, 'Place', '南', 2))).toBe(false)
  })
})

describe('groupCandidatesByComponent', () => {
  it('groups connected same-type candidates into components', () => {
    const all: PromotionCandidate[] = [
      cand(1, 'Person', '孔子', 1),
      cand(2, 'Person', '孔子', 2),
      cand(3, 'Place', '北京', 1),
      cand(4, 'Place', '北京', 3),
      cand(5, 'Person', 'unmatched', 1),
    ]
    const comps = groupCandidatesByComponent(all, defaultIsCoreferent)
    expect(comps).toHaveLength(2)
    const ids = comps.map((c) => c.map((m) => m.id).sort())
    expect(ids).toContainEqual([1, 2])
    expect(ids).toContainEqual([3, 4])
  })

  it('excludes singletons (no neighbor)', () => {
    const all = [cand(1, 'X', 'a', 1), cand(2, 'X', 'totally different', 2)]
    expect(groupCandidatesByComponent(all, defaultIsCoreferent)).toHaveLength(0)
  })
})

describe('classifyComponent', () => {
  it('links to an anchor when present (even with one doc member)', () => {
    const v = classifyComponent([cand(1, 'Person', '孔子', null), cand(2, 'Person', '孔子', 1)])
    expect(v.shouldLinkOnly).toBe(true)
    expect(v.shouldCreate).toBe(false)
    expect(v.anchor?.id).toBe(1)
  })

  it('creates a new scope entity when ≥2 distinct documents agree (no anchor)', () => {
    const v = classifyComponent([
      cand(1, 'Person', '孔子', 10),
      cand(2, 'Person', '孔子', 20),
    ])
    expect(v.shouldCreate).toBe(true)
    expect(v.shouldLinkOnly).toBe(false)
    expect(v.distinctDocCount).toBe(2)
  })

  it('does nothing when the component is all from one document', () => {
    const v = classifyComponent([
      cand(1, 'Place', '北京', 5),
      cand(2, 'Place', '北京', 5),
    ])
    expect(v.shouldCreate).toBe(false)
    expect(v.shouldLinkOnly).toBe(false)
  })
})

// ── Mock env for promoteDocumentToScope ──────────────────────

interface FakeStatement {
  bind: (...args: unknown[]) => FakeStatement
  first: <T>() => Promise<T | null>
  all: <T>() => Promise<{ results: T[] }>
  run: () => Promise<void>
}

interface MockState {
  docCount: number
  triggerEntities: { id: number; entity_type: string; label: string }[]
  scopeEntities: { id: number; entity_type: string; label: string }[]
  otherEntities: { id: number; entity_type: string; label: string; source_document_id: number }[]
  insertedScopeEntities: {
    id: number
    entity_type: string
    label: string
    knowledge_scope_id: number
    source_document_id: number
  }[]
  parentIdUpdates: { ids: number[]; parentId: number }[]
  nextScopeEntityId: number
  // For relationship promotion
  docRelationships: {
    id: number
    edge_type: string
    explanation: string | null
    from_parent: number | null
    to_parent: number | null
  }[]
  existingScopeRels: Set<string>
  insertedScopeRels: {
    from: number
    to: number
    edge_type: string
    knowledge_scope_id: number
  }[]
}

function makeEnv(state: MockState): Env {
  const prepare = (sql: string): FakeStatement => {
    let bound: unknown[] = []
    const stmt: FakeStatement = {
      bind: (...args) => {
        bound = args
        return stmt
      },
      first: async <T>() => {
        if (sql.includes('COUNT(*) AS n FROM document WHERE knowledge_scope_id')) {
          return { n: state.docCount } as unknown as T
        }
        if (sql.includes('INSERT INTO extracted_entity')) {
          const id = state.nextScopeEntityId++
          state.insertedScopeEntities.push({
            id,
            source_document_id: bound[0] as number,
            entity_type: bound[1] as string,
            label: bound[2] as string,
            knowledge_scope_id: bound[3] as number,
          })
          return { id } as unknown as T
        }
        if (sql.includes("scope = 'scope'") && sql.includes('extracted_relationship') && sql.includes('LIMIT 1')) {
          const key = `${bound[1]}|${bound[2]}|${bound[3]}`
          return state.existingScopeRels.has(key) ? ({ id: 1 } as unknown as T) : null
        }
        return null
      },
      all: async <T>() => {
        if (sql.includes("scope = 'document'") && sql.includes('AND label IS NOT NULL') && sql.includes('source_document_id = ?')) {
          return { results: state.triggerEntities as unknown as T[] }
        }
        if (sql.includes("scope = 'scope'") && sql.includes('knowledge_scope_id = ?') && sql.includes('label IS NOT NULL')) {
          return { results: state.scopeEntities as unknown as T[] }
        }
        if (sql.includes("scope = 'document'") && sql.includes('parent_id IS NULL') && sql.includes('source_document_id != ?')) {
          return { results: state.otherEntities as unknown as T[] }
        }
        if (sql.includes("scope = 'document'") && sql.includes('extracted_relationship')) {
          return { results: state.docRelationships as unknown as T[] }
        }
        return { results: [] }
      },
      run: async () => {
        if (sql.includes('UPDATE extracted_entity SET parent_id = ? WHERE id IN')) {
          const parentId = bound[0] as number
          const ids = bound.slice(1) as number[]
          state.parentIdUpdates.push({ ids, parentId })
        }
        if (sql.includes('INSERT INTO extracted_relationship')) {
          state.insertedScopeRels.push({
            from: bound[1] as number,
            to: bound[2] as number,
            edge_type: bound[3] as string,
            knowledge_scope_id: bound[5] as number,
          })
        }
      },
    }
    return stmt
  }
  return { DB: { prepare } as unknown as D1Database, AI: { run: vi.fn() } } as unknown as Env
}

function freshState(overrides: Partial<MockState> = {}): MockState {
  return {
    docCount: 2,
    triggerEntities: [],
    scopeEntities: [],
    otherEntities: [],
    insertedScopeEntities: [],
    parentIdUpdates: [],
    nextScopeEntityId: 1000,
    docRelationships: [],
    existingScopeRels: new Set(),
    insertedScopeRels: [],
    ...overrides,
  }
}

describe('promoteDocumentToScope — ≥2-doc rule', () => {
  it('returns skipped when only one document is in the scope', async () => {
    const state = freshState({ docCount: 1 })
    const env = makeEnv(state)
    const result = await promoteDocumentToScope(7, 99, env, {
      refineGroupsLLM: async (b) => [b],
    })
    expect(result.skipped).toBe('only_one_document_in_scope')
    expect(state.insertedScopeEntities).toHaveLength(0)
  })

  it('mints a scope entity when ≥2 documents share an entity', async () => {
    const state = freshState({
      docCount: 2,
      triggerEntities: [{ id: 100, entity_type: 'Person', label: '孔子' }],
      otherEntities: [{ id: 200, entity_type: 'Person', label: '孔子', source_document_id: 5 }],
    })
    const env = makeEnv(state)
    const result = await promoteDocumentToScope(7, 99, env, {
      refineGroupsLLM: async (b) => [b],
    })
    expect(result.skipped).toBeNull()
    expect(result.scopeEntitiesCreated).toBe(1)
    expect(result.affectedDocumentIds).toEqual([5])
    expect(state.insertedScopeEntities).toHaveLength(1)
    expect(state.insertedScopeEntities[0].label).toBe('孔子')
    expect(state.insertedScopeEntities[0].knowledge_scope_id).toBe(99)
    expect(state.parentIdUpdates).toHaveLength(1)
    expect(state.parentIdUpdates[0].ids.sort()).toEqual([100, 200])
  })

  it('does NOT mint a scope entity for a single-doc group', async () => {
    const state = freshState({
      docCount: 2,
      triggerEntities: [
        { id: 100, entity_type: 'Person', label: 'unique' },
        { id: 101, entity_type: 'Person', label: 'unique' },
      ],
      otherEntities: [],
    })
    const env = makeEnv(state)
    const result = await promoteDocumentToScope(7, 99, env, {
      refineGroupsLLM: async (b) => [b],
    })
    expect(result.scopeEntitiesCreated).toBe(0)
    expect(state.insertedScopeEntities).toHaveLength(0)
  })

  it('links a new doc to an existing scope entity (3rd doc case)', async () => {
    const state = freshState({
      docCount: 3,
      triggerEntities: [{ id: 100, entity_type: 'Person', label: '孔子' }],
      scopeEntities: [{ id: 500, entity_type: 'Person', label: '孔子' }],
    })
    const env = makeEnv(state)
    const result = await promoteDocumentToScope(7, 99, env, {
      refineGroupsLLM: async (b) => [b],
    })
    expect(result.scopeEntitiesCreated).toBe(0)
    expect(result.scopeEntitiesLinked).toBe(1)
    expect(state.parentIdUpdates).toHaveLength(1)
    expect(state.parentIdUpdates[0].parentId).toBe(500)
    expect(state.parentIdUpdates[0].ids).toEqual([100])
  })

  it('does not mint a scope entity when the LLM splits the batch into single-doc groups', async () => {
    const state = freshState({
      docCount: 2,
      triggerEntities: [{ id: 100, entity_type: 'Person', label: '王' }],
      otherEntities: [{ id: 200, entity_type: 'Person', label: '王', source_document_id: 5 }],
    })
    const env = makeEnv(state)
    // LLM disambiguates: the two "王" are different people, return them as singleton groups.
    const result = await promoteDocumentToScope(7, 99, env, {
      refineGroupsLLM: async () => [],
    })
    expect(result.scopeEntitiesCreated).toBe(0)
    expect(state.insertedScopeEntities).toHaveLength(0)
  })
})

describe('promoteDocumentRelationshipsToScope', () => {
  it('promotes a relationship when both endpoints have scope parents', async () => {
    const state = freshState({
      docRelationships: [
        {
          id: 1,
          edge_type: 'defeated',
          explanation: 'A overcame B',
          from_parent: 500,
          to_parent: 501,
        },
      ],
    })
    const env = makeEnv(state)
    const result = await promoteDocumentRelationshipsToScope(7, 99, env)
    expect(result.relationshipsPromoted).toBe(1)
    expect(state.insertedScopeRels).toEqual([
      { from: 500, to: 501, edge_type: 'defeated', knowledge_scope_id: 99 },
    ])
  })

  it('skips a relationship when an endpoint has no scope parent', async () => {
    const state = freshState({
      docRelationships: [
        { id: 1, edge_type: 'x', explanation: null, from_parent: null, to_parent: 501 },
      ],
    })
    const env = makeEnv(state)
    const result = await promoteDocumentRelationshipsToScope(7, 99, env)
    expect(result.relationshipsPromoted).toBe(0)
  })

  it('skips duplicates of existing scope relationships', async () => {
    const state = freshState({
      docRelationships: [
        { id: 1, edge_type: 'defeated', explanation: 'x', from_parent: 500, to_parent: 501 },
      ],
      existingScopeRels: new Set(['500|501|defeated']),
    })
    const env = makeEnv(state)
    const result = await promoteDocumentRelationshipsToScope(7, 99, env)
    expect(result.relationshipsPromoted).toBe(0)
    expect(state.insertedScopeRels).toHaveLength(0)
  })

  it('promotes a single-document relationship (no ≥2-doc threshold)', async () => {
    const state = freshState({
      docRelationships: [
        { id: 1, edge_type: 'lived_in', explanation: null, from_parent: 500, to_parent: 501 },
      ],
    })
    const env = makeEnv(state)
    const result = await promoteDocumentRelationshipsToScope(7, 99, env)
    expect(result.relationshipsPromoted).toBe(1)
  })
})
