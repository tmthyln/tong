import { Hono } from 'hono'
import { getUserId, userType } from '../lib/auth'
import { retranslateChunkWithTermPreferences } from '../lib/translation'
import { resolveDocumentCoreference } from '../lib/coreference'
import { extractRelationshipsForEdgeType } from '../lib/relationship-extraction'
import type { EdgeTypeInput } from '../lib/relationship-extraction'

const knowledgeRoutes = new Hono<{ Bindings: Env }>()

// POST /api/knowledge/document-entity-summary
//
// Request body: { documentId: number, entityId: number }
// Returns: { summary: string }
knowledgeRoutes.post('/document-entity-summary', async (c) => {
  const body = await c.req.json<{ documentId: number; entityId: number }>()
  const { documentId, entityId } = body

  // 1. Fetch the chunk entity
  const entity = await c.env.DB
    .prepare(
      `SELECT entity_type, extracted_text, source_chunk_id, parent_id
       FROM extracted_entity WHERE id = ? AND scope = 'chunk'`
    )
    .bind(entityId)
    .first<{ entity_type: string; extracted_text: string | null; source_chunk_id: number; parent_id: number | null }>()

  if (!entity) return c.json({ error: 'Entity not found' }, 404)

  // 3. Determine relationship entity ID
  const relEntityId = entity.parent_id ?? entityId

  // 2 & 4. Fetch chunk content and relationships in parallel
  const [chunkRow, { results: relRows }] = await Promise.all([
    c.env.DB
      .prepare(`SELECT content FROM text_chunk WHERE id = ?`)
      .bind(entity.source_chunk_id)
      .first<{ content: string }>(),
    c.env.DB
      .prepare(
        `SELECT er.edge_type, er.explanation,
                fe.label AS from_label, fe.extracted_text AS from_text,
                te.label AS to_label, te.extracted_text AS to_text
         FROM extracted_relationship er
         JOIN extracted_entity fe ON fe.id = er.from_entity_id
         JOIN extracted_entity te ON te.id = er.to_entity_id
         WHERE (er.from_entity_id = ? OR er.to_entity_id = ?)
           AND er.source_document_id = ?`
      )
      .bind(relEntityId, relEntityId, documentId)
      .all<{
        edge_type: string
        explanation: string | null
        from_label: string | null
        from_text: string | null
        to_label: string | null
        to_text: string | null
      }>(),
  ])

  const chunkContent = chunkRow?.content ?? ''

  // 5. Format relationships
  const relLines = relRows.map((r) => {
    const from = r.from_label ?? r.from_text ?? '?'
    const to = r.to_label ?? r.to_text ?? '?'
    const explanation = r.explanation ? `: ${r.explanation}` : ''
    return `- ${from} ${r.edge_type} ${to}${explanation}`
  })

  const relSection = relLines.length > 0
    ? `\nKnown relationships:\n${relLines.join('\n')}`
    : ''

  // 6. LLM call
  const entityLabel = entity.extracted_text ?? '(unknown)'
  const messages = [
    {
      role: 'system' as const,
      content: 'You are a knowledge assistant for Chinese literature. Give direct, compact entity descriptions in English. Never use filler phrases like "In this passage", "Based on the text", "According to". Start immediately with the description.',
    },
    {
      role: 'user' as const,
      content: `Entity: "${entityLabel}" (${entity.entity_type})

Passage:
${chunkContent}${relSection}

In 2–3 sentences, describe who or what "${entityLabel}" is in the context of this document.`,
    },
  ]

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await c.env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast' as any, {
    messages,
    temperature: 0.3,
    max_tokens: 300,
  })

  const summary = (result as { response?: string }).response ?? ''

  return c.json({ summary })
})

knowledgeRoutes.patch('/entity/:id/preferred-translation', async (c) => {
  if (userType(getUserId(c)) === 'public') {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const entityId = parseInt(c.req.param('id'), 10)
  const { preferredTranslation } = await c.req.json<{ preferredTranslation: string }>()

  const entity = await c.env.DB
    .prepare('SELECT id, parent_id, extracted_text, label, source_document_id, source_chunk_id FROM extracted_entity WHERE id = ?')
    .bind(entityId)
    .first<{ id: number; parent_id: number | null; extracted_text: string | null; label: string | null; source_document_id: number | null; source_chunk_id: number | null }>()

  if (!entity) return c.json({ error: 'Entity not found' }, 404)

  const targetId = entity.parent_id ?? entity.id
  const now = new Date().toISOString()
  const userId = getUserId(c)

  await c.env.DB
    .prepare('UPDATE extracted_entity SET preferred_translation = ?, preferred_translation_by = ?, preferred_translation_date = ? WHERE id = ?')
    .bind(preferredTranslation, userId, now, targetId)
    .run()

  // Resolve target entity details (needed if target is parent)
  const targetEntity = entity.parent_id != null
    ? await c.env.DB
        .prepare('SELECT extracted_text, label, source_document_id FROM extracted_entity WHERE id = ?')
        .bind(targetId)
        .first<{ extracted_text: string | null; label: string | null; source_document_id: number | null }>()
    : { extracted_text: entity.extracted_text, label: entity.label, source_document_id: entity.source_document_id }

  const termText = targetEntity?.label ?? targetEntity?.extracted_text ?? ''
  const documentId = targetEntity?.source_document_id ?? entity.source_document_id

  // Find all chunks to retranslate
  let chunkIds: number[]
  if (entity.parent_id != null) {
    // Document-scoped parent: retranslate all chunks whose entities share this parent
    const rows = await c.env.DB
      .prepare('SELECT DISTINCT source_chunk_id FROM extracted_entity WHERE parent_id = ? AND source_chunk_id IS NOT NULL')
      .bind(targetId)
      .all<{ source_chunk_id: number }>()
    chunkIds = rows.results.map((r) => r.source_chunk_id)
  } else {
    // Chunk-scoped entity with no parent: just its own chunk
    chunkIds = entity.source_chunk_id != null ? [entity.source_chunk_id] : []
  }

  if (chunkIds.length > 0 && documentId != null && termText) {
    const preferredTerms = [{ text: termText, translation: preferredTranslation }]
    c.executionCtx.waitUntil(
      Promise.all(
        chunkIds.map(async (chunkId) => {
          const row = await c.env.DB
            .prepare('SELECT content FROM text_chunk WHERE id = ?')
            .bind(chunkId)
            .first<{ content: string }>()
          if (!row) return
          await retranslateChunkWithTermPreferences(chunkId, documentId, row.content, preferredTerms, c.env)
        })
      )
    )
  }

  return c.json({ queued: chunkIds.length })
})

// POST /api/knowledge/entity
//
// Manually create a chunk-scoped entity from selected text.
// Body: { text, entityType, chunkId, documentId }
// Returns: { ids: number[] }  (one per occurrence of text in the chunk)
// Side-effects (async): coreference resolution + windowed relationship extraction.
knowledgeRoutes.post('/entity', async (c) => {
  if (userType(getUserId(c)) === 'public') {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const { text, entityType, chunkId, documentId } = await c.req.json<{
    text: string
    entityType: string
    chunkId: number
    documentId: number
  }>()

  if (!text?.trim() || !entityType?.trim()) {
    return c.json({ error: 'text and entityType are required' }, 400)
  }

  const chunk = await c.env.DB
    .prepare('SELECT content FROM text_chunk WHERE id = ?')
    .bind(chunkId)
    .first<{ content: string }>()
  if (!chunk) return c.json({ error: 'Chunk not found' }, 404)

  // Insert one entity row per occurrence of text in the chunk content.
  const insertedIds: number[] = []
  let searchFrom = 0
  while (true) {
    const pos = chunk.content.indexOf(text, searchFrom)
    if (pos === -1) break
    const row = await c.env.DB
      .prepare(
        `INSERT INTO extracted_entity
          (source_document_id, source_chunk_id, entity_type, extracted_text, scope, chunk_start_index, chunk_end_index)
         VALUES (?, ?, ?, ?, 'chunk', ?, ?)
         RETURNING id`
      )
      .bind(documentId, chunkId, entityType, text, pos, pos + text.length)
      .first<{ id: number }>()
    if (row) insertedIds.push(row.id)
    searchFrom = pos + text.length
  }

  if (insertedIds.length === 0) {
    return c.json({ error: 'Text not found in chunk content' }, 422)
  }

  c.executionCtx.waitUntil(
    (async () => {
      await resolveDocumentCoreference(documentId, c.env)
      await extractAndPersistChunkRelationships(chunkId, documentId, c.env)
    })()
  )

  return c.json({ ids: insertedIds })
})

async function extractAndPersistChunkRelationships(
  chunkId: number,
  documentId: number,
  env: Env
): Promise<void> {
  const chunkRow = await env.DB
    .prepare('SELECT chunk_order FROM text_chunk WHERE id = ?')
    .bind(chunkId)
    .first<{ chunk_order: number }>()
  if (!chunkRow) return

  const order = chunkRow.chunk_order

  const windowRows = await env.DB
    .prepare(
      `SELECT id FROM text_chunk WHERE source_document_id = ?
       AND chunk_order BETWEEN ? AND ? ORDER BY chunk_order`
    )
    .bind(documentId, order - 3, order + 3)
    .all<{ id: number }>()

  const windowChunkIds = windowRows.results.map((r) => r.id)
  if (windowChunkIds.length === 0) return

  const ph = windowChunkIds.map(() => '?').join(', ')

  const [contentRow, entityRows, edgeTypeRows, edgeExampleRows] = await Promise.all([
    env.DB.prepare(
      `SELECT GROUP_CONCAT(content, char(10)) AS window_content
       FROM (SELECT content FROM text_chunk WHERE id IN (${ph}) ORDER BY chunk_order)`
    )
      .bind(...windowChunkIds)
      .first<{ window_content: string }>(),
    env.DB.prepare(
      `SELECT id, entity_type, extracted_text FROM extracted_entity
       WHERE source_chunk_id IN (${ph}) AND scope = 'chunk' AND extracted_text IS NOT NULL`
    )
      .bind(...windowChunkIds)
      .all<{ id: number; entity_type: string; extracted_text: string }>(),
    env.DB.prepare('SELECT id, name, reverse_name, definition FROM edge_type ORDER BY name')
      .all<{ id: number; name: string; reverse_name: string | null; definition: string }>(),
    env.DB.prepare('SELECT edge_type_id, example FROM edge_type_example ORDER BY id')
      .all<{ edge_type_id: number; example: string }>(),
  ])

  const windowContent = contentRow?.window_content ?? ''
  const entities = entityRows.results.map((r) => ({ nodeType: r.entity_type, text: r.extracted_text }))

  const exByEdge: Record<number, string[]> = {}
  for (const ex of edgeExampleRows.results) {
    if (!exByEdge[ex.edge_type_id]) exByEdge[ex.edge_type_id] = []
    exByEdge[ex.edge_type_id].push(ex.example)
  }
  const edgeTypes: EdgeTypeInput[] = edgeTypeRows.results.map((et) => ({
    name: et.name,
    reverseName: et.reverse_name,
    definition: et.definition,
    examples: exByEdge[et.id] ?? [],
  }))

  if (edgeTypes.length === 0 || entities.length < 2) return

  const allRels: Array<{ fromText: string; toText: string; edgeType: string; explanation: string }> = []
  for (const edgeType of edgeTypes) {
    const rels = await extractRelationshipsForEdgeType(windowContent, entities, edgeType, env)
    allRels.push(...rels)
  }

  if (allRels.length === 0) return

  const textToIds = new Map<string, number[]>()
  for (const e of entityRows.results) {
    const arr = textToIds.get(e.extracted_text)
    if (arr) arr.push(e.id)
    else textToIds.set(e.extracted_text, [e.id])
  }

  const existingRows = await env.DB
    .prepare(
      `SELECT from_entity_id, to_entity_id, edge_type FROM extracted_relationship
       WHERE source_document_id = ? AND scope = 'chunk'`
    )
    .bind(documentId)
    .all<{ from_entity_id: number; to_entity_id: number; edge_type: string }>()

  const existingKeys = new Set(
    existingRows.results.map((r) => `${r.from_entity_id}|${r.to_entity_id}|${r.edge_type}`)
  )

  const toInsert: Array<{ fromId: number; toId: number; edgeType: string; explanation: string }> = []
  const seen = new Set<string>()

  for (const rel of allRels) {
    const fromIds = textToIds.get(rel.fromText) ?? []
    const toIds = textToIds.get(rel.toText) ?? []
    for (const fromId of fromIds) {
      for (const toId of toIds) {
        if (fromId === toId) continue
        const key = `${fromId}|${toId}|${rel.edgeType}`
        if (existingKeys.has(key) || seen.has(key)) continue
        seen.add(key)
        toInsert.push({ fromId, toId, edgeType: rel.edgeType, explanation: rel.explanation })
      }
    }
  }

  if (toInsert.length > 0) {
    const stmt = env.DB.prepare(
      `INSERT INTO extracted_relationship
        (source_document_id, from_entity_id, to_entity_id, edge_type, explanation, scope)
       VALUES (?, ?, ?, ?, ?, 'chunk')`
    )
    await env.DB.batch(
      toInsert.map((r) => stmt.bind(documentId, r.fromId, r.toId, r.edgeType, r.explanation))
    )
  }
}

export default knowledgeRoutes
