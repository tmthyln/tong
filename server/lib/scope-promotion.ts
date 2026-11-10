/**
 * Cross-document entity resolution within a knowledge scope ("scope promotion"):
 * link a document's document-scope entities to the scope's knowledge base —
 * existing scope-level entities, or unpromoted entities of other documents in
 * the scope — and mint a scope entity when ≥2 documents agree.
 *
 * Every entity carries its aliases (the surface forms of its chunk mentions,
 * already alias-grouped by coreference) and one context snippet. By default a
 * query links to the KB entity it shares an exact alias with, when that match
 * is unambiguous — no LLM. In the eval (eval/resolution) this rule beat every
 * LLM linker (models over-link similar names); `deps.llm` enables the LLM pass
 * over the remaining queries' top-k candidates for experimentation. The previous
 * implementation compared labels only (exact or edit distance < 0.3, which never
 * fires for 2–3 character names) and asked llama-3.3-70b to group ids by label
 * with no context. Chosen from the local eval (eval/resolution).
 */
import { exactAliasMatch, linkEntities, type KbEntity, type LinkQuery } from './extraction/resolve'
import { workersAiClient, type LlmClient } from './extraction/llm'

/** Recorded as the enrichment run's model: the default linker is a rule, not an LLM. */
export const SCOPE_PROMOTION_LINKER = 'rule:exact-alias'

/** Model for the optional LLM pass (deps.llm); the default linker uses none. */
export const SCOPE_PROMOTION_MODEL = '@cf/google/gemma-4-26b-a4b-it'

export interface PromoteEntitiesResult {
  scopeEntitiesCreated: number
  scopeEntitiesLinked: number
  affectedDocumentIds: number[]
  skipped: null | 'only_one_document_in_scope'
}

export interface PromoteRelationshipsResult {
  relationshipsPromoted: number
}

export interface ScopePromotionDeps {
  /** Override the linker (tests). Default: linkEntities with exact auto-links + top-8 retrieval. */
  link?: (queries: LinkQuery[], kb: KbEntity[], env: Env) => Promise<Map<string, string | null>>
  /** Also ask an LLM about queries without an exact alias match (default false). */
  llm?: boolean
  model?: string
  client?: LlmClient
}

/** D1 caps bound parameters per statement at 100. */
const ID_BATCH = 90

interface AliasRow {
  owner: number
  text: string
  n: number
  ctx: string | null
}

/**
 * Aliases (chunk-mention texts, most frequent first) and one context snippet
 * per owner entity. `ownerExpr` names the column that identifies the owner of
 * each chunk mention `c` (joined through its document entity `d`).
 */
async function loadAliases(env: Env, ownerExpr: string, where: string, binds: unknown[]): Promise<Map<number, { aliases: string[]; context: string | null }>> {
  const rows = await env.DB.prepare(
    `SELECT ${ownerExpr} AS owner, c.extracted_text AS text, COUNT(*) AS n, MIN(c.id) AS first_id,
            substr(tc.content, max(1, c.chunk_start_index - 29), c.chunk_start_index - max(0, c.chunk_start_index - 30))
              || '【' || c.extracted_text || '】' || substr(tc.content, c.chunk_end_index + 1, 30) AS ctx
     FROM extracted_entity c
     JOIN extracted_entity d ON d.id = c.parent_id
     JOIN text_chunk tc ON tc.id = c.source_chunk_id
     WHERE c.scope = 'chunk' AND c.extracted_text IS NOT NULL AND d.scope = 'document' AND ${where}
     GROUP BY owner, text`,
  )
    .bind(...binds)
    .all<AliasRow>()
  const out = new Map<number, { aliases: Array<[string, number]>; context: string | null; best: number }>()
  for (const r of rows.results) {
    let e = out.get(r.owner)
    if (!e) out.set(r.owner, (e = { aliases: [], context: null, best: -1 }))
    e.aliases.push([r.text, r.n])
    if (r.n > e.best) {
      e.best = r.n
      e.context = r.ctx ? r.ctx.replace(/\s+/g, ' ') : null
    }
  }
  return new Map(
    [...out].map(([k, v]) => [k, { aliases: v.aliases.sort((a, b) => b[1] - a[1]).map(([t]) => t), context: v.context }]),
  )
}

function withLabel(aliases: string[] | undefined, label: string): string[] {
  const a = aliases ?? []
  return a.includes(label) ? a : [label, ...a]
}

async function setParent(env: Env, parentId: number, ids: number[]) {
  const stmts: D1PreparedStatement[] = []
  for (let k = 0; k < ids.length; k += ID_BATCH) {
    const chunk = ids.slice(k, k + ID_BATCH)
    stmts.push(env.DB.prepare(`UPDATE extracted_entity SET parent_id = ? WHERE id IN (${chunk.map(() => '?').join(', ')})`).bind(parentId, ...chunk))
  }
  if (stmts.length) await env.DB.batch(stmts)
}

/**
 * Promote a document's document-scope entities to scope-scope under the
 * given knowledge scope. Idempotent per trigger document; safe to call
 * repeatedly.
 *
 * Rules (unchanged):
 * - If the scope has fewer than 2 documents, returns skipped='only_one_document_in_scope'.
 * - A trigger entity linked to an existing scope entity gets it as parent.
 * - A trigger entity linked to another document's unpromoted entity mints a new
 *   scope entity (≥2 distinct documents) that both get as parent.
 * - Entities with no cross-document match remain unpromoted.
 */
export async function promoteDocumentToScope(
  triggerDocumentId: number,
  knowledgeScopeId: number,
  env: Env,
  deps: ScopePromotionDeps = {}
): Promise<PromoteEntitiesResult> {
  const docCountRow = await env.DB.prepare('SELECT COUNT(*) AS n FROM document WHERE knowledge_scope_id = ?')
    .bind(knowledgeScopeId)
    .first<{ n: number }>()
  if ((docCountRow?.n ?? 0) < 2) {
    return { scopeEntitiesCreated: 0, scopeEntitiesLinked: 0, affectedDocumentIds: [], skipped: 'only_one_document_in_scope' }
  }

  // Clear stale parent links from the trigger document only.
  await env.DB.prepare(`UPDATE extracted_entity SET parent_id = NULL WHERE source_document_id = ? AND scope = 'document'`)
    .bind(triggerDocumentId)
    .run()

  // Queries: the trigger document's document-scope entities.
  const triggerRows = await env.DB.prepare(
    `SELECT id, entity_type, label FROM extracted_entity
     WHERE source_document_id = ? AND scope = 'document' AND label IS NOT NULL`,
  )
    .bind(triggerDocumentId)
    .all<{ id: number; entity_type: string; label: string }>()
  if (triggerRows.results.length === 0) {
    return { scopeEntitiesCreated: 0, scopeEntitiesLinked: 0, affectedDocumentIds: [], skipped: null }
  }
  const triggerAliases = await loadAliases(env, 'd.id', 'd.source_document_id = ?', [triggerDocumentId])
  const queries: LinkQuery[] = triggerRows.results.map((r) => ({
    id: String(r.id),
    type: r.entity_type,
    label: r.label,
    aliases: withLabel(triggerAliases.get(r.id)?.aliases, r.label),
    context: triggerAliases.get(r.id)?.context ?? undefined,
  }))

  // KB part 1: existing scope entities, with the aliases of all their members.
  const scopeRows = await env.DB.prepare(
    `SELECT id, entity_type, label FROM extracted_entity
     WHERE scope = 'scope' AND knowledge_scope_id = ? AND label IS NOT NULL`,
  )
    .bind(knowledgeScopeId)
    .all<{ id: number; entity_type: string; label: string }>()
  const scopeAliases = await loadAliases(
    env,
    'd.parent_id',
    `d.parent_id IN (SELECT id FROM extracted_entity WHERE scope = 'scope' AND knowledge_scope_id = ?)`,
    [knowledgeScopeId],
  )

  // KB part 2: unpromoted document-scope entities of other in-scope documents.
  const otherRows = await env.DB.prepare(
    `SELECT ee.id, ee.entity_type, ee.label, ee.source_document_id
     FROM extracted_entity ee
     JOIN document d ON d.id = ee.source_document_id
     WHERE d.knowledge_scope_id = ? AND ee.scope = 'document' AND ee.parent_id IS NULL
       AND ee.source_document_id != ? AND ee.label IS NOT NULL`,
  )
    .bind(knowledgeScopeId, triggerDocumentId)
    .all<{ id: number; entity_type: string; label: string; source_document_id: number }>()
  const otherAliases = await loadAliases(
    env,
    'd.id',
    `d.parent_id IS NULL AND d.source_document_id != ? AND d.source_document_id IN (SELECT id FROM document WHERE knowledge_scope_id = ?)`,
    [triggerDocumentId, knowledgeScopeId],
  )

  const kb: KbEntity[] = [
    ...scopeRows.results.map((r) => ({
      id: `s${r.id}`,
      type: r.entity_type,
      label: r.label,
      aliases: withLabel(scopeAliases.get(r.id)?.aliases, r.label),
      contexts: scopeAliases.get(r.id)?.context ? [scopeAliases.get(r.id)!.context!] : [],
    })),
    ...otherRows.results.map((r) => ({
      id: `d${r.id}`,
      type: r.entity_type,
      label: r.label,
      aliases: withLabel(otherAliases.get(r.id)?.aliases, r.label),
      contexts: otherAliases.get(r.id)?.context ? [otherAliases.get(r.id)!.context!] : [],
    })),
  ]
  if (kb.length === 0) return { scopeEntitiesCreated: 0, scopeEntitiesLinked: 0, affectedDocumentIds: [], skipped: null }

  const link =
    deps.link ??
    (async (q: LinkQuery[], k: KbEntity[]) => {
      if (!deps.llm) return new Map(q.map((x) => [x.id, exactAliasMatch(x, k)?.id ?? null] as const))
      const r = await linkEntities(deps.client ?? workersAiClient(env.AI), q, k, {
        model: deps.model ?? SCOPE_PROMOTION_MODEL,
        retrieval: 'topk',
        k: 8,
        autoLinkExact: true,
      })
      if (r.errors.length) console.warn(`[scope-promotion] document ${triggerDocumentId}: ${r.errors.join('; ')}`)
      return r.links
    })
  const links = await link(queries, kb, env)

  // Group trigger entities by the KB entity they link to.
  const byTarget = new Map<string, number[]>()
  for (const q of queries) {
    const t = links.get(q.id)
    if (t) byTarget.set(t, [...(byTarget.get(t) ?? []), Number(q.id)])
  }

  const otherById = new Map(otherRows.results.map((r) => [r.id, r]))
  const triggerById = new Map(triggerRows.results.map((r) => [r.id, r]))
  let created = 0
  let linked = 0
  const affected = new Set<number>()
  for (const [target, ids] of byTarget) {
    if (target.startsWith('s')) {
      await setParent(env, Number(target.slice(1)), ids)
      linked++
      continue
    }
    const other = otherById.get(Number(target.slice(1)))
    if (!other) continue
    // Mint a scope entity; label by the most frequent label among members (first seen on ties).
    const labels = [other.label, ...ids.map((id) => triggerById.get(id)!.label)]
    const counts = new Map<string, number>()
    for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1)
    const label = [...counts].sort((a, b) => b[1] - a[1])[0][0]
    const inserted = await env.DB.prepare(
      `INSERT INTO extracted_entity
         (source_document_id, source_chunk_id, entity_type, extracted_text, label, scope, knowledge_scope_id)
       VALUES (?, NULL, ?, NULL, ?, 'scope', ?)
       RETURNING id`,
    )
      .bind(triggerDocumentId, other.entity_type, label, knowledgeScopeId)
      .first<{ id: number }>()
    if (!inserted) continue
    await setParent(env, inserted.id, [other.id, ...ids])
    created++
    affected.add(other.source_document_id)
  }

  return { scopeEntitiesCreated: created, scopeEntitiesLinked: linked, affectedDocumentIds: [...affected], skipped: null }
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
