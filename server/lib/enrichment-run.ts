export type EnrichmentKind =
  | 'document_stored'
  | 'chunk_embedding'
  | 'entity_extraction'
  | 'coreference_resolution'
  | 'relationship_extraction'
  | 'entity_resolution'
  | 'entity_resolution_retroactive'
  | 'initial_translation'
  | 'initial_translation_refinement'

export interface OntologyRef {
  kind: 'node' | 'edge'
  name: string
  version: number
}

export interface StartEnrichmentRunArgs {
  documentId: number
  kind: EnrichmentKind
  model: string | null
  params: Record<string, unknown>
  ontology: OntologyRef[]
}

export async function startEnrichmentRun(
  db: D1Database,
  args: StartEnrichmentRunArgs
): Promise<number> {
  const startedAt = new Date().toISOString()
  const row = await db
    .prepare(
      `INSERT INTO document_enrichment_run
        (document_id, kind, status, model, params_json, ontology_json, started_at)
       VALUES (?, ?, 'in_progress', ?, ?, ?, ?)
       RETURNING id`
    )
    .bind(
      args.documentId,
      args.kind,
      args.model,
      JSON.stringify(args.params),
      JSON.stringify(args.ontology),
      startedAt
    )
    .first<{ id: number }>()
  if (!row) throw new Error('Failed to insert enrichment run row')
  return row.id
}

export async function completeEnrichmentRun(
  db: D1Database,
  runId: number,
  summary: Record<string, unknown>
): Promise<void> {
  await db
    .prepare(
      `UPDATE document_enrichment_run
       SET status = 'completed', result_summary_json = ?, completed_at = ?
       WHERE id = ?`
    )
    .bind(JSON.stringify(summary), new Date().toISOString(), runId)
    .run()
}

export async function failEnrichmentRun(
  db: D1Database,
  runId: number,
  error: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE document_enrichment_run
       SET status = 'failed', error = ?, completed_at = ?
       WHERE id = ?`
    )
    .bind(error, new Date().toISOString(), runId)
    .run()
}

/**
 * Run a phase wrapped in an enrichment run: writes a start row, executes the
 * phase, then writes either completed (with summary) or failed (with error).
 * Errors are re-thrown so the surrounding workflow step's retry behavior is preserved.
 */
export async function withEnrichmentRun<T>(
  db: D1Database,
  args: StartEnrichmentRunArgs,
  fn: (runId: number) => Promise<{ result: T; summary: Record<string, unknown> }>
): Promise<T> {
  const runId = await startEnrichmentRun(db, args)
  try {
    const { result, summary } = await fn(runId)
    await completeEnrichmentRun(db, runId, summary)
    return result
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await failEnrichmentRun(db, runId, msg)
    throw err
  }
}

export type ProcessingStatus = 'pending' | 'processing' | 'ready'

export interface EnrichmentRunSummary {
  id: number
  kind: string
  status: string
  startedAt: string
}

/**
 * Preprocessing enrichments that gate a document's "ready" status in the
 * library table. Excludes entity_resolution, which only runs once a
 * document is assigned a knowledge scope.
 */
export const PREPROCESSING_KINDS: EnrichmentKind[] = [
  'document_stored',
  'chunk_embedding',
  'entity_extraction',
  'coreference_resolution',
  'relationship_extraction',
  'initial_translation',
  'initial_translation_refinement',
]

/**
 * Derive a document's 3-state processing status from its enrichment runs.
 * Only the latest run per kind counts, where "latest" means highest
 * startedAt, then highest id as a tiebreaker.
 */
export function computeProcessingStatus(runs: EnrichmentRunSummary[]): ProcessingStatus {
  const latestByKind = new Map<string, EnrichmentRunSummary>()
  for (const run of runs) {
    const existing = latestByKind.get(run.kind)
    if (
      !existing ||
      run.startedAt > existing.startedAt ||
      (run.startedAt === existing.startedAt && run.id > existing.id)
    ) {
      latestByKind.set(run.kind, run)
    }
  }

  const stored = latestByKind.get('document_stored')
  if (!stored || stored.status !== 'completed') return 'pending'

  const allDone = PREPROCESSING_KINDS.every(
    (kind) => latestByKind.get(kind)?.status === 'completed'
  )
  return allDone ? 'ready' : 'processing'
}
