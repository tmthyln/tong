import { extractJsonObject } from '../llm-utils'
import { EMPTY_USAGE, type ChatResult, type ChatUsage, type LlmClient } from './llm'
import {
  buildSystemPrompt,
  buildUserPrompt,
  type ExtractionSchema,
  type KnownEntity,
  type PromptOptions,
} from './schema'
import { locateMentions, resolveOverlaps, type Span } from './spans'

export interface Mention {
  text: string
  label: string
}

export interface Relation {
  head: string
  label: string
  tail: string
  evidence: string
}

export interface ExtractionOutput {
  /** Unique (text, label) mentions, validated to occur verbatim in the text. */
  mentions: Mention[]
  /** Character spans for every occurrence of every mention, overlaps resolved. */
  spans: Span[]
  relations: Relation[]
  classifications: Record<string, string[]>
}

export interface ExtractionRun extends ExtractionOutput {
  model: string
  usage: ChatUsage
  latencyMs: number
  finishReason: string | null
  rawContent: string | null
  error: string | null
}

export interface ExtractOptions extends PromptOptions {
  model: string
  maxCompletionTokens?: number
  thinking?: boolean
  /** Keep overlapping spans instead of greedy longest-span resolution. */
  keepOverlaps?: boolean
}

type Json = string | number | boolean | null | Json[] | { [k: string]: Json }

function asString(v: Json | undefined): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
}

/** Accepts {"TYPE": ["m", ...]} or [{"text": "m", "type": "TYPE"}, ...]. */
function parseEntities(raw: Json | undefined, allowed: Set<string>): Mention[] {
  const out: Mention[] = []
  const push = (text: string | null, label: string | null) => {
    if (text && label && allowed.has(label)) out.push({ text, label })
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [label, list] of Object.entries(raw)) {
      if (Array.isArray(list)) for (const m of list) push(asString(m), label)
    }
  } else if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        push(asString(item.text ?? item.mention), asString(item.type ?? item.label))
      }
    }
  }
  return out
}

/** Accepts [["h","REL","t", "ev"?], ...] or [{"head","relation","tail","evidence"}, ...]. */
function parseRelations(raw: Json | undefined, allowed: Set<string>): Relation[] {
  if (!Array.isArray(raw)) return []
  const out: Relation[] = []
  for (const item of raw) {
    let head: string | null = null
    let label: string | null = null
    let tail: string | null = null
    let evidence = ''
    if (Array.isArray(item)) {
      ;[head, label, tail] = [asString(item[0]), asString(item[1]), asString(item[2])]
      evidence = asString(item[3]) ?? ''
    } else if (item && typeof item === 'object') {
      head = asString(item.head ?? item.from ?? item.source)
      label = asString(item.relation ?? item.type ?? item.label)
      tail = asString(item.tail ?? item.to ?? item.target)
      evidence = asString(item.evidence ?? item.explanation) ?? ''
    }
    if (head && tail && label && allowed.has(label) && head !== tail) out.push({ head, label, tail, evidence })
  }
  return out
}

/**
 * Parse a raw model response against a schema. Pure — exported for tests.
 * Mentions are validated against `text`; relation arguments against the
 * extracted mentions (joint mode) or `knownEntities` (closed-world mode).
 */
export function parseExtraction(
  content: string | null,
  text: string,
  schema: ExtractionSchema,
  opts: Pick<ExtractOptions, 'knownEntities' | 'keepOverlaps'> = {},
): ExtractionOutput {
  const empty: ExtractionOutput = { mentions: [], spans: [], relations: [], classifications: {} }
  if (!content) return empty
  let parsed: { [k: string]: Json }
  try {
    const v = JSON.parse(extractJsonObject(content)) as Json
    if (!v || typeof v !== 'object' || Array.isArray(v)) return empty
    parsed = v
  } catch {
    return empty
  }

  // Entities — dedupe (text,label), keep only verbatim substrings; if the
  // model assigned one string several types, keep the first.
  const entityLabels = new Set((schema.entities ?? []).map((e) => e.name))
  const byText = new Map<string, Mention>()
  for (const m of parseEntities(parsed.entities, entityLabels)) {
    if (!byText.has(m.text) && text.includes(m.text)) byText.set(m.text, m)
  }
  const mentions = [...byText.values()]
  const located = locateMentions(text, mentions)
  const spans = opts.keepOverlaps ? located.sort((a, b) => a.start - b.start) : resolveOverlaps(located)

  // Relations — arguments must be known entities.
  const relationLabels = new Map((schema.relations ?? []).map((r) => [r.name, r]))
  const argLabels = new Map<string, string>()
  const known: KnownEntity[] = entityLabels.size > 0 ? mentions : (opts.knownEntities ?? [])
  for (const e of known) if (!argLabels.has(e.text)) argLabels.set(e.text, e.label)
  const seenRel = new Set<string>()
  const relations = parseRelations(parsed.relations, new Set(relationLabels.keys())).filter((r) => {
    const headLabel = argLabels.get(r.head)
    const tailLabel = argLabels.get(r.tail)
    if (!headLabel || !tailLabel) return false
    const def = relationLabels.get(r.label)!
    if (def.headLabels?.length && !def.headLabels.includes(headLabel)) return false
    if (def.tailLabels?.length && !def.tailLabels.includes(tailLabel)) return false
    const key = `${r.head}\u0000${r.label}\u0000${r.tail}`
    if (seenRel.has(key)) return false
    seenRel.add(key)
    return true
  })

  const classifications: Record<string, string[]> = {}
  for (const task of schema.classifications ?? []) {
    const allowed = new Set(task.labels.map((l) => l.name))
    const v = parsed[task.name]
    const values = (Array.isArray(v) ? v : [v]).map((x) => asString(x as Json)).filter((x): x is string => !!x && allowed.has(x))
    classifications[task.name] = task.multiLabel ? [...new Set(values)] : values.slice(0, 1)
  }

  return { mentions, spans, relations, classifications }
}

/** Default output budget: generous enough for dense chunks, small enough to cap runaway generations. */
function defaultMaxTokens(schema: ExtractionSchema, opts: PromptOptions): number {
  let n = 256
  if (schema.entities?.length) n += 768
  if (schema.relations?.length) n += opts.relationEvidence ? 2048 : 1024
  return n
}

/**
 * Run one extraction call: build prompts from the schema, call the model,
 * parse + validate. Never throws for model/transport errors — returns an
 * empty result with `error` set so batch callers can degrade gracefully.
 */
export async function extract(
  client: LlmClient,
  text: string,
  schema: ExtractionSchema,
  opts: ExtractOptions,
): Promise<ExtractionRun> {
  const messages = [
    { role: 'system' as const, content: buildSystemPrompt(schema, opts) },
    { role: 'user' as const, content: buildUserPrompt(text, schema, opts) },
  ]
  let result: ChatResult
  try {
    result = await client.chat({
      model: opts.model,
      messages,
      json: true,
      thinking: opts.thinking ?? false,
      maxCompletionTokens: opts.maxCompletionTokens ?? defaultMaxTokens(schema, opts),
    })
  } catch (err) {
    return {
      mentions: [],
      spans: [],
      relations: [],
      classifications: {},
      model: opts.model,
      usage: EMPTY_USAGE,
      latencyMs: 0,
      finishReason: 'error',
      rawContent: null,
      error: err instanceof Error ? err.message : String(err),
    }
  }
  return {
    ...parseExtraction(result.content, text, schema, opts),
    model: result.model,
    usage: result.usage,
    latencyMs: result.latencyMs,
    finishReason: result.finishReason,
    rawContent: result.content,
    error: null,
  }
}
