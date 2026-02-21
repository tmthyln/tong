import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers'
import { extractContent, loadExtractedContent } from '../lib/extract-content'
import { countChineseCharacters } from '../lib/chinese-utils'
import { generateChunkIndices } from '../lib/chunking'
import { embedAndStoreChunk } from '../lib/embedding'
import { translateAndStoreChunk } from '../lib/translation'
import { extractEntities } from '../lib/entity-extraction'

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

    // Step 8: Load node types for entity extraction
    const nodeTypes = await step.do('load-node-types', async () => {
      const types = await this.env.DB.prepare(
        'SELECT id, name, definition FROM node_type ORDER BY name'
      ).all<{ id: number; name: string; definition: string }>()

      const examples = await this.env.DB.prepare(
        'SELECT node_type_id, example FROM node_type_example ORDER BY id'
      ).all<{ node_type_id: number; example: string }>()

      const examplesByType: Record<number, string[]> = {}
      for (const ex of examples.results) {
        if (!examplesByType[ex.node_type_id]) examplesByType[ex.node_type_id] = []
        examplesByType[ex.node_type_id].push(ex.example)
      }

      return types.results.map((t) => ({
        name: t.name,
        definition: t.definition,
        examples: examplesByType[t.id] || [],
      }))
    })

    // Step 9: Extract entities from each chunk
    console.log(`[ingest] Node types loaded: ${nodeTypes.length}`, nodeTypes.map((t) => t.name))
    if (nodeTypes.length > 0) {
      for (const chunkId of chunkIds) {
        await step.do(`extract-entities-${chunkId}`, async () => {
          console.log(`[ingest] Extracting entities for chunk ${chunkId}`)
          try {
            const chunk = await this.env.DB.prepare(
              'SELECT content FROM text_chunk WHERE id = ?'
            )
              .bind(chunkId)
              .first<{ content: string }>()

            if (!chunk) {
              throw new Error(`Chunk ${chunkId} not found`)
            }

            const entities = await extractEntities(chunk.content, nodeTypes, this.env)
            console.log(`[ingest] Chunk ${chunkId}: ${entities.length} entities extracted`)

            if (entities.length > 0) {
              const stmt = this.env.DB.prepare(
                `INSERT INTO extracted_entity
                  (source_document_id, source_chunk_id, entity_type, extracted_text,
                   chunk_start_index, chunk_end_index, scope)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`
              )
              await this.env.DB.batch(
                entities.map((e) =>
                  stmt.bind(
                    documentId,
                    chunkId,
                    e.nodeType,
                    e.text,
                    e.startIndex,
                    e.endIndex,
                    'chunk'
                  )
                )
              )
              console.log(`[ingest] Chunk ${chunkId}: ${entities.length} entities inserted`)
            }
          } catch (err) {
            console.error(`[ingest] Entity extraction failed for chunk ${chunkId}:`, err)
            throw err
          }
        })
      }
    } else {
      console.log('[ingest] No node types configured, skipping entity extraction')
    }

    return { documentId, chunkCount: chunkIds.length }
  }
}