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
  extractEntitiesBatch,
  removeOverlaps,
  ENTITY_BATCH_CHUNKS,
  ENTITY_EXTRACTION_MODEL,
} from '../lib/entity-extraction'
import type { NodeTypeInput, ExtractedEntity } from '../lib/entity-extraction'
import {
  extractRelationships,
  relationWindows,
  RELATION_WINDOW_CHUNKS,
  RELATION_WINDOW_STRIDE,
  RELATIONSHIP_EXTRACTION_MODEL,
} from '../lib/relationship-extraction'
import { anchorRelations } from '../lib/relationship-anchoring'
import type { EdgeTypeInput, ExtractedRelationship } from '../lib/relationship-extraction'
import { resolveDocumentCoreference, COREFERENCE_MODEL } from '../lib/coreference'
import {
  startEnrichmentRun,
  completeEnrichmentRun,
  failEnrichmentRun,
  type OntologyRef,
} from '../lib/enrichment-run'
import {
  promoteDocumentToScope,
  promoteDocumentRelationshipsToScope,
  SCOPE_PROMOTION_LINKER,
} from '../lib/scope-promotion'

const LLM_STEP_RETRIES = { retries: { limit: 4, delay: '5 second', backoff: 'exponential' } } as const


/**
 * Run scope promotion for one document under a known knowledge scope. Writes
 * one entity_resolution enrichment run for the trigger document, and one
 * entity_resolution_retroactive run for each other document whose entities
 * were touched in the process.
 */
async function runScopePromotion(
  env: Env,
  triggerDocumentId: number,
  knowledgeScopeId: number,
  ctx: EntityTypeContext,
  step: WorkflowStep
): Promise<void> {
  const ontology = [...ctx.nodeOntology, ...ctx.edgeOntology]

  await step.do('scope-promote-trigger', LLM_STEP_RETRIES, async () => {
    const runId = await startEnrichmentRun(env.DB, {
      documentId: triggerDocumentId,
      kind: 'entity_resolution',
      model: SCOPE_PROMOTION_LINKER,
      params: { knowledge_scope_id: knowledgeScopeId },
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
      // Retroactive runs for affected docs.
      for (const m of entResult.affectedDocumentIds) {
        const retroRelResult = await promoteDocumentRelationshipsToScope(m, knowledgeScopeId, env)
        const retroId = await startEnrichmentRun(env.DB, {
          documentId: m,
          kind: 'entity_resolution_retroactive',
          model: SCOPE_PROMOTION_LINKER,
          params: { knowledge_scope_id: knowledgeScopeId, triggered_by_document_id: triggerDocumentId },
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
      throw err
    }
  })
}

interface IngestDocumentParams {
  documentId: number
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
    const documentId = payload.documentId

    // Phase 1: document_stored — extract content, count characters, update the
    // document record, generate chunk indices, and persist chunks — n + 5 steps
    const storedRunId = await step.do('enrichment-start-document-stored', async () =>
      startEnrichmentRun(this.env.DB, {
        documentId,
        kind: 'document_stored',
        model: null,
        params: {},
        ontology: [],
      })
    )

    let chunkIds: number[]
    try {
      const extractResult = await step.do('extract-content', async () => {
        const result = await extractContent(payload.location, payload.mimetype, this.env)
        return { extractedLocation: result.extractedLocation, title: result.title }
      })
      const { extractedLocation, title } = extractResult

      const charStats = await step.do('count-characters', async () => {
        const content = await loadExtractedContent(extractedLocation, this.env)
        return countChineseCharacters(content)
      })

      await step.do('update-document-record', async () => {
        await this.env.DB.prepare(
          `UPDATE document SET
            title = ?,
            extracted_doc_location = ?,
            extracted_doc_char_count = ?,
            extracted_doc_unique_char_count = ?
          WHERE id = ?`
        )
          .bind(title, extractedLocation, charStats.charCount, charStats.uniqueCharCount, documentId)
          .run()
      })

      const chunkIndices = await step.do('generate-chunk-indices', async () => {
        const content = await loadExtractedContent(extractedLocation, this.env)
        return generateChunkIndices(content)
      })

      chunkIds = await step.do('persist-text-chunks', async () => {
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

      await step.do('enrichment-complete-document-stored', async () => {
        await completeEnrichmentRun(this.env.DB, storedRunId, { chunk_count: chunkIds.length })
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await step.do('enrichment-fail-document-stored', async () => {
        await failEnrichmentRun(this.env.DB, storedRunId, msg)
      })
      throw err
    }

    // Phase 2: chunk_embedding — embed each chunk — n + 2 steps
    const embedRunId = await step.do('enrichment-start-chunk-embedding', async () =>
      startEnrichmentRun(this.env.DB, {
        documentId,
        kind: 'chunk_embedding',
        model: null,
        params: { chunk_count: chunkIds.length },
        ontology: [],
      })
    )

    const embedResults = await Promise.allSettled(
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

    await step.do('enrichment-complete-chunk-embedding', async () => {
      const failed = embedResults.filter((r) => r.status === 'rejected').length
      if (failed > 0) {
        await failEnrichmentRun(
          this.env.DB,
          embedRunId,
          `${failed} of ${embedResults.length} chunk embeddings rejected`
        )
      } else {
        await completeEnrichmentRun(this.env.DB, embedRunId, {
          chunks_embedded: embedResults.length,
        })
      }
    })

    // Phase 3: Load entity type definitions — 1 step
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

    // Phase 4/5: entity extraction + coreference resolution (skipped-but-tracked
    // when no node types are configured; translation always runs regardless)
    if (entityTypeContext.nodeTypes.length === 0) {
      console.log('[ingest] No node types configured, skipping entity extraction')
      await step.do('enrichment-skip-entity-extraction', async () => {
        const runId = await startEnrichmentRun(this.env.DB, {
          documentId,
          kind: 'entity_extraction',
          model: ENTITY_EXTRACTION_MODEL,
          params: { chunk_count: chunkIds.length },
          ontology: [],
        })
        await completeEnrichmentRun(this.env.DB, runId, { skipped: 'no_node_types' })
      })
      await step.do('enrichment-skip-coreference-resolution', async () => {
        const runId = await startEnrichmentRun(this.env.DB, {
          documentId,
          kind: 'coreference_resolution',
          model: COREFERENCE_MODEL,
          params: {},
          ontology: [],
        })
        await completeEnrichmentRun(this.env.DB, runId, { skipped: 'no_node_types' })
      })
    } else {
      console.log(
        `[ingest] Starting entity extraction — ${chunkIds.length} chunks, ${entityTypeContext.nodeTypes.length} node types, ${entityTypeContext.edgeTypes.length} edge types`
      )

      // Phase 4: Extract entities (one call per batch of chunks, all node types), resolve overlaps, persist — 3⌈n/b⌉ steps
      const entityRunId = await step.do('enrichment-start-entity-extraction', async () =>
        startEnrichmentRun(this.env.DB, {
          documentId,
          kind: 'entity_extraction',
          model: ENTITY_EXTRACTION_MODEL,
          params: {
            temperature: 0,
            response_format: 'json_object',
            strategy: 'single-call-all-node-types',
            batch_chunks: ENTITY_BATCH_CHUNKS,
            chunk_count: chunkIds.length,
          },
          ontology: entityTypeContext.nodeOntology,
        })
      )

      // Chunks are extracted in batches: one call reads ENTITY_BATCH_CHUNKS
      // consecutive chunks, amortizing the (large, static) node-type prompt.
      const batches: number[][] = []
      for (let i = 0; i < chunkIds.length; i += ENTITY_BATCH_CHUNKS) batches.push(chunkIds.slice(i, i + ENTITY_BATCH_CHUNKS))

      const entityResults = await Promise.allSettled(
        batches.map(async (batchChunkIds) => {
          const contents = await step.do(`load-chunk-contents-${batchChunkIds[0]}`, async () => {
            const ph = batchChunkIds.map(() => '?').join(', ')
            const rows = await this.env.DB.prepare(`SELECT id, content FROM text_chunk WHERE id IN (${ph})`)
              .bind(...batchChunkIds)
              .all<{ id: number; content: string }>()
            const byId = new Map(rows.results.map((r) => [r.id, r.content]))
            return batchChunkIds.map((id) => {
              const content = byId.get(id)
              if (content === undefined) throw new Error(`Chunk ${id} not found`)
              return content
            })
          })

          // One call for all node types over the whole batch. The model assigns
          // each string a single type; nested-span overlaps are resolved
          // deterministically (longest span wins) — no extra LLM call.
          const rawPerChunk = await step.do(
            `extract-entities-batch-${batchChunkIds[0]}`,
            LLM_STEP_RETRIES,
            async (): Promise<ExtractedEntity[][]> =>
              extractEntitiesBatch(contents, entityTypeContext.nodeTypes, this.env)
          )

          await step.do(`persist-entities-batch-${batchChunkIds[0]}`, async () => {
            const entityStmt = this.env.DB.prepare(
              `INSERT OR IGNORE INTO extracted_entity
                (source_document_id, source_chunk_id, entity_type, extracted_text,
                 chunk_start_index, chunk_end_index, scope)
               VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            const stmts = batchChunkIds.flatMap((chunkId, i) => {
              const entities = removeOverlaps(rawPerChunk[i])
              console.log(`[ingest] Chunk ${chunkId}: ${entities.length} entities (${rawPerChunk[i].length} raw)`)
              return entities.map((entity) =>
                entityStmt.bind(documentId, chunkId, entity.nodeType, entity.text, entity.startIndex, entity.endIndex, 'chunk')
              )
            })
            if (stmts.length > 0) await this.env.DB.batch(stmts)
          })
        })
      )

      // Close Phase 4 enrichment run
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
            `${failed} of ${entityResults.length} chunk-batch extractions rejected`
          )
        } else {
          await completeEnrichmentRun(this.env.DB, entityRunId, {
            chunks_processed: chunkIds.length,
            batches_processed: entityResults.length,
            batches_failed: failed,
            entities_inserted: totalEntitiesRow?.n ?? 0,
            node_types: entityTypeContext.nodeTypes.length,
          })
        }
      })

      // Phase 5: Document-wide coreference resolution — 1 step
      await step.do('coref-resolution', LLM_STEP_RETRIES, async () => {
        const corefRunId = await startEnrichmentRun(this.env.DB, {
          documentId,
          kind: 'coreference_resolution',
          model: COREFERENCE_MODEL,
          params: { strategy: 'surface-forms', context: false, temperature: 0, response_format: 'json_object' },
          ontology: entityTypeContext.nodeOntology,
        })
        try {
          // Non-fatal on model failure: falls back to identical-text grouping and reports errors.
          const coref = await resolveDocumentCoreference(documentId, this.env)
          await completeEnrichmentRun(this.env.DB, corefRunId, {
            document_entities_created: coref.documentEntities,
            chunk_entities_linked: coref.chunkEntitiesLinked,
            model_errors: coref.errors.length,
          })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          await failEnrichmentRun(this.env.DB, corefRunId, msg)
          throw err
        }
      })
    }

    // Phase 6: Sliding window relationship extraction — one step per window (all edge types) + 1
    if (entityTypeContext.edgeTypes.length > 0) {
      const relRunId = await step.do('enrichment-start-relationship-extraction', async () =>
        startEnrichmentRun(this.env.DB, {
          documentId,
          kind: 'relationship_extraction',
          model: RELATIONSHIP_EXTRACTION_MODEL,
          params: {
            temperature: 0,
            response_format: 'json_object',
            strategy: 'single-call-all-edge-types',
            window_chunks: RELATION_WINDOW_CHUNKS,
            window_stride: RELATION_WINDOW_STRIDE,
          },
          ontology: entityTypeContext.edgeOntology,
        })
      )
      interface WindowRelResult {
        windowStart: number
        windowChunkIds: number[]
        relationships: ExtractedRelationship[]
      }

      const windows = relationWindows(chunkIds.length)
      console.log(`[ingest] Document ${documentId}: starting Phase 6 — ${windows.length} window steps`)

      const windowResults = await Promise.allSettled(
        windows.map(([windowStart, windowEnd]) =>
          step.do(
            `extract-rels-window-${windowStart}-${windowEnd}`,
            LLM_STEP_RETRIES,
            async (): Promise<WindowRelResult> => {
              const windowChunkIds = chunkIds.slice(windowStart, windowEnd)
              const placeholders = windowChunkIds.map(() => '?').join(', ')
              const [contentRow, entityRows] = await Promise.all([
                this.env.DB.prepare(
                  `SELECT GROUP_CONCAT(content, char(10)) AS window_content
                   FROM (SELECT content FROM text_chunk WHERE id IN (${placeholders}) ORDER BY chunk_order)`
                )
                  .bind(...windowChunkIds)
                  .first<{ window_content: string }>(),
                this.env.DB.prepare(
                  `SELECT entity_type, extracted_text FROM extracted_entity
                   WHERE source_chunk_id IN (${placeholders}) AND scope = 'chunk'
                   AND extracted_text IS NOT NULL`
                )
                  .bind(...windowChunkIds)
                  .all<{ entity_type: string; extracted_text: string }>(),
              ])

              const relationships = await extractRelationships(
                contentRow?.window_content ?? '',
                entityRows.results.map((r) => ({ nodeType: r.entity_type, text: r.extracted_text })),
                entityTypeContext.edgeTypes,
                this.env
              )
              return { windowStart, windowChunkIds, relationships }
            }
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
          `SELECT ee.id, ee.entity_type, ee.extracted_text, ee.parent_id, ee.source_chunk_id,
                  ee.chunk_start_index, tc.chunk_order
           FROM extracted_entity ee
           LEFT JOIN text_chunk tc ON tc.id = ee.source_chunk_id
           WHERE ee.source_document_id = ? AND ee.scope = 'chunk'`
        )
          .bind(documentId)
          .all<{
            id: number
            entity_type: string
            extracted_text: string | null
            parent_id: number | null
            source_chunk_id: number | null
            chunk_start_index: number | null
            chunk_order: number | null
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
          const windowMentions = entityRows.results
            .filter((r) => r.extracted_text && r.source_chunk_id !== null && windowChunkSet.has(r.source_chunk_id))
            .map((r) => ({
              id: r.id,
              text: r.extracted_text!,
              chunkId: r.source_chunk_id!,
              chunkOrder: r.chunk_order ?? 0,
              startIndex: r.chunk_start_index ?? 0,
            }))
          // One anchored row per co-occurring chunk — not every mention pair.
          for (const rel of anchorRelations(relationships, windowMentions)) {
            const key = `${rel.fromEntityId}|${rel.toEntityId}|${rel.edgeType}`
            if (chunkRelSeen.has(key)) continue
            chunkRelSeen.add(key)
            chunkRels.push({
              from_entity_id: rel.fromEntityId,
              to_entity_id: rel.toEntityId,
              edgeType: rel.edgeType,
              explanation: rel.explanation,
            })
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
    } else {
      await step.do('enrichment-skip-relationship-extraction', async () => {
        const runId = await startEnrichmentRun(this.env.DB, {
          documentId,
          kind: 'relationship_extraction',
          model: RELATIONSHIP_EXTRACTION_MODEL,
          params: {},
          ontology: [],
        })
        await completeEnrichmentRun(this.env.DB, runId, { skipped: 'no_edge_types' })
      })
    }

    // Phase 7: Knowledge-scope promotion (entity_resolution) — runs only when
    // the document is assigned a scope. Not part of the preprocessing Ready gate.
    if (payload.knowledgeScopeId !== null) {
      await runScopePromotion(this.env, documentId, payload.knowledgeScopeId, entityTypeContext, step)
    }

    // Phase 8: initial_translation — MT baseline (draft -1), LLM+MT context
    // baseline (draft 0), and initial draft — 3n + 2 steps
    const initialTranslationRunId = await step.do('enrichment-start-initial-translation', async () =>
      startEnrichmentRun(this.env.DB, {
        documentId,
        kind: 'initial_translation',
        model: null,
        params: { chunk_count: chunkIds.length },
        ontology: [],
      })
    )

    const mtBaselineResults = await Promise.allSettled(
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
    console.log(`[ingest] Document ${documentId}: MT baseline translation complete — ${chunkIds.length} chunks`)

    const llmMtBaselineResults = await Promise.allSettled(
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
    console.log(`[ingest] Document ${documentId}: LLM+MT baseline translation complete — ${chunkIds.length} chunks`)

    const initialDraftResults = await Promise.allSettled(
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
    console.log(`[ingest] Document ${documentId}: initial draft translation complete — ${chunkIds.length} chunks`)

    await step.do('enrichment-complete-initial-translation', async () => {
      const failed = [...mtBaselineResults, ...llmMtBaselineResults, ...initialDraftResults].filter(
        (r) => r.status === 'rejected'
      ).length
      if (failed > 0) {
        await failEnrichmentRun(
          this.env.DB,
          initialTranslationRunId,
          `${failed} chunk translation steps rejected across MT baseline / LLM+MT baseline / initial draft`
        )
      } else {
        await completeEnrichmentRun(this.env.DB, initialTranslationRunId, {
          chunks_translated: chunkIds.length,
        })
      }
    })

    // Phase 9: initial_translation_refinement — revision draft — n + 2 steps
    const refinementRunId = await step.do('enrichment-start-initial-translation-refinement', async () =>
      startEnrichmentRun(this.env.DB, {
        documentId,
        kind: 'initial_translation_refinement',
        model: null,
        params: { chunk_count: chunkIds.length },
        ontology: [],
      })
    )

    const revisionResults = await Promise.allSettled(
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
    console.log(`[ingest] Document ${documentId}: revision translation complete — ${chunkIds.length} chunks`)

    await step.do('enrichment-complete-initial-translation-refinement', async () => {
      const failed = revisionResults.filter((r) => r.status === 'rejected').length
      if (failed > 0) {
        await failEnrichmentRun(
          this.env.DB,
          refinementRunId,
          `${failed} of ${revisionResults.length} revision steps rejected`
        )
      } else {
        await completeEnrichmentRun(this.env.DB, refinementRunId, {
          chunks_revised: revisionResults.length,
        })
      }
    })

    return { documentId, chunkCount: chunkIds.length }
  }
}
