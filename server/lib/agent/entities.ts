// Shared core for entity create / delete / search.
//
// Extracted from server/routes/knowledge.ts so the same logic backs both the
// standalone routes and the agent's entity tools. The post-change enrichment
// (coreference + relationship extraction) is exposed separately so callers can
// run it in the background via waitUntil.

import { resolveDocumentCoreference } from '../coreference'
import { extractRelationshipsForEdgeType, type EdgeTypeInput } from '../relationship-extraction'

export interface CreateEntityParams {
  text: string
  entityType: string
  chunkId: number
  documentId: number
}

export type CreateEntityResult =
  | { ok: true; ids: number[] }
  | { ok: false; status: 400 | 404 | 422; error: string }

export type DeleteEntityResult = { ok: true } | { ok: false; status: 404; error: string }

export interface EntitySearchHit {
  id: number
  label: string | null
  entityType: string
  extractedText: string | null
  preferredTranslation: string | null
}

/**
 * Create a chunk-scoped entity for each occurrence of `text` in the chunk.
 * Does NOT run enrichment — call {@link enrichAfterEntityChange} afterwards
 * (typically via waitUntil) to refresh coreference + relationships.
 */
export async function createEntityFromText(
  env: Env,
  params: CreateEntityParams,
): Promise<CreateEntityResult> {
  const { text, entityType, chunkId, documentId } = params

  if (!text?.trim() || !entityType?.trim()) {
    return { ok: false, status: 400, error: 'text and entityType are required' }
  }

  const chunk = await env.DB
    .prepare('SELECT content FROM text_chunk WHERE id = ?')
    .bind(chunkId)
    .first<{ content: string }>()
  if (!chunk) return { ok: false, status: 404, error: 'Chunk not found' }

  const insertedIds: number[] = []
  let searchFrom = 0
  while (true) {
    const pos = chunk.content.indexOf(text, searchFrom)
    if (pos === -1) break
    const row = await env.DB
      .prepare(
        `INSERT INTO extracted_entity
          (source_document_id, source_chunk_id, entity_type, extracted_text, scope, chunk_start_index, chunk_end_index)
         VALUES (?, ?, ?, ?, 'chunk', ?, ?)
         RETURNING id`,
      )
      .bind(documentId, chunkId, entityType, text, pos, pos + text.length)
      .first<{ id: number }>()
    if (row) insertedIds.push(row.id)
    searchFrom = pos + text.length
  }

  if (insertedIds.length === 0) {
    return { ok: false, status: 422, error: 'Text not found in chunk content' }
  }

  return { ok: true, ids: insertedIds }
}

/** Delete an entity, its document-scoped parent (if any), children, and relationships. */
export async function deleteEntityCascade(env: Env, entityId: number): Promise<DeleteEntityResult> {
  const entity = await env.DB
    .prepare('SELECT id, parent_id FROM extracted_entity WHERE id = ?')
    .bind(entityId)
    .first<{ id: number; parent_id: number | null }>()

  if (!entity) return { ok: false, status: 404, error: 'Entity not found' }

  const rootId = entity.parent_id ?? entity.id

  await env.DB.batch([
    env.DB
      .prepare(
        `DELETE FROM extracted_relationship
         WHERE from_entity_id = ?1 OR to_entity_id = ?1
            OR from_entity_id IN (SELECT id FROM extracted_entity WHERE parent_id = ?1)
            OR to_entity_id   IN (SELECT id FROM extracted_entity WHERE parent_id = ?1)`,
      )
      .bind(rootId),
    env.DB.prepare('DELETE FROM extracted_entity WHERE parent_id = ?').bind(rootId),
    env.DB.prepare('DELETE FROM extracted_entity WHERE id = ?').bind(rootId),
  ])

  return { ok: true }
}

/** Search a document's document-scoped entities, optionally filtered by a substring. */
export async function searchEntities(
  env: Env,
  params: { documentId: number; query?: string; limit?: number },
): Promise<EntitySearchHit[]> {
  const { documentId } = params
  const limit = Math.min(params.limit ?? 25, 100)
  const query = params.query?.trim() ?? ''

  const conds = ["source_document_id = ?", "scope = 'document'"]
  const binds: (string | number)[] = [documentId]
  if (query) {
    conds.push('(label LIKE ? OR extracted_text LIKE ?)')
    binds.push(`%${query}%`, `%${query}%`)
  }

  const { results } = await env.DB
    .prepare(
      `SELECT id, label, entity_type, extracted_text, preferred_translation
       FROM extracted_entity
       WHERE ${conds.join(' AND ')}
       ORDER BY length(COALESCE(label, extracted_text, '')), label
       LIMIT ?`,
    )
    .bind(...binds, limit)
    .all<{
      id: number
      label: string | null
      entity_type: string
      extracted_text: string | null
      preferred_translation: string | null
    }>()

  return results.map((r) => ({
    id: r.id,
    label: r.label,
    entityType: r.entity_type,
    extractedText: r.extracted_text,
    preferredTranslation: r.preferred_translation,
  }))
}

/** Refresh document coreference and re-extract relationships around a changed chunk. */
export async function enrichAfterEntityChange(
  env: Env,
  chunkId: number,
  documentId: number,
): Promise<void> {
  await resolveDocumentCoreference(documentId, env)
  await extractAndPersistChunkRelationships(chunkId, documentId, env)
  // resolveDocumentCoreference() deletes and recreates the document's
  // document-scope entities; the FK (extracted_relationship → extracted_entity,
  // ON DELETE CASCADE) means that also wipes every document-scope relationship.
  // Chunk-scope relationships survive, so re-derive the document-scope layer
  // from them — otherwise the graph outside the changed chunk's window is lost.
  await rebuildDocumentScopeRelationships(documentId, env)
}

/**
 * Rebuild a document's document-scope relationships from its surviving
 * chunk-scope relationships. Each chunk-relationship endpoint is mapped to its
 * coreference parent (document-scope) entity; endpoints whose chunk entity has
 * no parent are promoted to a single-member document-scope entity, matching
 * the ingest workflow's Phase 6 semantics. Idempotent: existing document-scope
 * relationships for the document are cleared before rebuilding.
 */
export async function rebuildDocumentScopeRelationships(
  documentId: number,
  env: Env,
): Promise<void> {
  // Clear any lingering document-scope relationships (usually already empty:
  // the coreference delete cascaded them away). Keeps repeated runs consistent.
  await env.DB
    .prepare(`DELETE FROM extracted_relationship WHERE source_document_id = ? AND scope = 'document'`)
    .bind(documentId)
    .run()

  const chunkRels = await env.DB
    .prepare(
      `SELECT from_entity_id, to_entity_id, edge_type, explanation
       FROM extracted_relationship
       WHERE source_document_id = ? AND scope = 'chunk'`,
    )
    .bind(documentId)
    .all<{ from_entity_id: number; to_entity_id: number; edge_type: string; explanation: string | null }>()

  if (chunkRels.results.length === 0) return

  // Load every chunk entity so endpoints can be mapped to a document-scope parent.
  const entityRows = await env.DB
    .prepare(
      `SELECT id, parent_id, entity_type, extracted_text
       FROM extracted_entity
       WHERE source_document_id = ? AND scope = 'chunk'`,
    )
    .bind(documentId)
    .all<{ id: number; parent_id: number | null; entity_type: string; extracted_text: string | null }>()

  const entityInfo = new Map<
    number,
    { parentId: number | null; entityType: string; extractedText: string | null }
  >()
  for (const r of entityRows.results) {
    entityInfo.set(r.id, {
      parentId: r.parent_id,
      entityType: r.entity_type,
      extractedText: r.extracted_text,
    })
  }

  // Resolve a chunk entity to its document-scope parent, promoting singletons
  // (chunk entities coreference left unparented) on demand.
  const promoted = new Map<number, number>()
  const resolveDocEntityId = async (chunkEntityId: number): Promise<number | null> => {
    const info = entityInfo.get(chunkEntityId)
    if (!info) return null
    if (info.parentId !== null) return info.parentId

    const cached = promoted.get(chunkEntityId)
    if (cached !== undefined) return cached

    const inserted = await env.DB
      .prepare(
        `INSERT INTO extracted_entity
          (source_document_id, source_chunk_id, entity_type, extracted_text, label, scope)
         VALUES (?, NULL, ?, NULL, ?, 'document')
         RETURNING id`,
      )
      .bind(documentId, info.entityType, info.extractedText)
      .first<{ id: number }>()
    if (!inserted) return null

    await env.DB
      .prepare('UPDATE extracted_entity SET parent_id = ? WHERE id = ?')
      .bind(inserted.id, chunkEntityId)
      .run()

    promoted.set(chunkEntityId, inserted.id)
    info.parentId = inserted.id
    return inserted.id
  }

  const docRels: Array<{ fromId: number; toId: number; edgeType: string; explanation: string | null }> = []
  const seen = new Set<string>()
  for (const rel of chunkRels.results) {
    const fromId = await resolveDocEntityId(rel.from_entity_id)
    const toId = await resolveDocEntityId(rel.to_entity_id)
    if (fromId === null || toId === null || fromId === toId) continue

    const key = `${fromId}|${toId}|${rel.edge_type}`
    if (seen.has(key)) continue
    seen.add(key)
    docRels.push({ fromId, toId, edgeType: rel.edge_type, explanation: rel.explanation })
  }

  if (docRels.length > 0) {
    const stmt = env.DB.prepare(
      `INSERT INTO extracted_relationship
        (source_document_id, from_entity_id, to_entity_id, edge_type, explanation, scope)
       VALUES (?, ?, ?, ?, ?, 'document')`,
    )
    await env.DB.batch(
      docRels.map((r) => stmt.bind(documentId, r.fromId, r.toId, r.edgeType, r.explanation)),
    )
  }
}

async function extractAndPersistChunkRelationships(
  chunkId: number,
  documentId: number,
  env: Env,
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
       AND chunk_order BETWEEN ? AND ? ORDER BY chunk_order`,
    )
    .bind(documentId, order - 3, order + 3)
    .all<{ id: number }>()

  const windowChunkIds = windowRows.results.map((r) => r.id)
  if (windowChunkIds.length === 0) return

  const ph = windowChunkIds.map(() => '?').join(', ')

  const [contentRow, entityRows, edgeTypeRows] = await Promise.all([
    env.DB
      .prepare(
        `SELECT GROUP_CONCAT(content, char(10)) AS window_content
         FROM (SELECT content FROM text_chunk WHERE id IN (${ph}) ORDER BY chunk_order)`,
      )
      .bind(...windowChunkIds)
      .first<{ window_content: string }>(),
    env.DB
      .prepare(
        `SELECT id, entity_type, extracted_text FROM extracted_entity
         WHERE source_chunk_id IN (${ph}) AND scope = 'chunk' AND extracted_text IS NOT NULL`,
      )
      .bind(...windowChunkIds)
      .all<{ id: number; entity_type: string; extracted_text: string }>(),
    env.DB
      .prepare(
        'SELECT name, reverse_name, definition, examples_json FROM edge_type WHERE is_current = 1 ORDER BY name',
      )
      .all<{ name: string; reverse_name: string | null; definition: string; examples_json: string }>(),
  ])

  const windowContent = contentRow?.window_content ?? ''
  const entities = entityRows.results.map((r) => ({ nodeType: r.entity_type, text: r.extracted_text }))

  const parseExamples = (json: string): string[] => {
    try {
      const v = JSON.parse(json)
      return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []
    } catch {
      return []
    }
  }
  const edgeTypes: EdgeTypeInput[] = edgeTypeRows.results.map((et) => ({
    name: et.name,
    reverseName: et.reverse_name,
    definition: et.definition,
    examples: parseExamples(et.examples_json),
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
       WHERE source_document_id = ? AND scope = 'chunk'`,
    )
    .bind(documentId)
    .all<{ from_entity_id: number; to_entity_id: number; edge_type: string }>()

  const existingKeys = new Set(
    existingRows.results.map((r) => `${r.from_entity_id}|${r.to_entity_id}|${r.edge_type}`),
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
       VALUES (?, ?, ?, ?, ?, 'chunk')`,
    )
    await env.DB.batch(
      toInsert.map((r) => stmt.bind(documentId, r.fromId, r.toId, r.edgeType, r.explanation)),
    )
  }
}
