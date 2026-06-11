import { extractJsonObject } from './llm-utils'

export const SCOPE_PROMOTION_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
type ModelOutput = AiModels[typeof SCOPE_PROMOTION_MODEL]['postProcessedOutputs']

export interface PromoteEntitiesResult {
  scopeEntitiesCreated: number
  scopeEntitiesLinked: number
  affectedDocumentIds: number[]
  skipped: null | 'only_one_document_in_scope'
}

export interface PromoteRelationshipsResult {
  relationshipsPromoted: number
}

interface PromotionCandidate {
  id: number
  entityType: string
  label: string
  sourceDocumentId: number | null // null marks an existing scope-level anchor
}

function normalizedEditDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i)
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= n; j++) {
      const temp = dp[j]
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1])
      prev = temp
    }
  }
  return dp[n] / Math.max(m, n)
}

function parseLLMResponse(result: ModelOutput): Record<string, unknown> | null {
  if (typeof result === 'string') return null
  if ('response' in result && typeof result.response === 'string') {
    const raw = result.response
    return JSON.parse(extractJsonObject(raw)) as Record<string, unknown>
  }
  if ('response' in result && result.response && typeof result.response === 'object') {
    return result.response as Record<string, unknown>
  }
  return null
}

interface ScopePromotionDeps {
  /**
   * Override candidate filtering. Default uses exact-match OR (length ≥ 3 AND
   * normalized edit distance < 0.3) on same-type pairs — mirrors coreference.ts.
   */
  isCoreferent?: (a: PromotionCandidate, b: PromotionCandidate) => boolean
  /**
   * Refine a candidate component into final merge groups. Default uses the LLM
   * to disambiguate homonyms; tests can stub this with an identity function.
   */
  refineGroupsLLM?: (batch: PromotionCandidate[], env: Env) => Promise<PromotionCandidate[][]>
}

/**
 * Decide whether two same-type candidates should be considered for merging.
 * Cross-type pairs always return false. Exported for testing.
 */
export function defaultIsCoreferent(a: PromotionCandidate, b: PromotionCandidate): boolean {
  if (a.entityType !== b.entityType) return false
  if (a.label === b.label) return true
  if (a.label.length < 3 || b.label.length < 3) return false
  return normalizedEditDistance(a.label, b.label) < 0.3
}

/**
 * Compute connected components from a candidate list using a same-type
 * coreference predicate. Each component groups candidates that may refer to
 * the same scope-level entity. Singleton components (one candidate that
 * matched nothing) are excluded.
 *
 * Exported for testing.
 */
export function groupCandidatesByComponent(
  candidates: PromotionCandidate[],
  isCoreferent: (a: PromotionCandidate, b: PromotionCandidate) => boolean
): PromotionCandidate[][] {
  const n = candidates.length
  const adj = new Map<number, Set<number>>()
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (isCoreferent(candidates[i], candidates[j])) {
        if (!adj.has(i)) adj.set(i, new Set())
        if (!adj.has(j)) adj.set(j, new Set())
        adj.get(i)!.add(j)
        adj.get(j)!.add(i)
      }
    }
  }

  const visited = new Array<boolean>(n).fill(false)
  const components: PromotionCandidate[][] = []
  for (let i = 0; i < n; i++) {
    if (visited[i]) continue
    if (!adj.has(i)) continue
    const queue = [i]
    visited[i] = true
    const comp: PromotionCandidate[] = []
    while (queue.length > 0) {
      const cur = queue.shift()!
      comp.push(candidates[cur])
      for (const nb of adj.get(cur) ?? []) {
        if (!visited[nb]) {
          visited[nb] = true
          queue.push(nb)
        }
      }
    }
    if (comp.length >= 2) components.push(comp)
  }
  return components
}

/**
 * Classify a connected component for the ≥2-document rule.
 * Exported for testing.
 */
export function classifyComponent(comp: PromotionCandidate[]): {
  anchor: PromotionCandidate | null      // existing scope entity to link against, if any
  documentMembers: PromotionCandidate[]   // document-scope members
  distinctDocCount: number                // distinct source_document_id among document members
  shouldCreate: boolean                   // mint a new scope entity?
  shouldLinkOnly: boolean                 // link existing anchor only?
} {
  const anchor = comp.find((c) => c.sourceDocumentId === null) ?? null
  const documentMembers = comp.filter((c) => c.sourceDocumentId !== null)
  const distinctDocs = new Set(documentMembers.map((c) => c.sourceDocumentId))
  const distinctDocCount = distinctDocs.size

  if (anchor) {
    return { anchor, documentMembers, distinctDocCount, shouldCreate: false, shouldLinkOnly: true }
  }
  if (distinctDocCount >= 2) {
    return { anchor: null, documentMembers, distinctDocCount, shouldCreate: true, shouldLinkOnly: false }
  }
  return { anchor: null, documentMembers, distinctDocCount, shouldCreate: false, shouldLinkOnly: false }
}

/**
 * Default LLM refinement: send the candidate batch to the model with the
 * instruction "group ids that refer to the same real-world entity," then map
 * each returned id list back to PromotionCandidate references. If the LLM
 * fails or returns nothing usable, fall back to the batch as a single group.
 */
async function llmRefineGroups(
  batch: PromotionCandidate[],
  env: Env
): Promise<PromotionCandidate[][]> {
  const byId = new Map(batch.map((c) => [c.id, c]))
  const entityLines = batch
    .map(
      (c) =>
        `${c.id} | ${c.entityType} | ${c.label} | ${
          c.sourceDocumentId === null ? 'scope-anchor' : `doc-${c.sourceDocumentId}`
        }`
    )
    .join('\n')

  const systemPrompt = `You are a cross-document entity resolution system for Chinese knowledge graphs.
Group the entity IDs that refer to the same real-world entity across documents.
Rows tagged "scope-anchor" are existing knowledge-scope entities; merging document entities with them links to that anchor.
Entities of different types must not be merged. Use the labels to decide; homonyms (same text, different referent) should stay separate.
Return JSON: { "groups": [[id, id, ...], ...] }
Only include groups of 2 or more. Omit entities that should remain distinct.`

  const userPrompt = `Candidates (id | type | label | source):
${entityLines}

Group the ids that refer to the same real-world entity.
Reply with JSON { "groups": [[id, id, ...], ...] }`

  try {
    const result = await env.AI.run(SCOPE_PROMOTION_MODEL, {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0,
      max_tokens: 1024,
      response_format: { type: 'json_object' },
    })

    const parsed = parseLLMResponse(result)
    if (!parsed?.groups || !Array.isArray(parsed.groups)) return [batch]

    const groups: PromotionCandidate[][] = []
    for (const group of parsed.groups as unknown[]) {
      if (!Array.isArray(group) || group.length < 2) continue
      const members: PromotionCandidate[] = []
      for (const id of group) {
        if (typeof id !== 'number') continue
        const cand = byId.get(id)
        if (cand) members.push(cand)
      }
      if (members.length >= 2) groups.push(members)
    }
    return groups
  } catch (err) {
    console.warn('[scope-promotion] LLM refinement failed, keeping batch as one group:', err)
    return [batch]
  }
}

/**
 * Promote a document's document-scope entities to scope-scope under the
 * given knowledge scope. Idempotent per trigger document; safe to call
 * repeatedly.
 *
 * Rules:
 * - If the scope has fewer than 2 documents, returns skipped='only_one_document_in_scope'.
 * - A new scope-scope entity is minted only when an LLM group spans entities
 *   from ≥2 distinct source documents.
 * - If a group includes an existing scope-scope entity, every document-scope
 *   member's parent_id is linked to it.
 * - Document-scope entities with no cross-document match remain unpromoted.
 */
export async function promoteDocumentToScope(
  triggerDocumentId: number,
  knowledgeScopeId: number,
  env: Env,
  deps: ScopePromotionDeps = {}
): Promise<PromoteEntitiesResult> {
  const isCoreferent = deps.isCoreferent ?? defaultIsCoreferent
  const refineGroupsLLM = deps.refineGroupsLLM ?? llmRefineGroups

  // Step 1: n=1 early exit
  const docCountRow = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM document WHERE knowledge_scope_id = ?'
  )
    .bind(knowledgeScopeId)
    .first<{ n: number }>()
  const docCount = docCountRow?.n ?? 0
  if (docCount < 2) {
    return {
      scopeEntitiesCreated: 0,
      scopeEntitiesLinked: 0,
      affectedDocumentIds: [],
      skipped: 'only_one_document_in_scope',
    }
  }

  // Step 2: clear stale parent links from the trigger document only
  await env.DB.prepare(
    `UPDATE extracted_entity SET parent_id = NULL
     WHERE source_document_id = ? AND scope = 'document'`
  )
    .bind(triggerDocumentId)
    .run()

  // Step 3: load trigger doc's document-scope entities
  const triggerRows = await env.DB.prepare(
    `SELECT id, entity_type, label
     FROM extracted_entity
     WHERE source_document_id = ? AND scope = 'document' AND label IS NOT NULL`
  )
    .bind(triggerDocumentId)
    .all<{ id: number; entity_type: string; label: string }>()
  const triggerCandidates: PromotionCandidate[] = triggerRows.results.map((r) => ({
    id: r.id,
    entityType: r.entity_type,
    label: r.label,
    sourceDocumentId: triggerDocumentId,
  }))

  if (triggerCandidates.length === 0) {
    return { scopeEntitiesCreated: 0, scopeEntitiesLinked: 0, affectedDocumentIds: [], skipped: null }
  }

  // Step 4: existing scope-scope entities anchored by this knowledge scope
  const scopeRows = await env.DB.prepare(
    `SELECT id, entity_type, label
     FROM extracted_entity
     WHERE scope = 'scope' AND knowledge_scope_id = ? AND label IS NOT NULL`
  )
    .bind(knowledgeScopeId)
    .all<{ id: number; entity_type: string; label: string }>()
  const scopeAnchors: PromotionCandidate[] = scopeRows.results.map((r) => ({
    id: r.id,
    entityType: r.entity_type,
    label: r.label,
    sourceDocumentId: null,
  }))

  // Step 5: unpromoted document-scope candidates from other in-scope documents
  const otherRows = await env.DB.prepare(
    `SELECT ee.id, ee.entity_type, ee.label, ee.source_document_id
     FROM extracted_entity ee
     JOIN document d ON d.id = ee.source_document_id
     WHERE d.knowledge_scope_id = ?
       AND ee.scope = 'document'
       AND ee.parent_id IS NULL
       AND ee.source_document_id != ?
       AND ee.label IS NOT NULL`
  )
    .bind(knowledgeScopeId, triggerDocumentId)
    .all<{ id: number; entity_type: string; label: string; source_document_id: number }>()
  const otherCandidates: PromotionCandidate[] = otherRows.results.map((r) => ({
    id: r.id,
    entityType: r.entity_type,
    label: r.label,
    sourceDocumentId: r.source_document_id,
  }))

  const allCandidates = [...triggerCandidates, ...scopeAnchors, ...otherCandidates]
  const components = groupCandidatesByComponent(allCandidates, isCoreferent)

  // Refine each candidate component into final merge groups via LLM.
  const refinedGroups: PromotionCandidate[][] = []
  for (const comp of components) {
    const groups = await refineGroupsLLM(comp, env)
    for (const g of groups) refinedGroups.push(g)
  }

  let created = 0
  let linked = 0
  const affectedDocSet = new Set<number>()

  for (const comp of refinedGroups) {
    const verdict = classifyComponent(comp)

    if (verdict.shouldLinkOnly && verdict.anchor) {
      // Link every document-scope member to the existing anchor.
      if (verdict.documentMembers.length === 0) continue
      const ids = verdict.documentMembers.map((m) => m.id)
      const placeholders = ids.map(() => '?').join(', ')
      await env.DB.prepare(
        `UPDATE extracted_entity SET parent_id = ? WHERE id IN (${placeholders})`
      )
        .bind(verdict.anchor.id, ...ids)
        .run()
      linked += 1
      for (const m of verdict.documentMembers) {
        if (m.sourceDocumentId !== null && m.sourceDocumentId !== triggerDocumentId) {
          affectedDocSet.add(m.sourceDocumentId)
        }
      }
    } else if (verdict.shouldCreate) {
      // Mint a new scope entity. Use the most common label among members; tie-break by first-seen.
      const labelCounts = new Map<string, number>()
      for (const m of verdict.documentMembers) {
        labelCounts.set(m.label, (labelCounts.get(m.label) ?? 0) + 1)
      }
      let chosenLabel = verdict.documentMembers[0].label
      let chosenCount = -1
      for (const [lbl, ct] of labelCounts) {
        if (ct > chosenCount) {
          chosenCount = ct
          chosenLabel = lbl
        }
      }

      const inserted = await env.DB.prepare(
        `INSERT INTO extracted_entity
           (source_document_id, source_chunk_id, entity_type, extracted_text,
            label, scope, knowledge_scope_id)
         VALUES (?, NULL, ?, NULL, ?, 'scope', ?)
         RETURNING id`
      )
        .bind(
          triggerDocumentId,
          verdict.documentMembers[0].entityType,
          chosenLabel,
          knowledgeScopeId
        )
        .first<{ id: number }>()
      if (!inserted) continue

      const ids = verdict.documentMembers.map((m) => m.id)
      const placeholders = ids.map(() => '?').join(', ')
      await env.DB.prepare(
        `UPDATE extracted_entity SET parent_id = ? WHERE id IN (${placeholders})`
      )
        .bind(inserted.id, ...ids)
        .run()
      created += 1
      for (const m of verdict.documentMembers) {
        if (m.sourceDocumentId !== null && m.sourceDocumentId !== triggerDocumentId) {
          affectedDocSet.add(m.sourceDocumentId)
        }
      }
    }
    // shouldCreate=false && !shouldLinkOnly → single-doc group: no-op.
  }

  return {
    scopeEntitiesCreated: created,
    scopeEntitiesLinked: linked,
    affectedDocumentIds: [...affectedDocSet],
    skipped: null,
  }
}

/**
 * Promote a document's document-scope relationships to scope-scope when both
 * endpoints have a scope-level parent. Idempotent — skips duplicates.
 */
export async function promoteDocumentRelationshipsToScope(
  documentId: number,
  knowledgeScopeId: number,
  env: Env
): Promise<PromoteRelationshipsResult> {
  // Load this document's document-scope relationships joined with endpoint parents.
  const rows = await env.DB.prepare(
    `SELECT er.id, er.edge_type, er.explanation,
            fe.parent_id AS from_parent, te.parent_id AS to_parent
     FROM extracted_relationship er
     JOIN extracted_entity fe ON fe.id = er.from_entity_id
     JOIN extracted_entity te ON te.id = er.to_entity_id
     WHERE er.source_document_id = ? AND er.scope = 'document'`
  )
    .bind(documentId)
    .all<{
      id: number
      edge_type: string
      explanation: string | null
      from_parent: number | null
      to_parent: number | null
    }>()

  let promoted = 0
  for (const r of rows.results) {
    if (r.from_parent === null || r.to_parent === null) continue
    if (r.from_parent === r.to_parent) continue

    const existing = await env.DB.prepare(
      `SELECT id FROM extracted_relationship
       WHERE scope = 'scope' AND knowledge_scope_id = ?
         AND from_entity_id = ? AND to_entity_id = ? AND edge_type = ?
       LIMIT 1`
    )
      .bind(knowledgeScopeId, r.from_parent, r.to_parent, r.edge_type)
      .first<{ id: number }>()
    if (existing) continue

    await env.DB.prepare(
      `INSERT INTO extracted_relationship
         (source_document_id, from_entity_id, to_entity_id, edge_type,
          explanation, scope, knowledge_scope_id)
       VALUES (?, ?, ?, ?, ?, 'scope', ?)`
    )
      .bind(documentId, r.from_parent, r.to_parent, r.edge_type, r.explanation, knowledgeScopeId)
      .run()
    promoted += 1
  }
  return { relationshipsPromoted: promoted }
}
