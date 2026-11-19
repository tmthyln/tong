// Import a multi-chapter book (e.g. from Project Gutenberg) as a new root-level
// `book` collection: one Markdown document per chapter, in reading order, each
// run through the normal ingestion workflow.
import { storeOriginalFile, type UploadedFileInfo } from './documents'
import { chapterDocument, chapterFilename, type BookChapter } from './gutenberg'
import { mapLimit } from './map-limit'

export interface BookImportInput {
  title: string
  chapters: BookChapter[]
  /** Where the book came from; stored as R2 metadata on every chapter. */
  sourceUrl: string
  knowledgeScopeId: number | null
}

export type BookImportResult =
  | {
      /** Every chapter was already in the library (same content hash). */
      alreadyExists: true
      folderId: number | null
      documentIds: number[]
    }
  | {
      alreadyExists: false
      folderId: number
      /** Newly created chapter documents, in reading order. */
      documentIds: number[]
      /** Chapters skipped because identical content was already in the library. */
      skippedChapters: number
    }

type BookImportEnv = Pick<Env, 'DB' | 'DOCUMENTS' | 'INGEST_DOCUMENT_WORKFLOW'>

// Bounded concurrency for R2 writes; D1 inserts go in batches.
const STORE_CONCURRENCY = 6
const INSERT_BATCH = 50
// Workflow.createBatch accepts at most 100 instances per call.
const WORKFLOW_BATCH = 100

export async function importBook(env: BookImportEnv, input: BookImportInput): Promise<BookImportResult> {
  const { chapters } = input
  if (chapters.length === 0) throw new Error('Book has no chapters')
  const encoder = new TextEncoder()

  const stored: UploadedFileInfo[] = await mapLimit(chapters, STORE_CONCURRENCY, (chapter, i) =>
    storeOriginalFile(
      {
        data: encoder.encode(chapterDocument(chapter)).buffer as ArrayBuffer,
        filename: chapterFilename(input.title, i, chapters.length, chapter.title),
        mimetype: 'text/markdown',
        customMetadata: { sourceUrl: input.sourceUrl },
      },
      env
    )
  )

  const fresh = stored.flatMap((info, sortIndex) => (info.alreadyExists ? [] : [{ info, sortIndex }]))
  if (fresh.length === 0) {
    const documentIds = stored.flatMap((info) => (info.alreadyExists ? [info.existingId] : []))
    const existing = await env.DB.prepare('SELECT parent_id FROM document WHERE id = ?')
      .bind(documentIds[0])
      .first<{ parent_id: number | null }>()
    return { alreadyExists: true, folderId: existing?.parent_id ?? null, documentIds }
  }

  const folder = await env.DB.prepare(
    "INSERT INTO document_group (name, parent_id, group_type, knowledge_scope_id) VALUES (?, NULL, 'book', ?) RETURNING id"
  )
    .bind(input.title, input.knowledgeScopeId)
    .first<{ id: number }>()
  if (!folder) throw new Error('Failed to create book collection')

  // Rows exist before ingestion starts so chapters show up as "Pending".
  const dateUploaded = new Date().toISOString()
  const documentIds: number[] = []
  for (let start = 0; start < fresh.length; start += INSERT_BATCH) {
    const results = await env.DB.batch<{ id: number }>(
      fresh.slice(start, start + INSERT_BATCH).map(({ info, sortIndex }) =>
        env.DB.prepare(
          `INSERT INTO document (
            original_doc_location, original_doc_filename, original_doc_mimetype,
            original_doc_content_hash, date_uploaded, parent_id, knowledge_scope_id, sort_index
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
        ).bind(
          info.location,
          info.filename,
          info.mimetype,
          info.contentHash,
          dateUploaded,
          folder.id,
          input.knowledgeScopeId,
          sortIndex
        )
      )
    )
    for (const r of results) {
      const id = r.results[0]?.id
      if (id === undefined) throw new Error('Failed to create chapter document record')
      documentIds.push(id)
    }
  }

  const params = fresh.map(({ info }, i) => ({
    params: {
      documentId: documentIds[i],
      location: info.location,
      filename: info.filename,
      mimetype: info.mimetype,
      contentHash: info.contentHash,
      dateUploaded,
      parentId: folder.id,
      knowledgeScopeId: input.knowledgeScopeId,
    },
  }))
  for (let start = 0; start < params.length; start += WORKFLOW_BATCH) {
    await env.INGEST_DOCUMENT_WORKFLOW.createBatch(params.slice(start, start + WORKFLOW_BATCH))
  }

  return {
    alreadyExists: false,
    folderId: folder.id,
    documentIds,
    skippedChapters: chapters.length - fresh.length,
  }
}
