import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers'
import { extractContent, loadExtractedContent } from '../lib/extract-content'
import { countChineseCharacters } from '../lib/chinese-utils'
import { generateChunkIndices } from '../lib/chunking'
import { embedAndStoreChunk } from '../lib/embedding'
import { translateChunkInitialDraft, translateChunkRevision } from '../lib/translation'
import { extractEntitiesForNodeTypes, deduplicateEntitiesLLM } from '../lib/entity-extraction'
import type { NodeTypeInput, ExtractedEntity } from '../lib/entity-extraction'
import { extractRelationshipsForEdgeType } from '../lib/relationship-extraction'
import type { EdgeTypeInput, ExtractedRelationship } from '../lib/relationship-extraction'

interface IngestDocumentParams {
  location: string
  filename: string
  mimetype: string
  contentHash: string
  dateUploaded: string
  parentId: number | null
}

interface EntityTypeContext {
  nodeTypes: NodeTypeInput[]
  edgeTypes: EdgeTypeInput[]
}

export class IngestDocumentWorkflow extends WorkflowEntrypoint<Env, IngestDocumentParams> {
  async run(event: WorkflowEvent<IngestDocumentParams>, step: WorkflowStep) {
    const { payload } = event

    // Phase 1: Extract content from document and save as markdown to R2
    const extractResult = await step.do('extract-content', async () => {
      const result = await extractContent(payload.location, payload.mimetype, this.env)
      return { extractedLocation: result.extractedLocation, title: result.title }
    })
    const { extractedLocation, title } = extractResult

    // Phase 2: Count Chinese characters
    const charStats = await step.do('count-characters', async () => {
      const content = await loadExtractedContent(extractedLocation, this.env)
      return countChineseCharacters(content)
    })

    // Phase 3: Create the document record in the database
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

    // Phase 4: Generate text chunk indices
    const chunkIndices = await step.do('generate-chunk-indices', async () => {
      const content = await loadExtractedContent(extractedLocation, this.env)
      return generateChunkIndices(content)
    })

    // Phase 5: Persist each text chunk in database
    const chunkIds = await step.do('persist-text-chunks', async () => {
      const content = await loadExtractedContent(extractedLocation, this.env)

      const settled = await Promise.allSettled(
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

      const ids: number[] = []
      for (const r of settled) {
        if (r.status === 'fulfilled') {
          ids.push(r.value)
        } else {
          console.warn('[ingest] Failed to persist chunk:', r.reason)
        }
      }
      return ids
    })

    // Phase 6: Embed each chunk
    await Promise.allSettled(
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

    // Phase 7: Load entity type definitions
    const entityTypeContext = await step.do(
      'load-entity-type-definitions',
      async (): Promise<EntityTypeContext> => {
        const [nodeTypesResult, nodeExamplesResult, edgeTypesResult, edgeExamplesResult] =
          await Promise.allSettled([
            this.env.DB.prepare('SELECT id, name, definition FROM node_type ORDER BY name').all<{
              id: number
              name: string
              definition: string
            }>(),
            this.env.DB.prepare(
              'SELECT node_type_id, example FROM node_type_example ORDER BY id'
            ).all<{ node_type_id: number; example: string }>(),
            this.env.DB.prepare(
              'SELECT id, name, reverse_name, definition FROM edge_type ORDER BY name'
            ).all<{ id: number; name: string; reverse_name: string | null; definition: string }>(),
            this.env.DB.prepare(
              'SELECT edge_type_id, example FROM edge_type_example ORDER BY id'
            ).all<{ edge_type_id: number; example: string }>(),
          ])

        if (nodeTypesResult.status === 'rejected') throw new Error(`Failed to load node types: ${nodeTypesResult.reason}`)
        if (nodeExamplesResult.status === 'rejected') throw new Error(`Failed to load node examples: ${nodeExamplesResult.reason}`)
        if (edgeTypesResult.status === 'rejected') throw new Error(`Failed to load edge types: ${edgeTypesResult.reason}`)
        if (edgeExamplesResult.status === 'rejected') throw new Error(`Failed to load edge examples: ${edgeExamplesResult.reason}`)

        const nodeExamplesByType: Record<number, string[]> = {}
        for (const ex of nodeExamplesResult.value.results) {
          if (!nodeExamplesByType[ex.node_type_id]) nodeExamplesByType[ex.node_type_id] = []
          nodeExamplesByType[ex.node_type_id].push(ex.example)
        }

        const edgeExamplesByType: Record<number, string[]> = {}
        for (const ex of edgeExamplesResult.value.results) {
          if (!edgeExamplesByType[ex.edge_type_id]) edgeExamplesByType[ex.edge_type_id] = []
          edgeExamplesByType[ex.edge_type_id].push(ex.example)
        }

        return {
          nodeTypes: nodeTypesResult.value.results.map((t) => ({
            name: t.name,
            definition: t.definition,
            examples: nodeExamplesByType[t.id] || [],
          })),
          edgeTypes: edgeTypesResult.value.results.map((t) => ({
            name: t.name,
            reverseName: t.reverse_name,
            definition: t.definition,
            examples: edgeExamplesByType[t.id] || [],
          })),
        }
      }
    )

    if (entityTypeContext.nodeTypes.length === 0) {
      console.log('[ingest] No node types configured, skipping entity extraction')
      return { documentId, chunkCount: chunkIds.length }
    }

    console.log(
      `[ingest] Starting entity extraction — ${chunkIds.length} chunks, ${entityTypeContext.nodeTypes.length} node types, ${entityTypeContext.edgeTypes.length} edge types`
    )

    // Phase 8: Extract entities + deduplicate + extract relationships + persist — all chunks in parallel
    await Promise.allSettled(
      chunkIds.map(async (chunkId) => {
        const chunkContent = await step.do(`load-chunk-content-${chunkId}`, async () => {
          const chunk = await this.env.DB.prepare('SELECT content FROM text_chunk WHERE id = ?')
            .bind(chunkId)
            .first<{ content: string }>()
          if (!chunk) throw new Error(`Chunk ${chunkId} not found`)
          return chunk.content
        })

        // Entity extraction: one step per node type
        const rawEntities: ExtractedEntity[] = []
        for (const nodeType of entityTypeContext.nodeTypes) {
          const entities = await step.do(
            `extract-entities-${chunkId}-${nodeType.name}`,
            async (): Promise<ExtractedEntity[]> =>
              extractEntitiesForNodeTypes(chunkContent, [nodeType], this.env)
          )
          console.log(`[ingest] Chunk ${chunkId} / ${nodeType.name}: ${entities.length} entities`)
          rawEntities.push(...entities)
        }

        // LLM entity deduplication
        const entities = await step.do(
          `deduplicate-entities-${chunkId}`,
          async (): Promise<ExtractedEntity[]> =>
            deduplicateEntitiesLLM(chunkContent, rawEntities, this.env)
        )
        console.log(
          `[ingest] Chunk ${chunkId}: ${entities.length} entities after dedup (${rawEntities.length} raw)`
        )

        // Relationship extraction: one step per edge type
        const relationships: ExtractedRelationship[] = []
        if (entities.length > 0 && entityTypeContext.edgeTypes.length > 0) {
          for (const edgeType of entityTypeContext.edgeTypes) {
            const rels = await step.do(
              `extract-relationships-${chunkId}-${edgeType.name}`,
              async (): Promise<ExtractedRelationship[]> =>
                extractRelationshipsForEdgeType(chunkContent, entities, edgeType, this.env)
            )
            console.log(`[ingest] Chunk ${chunkId} / ${edgeType.name}: ${rels.length} relationships`)
            relationships.push(...rels)
          }
        }

        // Persist entities + relationships for this chunk
        await step.do(`persist-entities-${chunkId}`, async () => {
          console.log(
            `[ingest] Chunk ${chunkId}: persisting ${entities.length} entities + ${relationships.length} relationships`
          )
          const statements: D1PreparedStatement[] = []

          if (entities.length > 0) {
            const entityStmt = this.env.DB.prepare(
              `INSERT OR IGNORE INTO extracted_entity
                (source_document_id, source_chunk_id, entity_type, extracted_text,
                 chunk_start_index, chunk_end_index, scope)
               VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            for (const entity of entities) {
              statements.push(
                entityStmt.bind(
                  documentId,
                  chunkId,
                  entity.nodeType,
                  entity.text,
                  entity.startIndex,
                  entity.endIndex,
                  'chunk'
                )
              )
            }
          }

          if (relationships.length > 0) {
            const relStmt = this.env.DB.prepare(
              `INSERT OR IGNORE INTO extracted_relationship
                (source_document_id, source_chunk_id, edge_type, from_entity_text, to_entity_text, scope)
               VALUES (?, ?, ?, ?, ?, ?)`
            )
            for (const rel of relationships) {
              statements.push(
                relStmt.bind(
                  documentId,
                  chunkId,
                  rel.edgeType,
                  rel.fromText,
                  rel.toText,
                  'chunk'
                )
              )
            }
          }

          if (statements.length > 0) {
            await this.env.DB.batch(statements)
            console.log(`[ingest] Chunk ${chunkId}: batch succeeded (${statements.length} statements)`)
          } else {
            console.log(`[ingest] Chunk ${chunkId}: nothing to persist`)
          }
        })
      })
    )

    // Phase 9: Initial translation draft (all chunks in parallel)
    await Promise.allSettled(
      chunkIds.map((chunkId) =>
        step.do(`translate-chunk-initial-${chunkId}`, async () => {
          const chunk = await this.env.DB.prepare('SELECT content FROM text_chunk WHERE id = ?')
            .bind(chunkId)
            .first<{ content: string }>()
          if (!chunk) throw new Error(`Chunk ${chunkId} not found`)
          await translateChunkInitialDraft(chunkId, documentId, chunk.content, this.env)
        })
      )
    )

    // Phase 10: Revised translation draft (all chunks in parallel)
    await Promise.allSettled(
      chunkIds.map((chunkId) =>
        step.do(`translate-chunk-revision-${chunkId}`, async () => {
          const chunk = await this.env.DB.prepare('SELECT content FROM text_chunk WHERE id = ?')
            .bind(chunkId)
            .first<{ content: string }>()
          if (!chunk) throw new Error(`Chunk ${chunkId} not found`)
          await translateChunkRevision(chunkId, documentId, chunk.content, this.env)
        })
      )
    )

    return { documentId, chunkCount: chunkIds.length }
  }
}
