import { describe, it, expect, vi } from 'vitest'
import { resolveDocumentCoreference } from './coreference'
import { createSqliteD1, fixtures } from './testing/sqlite-d1'
import type { ChatRequest, LlmClient } from './extraction/llm'

function setup() {
  const { db, d1 } = createSqliteD1()
  const doc = fixtures.document(db)
  const c0 = fixtures.chunk(db, doc, 0, '劉備字玄德，涿郡人也。玄德與關羽結義。')
  const c1 = fixtures.chunk(db, doc, 1, '玄德曰：「雲長何在？」關羽至。張飛。')
  const ids = {
    liubei: fixtures.mentions(db, doc, c0, '劉備', 'PERSON'),
    xuande: [...fixtures.mentions(db, doc, c0, '玄德', 'PERSON'), ...fixtures.mentions(db, doc, c1, '玄德', 'PERSON')],
    guanyu: [...fixtures.mentions(db, doc, c0, '關羽', 'PERSON'), ...fixtures.mentions(db, doc, c1, '關羽', 'PERSON')],
    yunchang: fixtures.mentions(db, doc, c1, '雲長', 'PERSON'),
    zhangfei: fixtures.mentions(db, doc, c1, '張飛', 'PERSON'),
  }
  const env = { DB: d1, AI: { run: vi.fn() } } as unknown as Env
  const parentOf = (id: number) => (db.prepare('SELECT parent_id FROM extracted_entity WHERE id = ?').get(id) as { parent_id: number | null }).parent_id
  const docEntities = () => db.prepare(`SELECT id, label, entity_type FROM extracted_entity WHERE scope = 'document' ORDER BY id`).all() as Array<{ id: number; label: string; entity_type: string }>
  return { db, doc, env, ids, parentOf, docEntities }
}

function client(content: string | Error, requests: ChatRequest[] = []): LlmClient {
  return {
    async chat(req) {
      requests.push(req)
      if (content instanceof Error) throw content
      return { model: req.model, content, finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1, cachedPromptTokens: 0, neurons: 0 }, latencyMs: 0 }
    },
  }
}

describe('resolveDocumentCoreference', () => {
  it('sends one call over distinct surface forms and parents alias groups', async () => {
    const s = setup()
    const requests: ChatRequest[] = []
    // Forms in first-occurrence order: 1 劉備, 2 玄德, 3 關羽, 4 雲長, 5 張飛
    const result = await resolveDocumentCoreference(s.doc, s.env, {
      client: client('{"groups":[{"ids":[1,2],"label":"劉備"},{"ids":[3,4],"label":"關羽"}]}', requests),
    })
    expect(requests).toHaveLength(1)
    expect(requests[0].messages[1].content).toContain('2 | PERSON | ×3 | 玄德\n')
    expect(result).toEqual({ documentEntities: 3, chunkEntitiesLinked: 8, errors: [] })
    const ents = s.docEntities()
    expect(ents.map((e) => e.label)).toEqual(['劉備', '關羽', '張飛'])
    for (const id of [...s.ids.liubei, ...s.ids.xuande]) expect(s.parentOf(id)).toBe(ents[0].id)
    for (const id of [...s.ids.guanyu, ...s.ids.yunchang]) expect(s.parentOf(id)).toBe(ents[1].id)
    // A name mentioned once is still an entity.
    expect(s.parentOf(s.ids.zhangfei[0])).toBe(ents[2].id)
  })

  it('is idempotent', async () => {
    const s = setup()
    const c = client('{"groups":[{"ids":[1,2],"label":"劉備"}]}')
    await resolveDocumentCoreference(s.doc, s.env, { client: c })
    await resolveDocumentCoreference(s.doc, s.env, { client: c })
    expect(s.docEntities().map((e) => e.label)).toEqual(['劉備', '關羽', '雲長', '張飛'])
  })

  it('falls back to identical-text grouping when the model fails', async () => {
    const s = setup()
    const result = await resolveDocumentCoreference(s.doc, s.env, { client: client(new Error('down')) })
    expect(result.errors).toHaveLength(1)
    // Every distinct name becomes an entity; nothing is merged across names.
    expect(s.docEntities().map((e) => e.label)).toEqual(['劉備', '玄德', '關羽', '雲長', '張飛'])
  })

  it('updates more than 100 mentions of one entity (D1 parameter cap)', async () => {
    const { db, d1 } = createSqliteD1()
    const doc = fixtures.document(db)
    const chunk = fixtures.chunk(db, doc, 0, '唐三。'.repeat(150))
    const ids = fixtures.mentions(db, doc, chunk, '唐三', 'PERSON')
    const result = await resolveDocumentCoreference(doc, { DB: d1 } as unknown as Env, { client: client('{"groups":[]}') })
    expect(result.chunkEntitiesLinked).toBe(150)
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM extracted_entity WHERE parent_id IS NOT NULL AND id IN (${ids.join(',')})`).get() as { n: number }).n
    expect(n).toBe(150)
  })
})
