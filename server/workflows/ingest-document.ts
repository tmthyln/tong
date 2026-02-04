import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers'
import { extractContent, loadExtractedContent } from '../lib/extract-content'
import { countChineseCharacters } from '../lib/chinese-utils'
import { generateChunkIndices } from '../lib/chunking'
import { embedAndStoreChunk } from '../lib/embedding'
import { translateAndStoreChunk } from '../lib/translation'

interface IngestDocumentParams {
  location: string
  filename: string
  mimetype: string
  contentHash: string
  dateUploaded: string
  parentId: number | null
}

export class IngestDocumentWorkflow extends WorkflowEntrypoint<Env, IngestDocumentParams> {
  async run(event: WorkflowEvent<IngestDocumentParams>, step: WorkflowStep) {
    const { payload } = event

    // Step 1: Extract content from document and save as markdown to R2
    const extractResult = await step.do('extract-content', async () => {
      const result = await extractContent(payload.location, payload.mimetype, this.env)
      return { extractedLocation: result.extractedLocation, title: result.title }
    })
    const { extractedLocation, title } = extractResult

    // Step 2: Count Chinese characters (loads content from R2)
    const charStats = await step.do('count-characters', async () => {
      const content = await loadExtractedContent(extractedLocation, this.env)
      return countChineseCharacters(content)
    })

    // Step 3: Create the document record in the database
    const documentId = await step.do('create-document-record', async () => {
      const result = await this.env.DB.prepare(
        `INSERT INTO document (
          title,
          original_doc_location,
          original_doc_filename,
          original_doc_mimetype,
          original_doc_content_hash,
          date_uploaded,
          extracted_doc_location,
          extracted_doc_char_count,
          extracted_doc_unique_char_count,
          parent_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id`
      )
        .bind(
          title,
          payload.location,
          payload.filename,
          payload.mimetype,
          payload.contentHash,
          payload.dateUploaded,
          extractedLocation,
          charStats.charCount,
          charStats.uniqueCharCount,
          payload.parentId
        )
        .first<{ id: number }>()

      if (!result) {
        throw new Error('Failed to create document record')
      }
      return result.id
    })

    // Step 4: Generate text chunk indices (loads content from R2)
    const chunkIndices = await step.do('generate-chunk-indices', async () => {
      const content = await loadExtractedContent(extractedLocation, this.env)
      return generateChunkIndices(content)
    })

    // Step 5: Persist each text chunk in database
    const chunkIds = await step.do('persist-text-chunks', async () => {
      const content = await loadExtractedContent(extractedLocation, this.env)

      return Promise.all(
        chunkIndices.map((indices, order) =>
          step.do(`persist-text-chunk-${order}`, async () => {
            const chunkContent = content.slice(indices.startIndex, indices.endIndex)
            const chunkCharStats = countChineseCharacters(chunkContent)
            const result = await this.env.DB.prepare(
              `INSERT INTO text_chunk (
                source_document_id,
                chunk_order,
                extracted_doc_start_index,
                extracted_doc_end_index,
                content,
                char_count,
                unique_char_count
              ) VALUES (?, ?, ?, ?, ?, ?, ?)
              RETURNING id`
            )
              .bind(
                documentId,
                order,
                indices.startIndex,
                indices.endIndex,
                chunkContent,
                chunkCharStats.charCount,
                chunkCharStats.uniqueCharCount
              )
              .first<{ id: number }>()

            if (!result) {
              throw new Error('Failed to create text chunk record')
            }
            return result.id
          })
        )
      )
    })

    // Step 6: Embed each chunk (loads chunk content from DB)
    await Promise.all(
      chunkIds.map((chunkId) =>
        step.do(`embed-chunk-${chunkId}`, async () => {
          const chunk = await this.env.DB.prepare(
            'SELECT content FROM text_chunk WHERE id = ?'
          )
            .bind(chunkId)
            .first<{ content: string }>()

          if (!chunk) {
            throw new Error(`Chunk ${chunkId} not found`)
          }
          await embedAndStoreChunk(chunkId, documentId, chunk.content, this.env)
        })
      )
    )

    // Step 7: Translate each chunk (loads chunk content from DB)
    await Promise.all(
      chunkIds.map((chunkId) =>
        step.do(`translate-chunk-${chunkId}`, async () => {
          const chunk = await this.env.DB.prepare(
            'SELECT content FROM text_chunk WHERE id = ?'
          )
            .bind(chunkId)
            .first<{ content: string }>()

          if (!chunk) {
            throw new Error(`Chunk ${chunkId} not found`)
          }
          await translateAndStoreChunk(chunkId, chunk.content, this.env)
        })
      )
    )

    return { documentId, chunkCount: chunkIds.length }
  }
}