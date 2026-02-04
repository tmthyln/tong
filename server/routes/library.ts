import { Hono } from 'hono'
import { storeUploadedFile } from '../lib/documents'
import { loadExtractedContent } from '../lib/extract-content'

const libraryRoutes = new Hono<{ Bindings: Env }>()

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
      parent_id
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
    }>()

  if (!doc) {
    return c.json({ error: 'Document not found' }, 404)
  }

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
        scope
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
      })
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
    extractedContent,
    chunks,
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

libraryRoutes.post('/document', async (c) => {
  const formData = await c.req.formData()
  const file = formData.get('file')

  if (!file || !(file instanceof File)) {
    return c.json({ error: 'No file provided' }, 400)
  }

  const fileInfo = await storeUploadedFile(file, c.env)

  if (fileInfo.alreadyExists) {
    return c.json({
      message: 'Document already exists',
      documentId: fileInfo.existingId,
      alreadyExists: true,
    })
  }

  // Kick off the ingestion workflow for new documents
  const instance = await c.env.INGEST_DOCUMENT_WORKFLOW.create({
    params: {
      location: fileInfo.location,
      filename: fileInfo.filename,
      mimetype: fileInfo.mimetype,
      contentHash: fileInfo.contentHash,
      dateUploaded: new Date().toISOString(),
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
