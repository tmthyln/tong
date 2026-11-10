import { describe, it, expect, vi } from 'vitest'
import { promoteDocumentToScope, promoteDocumentRelationshipsToScope } from './scope-promotion'
import { createSqliteD1, fixtures } from './testing/sqlite-d1'
import type { KbEntity, LinkQuery } from './extraction/resolve'
import type { ChatRequest, LlmClient } from './extraction/llm'

// ── promoteDocumentToScope against a migrated in-memory database ──────────

/**
 * Two-chunk documents whose chunk mentions are already grouped under
 * document-scope entities (as coreference leaves them).
 */
function seed() {
  const { db, d1 } = createSqliteD1()
  const scope = fixtures.scope(db)
  const docEntity = (docId: number, label: string, type: string, mentionIds: number[]) => {
    const id = Number(db.prepare(`INSERT INTO extracted_entity (source_document_id, entity_type, label, scope) VALUES (?, ?, ?, 'document')`).run(docId, type, label).lastInsertRowid)
    for (const m of mentionIds) db.prepare('UPDATE extracted_entity SET parent_id = ? WHERE id = ?').run(id, m)
    return id
  }
  const addDoc = (text: string, entities: Array<{ label: string; type: string; forms: string[] }>) => {
    const docId = fixtures.document(db, scope)
    const chunk = fixtures.chunk(db, docId, 0, text)
    const ids = entities.map((e) => docEntity(docId, e.label, e.type, e.forms.flatMap((f) => fixtures.mentions(db, docId, chunk, f, e.type))))
    return { docId, ids }
  }
  const parentOf = (id: number) => (db.prepare('SELECT parent_id FROM extracted_entity WHERE id = ?').get(id) as { parent_id: number | null }).parent_id
  const scopeEntities = () => db.prepare(`SELECT id, label FROM extracted_entity WHERE scope = 'scope'`).all() as Array<{ id: number; label: string }>
  return { db, env: { DB: d1, AI: { run: vi.fn() } } as unknown as Env, scope, addDoc, parentOf, scopeEntities }
}

/** Linker stub: link each query to the KB entry whose label is in `pairs[query.label]`. */
const linkByLabel = (pairs: Record<string, string>) => async (queries: LinkQuery[], kb: KbEntity[]) =>
  new Map(queries.map((q) => [q.id, kb.find((e) => e.label === pairs[q.label])?.id ?? null] as const))

describe('promoteDocumentToScope', () => {
  it('returns skipped when only one document is in the scope', async () => {
    const s = seed()
    s.addDoc('劉備在涿縣。劉備。', [{ label: '劉備', type: 'PERSON', forms: ['劉備'] }])
    const result = await promoteDocumentToScope(1, s.scope, s.env, { link: linkByLabel({}) })
    expect(result.skipped).toBe('only_one_document_in_scope')
  })

  it('mints a scope entity when a new document links to another document\'s entity', async () => {
    const s = seed()
    const a = s.addDoc('劉備起兵。劉備。', [{ label: '劉備', type: 'PERSON', forms: ['劉備'] }])
    const b = s.addDoc('玄德曰：劉玄德。玄德。', [{ label: '劉玄德', type: 'PERSON', forms: ['玄德', '劉玄德'] }])
    const result = await promoteDocumentToScope(b.docId, s.scope, s.env, { link: linkByLabel({ 劉玄德: '劉備' }) })
    expect(result).toMatchObject({ scopeEntitiesCreated: 1, scopeEntitiesLinked: 0, affectedDocumentIds: [a.docId], skipped: null })
    const [se] = s.scopeEntities()
    expect(s.parentOf(a.ids[0])).toBe(se.id)
    expect(s.parentOf(b.ids[0])).toBe(se.id)
  })

  it('links to an existing scope entity (third document)', async () => {
    const s = seed()
    const a = s.addDoc('劉備起兵。劉備。', [{ label: '劉備', type: 'PERSON', forms: ['劉備'] }])
    const b = s.addDoc('劉備曰。劉備。', [{ label: '劉備', type: 'PERSON', forms: ['劉備'] }])
    await promoteDocumentToScope(b.docId, s.scope, s.env, { link: linkByLabel({ 劉備: '劉備' }) })
    const c = s.addDoc('玄德至。玄德。', [{ label: '玄德', type: 'PERSON', forms: ['玄德'] }])
    const result = await promoteDocumentToScope(c.docId, s.scope, s.env, { link: linkByLabel({ 玄德: '劉備' }) })
    expect(result).toMatchObject({ scopeEntitiesCreated: 0, scopeEntitiesLinked: 1 })
    expect(s.scopeEntities()).toHaveLength(1)
    expect(s.parentOf(c.ids[0])).toBe(s.parentOf(a.ids[0]))
  })

  it('leaves unlinked entities unpromoted', async () => {
    const s = seed()
    s.addDoc('王曰。王。', [{ label: '王', type: 'PERSON', forms: ['王'] }])
    const b = s.addDoc('王至。王。', [{ label: '王', type: 'PERSON', forms: ['王'] }])
    const result = await promoteDocumentToScope(b.docId, s.scope, s.env, { link: linkByLabel({}) })
    expect(result.scopeEntitiesCreated).toBe(0)
    expect(s.parentOf(b.ids[0])).toBeNull()
  })

  it('gives the linker aliases and contexts from chunk mentions, and auto-links exact matches', async () => {
    const s = seed()
    s.addDoc('劉備字玄德。玄德起兵。', [{ label: '劉備', type: 'PERSON', forms: ['劉備', '玄德'] }])
    const b = s.addDoc('玄德曰：雲長何在？雲長。玄德。', [
      { label: '玄德', type: 'PERSON', forms: ['玄德'] },
      { label: '雲長', type: 'PERSON', forms: ['雲長'] },
    ])
    const requests: ChatRequest[] = []
    const client: LlmClient = {
      async chat(req) {
        requests.push(req)
        return { model: req.model, content: '{"links":{}}', finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1, cachedPromptTokens: 0, neurons: 0 }, latencyMs: 0 }
      },
    }
    const result = await promoteDocumentToScope(b.docId, s.scope, s.env, { client })
    // 玄德 is an exact alias of the KB's 劉備 → linked without a call; 雲長 has no candidate → no call.
    expect(requests).toHaveLength(0)
    expect(result.scopeEntitiesCreated).toBe(1)
    expect(s.scopeEntities()[0].label).toBe('劉備')
  })
})

// ── Mock env for promoteDocumentRelationshipsToScope ─────────────────────

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
