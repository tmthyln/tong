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
import {
  extractEntitiesForNodeTypes,
  deduplicateEntitiesLLM,
  ENTITY_EXTRACTION_MODEL,
} from '../lib/entity-extraction'
import type { NodeTypeInput, ExtractedEntity } from '../lib/entity-extraction'
import {
  extractRelationshipsForEdgeType,
  RELATIONSHIP_EXTRACTION_MODEL,
} from '../lib/relationship-extraction'
import type { EdgeTypeInput, ExtractedRelationship } from '../lib/relationship-extraction'
import { resolveDocumentCoreference, COREFERENCE_MODEL } from '../lib/coreference'
import {
  startEnrichmentRun,
  completeEnrichmentRun,
  failEnrichmentRun,
  type OntologyRef,
} from '../lib/enrichment-run'

const LLM_STEP_RETRIES = { retries: { limit: 4, delay: '5 second', backoff: 'exponential' } } as const

interface IngestDocumentParams {
  location: string
  filename: string
  mimetype: string
  contentHash: string
  dateUploaded: string
  parentId: number | null
  knowledgeScopeId: number | null
}

interface EntityTypeContext {
  nodeTypes: NodeTypeInput[]
  edgeTypes: EdgeTypeInput[]
  nodeOntology: OntologyRef[]
  edgeOntology: OntologyRef[]
}

export class IngestDocumentWorkflow extends WorkflowEntrypoint<Env, IngestDocumentParams> {
  async run(event: WorkflowEvent<IngestDocumentParams>, step: WorkflowStep) {
    const { payload } = event

    // Phase 1: Extract content from document and save as markdown to R2 — 1 step
    const extractResult = await step.do('extract-content', async () => {
      const result = await extractContent(payload.location, payload.mimetype, this.env)
      return { extractedLocation: result.extractedLocation, title: result.title }
    })
    const { extractedLocation, title } = extractResult

    // Phase 2: Count Chinese characters — 1 step
    const charStats = await step.do('count-characters', async () => {
      const content = await loadExtractedContent(extractedLocation, this.env)
      return countChineseCharacters(content)
    })

    // Phase 3: Create the document record in the database — 1 step
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
          parent_id,
          knowledge_scope_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          payload.parentId,
          payload.knowledgeScopeId
        )
        .first<{ id: number }>()

      if (!result) {
        throw new Error('Failed to create document record')
      }
      return result.id
    })

    // Phase 4: Generate text chunk indices — 1 step
    const chunkIndices = await step.do('generate-chunk-indices', async () => {
      const content = await loadExtractedContent(extractedLocation, this.env)
      return generateChunkIndices(content)
    })

    // Phase 5: Persist each text chunk in database — n + 1 steps
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

    // Phase 6: Embed each chunk — n steps
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

    // Phase 7: Load entity type definitions — 1 step
    const entityTypeContext = await step.do(
      'load-entity-type-definitions',
      async (): Promise<EntityTypeContext> => {
        const [nodeTypesResult, edgeTypesResult] = await Promise.allSettled([
          this.env.DB.prepare(
            'SELECT name, definition, examples_json, version FROM node_type WHERE is_current = 1 ORDER BY name'
          ).all<{ name: string; definition: string; examples_json: string; version: number }>(),
          this.env.DB.prepare(
            'SELECT name, reverse_name, definition, examples_json, version FROM edge_type WHERE is_current = 1 ORDER BY name'
          ).all<{
            name: string
            reverse_name: string | null
            definition: string
            examples_json: string
            version: number
          }>(),
        ])

        if (nodeTypesResult.status === 'rejected') throw new Error(`Failed to load node types: ${nodeTypesResult.reason}`)
        if (edgeTypesResult.status === 'rejected') throw new Error(`Failed to load edge types: ${edgeTypesResult.reason}`)

        const parseExamples = (json: string): string[] => {
          try {
            const v = JSON.parse(json)
            return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []
          } catch {
            return []
          }
        }

        return {
          nodeTypes: nodeTypesResult.value.results.map((t) => ({
            name: t.name,
            definition: t.definition,
            examples: parseExamples(t.examples_json),
          })),
          edgeTypes: edgeTypesResult.value.results.map((t) => ({
            name: t.name,
            reverseName: t.reverse_name,
            definition: t.definition,
            examples: parseExamples(t.examples_json),
          })),
          nodeOntology: nodeTypesResult.value.results.map((t) => ({
            kind: 'node' as const,
            name: t.name,
            version: t.version,
          })),
          edgeOntology: edgeTypesResult.value.results.map((t) => ({
            kind: 'edge' as const,
            name: t.name,
            version: t.version,
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

    // Phase 8: Extract entities, deduplicate, and persist — n(k + 3) steps (k = node types)
    const entityRunId = await step.do('enrichment-start-entity-extraction', async () =>
      startEnrichmentRun(this.env.DB, {
        documentId,
        kind: 'entity_extraction',
        model: ENTITY_EXTRACTION_MODEL,
        params: {
          temperature: 0,
          max_completion_tokens: 1024,
          response_format: 'json_object',
          chunk_count: chunkIds.length,
        },
        ontology: entityTypeContext.nodeOntology,
      })
    )

    const entityResults = await Promise.allSettled(
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

    // Close Phase 8 enrichment run
    await step.do('enrichment-complete-entity-extraction', async () => {
      const failed = entityResults.filter((r) => r.status === 'rejected').length
      const totalEntitiesRow = await this.env.DB.prepare(
        `SELECT COUNT(*) AS n FROM extracted_entity WHERE source_document_id = ? AND scope = 'chunk'`
      )
        .bind(documentId)
        .first<{ n: number }>()
      if (failed > 0) {
        await failEnrichmentRun(
          this.env.DB,
          entityRunId,
          `${failed} of ${entityResults.length} per-chunk extractions rejected`
        )
      } else {
        await completeEnrichmentRun(this.env.DB, entityRunId, {
          chunks_processed: entityResults.length,
          chunks_failed: failed,
          entities_inserted: totalEntitiesRow?.n ?? 0,
          node_types: entityTypeContext.nodeTypes.length,
        })
      }
    })

    // Phase 9: Document-wide coreference resolution — 1 step
    await step.do('coref-resolution', LLM_STEP_RETRIES, async () => {
      const corefRunId = await startEnrichmentRun(this.env.DB, {
        documentId,
        kind: 'document_coreference',
        model: COREFERENCE_MODEL,
        params: { temperature: 0, max_tokens: 1024, response_format: 'json_object' },
        ontology: entityTypeContext.nodeOntology,
      })
      try {
        await resolveDocumentCoreference(documentId, this.env)
        const docEntitiesRow = await this.env.DB.prepare(
          `SELECT COUNT(*) AS n FROM extracted_entity WHERE source_document_id = ? AND scope = 'document'`
        )
          .bind(documentId)
          .first<{ n: number }>()
        await completeEnrichmentRun(this.env.DB, corefRunId, {
          document_entities_created: docEntitiesRow?.n ?? 0,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        await failEnrichmentRun(this.env.DB, corefRunId, msg)
        throw err
      }
    })

    // Phase 10: Sliding window relationship extraction — ⌈n/2⌉ · e + 1 steps (e = edge types)
    if (entityTypeContext.edgeTypes.length > 0) {
      const relRunId = await step.do('enrichment-start-relationship-extraction', async () =>
        startEnrichmentRun(this.env.DB, {
          documentId,
          kind: 'relationship_extraction',
          model: RELATIONSHIP_EXTRACTION_MODEL,
          params: {
            temperature: 0,
            max_tokens: 2048,
            response_format: 'json_object',
            window_size: 'sliding-3-chunks',
          },
          ontology: entityTypeContext.edgeOntology,
        })
      )
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
      console.log(`[ingest] Document ${documentId}: starting Phase 10 — ${windowCount} window/edge-type steps`)

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

      await step.do('enrichment-complete-relationship-extraction', async () => {
        const counts = await this.env.DB.prepare(
          `SELECT
             SUM(CASE WHEN scope = 'chunk' THEN 1 ELSE 0 END) AS chunk_count,
             SUM(CASE WHEN scope = 'document' THEN 1 ELSE 0 END) AS doc_count
           FROM extracted_relationship WHERE source_document_id = ?`
        )
          .bind(documentId)
          .first<{ chunk_count: number | null; doc_count: number | null }>()
        await completeEnrichmentRun(this.env.DB, relRunId, {
          chunk_relationships_inserted: counts?.chunk_count ?? 0,
          document_relationships_inserted: counts?.doc_count ?? 0,
          edge_types: entityTypeContext.edgeTypes.length,
        })
      })
    }

    // Phase 11: MT baseline translation (draft_number = -1) — n steps
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
    console.log(`[ingest] Document ${documentId}: Phase 11 complete — ${chunkIds.length} chunks MT baseline translated`)

    // Phase 12: LLM+MT context baseline translation (draft_number = 0) — n steps
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
    console.log(`[ingest] Document ${documentId}: Phase 12 complete — ${chunkIds.length} chunks LLM+MT baseline translated`)

    // Phase 13: Initial translation draft — n steps
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
    console.log(`[ingest] Document ${documentId}: Phase 13 complete — ${chunkIds.length} chunks translated (initial draft)`)

    // Phase 14: Revised translation draft — n steps
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
    console.log(`[ingest] Document ${documentId}: Phase 14 complete — ${chunkIds.length} chunks translated (revision)`)

    return { documentId, chunkCount: chunkIds.length }
  }
}
