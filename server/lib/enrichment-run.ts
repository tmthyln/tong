export type EnrichmentKind =
  | 'entity_extraction'
  | 'relationship_extraction'
  | 'document_coreference'
  | 'scope_promotion'
  | 'scope_promotion_retroactive'

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
