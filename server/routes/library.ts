import { Hono } from 'hono'
import { storeUploadedFile } from '../lib/documents'
import { loadExtractedContent } from '../lib/extract-content'
import { removeOverlaps } from '../lib/entity-extraction'
import { getUserId, userType } from '../lib/auth'
import { extractTermsFromText } from '../lib/text-terms'
import {
  promoteDocumentToScope,
  promoteDocumentRelationshipsToScope,
  SCOPE_PROMOTION_MODEL,
} from '../lib/scope-promotion'
import {
  startEnrichmentRun,
  completeEnrichmentRun,
  failEnrichmentRun,
  type OntologyRef,
} from '../lib/enrichment-run'

const libraryRoutes = new Hono<{ Bindings: Env }>()

export interface FolderAffinityRow {
  id: number
  parent_id: number | null
  knowledge_scope_id: number | null
}

// Pure nearest-ancestor walk: starting at folderId, climb the parent_id chain
// and return the first non-null knowledge_scope_id. Cycle-safe.
export function nearestAncestorAffinity(
  folders: FolderAffinityRow[],
  folderId: number | null
): number | null {
  if (folderId === null) return null

  const byId = new Map(folders.map((r) => [r.id, r]))
  const seen = new Set<number>()
  let cursor: number | null = folderId
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor)
    const folder = byId.get(cursor)
    if (!folder) break
    if (folder.knowledge_scope_id !== null) return folder.knowledge_scope_id
    cursor = folder.parent_id
  }
  return null
}

// Document → knowledge-scope assignment is permanent: once a document has a
// non-null scope, it cannot be re-pointed at a different scope or cleared.
// Idempotent re-assert (same id) is fine.
export function canAssignDocumentScope(
  currentScopeId: number | null,
  requestedScopeId: number | null
): boolean {
  if (currentScopeId === null) return true
  return requestedScopeId === currentScopeId
}

// Resolve a folder's knowledge-scope affinity using nearest-ancestor inheritance.
async function resolveFolderAffinity(
  db: D1Database,
  folderId: number | null
): Promise<number | null> {
  if (folderId === null) return null

  const rows = await db
    .prepare('SELECT id, parent_id, knowledge_scope_id FROM document_group')
    .all<FolderAffinityRow>()
  return nearestAncestorAffinity(rows.results, folderId)
}

// Get directory tree structure
libraryRoutes.get('/', async (c) => {
  // Fetch all document groups
  const groupsResult = await c.env.DB.prepare(
    'SELECT id, name, parent_id, group_type FROM document_group ORDER BY name'
  ).all<{
    id: number
    name: string
    parent_id: number | null
    group_type: string
  }>()

  // Fetch all documents with minimal info for tree display
  const docsResult = await c.env.DB.prepare(
    `SELECT id, title, original_doc_filename, parent_id, extracted_doc_char_count
     FROM document ORDER BY COALESCE(title, original_doc_filename)`
  ).all<{
    id: number
    title: string | null
    original_doc_filename: string
    parent_id: number | null
    extracted_doc_char_count: number
  }>()

  // Build tree structure
  interface TreeNode {
    id: string
    name: string
    type: 'folder' | 'document'
    groupType?: string
    children?: TreeNode[]
    documentId?: number
    charCount?: number
  }

  const groupMap = new Map<number, TreeNode>()
  const rootNodes: TreeNode[] = []

  // Create folder nodes
  for (const group of groupsResult.results) {
    const node: TreeNode = {
      id: `group-${group.id}`,
      name: group.name,
      type: 'folder',
      groupType: group.group_type,
      children: [],
    }
    groupMap.set(group.id, node)
  }

  // Link folder hierarchy
  for (const group of groupsResult.results) {
    const node = groupMap.get(group.id)!
    if (group.parent_id === null) {
      rootNodes.push(node)
    } else {
      const parent = groupMap.get(group.parent_id)
      if (parent && parent.children) {
        parent.children.push(node)
      }
    }
  }

  // Add documents to their parent folders or root
  for (const doc of docsResult.results) {
    const node: TreeNode = {
      id: `doc-${doc.id}`,
      name: doc.title || doc.original_doc_filename,
      type: 'document',
      documentId: doc.id,
      charCount: doc.extracted_doc_char_count,
    }

    if (doc.parent_id === null) {
      rootNodes.push(node)
    } else {
      const parent = groupMap.get(doc.parent_id)
      if (parent && parent.children) {
        parent.children.push(node)
      }
    }
  }

  return c.json({ tree: rootNodes })
})

libraryRoutes.get('/document', async (c) => {
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20', 10)))
  const nextToken = c.req.query('nextToken')

  let cursor: { date: string; id: number } | null = null
  if (nextToken) {
    try {
      cursor = JSON.parse(atob(nextToken))
    } catch {
      return c.json({ error: 'Invalid nextToken' }, 400)
    }
  }

  // Use COALESCE to fall back to date_uploaded when date_last_accessed is null
  // Query one extra to determine if there's a next page
  let query: string
  let bindings: (string | number)[]

  if (cursor) {
    query = `
      SELECT
        id,
        title,
        original_doc_filename,
        original_doc_mimetype,
        date_uploaded,
        date_last_accessed,
        date_last_modified,
        extracted_doc_char_count,
        extracted_doc_unique_char_count,
        parent_id,
        COALESCE(date_last_accessed, date_uploaded) as effective_date
      FROM document
      WHERE COALESCE(date_last_accessed, date_uploaded) < ?
         OR (COALESCE(date_last_accessed, date_uploaded) = ? AND id < ?)
      ORDER BY effective_date DESC, id DESC
      LIMIT ?`
    bindings = [cursor.date, cursor.date, cursor.id, limit + 1]
  } else {
    query = `
      SELECT
        id,
        title,
        original_doc_filename,
        original_doc_mimetype,
        date_uploaded,
        date_last_accessed,
        date_last_modified,
        extracted_doc_char_count,
        extracted_doc_unique_char_count,
        parent_id,
        COALESCE(date_last_accessed, date_uploaded) as effective_date
      FROM document
      ORDER BY effective_date DESC, id DESC
      LIMIT ?`
    bindings = [limit + 1]
  }

  const result = await c.env.DB.prepare(query)
    .bind(...bindings)
    .all()

  const documents = result.results.slice(0, limit)
  const hasMore = result.results.length > limit

  let responseNextToken: string | null = null
  if (hasMore && documents.length > 0) {
    const lastDoc = documents[documents.length - 1] as {
      id: number
      effective_date: string
    }
    responseNextToken = btoa(JSON.stringify({ date: lastDoc.effective_date, id: lastDoc.id }))
  }

  return c.json({
    documents,
    nextToken: responseNextToken,
  })
})

libraryRoutes.get('/document/:id/similar', async (c) => {
  const id = parseInt(c.req.param('id'), 10)
  if (isNaN(id)) {
    return c.json({ error: 'Invalid document ID' }, 400)
  }

  // 1. Fetch all chunk IDs for this document
  const chunksResult = await c.env.DB.prepare(
    'SELECT id FROM text_chunk WHERE source_document_id = ?'
  )
    .bind(id)
    .all<{ id: number }>()

  const chunkIds = chunksResult.results.map((r) => r.id)
  if (chunkIds.length === 0) {
    return c.json([])
  }

  // 2. Batch-fetch all embeddings (max 20 IDs per call)
  const vectorBatches: Array<{ id: string; values: number[] } | null>[] = []
  for (let i = 0; i < chunkIds.length; i += 20) {
    const batch = chunkIds.slice(i, i + 20).map(String)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (c.env.CHUNK_VECTORS as any).getByIds(
      batch,
      { namespace: 'document' }
    ) as Array<{ id: string; values: number[] } | null>
    vectorBatches.push(...result)
  }
  const vectors = vectorBatches

  const validVectors = vectors.filter(
    (v): v is { id: string; values: number[] } => v != null && Array.isArray(v.values)
  )

  if (validVectors.length === 0) {
    return c.json([])
  }

  // 3. Query nearest neighbors for each chunk vector (parallel)
  const queryResults = await Promise.all(
    validVectors.map((vector) =>
      c.env.CHUNK_VECTORS.query(vector.values, {
        topK: 8,
        namespace: 'document',
        returnMetadata: 'all',
        filter: { sourceDocumentId: { $ne: id } },
      })
    )
  )

  // 4. Build matchCount and bestMatch maps keyed by candidate doc ID
  const matchCount = new Map<number, number>()
  const bestMatch = new Map<number, { chunkId: number; score: number }>()

  for (const result of queryResults) {
    for (const match of result.matches) {
      const meta = match.metadata as { sourceDocumentId?: number; chunkId?: number } | undefined
      const docId = meta?.sourceDocumentId
      const chunkId = meta?.chunkId
      if (docId == null || chunkId == null) continue

      matchCount.set(docId, (matchCount.get(docId) ?? 0) + 1)

      const existing = bestMatch.get(docId)
      if (!existing || match.score > existing.score) {
        bestMatch.set(docId, { chunkId, score: match.score })
      }
    }
  }

  if (matchCount.size === 0) {
    return c.json([])
  }

  // 5. Fetch total chunk counts for all candidate docs in one query
  const candidateDocIds = [...matchCount.keys()]
  const countsPlaceholders = candidateDocIds.map(() => '?').join(', ')
  const countsResult = await c.env.DB.prepare(
    `SELECT source_document_id, COUNT(*) as total
     FROM text_chunk
     WHERE source_document_id IN (${countsPlaceholders})
     GROUP BY source_document_id`
  )
    .bind(...candidateDocIds)
    .all<{ source_document_id: number; total: number }>()

  const totalChunksMap = new Map<number, number>()
  for (const row of countsResult.results) {
    totalChunksMap.set(row.source_document_id, row.total)
  }

  // 6. Compute Jaccard score, sort descending, take top 4
  const scored = candidateDocIds
    .map((docId) => ({
      docId,
      score: (matchCount.get(docId) ?? 0) / (totalChunksMap.get(docId) ?? 1),
      bestChunkId: bestMatch.get(docId)!.chunkId,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)

  if (scored.length === 0) {
    return c.json([])
  }

  // 7. Fetch document metadata + snippet chunk content for top 4
  const top4DocIds = scored.map((s) => s.docId)
  const top4ChunkIds = scored.map((s) => s.bestChunkId)
  const docPlaceholders = top4DocIds.map(() => '?').join(', ')
  const chunkPlaceholders = top4ChunkIds.map(() => '?').join(', ')

  const [docsResult, snippetsResult] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, title, original_doc_filename FROM document WHERE id IN (${docPlaceholders})`
    )
      .bind(...top4DocIds)
      .all<{ id: number; title: string | null; original_doc_filename: string }>(),
    c.env.DB.prepare(
      `SELECT id, content FROM text_chunk WHERE id IN (${chunkPlaceholders})`
    )
      .bind(...top4ChunkIds)
      .all<{ id: number; content: string }>(),
  ])

  const docMap = new Map(docsResult.results.map((d) => [d.id, d]))
  const chunkMap = new Map(snippetsResult.results.map((ch) => [ch.id, ch]))

  const similar = scored
    .map((s) => {
      const doc = docMap.get(s.docId)
      const snippet = chunkMap.get(s.bestChunkId)
      if (!doc) return null
      return {
        id: doc.id,
        title: doc.title,
        filename: doc.original_doc_filename,
        jaccardScore: s.score,
        snippet: (snippet?.content ?? '').slice(0, 300),
      }
    })
    .filter((s): s is NonNullable<typeof s> => s != null)

  return c.json(similar)
})

libraryRoutes.get('/document/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10)
  if (isNaN(id)) {
    return c.json({ error: 'Invalid document ID' }, 400)
  }

  const doc = await c.env.DB.prepare(
    `SELECT
      id,
      title,
      original_doc_filename,
      original_doc_mimetype,
      date_uploaded,
      date_last_accessed,
      date_last_modified,
      extracted_doc_location,
      extracted_doc_char_count,
      extracted_doc_unique_char_count,
      parent_id,
      knowledge_scope_id
    FROM document WHERE id = ?`
  )
    .bind(id)
    .first<{
      id: number
      title: string | null
      original_doc_filename: string
      original_doc_mimetype: string
      date_uploaded: string
      date_last_accessed: string | null
      date_last_modified: string | null
      extracted_doc_location: string
      extracted_doc_char_count: number
      extracted_doc_unique_char_count: number
      parent_id: number | null
      knowledge_scope_id: number | null
    }>()

  if (!doc) {
    return c.json({ error: 'Document not found' }, 404)
  }

  // Update last accessed timestamp (non-blocking)
  c.env.DB.prepare('UPDATE document SET date_last_accessed = ? WHERE id = ?')
    .bind(new Date().toISOString(), id)
    .run()

  const extractedContent = await loadExtractedContent(doc.extracted_doc_location, c.env)

  // Fetch text chunks
  const chunksResult = await c.env.DB.prepare(
    `SELECT
      id,
      chunk_order,
      extracted_doc_start_index,
      extracted_doc_end_index,
      content,
      char_count,
      unique_char_count
    FROM text_chunk
    WHERE source_document_id = ?
    ORDER BY chunk_order`
  )
    .bind(id)
    .all<{
      id: number
      chunk_order: number
      extracted_doc_start_index: number
      extracted_doc_end_index: number
      content: string
      char_count: number
      unique_char_count: number
    }>()

  const chunkIds = chunksResult.results.map((c) => c.id)

  // Fetch extracted entities for all chunks
  let entitiesByChunkId: Record<number, Array<{
    id: number
    entityType: string
    extractedText: string | null
    startIndex: number | null
    endIndex: number | null
    label: string | null
    scope: string
    parentId: number | null
    preferredTranslation: string | null
  }>> = {}

  if (chunkIds.length > 0) {
    const entitiesResult = await c.env.DB.prepare(
      `SELECT
        id,
        source_chunk_id,
        entity_type,
        extracted_text,
        chunk_start_index,
        chunk_end_index,
        label,
        scope,
        parent_id,
        preferred_translation
      FROM extracted_entity
      WHERE source_chunk_id IN (SELECT id FROM text_chunk WHERE source_document_id = ?)`
    )
      .bind(id)
      .all<{
        id: number
        source_chunk_id: number
        entity_type: string
        extracted_text: string | null
        chunk_start_index: number | null
        chunk_end_index: number | null
        label: string | null
        scope: string
        parent_id: number | null
        preferred_translation: string | null
      }>()

    for (const entity of entitiesResult.results) {
      const chunkId = entity.source_chunk_id
      if (!entitiesByChunkId[chunkId]) {
        entitiesByChunkId[chunkId] = []
      }
      entitiesByChunkId[chunkId].push({
        id: entity.id,
        entityType: entity.entity_type,
        extractedText: entity.extracted_text,
        startIndex: entity.chunk_start_index,
        endIndex: entity.chunk_end_index,
        label: entity.label,
        scope: entity.scope,
        parentId: entity.parent_id,
        preferredTranslation: entity.preferred_translation,
      })
    }

    // Apply cross-type overlap removal per chunk (entities are now inserted independently per type)
    for (const chunkId of Object.keys(entitiesByChunkId)) {
      const chunkEntities = entitiesByChunkId[Number(chunkId)]
      const positioned = chunkEntities.filter(
        (e) => e.startIndex !== null && e.endIndex !== null
      )
      const unpositioned = chunkEntities.filter(
        (e) => e.startIndex === null || e.endIndex === null
      )
      const dedupedPositioned = removeOverlaps(
        positioned.map((e) => ({
          nodeType: e.entityType,
          text: e.extractedText ?? '',
          startIndex: e.startIndex!,
          endIndex: e.endIndex!,
        }))
      )
      const dedupedIds = new Set(
        dedupedPositioned.map((d) =>
          positioned.find(
            (e) => e.startIndex === d.startIndex && e.endIndex === d.endIndex && e.entityType === d.nodeType
          )?.id
        )
      )
      entitiesByChunkId[Number(chunkId)] = [
        ...positioned.filter((e) => dedupedIds.has(e.id)),
        ...unpositioned,
      ]
    }
  }

  // Fetch document-scope entities + both relationship scopes in parallel
  const [allEntitiesResult, chunkRelsResult, docRelsResult] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, source_chunk_id, entity_type, extracted_text,
              chunk_start_index, chunk_end_index, label, scope, parent_id,
              preferred_translation
       FROM extracted_entity
       WHERE source_document_id = ? AND scope = 'document'
       ORDER BY id`
    )
      .bind(id)
      .all<{
        id: number
        source_chunk_id: number | null
        entity_type: string
        extracted_text: string | null
        chunk_start_index: number | null
        chunk_end_index: number | null
        label: string | null
        scope: string
        parent_id: number | null
        preferred_translation: string | null
      }>(),
    c.env.DB.prepare(
      `SELECT er.id, er.from_entity_id, er.to_entity_id, er.edge_type, er.explanation,
              fe.extracted_text AS from_text, fe.entity_type AS from_type,
              te.extracted_text AS to_text, te.entity_type AS to_type,
              et.reverse_name AS edge_reverse_name
       FROM extracted_relationship er
       JOIN extracted_entity fe ON fe.id = er.from_entity_id
       JOIN extracted_entity te ON te.id = er.to_entity_id
       LEFT JOIN edge_type et ON et.name = er.edge_type
       WHERE er.source_document_id = ? AND er.scope = 'chunk'`
    )
      .bind(id)
      .all<{
        id: number
        from_entity_id: number
        to_entity_id: number
        edge_type: string
        explanation: string | null
        from_text: string | null
        from_type: string
        to_text: string | null
        to_type: string
        edge_reverse_name: string | null
      }>(),
    c.env.DB.prepare(
      `SELECT er.id, er.from_entity_id, er.to_entity_id, er.edge_type, er.explanation,
              fe.label AS from_label, fe.entity_type AS from_type,
              te.label AS to_label, te.entity_type AS to_type,
              et.reverse_name AS edge_reverse_name
       FROM extracted_relationship er
       JOIN extracted_entity fe ON fe.id = er.from_entity_id
       JOIN extracted_entity te ON te.id = er.to_entity_id
       LEFT JOIN edge_type et ON et.name = er.edge_type
       WHERE er.source_document_id = ? AND er.scope = 'document'`
    )
      .bind(id)
      .all<{
        id: number
        from_entity_id: number
        to_entity_id: number
        edge_type: string
        explanation: string | null
        from_label: string | null
        from_type: string
        to_label: string | null
        to_type: string
        edge_reverse_name: string | null
      }>(),
  ])

  const entities = allEntitiesResult.results.map((e) => ({
    id: e.id,
    chunkId: e.source_chunk_id,
    entityType: e.entity_type,
    extractedText: e.extracted_text,
    startIndex: e.chunk_start_index,
    endIndex: e.chunk_end_index,
    label: e.label,
    scope: e.scope,
    parentId: e.parent_id,
    preferredTranslation: e.preferred_translation,
  }))

  const chunkRelationships = chunkRelsResult.results.map((r) => ({
    id: r.id,
    fromEntityId: r.from_entity_id,
    toEntityId: r.to_entity_id,
    edgeType: r.edge_type,
    edgeReverseName: r.edge_reverse_name,
    explanation: r.explanation,
    fromText: r.from_text,
    fromType: r.from_type,
    toText: r.to_text,
    toType: r.to_type,
  }))

  const relationships = docRelsResult.results.map((r) => ({
    id: r.id,
    fromEntityId: r.from_entity_id,
    toEntityId: r.to_entity_id,
    edgeType: r.edge_type,
    edgeReverseName: r.edge_reverse_name,
    explanation: r.explanation,
    fromLabel: r.from_label,
    fromType: r.from_type,
    toLabel: r.to_label,
    toType: r.to_type,
  }))

  // Fetch latest translation draft and all available draft numbers for each chunk
  const translationsByChunkId: Record<number, { content: string; draftNumber: number; translator: string; dateLastModified: string | null }> = {}
  const availableDraftsByChunkId: Record<number, number[]> = {}
  if (chunkIds.length > 0) {
    const [latestResult, allDraftsResult] = await Promise.all([
      c.env.DB.prepare(
        `SELECT text_chunk_id, content, draft_number, translator, date_last_modified
         FROM translation_chunk
         WHERE text_chunk_id IN (SELECT id FROM text_chunk WHERE source_document_id = ?)
         GROUP BY text_chunk_id
         HAVING draft_number = MAX(draft_number)`
      )
        .bind(id)
        .all<{ text_chunk_id: number; content: string; draft_number: number; translator: string; date_last_modified: string | null }>(),
      c.env.DB.prepare(
        `SELECT text_chunk_id, draft_number
         FROM translation_chunk
         WHERE text_chunk_id IN (SELECT id FROM text_chunk WHERE source_document_id = ?)
         ORDER BY draft_number`
      )
        .bind(id)
        .all<{ text_chunk_id: number; draft_number: number }>(),
    ])

    for (const row of latestResult.results) {
      translationsByChunkId[row.text_chunk_id] = { content: row.content, draftNumber: row.draft_number, translator: row.translator, dateLastModified: row.date_last_modified }
    }
    for (const row of allDraftsResult.results) {
      if (!availableDraftsByChunkId[row.text_chunk_id]) availableDraftsByChunkId[row.text_chunk_id] = []
      availableDraftsByChunkId[row.text_chunk_id].push(row.draft_number)
    }
  }

  // Map chunks with their entities
  const chunks = chunksResult.results.map((chunk) => ({
    id: chunk.id,
    order: chunk.chunk_order,
    startIndex: chunk.extracted_doc_start_index,
    endIndex: chunk.extracted_doc_end_index,
    content: chunk.content,
    charCount: chunk.char_count,
    uniqueCharCount: chunk.unique_char_count,
    entities: entitiesByChunkId[chunk.id] || [],
    translation: translationsByChunkId[chunk.id]?.content ?? null,
    translationDraftNumber: translationsByChunkId[chunk.id]?.draftNumber ?? null,
    translationTranslator: translationsByChunkId[chunk.id]?.translator ?? null,
    translationDateLastModified: translationsByChunkId[chunk.id]?.dateLastModified ?? null,
    availableTranslationDrafts: availableDraftsByChunkId[chunk.id] ?? [],
  }))

  return c.json({
    id: doc.id,
    title: doc.title,
    filename: doc.original_doc_filename,
    mimetype: doc.original_doc_mimetype,
    dateUploaded: doc.date_uploaded,
    dateLastAccessed: doc.date_last_accessed,
    dateLastModified: doc.date_last_modified,
    charCount: doc.extracted_doc_char_count,
    uniqueCharCount: doc.extracted_doc_unique_char_count,
    parentId: doc.parent_id,
    knowledgeScopeId: doc.knowledge_scope_id,
    extractedContent,
    entities,
    chunks,
    chunkRelationships,
    relationships,
  })
})

libraryRoutes.post('/chunks/seen', async (c) => {
  const userId = getUserId(c)
  if (userType(userId) === 'public') {
    return new Response(null, { status: 204 })
  }

  const body = await c.req.json<{ chunkIds: unknown }>().catch(() => null)
  if (!body || !Array.isArray(body.chunkIds)) {
    return new Response(null, { status: 204 })
  }

  const chunkIds = Array.from(
    new Set(
      body.chunkIds
        .map((v) => (typeof v === 'number' ? v : parseInt(String(v), 10)))
        .filter((n) => Number.isInteger(n) && n > 0)
    )
  ).slice(0, 200)

  if (chunkIds.length === 0) {
    return new Response(null, { status: 204 })
  }

  c.executionCtx.waitUntil(
    (async () => {
      const contents: string[] = []
      for (let i = 0; i < chunkIds.length; i += 99) {
        const batch = chunkIds.slice(i, i + 99)
        const placeholders = batch.map(() => '?').join(', ')
        const result = await c.env.DB.prepare(
          `SELECT content FROM text_chunk WHERE id IN (${placeholders})`
        )
          .bind(...batch)
          .all<{ content: string }>()
        for (const row of result.results) contents.push(row.content)
      }
      if (contents.length === 0) return
      const terms = await extractTermsFromText(contents.join('\n'), c.env.DB)
      if (terms.length === 0) return
      const lexicon = c.env.LEXICON.get(c.env.LEXICON.idFromName(userId))
      await lexicon.markSeenBulk(terms)
    })()
  )

  return new Response(null, { status: 204 })
})

libraryRoutes.get('/chunk/:chunkId/translation', async (c) => {
  const chunkId = parseInt(c.req.param('chunkId'), 10)
  const draftNumber = parseInt(c.req.query('draft') ?? '', 10)
  if (isNaN(chunkId) || isNaN(draftNumber)) {
    return c.json({ error: 'Invalid parameters' }, 400)
  }

  const row = await c.env.DB.prepare(
    'SELECT content FROM translation_chunk WHERE text_chunk_id = ? AND draft_number = ? LIMIT 1'
  )
    .bind(chunkId, draftNumber)
    .first<{ content: string }>()

  if (!row) return c.json({ error: 'Not found' }, 404)
  return c.json({ content: row.content })
})

libraryRoutes.put('/chunk/:chunkId/translation', async (c) => {
  const userId = getUserId(c)
  if (userType(userId) === 'public') {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const chunkId = parseInt(c.req.param('chunkId'), 10)
  if (isNaN(chunkId)) {
    return c.json({ error: 'Invalid chunk ID' }, 400)
  }

  const body = await c.req.json<{ content: string }>()
  if (typeof body.content !== 'string') {
    return c.json({ error: 'content is required' }, 400)
  }

  const now = new Date().toISOString()

  const latest = await c.env.DB.prepare(
    'SELECT draft_number, translator FROM translation_chunk WHERE text_chunk_id = ? ORDER BY draft_number DESC LIMIT 1'
  )
    .bind(chunkId)
    .first<{ draft_number: number; translator: string }>()

  let draftNumber: number
  let created: boolean

  if (!latest || latest.translator.startsWith('ai:') || latest.translator.startsWith('mt:')) {
    draftNumber = latest ? latest.draft_number + 1 : 1
    await c.env.DB.prepare(
      `INSERT INTO translation_chunk (text_chunk_id, draft_number, content, translator, date_created, date_last_modified)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(chunkId, draftNumber, body.content, userId, now, now)
      .run()
    created = true
  } else {
    draftNumber = latest.draft_number
    await c.env.DB.prepare(
      `UPDATE translation_chunk SET content = ?, translator = ?, date_last_modified = ?
       WHERE text_chunk_id = ? AND draft_number = ?`
    )
      .bind(body.content, userId, now, chunkId, draftNumber)
      .run()
    created = false
  }

  if (created) {
    c.executionCtx.waitUntil(
      c.env.DB.prepare('SELECT content FROM text_chunk WHERE id = ?')
        .bind(chunkId)
        .first<{ content: string }>()
        .then((row) => {
          if (!row) return
          return extractTermsFromText(row.content, c.env.DB).then((terms) => {
            if (terms.length === 0) return
            const lexicon = c.env.LEXICON.get(c.env.LEXICON.idFromName(userId))
            return lexicon.markLearnedBulk(terms)
          })
        })
    )
  }

  return c.json({ draftNumber, translator: userId, dateLastModified: now, created })
})

libraryRoutes.get('/document/:id/enrichments', async (c) => {
  const id = parseInt(c.req.param('id'), 10)
  if (isNaN(id)) return c.json({ error: 'Invalid document ID' }, 400)

  const rows = await c.env.DB.prepare(
    `SELECT id, kind, status, model, params_json, ontology_json,
            result_summary_json, error, started_at, completed_at
     FROM document_enrichment_run
     WHERE document_id = ?
     ORDER BY started_at DESC, id DESC`
  )
    .bind(id)
    .all<{
      id: number
      kind: string
      status: string
      model: string | null
      params_json: string
      ontology_json: string
      result_summary_json: string | null
      error: string | null
      started_at: string
      completed_at: string | null
    }>()

  const parse = (s: string | null) => {
    if (s === null) return null
    try {
      return JSON.parse(s)
    } catch {
      return null
    }
  }

  return c.json({
    enrichments: rows.results.map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      model: r.model,
      params: parse(r.params_json),
      ontology: parse(r.ontology_json),
      resultSummary: parse(r.result_summary_json),
      error: r.error,
      startedAt: r.started_at,
      completedAt: r.completed_at,
    })),
  })
})

libraryRoutes.get('/document/:id/original', async (c) => {
  const id = parseInt(c.req.param('id'), 10)
  if (isNaN(id)) {
    return c.json({ error: 'Invalid document ID' }, 400)
  }

  const doc = await c.env.DB.prepare(
    'SELECT original_doc_location, original_doc_filename, original_doc_mimetype FROM document WHERE id = ?'
  )
    .bind(id)
    .first<{
      original_doc_location: string
      original_doc_filename: string
      original_doc_mimetype: string
    }>()

  if (!doc) {
    return c.json({ error: 'Document not found' }, 404)
  }

  const object = await c.env.DOCUMENTS.get(doc.original_doc_location)
  if (!object) {
    return c.json({ error: 'File not found in storage' }, 404)
  }

  const headers = new Headers()
  headers.set('Content-Type', doc.original_doc_mimetype)
  headers.set(
    'Content-Disposition',
    `attachment; filename="${doc.original_doc_filename.replace(/"/g, '\\"')}"`
  )

  return new Response(object.body, { headers })
})

// List all folders
libraryRoutes.get('/folder', async (c) => {
  const result = await c.env.DB.prepare(
    'SELECT id, name, parent_id, group_type, knowledge_scope_id FROM document_group ORDER BY name'
  ).all<{
    id: number
    name: string
    parent_id: number | null
    group_type: string
    knowledge_scope_id: number | null
  }>()

  const folders = result.results.map((f) => ({
    id: f.id,
    name: f.name,
    parentId: f.parent_id,
    groupType: f.group_type,
    knowledgeScopeId: f.knowledge_scope_id,
  }))

  return c.json({ folders })
})

// Create a new folder
libraryRoutes.post('/folder', async (c) => {
  const body = await c.req.json<{
    name: string
    groupType: string
    knowledgeScopeId?: number | null
  }>()

  if (!body.name || body.name.trim() === '') {
    return c.json({ error: 'Folder name is required' }, 400)
  }

  const validTypes = ['book', 'series', 'collection']
  if (!validTypes.includes(body.groupType)) {
    return c.json({ error: `Invalid folder type. Must be one of: ${validTypes.join(', ')}` }, 400)
  }

  const knowledgeScopeId = body.knowledgeScopeId ?? null
  if (knowledgeScopeId !== null) {
    const scope = await c.env.DB.prepare('SELECT id FROM knowledge_scope WHERE id = ?')
      .bind(knowledgeScopeId)
      .first()
    if (!scope) return c.json({ error: 'Knowledge scope not found' }, 404)
  }

  const result = await c.env.DB.prepare(
    'INSERT INTO document_group (name, parent_id, group_type, knowledge_scope_id) VALUES (?, NULL, ?, ?) RETURNING id'
  )
    .bind(body.name.trim(), body.groupType, knowledgeScopeId)
    .first<{ id: number }>()

  if (!result) {
    return c.json({ error: 'Failed to create folder' }, 500)
  }

  return c.json(
    { id: result.id, name: body.name.trim(), groupType: body.groupType, knowledgeScopeId },
    201
  )
})

// Rename folder
libraryRoutes.patch('/folder/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10)
  if (isNaN(id)) {
    return c.json({ error: 'Invalid folder ID' }, 400)
  }

  const body = await c.req.json<{ name?: string; knowledgeScopeId?: number | null }>()

  const folder = await c.env.DB.prepare('SELECT id FROM document_group WHERE id = ?')
    .bind(id)
    .first()

  if (!folder) {
    return c.json({ error: 'Folder not found' }, 404)
  }

  if (body.name !== undefined) {
    if (body.name.trim() === '') {
      return c.json({ error: 'Folder name is required' }, 400)
    }
    await c.env.DB.prepare('UPDATE document_group SET name = ? WHERE id = ?')
      .bind(body.name.trim(), id)
      .run()
  }

  if (body.knowledgeScopeId !== undefined) {
    if (body.knowledgeScopeId !== null) {
      const scope = await c.env.DB.prepare('SELECT id FROM knowledge_scope WHERE id = ?')
        .bind(body.knowledgeScopeId)
        .first()
      if (!scope) return c.json({ error: 'Knowledge scope not found' }, 404)
    }
    await c.env.DB.prepare('UPDATE document_group SET knowledge_scope_id = ? WHERE id = ?')
      .bind(body.knowledgeScopeId, id)
      .run()
  }

  return c.json({ success: true })
})

// Move document to folder
libraryRoutes.patch('/document/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10)
  if (isNaN(id)) {
    return c.json({ error: 'Invalid document ID' }, 400)
  }

  const body = await c.req.json<{ folderId?: number | null; knowledgeScopeId?: number | null }>()

  // Verify document exists
  const doc = await c.env.DB.prepare(
    'SELECT id, knowledge_scope_id FROM document WHERE id = ?'
  )
    .bind(id)
    .first<{ id: number; knowledge_scope_id: number | null }>()

  if (!doc) {
    return c.json({ error: 'Document not found' }, 404)
  }

  // Move between folders (organization) — independent of knowledge scope.
  if (body.folderId !== undefined) {
    if (body.folderId !== null) {
      const folder = await c.env.DB.prepare('SELECT id FROM document_group WHERE id = ?')
        .bind(body.folderId)
        .first()
      if (!folder) {
        return c.json({ error: 'Folder not found' }, 404)
      }
    }
    await c.env.DB.prepare('UPDATE document SET parent_id = ? WHERE id = ?')
      .bind(body.folderId, id)
      .run()

    // Apply the destination folder's knowledge-scope affinity when the document
    // has no scope yet and the caller didn't set one explicitly in this request.
    if (
      body.folderId !== null &&
      doc.knowledge_scope_id === null &&
      body.knowledgeScopeId === undefined
    ) {
      const affinity = await resolveFolderAffinity(c.env.DB, body.folderId)
      if (affinity !== null) {
        await c.env.DB.prepare('UPDATE document SET knowledge_scope_id = ? WHERE id = ?')
          .bind(affinity, id)
          .run()
      }
    }
  }

  // Assign to a knowledge scope (entity universe) — independent of folder.
  // Once set, the assignment is permanent (changing or clearing is rejected).
  let promoteAfterAssign: { documentId: number; scopeId: number } | null = null
  if (body.knowledgeScopeId !== undefined) {
    if (!canAssignDocumentScope(doc.knowledge_scope_id, body.knowledgeScopeId ?? null)) {
      return c.json(
        { error: 'Document knowledge scope is permanent and cannot be changed' },
        409
      )
    }
    if (body.knowledgeScopeId !== null) {
      const scope = await c.env.DB.prepare('SELECT id FROM knowledge_scope WHERE id = ?')
        .bind(body.knowledgeScopeId)
        .first()
      if (!scope) {
        return c.json({ error: 'Knowledge scope not found' }, 404)
      }
    }
    if (body.knowledgeScopeId !== doc.knowledge_scope_id) {
      await c.env.DB.prepare('UPDATE document SET knowledge_scope_id = ? WHERE id = ?')
        .bind(body.knowledgeScopeId, id)
        .run()
      // First-time assignment (null → scopeX) — kick off scope promotion async.
      if (doc.knowledge_scope_id === null && body.knowledgeScopeId !== null) {
        promoteAfterAssign = { documentId: id, scopeId: body.knowledgeScopeId }
      }
    }
  }

  if (promoteAfterAssign) {
    const { documentId, scopeId } = promoteAfterAssign
    c.executionCtx.waitUntil(runScopePromotionAsync(c.env, documentId, scopeId))
  }

  return c.json({ success: true })
})

async function loadOntologyForRun(db: D1Database): Promise<OntologyRef[]> {
  const [nodeRows, edgeRows] = await Promise.all([
    db
      .prepare('SELECT name, version FROM node_type WHERE is_current = 1')
      .all<{ name: string; version: number }>(),
    db
      .prepare('SELECT name, version FROM edge_type WHERE is_current = 1')
      .all<{ name: string; version: number }>(),
  ])
  return [
    ...nodeRows.results.map((r) => ({ kind: 'node' as const, name: r.name, version: r.version })),
    ...edgeRows.results.map((r) => ({ kind: 'edge' as const, name: r.name, version: r.version })),
  ]
}

async function runScopePromotionAsync(
  env: Env,
  triggerDocumentId: number,
  knowledgeScopeId: number
): Promise<void> {
  const ontology = await loadOntologyForRun(env.DB)
  const runId = await startEnrichmentRun(env.DB, {
    documentId: triggerDocumentId,
    kind: 'scope_promotion',
    model: SCOPE_PROMOTION_MODEL,
    params: { knowledge_scope_id: knowledgeScopeId, trigger: 'late_assignment' },
    ontology,
  })
  try {
    const entResult = await promoteDocumentToScope(triggerDocumentId, knowledgeScopeId, env)
    if (entResult.skipped) {
      await completeEnrichmentRun(env.DB, runId, { skipped: entResult.skipped })
      return
    }
    const relResult = await promoteDocumentRelationshipsToScope(
      triggerDocumentId,
      knowledgeScopeId,
      env
    )
    for (const m of entResult.affectedDocumentIds) {
      const retroRelResult = await promoteDocumentRelationshipsToScope(m, knowledgeScopeId, env)
      const retroId = await startEnrichmentRun(env.DB, {
        documentId: m,
        kind: 'scope_promotion_retroactive',
        model: SCOPE_PROMOTION_MODEL,
        params: {
          knowledge_scope_id: knowledgeScopeId,
          triggered_by_document_id: triggerDocumentId,
        },
        ontology,
      })
      await completeEnrichmentRun(env.DB, retroId, {
        scope_relationships_promoted: retroRelResult.relationshipsPromoted,
      })
    }
    await completeEnrichmentRun(env.DB, runId, {
      scope_entities_created: entResult.scopeEntitiesCreated,
      scope_entities_linked: entResult.scopeEntitiesLinked,
      scope_relationships_promoted: relResult.relationshipsPromoted,
      affected_document_ids: entResult.affectedDocumentIds,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await failEnrichmentRun(env.DB, runId, msg)
  }
}

libraryRoutes.post('/document', async (c) => {
  const formData = await c.req.formData()
  const file = formData.get('file')
  const folderIdStr = formData.get('folderId')
  const folderId = folderIdStr ? parseInt(folderIdStr as string, 10) : null

  if (!file || !(file instanceof File)) {
    return c.json({ error: 'No file provided' }, 400)
  }

  // Verify folder exists if provided
  if (folderId !== null) {
    const folder = await c.env.DB.prepare('SELECT id FROM document_group WHERE id = ?')
      .bind(folderId)
      .first()

    if (!folder) {
      return c.json({ error: 'Folder not found' }, 404)
    }
  }

  const fileInfo = await storeUploadedFile(file, c.env)

  if (fileInfo.alreadyExists) {
    return c.json({
      message: 'Document already exists',
      documentId: fileInfo.existingId,
      alreadyExists: true,
    })
  }

  // A document uploaded into a folder inherits that folder's nearest-ancestor
  // knowledge-scope affinity (it has no scope of its own yet).
  const knowledgeScopeId = await resolveFolderAffinity(c.env.DB, folderId)

  // Kick off the ingestion workflow for new documents
  const instance = await c.env.INGEST_DOCUMENT_WORKFLOW.create({
    params: {
      location: fileInfo.location,
      filename: fileInfo.filename,
      mimetype: fileInfo.mimetype,
      contentHash: fileInfo.contentHash,
      dateUploaded: new Date().toISOString(),
      parentId: folderId,
      knowledgeScopeId,
    },
  })

  return c.json(
    {
      message: 'Document uploaded and processing started',
      workflowId: instance.id,
      alreadyExists: false,
    },
    201
  )
})

export default libraryRoutes
