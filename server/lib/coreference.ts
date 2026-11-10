/**
 * Within-document coreference: group a document's chunk-scope entities into
 * document-scope parent entities.
 *
 * One LLM call per document over its distinct surface forms (text, type,
 * frequency, one context each) via the generic resolver in ./extraction/resolve.
 * Identical strings are merged deterministically; the model joins aliases
 * (劉備 / 玄德 / 劉玄德, 杰克 / 老杰克) and names each entity. The previous
 * implementation sent every mention of every exact/edit-distance component —
 * hundreds of lines for a main character, often truncated — and could not join
 * aliases that share no characters. Model and options chosen from the local eval
 * (eval/resolution): glm-5.3-flash without contexts was on or near the frontier on both corpora.
 */
import { resolveCoreference, type CorefForm } from './extraction/resolve'
import { workersAiClient, type LlmClient } from './extraction/llm'

export const COREFERENCE_MODEL = '@cf/zai-org/glm-5.3-flash' as keyof AiModels

export interface CoreferenceOptions {
  model?: string
  /** Show the model a context snippet per form (default false: in the eval it cost ~5× for no consistent gain). */
  context?: boolean
  /** Inject a client (tests, local scripts). Defaults to the env.AI binding. */
  client?: LlmClient
}

export interface CoreferenceResult {
  documentEntities: number
  chunkEntitiesLinked: number
  /** Model failures; the document still gets identical-text merges. */
  errors: string[]
}

/** D1 caps bound parameters per statement at 100. */
const ID_BATCH = 90

/**
 * Resolve document-wide entity coreference and (re)create a document-scope
 * parent for every resolved entity — including names mentioned only once, so
 * they appear in the document graph and can be linked across documents by
 * scope promotion. Idempotent: clears previous document-scope entities first. Never throws on
 * model failure — falls back to identical-text grouping and reports `errors`.
 */
export async function resolveDocumentCoreference(
  documentId: number,
  env: Env,
  opts: CoreferenceOptions = {},
): Promise<CoreferenceResult> {
  // Idempotency: clear previous coreference results (children first, so the
  // parent_id cascade does not delete them).
  await env.DB.batch([
    env.DB.prepare(`UPDATE extracted_entity SET parent_id = NULL WHERE source_document_id = ? AND scope = 'chunk'`).bind(documentId),
    env.DB.prepare(`DELETE FROM extracted_entity WHERE source_document_id = ? AND scope = 'document'`).bind(documentId),
  ])

  const rows = await env.DB.prepare(
    `SELECT ee.id, ee.entity_type, ee.extracted_text, ee.chunk_start_index, ee.chunk_end_index,
            tc.content AS chunk_content
     FROM extracted_entity ee
     JOIN text_chunk tc ON tc.id = ee.source_chunk_id
     WHERE ee.source_document_id = ? AND ee.scope = 'chunk' AND ee.extracted_text IS NOT NULL
     ORDER BY tc.chunk_order, ee.chunk_start_index`,
  )
    .bind(documentId)
    .all<{
      id: number
      entity_type: string
      extracted_text: string
      chunk_start_index: number | null
      chunk_end_index: number | null
      chunk_content: string
    }>()

  // Distinct surface forms, in first-occurrence order.
  const forms: Array<CorefForm & { ids: number[] }> = []
  const byKey = new Map<string, number>()
  for (const r of rows.results) {
    const key = `${r.extracted_text}\t${r.entity_type}`
    const at = byKey.get(key)
    if (at !== undefined) {
      forms[at].count++
      forms[at].ids.push(r.id)
      continue
    }
    const start = r.chunk_start_index ?? r.chunk_content.indexOf(r.extracted_text)
    const end = r.chunk_end_index ?? start + r.extracted_text.length
    const context =
      start >= 0
        ? (r.chunk_content.slice(Math.max(0, start - 30), start) + '【' + r.extracted_text + '】' + r.chunk_content.slice(end, end + 30)).replace(/\s+/g, ' ')
        : undefined
    byKey.set(key, forms.length)
    forms.push({ text: r.extracted_text, type: r.entity_type, count: 1, context, ids: [r.id] })
  }
  if (forms.length === 0) return { documentEntities: 0, chunkEntitiesLinked: 0, errors: [] }

  const client = opts.client ?? workersAiClient(env.AI)
  const result = await resolveCoreference(client, forms, { model: opts.model ?? (COREFERENCE_MODEL as string), context: opts.context ?? false })
  if (result.errors.length) console.warn(`[coreference] document ${documentId}: ${result.errors.join('; ')}`)

  const parents = result.entities
    .map((e) => {
      const members = e.forms.map((i) => forms[i])
      const ids = members.flatMap((f) => f.ids)
      const type = [...members].sort((a, b) => b.count - a.count)[0].type
      return { label: e.label, type, ids }
    })
  if (parents.length === 0) return { documentEntities: 0, chunkEntitiesLinked: 0, errors: result.errors }

  const inserted = await env.DB.batch<{ id: number }>(
    parents.map((p) =>
      env.DB.prepare(
        `INSERT INTO extracted_entity (source_document_id, source_chunk_id, entity_type, extracted_text, label, scope)
         VALUES (?, NULL, ?, NULL, ?, 'document') RETURNING id`,
      ).bind(documentId, p.type, p.label),
    ),
  )
  const updates: D1PreparedStatement[] = []
  parents.forEach((p, i) => {
    const parentId = inserted[i].results[0].id
    for (let k = 0; k < p.ids.length; k += ID_BATCH) {
      const ids = p.ids.slice(k, k + ID_BATCH)
      updates.push(env.DB.prepare(`UPDATE extracted_entity SET parent_id = ? WHERE id IN (${ids.map(() => '?').join(', ')})`).bind(parentId, ...ids))
    }
  })
  await env.DB.batch(updates)

  const linked = parents.reduce((n, p) => n + p.ids.length, 0)
  console.log(`[coreference] document ${documentId}: ${parents.length} document entities over ${linked} chunk entities (${forms.length} surface forms)`)
  return { documentEntities: parents.length, chunkEntitiesLinked: linked, errors: result.errors }
}
