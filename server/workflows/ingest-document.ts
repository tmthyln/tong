import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers'
import { extractContent, loadExtractedContent } from '../lib/extract-content'
import { countChineseCharacters } from '../lib/chinese-utils'
import { generateChunkIndices } from '../lib/chunking'
import { embedAndStoreChunk } from '../lib/embedding'
import {
  translateChunkMTBaseline,
  translateChunkLLMWithMTContext,
  translateChunkInitialDraft,
  translateChunkRevision,
} from '../lib/translation'
import { extractEntitiesForNodeTypes, deduplicateEntitiesLLM } from '../lib/entity-extraction'
import type { NodeTypeInput, ExtractedEntity } from '../lib/entity-extraction'
import { extractRelationshipsForEdgeType } from '../lib/relationship-extraction'
import type { EdgeTypeInput, ExtractedRelationship } from '../lib/relationship-extraction'
import { resolveDocumentCoreference } from '../lib/coreference'

const LLM_STEP_RETRIES = { retries: { limit: 4, delay: '5 second', backoff: 'exponential' } } as const

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
            LLM_STEP_RETRIES,
            async (): Promise<ExtractedEntity[]> =>
              extractEntitiesForNodeTypes(chunkContent, [nodeType], this.env)
          )
          rawEntities.push(...entities)
        }

        // LLM entity deduplication
        const entities = await step.do(
          `deduplicate-entities-${chunkId}`,
          async (): Promise<ExtractedEntity[]> =>
            deduplicateEntitiesLLM(chunkContent, rawEntities, this.env)
        )
        // Persist entities for this chunk
        await step.do(`persist-entities-${chunkId}`, async () => {
          console.log(
            `[ingest] Chunk ${chunkId}: ${entities.length} entities (${rawEntities.length} raw)`
          )
          if (entities.length === 0) return

          const entityStmt = this.env.DB.prepare(
            `INSERT OR IGNORE INTO extracted_entity
              (source_document_id, source_chunk_id, entity_type, extracted_text,
               chunk_start_index, chunk_end_index, scope)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          await this.env.DB.batch(
            entities.map((entity) =>
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
          )
        })
      })
    )

    // Phase 8.5: Document-wide coreference resolution
    await step.do('coref-resolution', LLM_STEP_RETRIES, async () => {
      await resolveDocumentCoreference(documentId, this.env)
    })

    // Phase 8.7: Sliding window relationship extraction (document-level, after coref)
    if (entityTypeContext.edgeTypes.length > 0) {
      interface WindowRelResult {
        centerIdx: number
        windowChunkIds: number[]
        relationships: ExtractedRelationship[]
      }

      // Generate window center indices: 0, 2, 4, ... up to chunkIds.length - 1
      const centerIndices: number[] = []
      for (let i = 0; i < chunkIds.length; i += 2) {
        centerIndices.push(i)
      }

      const windowCount = centerIndices.length * entityTypeContext.edgeTypes.length
      console.log(`[ingest] Document ${documentId}: starting Phase 8.7 — ${windowCount} window/edge-type steps`)

      const windowResults = await Promise.allSettled(
        centerIndices.flatMap((centerIdx) =>
          entityTypeContext.edgeTypes.map((edgeType) =>
            step.do(
              `extract-rels-window-${centerIdx}-${edgeType.name}`,
              LLM_STEP_RETRIES,
              async (): Promise<WindowRelResult> => {
                const n = chunkIds.length
                const windowChunkIds = chunkIds.slice(
                  Math.max(0, centerIdx - 3),
                  Math.min(n - 1, centerIdx + 3) + 1
                )

                const placeholders = windowChunkIds.map(() => '?').join(', ')
                const [contentRow, entityRows] = await Promise.all([
                  this.env.DB.prepare(
                    `SELECT GROUP_CONCAT(content, char(10)) AS window_content
                     FROM (SELECT content FROM text_chunk WHERE id IN (${placeholders}) ORDER BY chunk_order)`
                  )
                    .bind(...windowChunkIds)
                    .first<{ window_content: string }>(),
                  this.env.DB.prepare(
                    `SELECT id, entity_type, extracted_text FROM extracted_entity
                     WHERE source_chunk_id IN (${placeholders}) AND scope = 'chunk'
                     AND extracted_text IS NOT NULL`
                  )
                    .bind(...windowChunkIds)
                    .all<{ id: number; entity_type: string; extracted_text: string }>(),
                ])

                const windowContent = contentRow?.window_content ?? ''

                const entities = entityRows.results.map((r) => ({
                  nodeType: r.entity_type,
                  text: r.extracted_text,
                }))

                const relationships = await extractRelationshipsForEdgeType(
                  windowContent,
                  entities,
                  edgeType,
                  this.env
                )

                return { centerIdx, windowChunkIds, relationships }
              }
            )
          )
        )
      )

      // Persist all relationships in a single step
      await step.do('persist-relationships', async () => {
        // Idempotency: clear any previously persisted relationships for this document
        await this.env.DB.prepare(
          'DELETE FROM extracted_relationship WHERE source_document_id = ?'
        )
          .bind(documentId)
          .run()

        // Load all chunk-scoped entities for the document
        const entityRows = await this.env.DB.prepare(
          `SELECT id, entity_type, extracted_text, parent_id, source_chunk_id
           FROM extracted_entity WHERE source_document_id = ? AND scope = 'chunk'`
        )
          .bind(documentId)
          .all<{
            id: number
            entity_type: string
            extracted_text: string | null
            parent_id: number | null
            source_chunk_id: number | null
          }>()

        const entityMap = new Map(
          entityRows.results.map((r) => [
            r.id,
            {
              extractedText: r.extracted_text,
              entityType: r.entity_type,
              parentId: r.parent_id,
              sourceChunkId: r.source_chunk_id,
            },
          ])
        )

        // Build text→entity IDs index per chunk
        const textToEntityIds = new Map<string, number[]>()
        for (const [id, info] of entityMap) {
          if (!info.extractedText) continue
          const existing = textToEntityIds.get(info.extractedText)
          if (existing) {
            existing.push(id)
          } else {
            textToEntityIds.set(info.extractedText, [id])
          }
        }

        interface ChunkRelRow {
          from_entity_id: number
          to_entity_id: number
          edgeType: string
          explanation: string
        }

        const chunkRels: ChunkRelRow[] = []
        const chunkRelSeen = new Set<string>()

        for (const result of windowResults) {
          if (result.status !== 'fulfilled') continue
          const { windowChunkIds, relationships } = result.value

          const windowChunkSet = new Set(windowChunkIds)
          // Entity IDs whose source_chunk_id is in this window
          const windowEntityIds = new Set<number>()
          for (const [id, info] of entityMap) {
            if (info.sourceChunkId !== null && windowChunkSet.has(info.sourceChunkId)) {
              windowEntityIds.add(id)
            }
          }

          for (const rel of relationships) {
            const fromIds = (textToEntityIds.get(rel.fromText) ?? []).filter((id) =>
              windowEntityIds.has(id)
            )
            const toIds = (textToEntityIds.get(rel.toText) ?? []).filter((id) =>
              windowEntityIds.has(id)
            )

            for (const fromId of fromIds) {
              for (const toId of toIds) {
                if (fromId === toId) continue
                const key = `${fromId}|${toId}|${rel.edgeType}`
                if (chunkRelSeen.has(key)) continue
                chunkRelSeen.add(key)
                chunkRels.push({
                  from_entity_id: fromId,
                  to_entity_id: toId,
                  edgeType: rel.edgeType,
                  explanation: rel.explanation,
                })
              }
            }
          }
        }

        // Batch-insert chunk-scope relationships
        if (chunkRels.length > 0) {
          const relStmt = this.env.DB.prepare(
            `INSERT INTO extracted_relationship
              (source_document_id, from_entity_id, to_entity_id, edge_type, explanation, scope)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          await this.env.DB.batch(
            chunkRels.map((r) =>
              relStmt.bind(documentId, r.from_entity_id, r.to_entity_id, r.edgeType, r.explanation, 'chunk')
            )
          )
        }

        // Promote chunk entities to document scope where needed, then create document-scope rels
        const promotedMap = new Map<number, number>()

        const resolveDocEntityId = async (chunkEntityId: number): Promise<number | null> => {
          const info = entityMap.get(chunkEntityId)
          if (!info) return null

          if (info.parentId !== null) return info.parentId

          // Already promoted in this run?
          const existing = promotedMap.get(chunkEntityId)
          if (existing !== undefined) return existing

          // Promote: create a document-scope entity
          const label = info.extractedText
          const inserted = await this.env.DB.prepare(
            `INSERT INTO extracted_entity
              (source_document_id, source_chunk_id, entity_type, extracted_text, label, scope)
             VALUES (?, NULL, ?, NULL, ?, 'document')
             RETURNING id`
          )
            .bind(documentId, info.entityType, label)
            .first<{ id: number }>()

          if (!inserted) return null
          const docEntityId = inserted.id

          // Link the chunk entity to its new parent
          await this.env.DB.prepare('UPDATE extracted_entity SET parent_id = ? WHERE id = ?')
            .bind(docEntityId, chunkEntityId)
            .run()

          promotedMap.set(chunkEntityId, docEntityId)
          // Update the in-memory map so subsequent lookups use the parent
          entityMap.set(chunkEntityId, { ...info, parentId: docEntityId })
          return docEntityId
        }

        const docRels: ChunkRelRow[] = []
        const docRelSeen = new Set<string>()

        for (const chunkRel of chunkRels) {
          const fromDocId = await resolveDocEntityId(chunkRel.from_entity_id)
          const toDocId = await resolveDocEntityId(chunkRel.to_entity_id)
          if (fromDocId === null || toDocId === null || fromDocId === toDocId) continue

          const key = `${fromDocId}|${toDocId}|${chunkRel.edgeType}`
          if (docRelSeen.has(key)) continue
          docRelSeen.add(key)
          docRels.push({
            from_entity_id: fromDocId,
            to_entity_id: toDocId,
            edgeType: chunkRel.edgeType,
            explanation: chunkRel.explanation,
          })
        }

        if (docRels.length > 0) {
          const relStmt = this.env.DB.prepare(
            `INSERT INTO extracted_relationship
              (source_document_id, from_entity_id, to_entity_id, edge_type, explanation, scope)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          await this.env.DB.batch(
            docRels.map((r) =>
              relStmt.bind(documentId, r.from_entity_id, r.to_entity_id, r.edgeType, r.explanation, 'document')
            )
          )
        }

        console.log(
          `[ingest] Document ${documentId}: ${chunkRels.length} chunk-scope relationships, ${docRels.length} document-scope relationships`
        )
      })
    }

    // Phase 8.9a: MT baseline translation (draft_number = -1)
    await Promise.allSettled(
      chunkIds.map((chunkId) =>
        step.do(`translate-chunk-mt-baseline-${chunkId}`, LLM_STEP_RETRIES, async () => {
          const chunk = await this.env.DB.prepare('SELECT content FROM text_chunk WHERE id = ?')
            .bind(chunkId)
            .first<{ content: string }>()
          if (!chunk) throw new Error(`Chunk ${chunkId} not found`)
          await translateChunkMTBaseline(chunkId, chunk.content, this.env)
        })
      )
    )
    console.log(`[ingest] Document ${documentId}: Phase 8.9a complete — ${chunkIds.length} chunks MT baseline translated`)

    // Phase 8.9b: LLM+MT context baseline translation (draft_number = 0)
    await Promise.allSettled(
      chunkIds.map((chunkId) =>
        step.do(`translate-chunk-llm-mt-baseline-${chunkId}`, LLM_STEP_RETRIES, async () => {
          const chunk = await this.env.DB.prepare('SELECT content FROM text_chunk WHERE id = ?')
            .bind(chunkId)
            .first<{ content: string }>()
          if (!chunk) throw new Error(`Chunk ${chunkId} not found`)
          await translateChunkLLMWithMTContext(chunkId, documentId, chunk.content, this.env)
        })
      )
    )
    console.log(`[ingest] Document ${documentId}: Phase 8.9b complete — ${chunkIds.length} chunks LLM+MT baseline translated`)

    // Phase 9: Initial translation draft (all chunks in parallel)
    await Promise.allSettled(
      chunkIds.map((chunkId) =>
        step.do(`translate-chunk-initial-${chunkId}`, LLM_STEP_RETRIES, async () => {
          const chunk = await this.env.DB.prepare('SELECT content FROM text_chunk WHERE id = ?')
            .bind(chunkId)
            .first<{ content: string }>()
          if (!chunk) throw new Error(`Chunk ${chunkId} not found`)
          await translateChunkInitialDraft(chunkId, documentId, chunk.content, this.env)
        })
      )
    )
    console.log(`[ingest] Document ${documentId}: Phase 9 complete — ${chunkIds.length} chunks translated (initial draft)`)

    // Phase 10: Revised translation draft (all chunks in parallel)
    await Promise.allSettled(
      chunkIds.map((chunkId) =>
        step.do(`translate-chunk-revision-${chunkId}`, LLM_STEP_RETRIES, async () => {
          const chunk = await this.env.DB.prepare('SELECT content FROM text_chunk WHERE id = ?')
            .bind(chunkId)
            .first<{ content: string }>()
          if (!chunk) throw new Error(`Chunk ${chunkId} not found`)
          await translateChunkRevision(chunkId, documentId, chunk.content, this.env)
        })
      )
    )
    console.log(`[ingest] Document ${documentId}: Phase 10 complete — ${chunkIds.length} chunks translated (revision)`)

    return { documentId, chunkCount: chunkIds.length }
  }
}
