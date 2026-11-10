/**
 * Generic entity resolution over LLM clients, the counterpart to ./extract:
 *
 *  - resolveCoreference: cluster a document's distinct surface forms (text,
 *    type, frequency, one context each) into entities with canonical labels —
 *    one call per document instead of one per candidate component over every
 *    mention. Aliases with no characters in common (劉備 / 玄德) are in reach
 *    because every form is shown, not only string-similar pairs.
 *
 *  - linkEntities: link a new document's entities to a knowledge base of
 *    earlier entities (or NIL). Candidates are either the whole KB in the
 *    prompt or a cheap top-k character-overlap retrieval per query.
 *
 * Pure functions of their inputs: callers own persistence.
 */
import { extractJsonObject } from '../llm-utils'
import { EMPTY_USAGE, addUsage, type ChatUsage, type LlmClient } from './llm'

// ------------------------------------------------------------------ coreference

export interface CorefForm {
  text: string
  type: string
  /** Occurrences in the document. */
  count: number
  /** A short snippet around one occurrence (optional). */
  context?: string
}

export interface CorefOptions {
  model: string
  /** Include each form's context snippet (default true). */
  context?: boolean
  /** One call per entity type instead of one per document (no cross-type merges). */
  perType?: boolean
  /** Merge forms with identical text (any type) before asking the model (default true). */
  mergeSameText?: boolean
  /** Above this many forms a document is resolved per type (default 300). */
  maxFormsPerCall?: number
  maxCompletionTokens?: number
}

export interface CorefEntity {
  label: string
  /** Indices into the input forms. */
  forms: number[]
}

export interface CorefResult {
  entities: CorefEntity[]
  usage: ChatUsage
  calls: number
  errors: string[]
}

export const COREF_SYSTEM_PROMPT = `You resolve coreference within one Chinese document.
You are given the distinct entity names (surface forms) extracted from the document, each with an id, its type, how often it occurs, and usually a short context with the occurrence marked 【like this】.

Group the forms that refer to the same specific entity in this document:
- full names, given names, surnames used alone, courtesy names (字), nicknames
- titles, epithets or roles used as a name for one specific person (e.g. 玄德 for 劉備, 大师 for a particular teacher)
- abbreviations, variant spellings, traditional/simplified variants
Forms in a group may have different types when the extractor mislabeled one.

Do NOT group:
- an entity with what describes it: emotions, states, qualities, ages, times and actions are never the same entity as a person, place or object
- entities that are merely related: a person and their family, school, title or weapon; a place and the region containing it; a collection and its members
- different people or places that share a title, surname or category (two empires are two entities)
- generic nouns or concepts with different meanings
When unsure, leave forms separate: a wrong merge is worse than a missed one.

Return JSON: {"groups": [{"ids": [<id>, ...], "label": "<canonical name>"}]}
Only include groups of two or more ids; use each id at most once. The label is the most complete common name of the entity (usually the full name, as written in the document). Forms not in any group stay separate entities.`

function corefUserPrompt(forms: Array<CorefForm & { id: number }>, withContext: boolean): string {
  const lines = forms.map((f) => `${f.id} | ${f.type} | ×${f.count} | ${f.text}${withContext && f.context ? ` | ${f.context}` : ''}`)
  return `Forms (id | type | count | name${withContext ? ' | context' : ''}):\n${lines.join('\n')}\n\nGroup the ids that refer to the same entity. Reply with JSON {"groups": [...]}.`
}

export function parseCorefGroups(content: string | null, validIds: Set<number>): Array<{ ids: number[]; label: string | null }> {
  if (!content) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(extractJsonObject(content))
  } catch {
    return []
  }
  const raw = (parsed as { groups?: unknown })?.groups
  if (!Array.isArray(raw)) return []
  const used = new Set<number>()
  const out: Array<{ ids: number[]; label: string | null }> = []
  for (const g of raw) {
    const idsRaw: unknown = Array.isArray(g) ? g : (g as { ids?: unknown })?.ids
    if (!Array.isArray(idsRaw)) continue
    const ids = idsRaw
      .map((x) => (typeof x === 'number' ? x : typeof x === 'string' ? Number(x.replace(/^\D+/, '')) : NaN))
      .filter((x) => Number.isInteger(x) && validIds.has(x) && !used.has(x))
    const uniq = [...new Set(ids)]
    if (uniq.length < 2) continue
    uniq.forEach((x) => used.add(x))
    const label = Array.isArray(g) ? null : (g as { label?: unknown }).label
    out.push({ ids: uniq, label: typeof label === 'string' && label.trim() && label.length <= 40 ? label.trim() : null })
  }
  return out
}

async function corefCall(client: LlmClient, forms: Array<CorefForm & { id: number }>, opts: CorefOptions) {
  const r = await client.chat({
    model: opts.model,
    messages: [
      { role: 'system', content: COREF_SYSTEM_PROMPT },
      { role: 'user', content: corefUserPrompt(forms, opts.context ?? true) },
    ],
    maxCompletionTokens: opts.maxCompletionTokens ?? 2048,
  })
  return { r, groups: parseCorefGroups(r.content, new Set(forms.map((f) => f.id))) }
}

/**
 * Cluster surface forms into entities. Never throws: a failed call leaves its
 * forms as singletons and is reported in `errors` (callers decide to retry).
 */
export async function resolveCoreference(client: LlmClient, forms: CorefForm[], opts: CorefOptions): Promise<CorefResult> {
  // Nodes shown to the model: one per form, or one per distinct text (identical
  // strings are the same entity far more often than not, and it shrinks the prompt).
  const nodes: Array<CorefForm & { id: number; members: number[] }> = []
  const byText = new Map<string, number>()
  forms.forEach((f, i) => {
    const at = opts.mergeSameText === false ? undefined : byText.get(f.text)
    if (at === undefined) {
      byText.set(f.text, nodes.length)
      nodes.push({ ...f, id: nodes.length + 1, members: [i] })
    } else {
      const n = nodes[at]
      n.members.push(i)
      if (f.count > forms[n.members[0]].count && f.type !== n.type) n.type = f.type
      n.count += f.count
    }
  })
  const perType = opts.perType || nodes.length > (opts.maxFormsPerCall ?? 300)
  const batches = perType ? [...groupBy(nodes, (f) => f.type).values()].filter((b) => b.length >= 2) : nodes.length >= 2 ? [nodes] : []
  let usage = EMPTY_USAGE
  const errors: string[] = []
  const settled = await Promise.allSettled(batches.map((b) => corefCall(client, b, opts)))
  const groups: Array<{ ids: number[]; label: string | null }> = []
  for (const s of settled) {
    if (s.status === 'rejected') {
      errors.push(String(s.reason))
      continue
    }
    usage = addUsage(usage, s.value.r.usage)
    if (s.value.r.finishReason === 'length') errors.push('truncated')
    groups.push(...s.value.groups)
  }
  const grouped = new Set(groups.flatMap((g) => g.ids))
  const node = (id: number) => nodes[id - 1]
  const entities: CorefEntity[] = [
    ...groups.map((g) => {
      const top = [...g.ids].sort((a, b) => node(b).count - node(a).count)[0]
      return { label: g.label ?? node(top).text, forms: g.ids.flatMap((id) => node(id).members) }
    }),
    ...nodes.filter((n) => !grouped.has(n.id)).map((n) => ({ label: n.text, forms: n.members })),
  ]
  return { entities, usage, calls: batches.length, errors }
}

// ------------------------------------------------------------------ linking

export interface LinkQuery {
  id: string
  type: string
  label: string
  aliases: string[]
  context?: string
}

export interface KbEntity {
  id: string
  type: string
  label: string
  aliases: string[]
  contexts: string[]
}

export interface LinkOptions {
  model: string
  /** 'all': whole KB in the prompt; 'topk': per-query character-overlap retrieval. */
  retrieval: 'all' | 'topk'
  k?: number
  /** Link unambiguous same-type exact alias matches without asking the model. */
  autoLinkExact?: boolean
  /** Queries per call (default 60). */
  batchSize?: number
  maxCompletionTokens?: number
}

export interface LinkResult {
  links: Map<string, string | null>
  usage: ChatUsage
  calls: number
  errors: string[]
}

export const LINK_SYSTEM_PROMPT = `You link entities from a new document of a Chinese text collection to a knowledge base (KB) built from earlier documents.
For each query entity, decide which KB entity it is (the same specific person, place, organization, object, concept, …), or null if it is not in the KB.

Names can differ for the same entity: courtesy names (字), titles, nicknames, surnames alone, abbreviations, traditional/simplified variants. Use the contexts.
Link only when the query clearly is that same entity. A similar name is not enough: a city is not the school named after it, a person is not their title or family, and two different people can share a surname or title. When unsure, answer null: a wrong link is worse than a missed one. Types can be mislabeled; prefer a candidate of the same type.

Return JSON: {"links": {"<query id>": "<KB id>" | null, ...}} with every query id.`

const chars = (s: string) => new Set([...s])

/** Name similarity in [0, 1]: exact 1, containment 0.8, else character Jaccard. */
export function nameSimilarity(a: string, b: string): number {
  if (a === b) return 1
  if (a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a))) return 0.8
  const A = chars(a), B = chars(b)
  let inter = 0
  for (const c of A) if (B.has(c)) inter++
  return inter / (A.size + B.size - inter)
}

export function retrieveCandidates(q: LinkQuery, kb: KbEntity[], k: number, minScore = 0.2): KbEntity[] {
  const scored = kb.map((e) => {
    let s = 0
    for (const a of q.aliases) for (const b of e.aliases) s = Math.max(s, nameSimilarity(a, b))
    return { e, s: s > 0 && e.type === q.type ? s + 0.1 : s }
  })
  return scored
    .filter((x) => x.s >= minScore)
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .map((x) => x.e)
}

/** The KB entity sharing an exact alias with the query, if exactly one (same type preferred). */
export function exactAliasMatch(q: LinkQuery, kb: KbEntity[]): KbEntity | null {
  const hits = kb.filter((e) => e.aliases.some((a) => q.aliases.includes(a)))
  const sameType = hits.filter((e) => e.type === q.type)
  if (sameType.length === 1) return sameType[0]
  if (sameType.length === 0 && hits.length === 1) return hits[0]
  return null
}

const kbLine = (id: string, e: KbEntity, withContext: boolean) =>
  `${id} | ${e.type} | ${e.aliases.join(' / ')}${withContext && e.contexts[0] ? ` | ${e.contexts[0]}` : ''}`
const queryLine = (id: string, q: LinkQuery) => `${id} | ${q.type} | ${q.aliases.join(' / ')}${q.context ? ` | ${q.context}` : ''}`

export function parseLinks(content: string | null, queryIds: Set<string>, kbIds: Set<string>): Map<string, string | null> {
  const out = new Map<string, string | null>()
  if (!content) return out
  let parsed: unknown
  try {
    parsed = JSON.parse(extractJsonObject(content))
  } catch {
    return out
  }
  const raw = (parsed as { links?: unknown })?.links
  const entries: Array<[unknown, unknown]> = Array.isArray(raw)
    ? raw.map((x) => [(x as { query?: unknown; q?: unknown }).query ?? (x as { q?: unknown }).q, (x as { kb?: unknown }).kb])
    : raw && typeof raw === 'object'
      ? Object.entries(raw)
      : []
  for (const [q, k] of entries) {
    if (typeof q !== 'string' || !queryIds.has(q)) continue
    out.set(q, typeof k === 'string' && kbIds.has(k) ? k : null)
  }
  return out
}

/**
 * Link queries to KB entities. Never throws; queries in failed calls are left
 * unlinked (null) and the failure is reported in `errors`.
 */
export async function linkEntities(client: LlmClient, queries: LinkQuery[], kb: KbEntity[], opts: LinkOptions): Promise<LinkResult> {
  const links = new Map<string, string | null>(queries.map((q) => [q.id, null]))
  let usage = EMPTY_USAGE
  const errors: string[] = []
  if (kb.length === 0 || queries.length === 0) return { links, usage, calls: 0, errors }

  const pending: Array<{ q: LinkQuery; cands: KbEntity[] }> = []
  for (const q of queries) {
    if (opts.autoLinkExact) {
      const hit = exactAliasMatch(q, kb)
      if (hit && hit.type === q.type) {
        links.set(q.id, hit.id)
        continue
      }
    }
    const cands = opts.retrieval === 'all' ? kb : retrieveCandidates(q, kb, opts.k ?? 8)
    if (cands.length > 0) pending.push({ q, cands })
  }

  const size = opts.batchSize ?? 60
  const batches: (typeof pending)[] = []
  for (let i = 0; i < pending.length; i += size) batches.push(pending.slice(i, i + size))

  const kbIdx = new Map(kb.map((e, i) => [e.id, `K${i + 1}`]))
  const fromKbIdx = new Map(kb.map((e, i) => [`K${i + 1}`, e.id]))
  const settled = await Promise.allSettled(
    batches.map(async (batch) => {
      const qIds = new Map(batch.map((p, i) => [`Q${i + 1}`, p.q.id]))
      let user: string
      if (opts.retrieval === 'all') {
        user = `KB (id | type | names):\n${kb.map((e) => kbLine(kbIdx.get(e.id)!, e, false)).join('\n')}\n\nQueries (id | type | names | context):\n${batch.map((p, i) => queryLine(`Q${i + 1}`, p.q)).join('\n')}`
      } else {
        user = `Queries, each followed by its KB candidates (id | type | names | context):\n${batch
          .map((p, i) => `${queryLine(`Q${i + 1}`, p.q)}\n${p.cands.map((c) => '  ' + kbLine(kbIdx.get(c.id)!, c, true)).join('\n')}`)
          .join('\n\n')}`
      }
      const r = await client.chat({
        model: opts.model,
        messages: [
          { role: 'system', content: LINK_SYSTEM_PROMPT },
          { role: 'user', content: `${user}\n\nReply with JSON {"links": {...}}.` },
        ],
        maxCompletionTokens: opts.maxCompletionTokens ?? 2048,
      })
      return { r, qIds }
    }),
  )
  for (const s of settled) {
    if (s.status === 'rejected') {
      errors.push(String(s.reason))
      continue
    }
    usage = addUsage(usage, s.value.r.usage)
    if (s.value.r.finishReason === 'length') errors.push('truncated')
    const parsed = parseLinks(s.value.r.content, new Set(s.value.qIds.keys()), new Set(fromKbIdx.keys()))
    for (const [q, k] of parsed) links.set(s.value.qIds.get(q)!, k ? fromKbIdx.get(k)! : null)
  }
  return { links, usage, calls: batches.length, errors }
}

function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x])
  return m
}
