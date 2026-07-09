export interface EnrichmentRunStatus {
  kind: string
  status: string
}

/**
 * True when the initial translation draft or its refinement hasn't finished
 * yet for a document. `runs` is expected in the order returned by
 * GET /api/library/document/:id/enrichments (started_at DESC, id DESC), so
 * the first entry per kind is the latest run.
 */
export function isTranslationNotReady(runs: EnrichmentRunStatus[]): boolean {
  const latestByKind = new Map<string, EnrichmentRunStatus>()
  for (const run of runs) {
    if (!latestByKind.has(run.kind)) latestByKind.set(run.kind, run)
  }
  const initial = latestByKind.get('initial_translation')
  const refinement = latestByKind.get('initial_translation_refinement')
  return initial?.status !== 'completed' || refinement?.status !== 'completed'
}
