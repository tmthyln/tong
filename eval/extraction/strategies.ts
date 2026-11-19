/**
 * Extraction strategies under evaluation. Each takes one example and returns
 * predicted mentions/relations plus cost accounting. All strategies except
 * `legacy-*` are thin compositions over the generic extractor in
 * server/lib/extraction.
 */
import { extract, type Mention, type Relation } from '../../server/lib/extraction/extract'
import { addUsage, EMPTY_USAGE, normalizeCompletion, type ChatResult, type ChatUsage, type LlmClient } from '../../server/lib/extraction/llm'
import type { ExtractionSchema } from '../../server/lib/extraction/schema'
import { ENTITY_BATCH_CHUNKS, extractEntitiesBatch, removeOverlaps, type ExtractedEntity, type NodeTypeInput } from '../../server/lib/entity-extraction'
import { extractRelationships, relationWindows, type EdgeTypeInput } from '../../server/lib/relationship-extraction'
import { anchorRelations } from '../../server/lib/relationship-anchoring'
import { extractEntitiesForNodeTypesWithUsage, deduplicateEntitiesLLM, ENTITY_EXTRACTION_MODEL } from './legacy/entity-extraction'
import { extractRelationshipsForEdgeTypeWithUsage } from './legacy/relationship-extraction'
import type { Example } from './datasets'

export interface Prediction {
  mentions: Mention[]
  relations: Relation[]
  usage: ChatUsage
  calls: number
  errors: number
  /** Wall-clock for the example (calls inside an example run in parallel). */
  wallMs: number
  /** Sum of per-call latencies (≈ serial compute time). */
  callMs: number
  truncated: number
  errorSample?: string
  /** app-pipeline: relations the model returned that anchoring could not place (never stored). */
  anchorDropped?: number
}

export interface StrategyCtx {
  client: LlmClient
  /** Raw `AI.run`-compatible function, for driving the legacy code paths. */
  rawRun: (model: string, args: Record<string, unknown>) => Promise<unknown>
  model: string
  thinking: boolean
  schema: ExtractionSchema
}

export interface Strategy {
  name: string
  description: string
  /** Which tasks the strategy produces predictions for. */
  tasks: Array<'ner' | 're'>
  /** Only runs with this model (legacy baselines). */
  fixedModel?: string
  run(ex: Example, ctx: StrategyCtx): Promise<Prediction>
}

/** Thinking needs room to reason before the JSON answer; non-thinking uses the extractor's defaults. */
const base = (ctx: StrategyCtx) => ({ model: ctx.model, thinking: ctx.thinking, maxCompletionTokens: ctx.thinking ? 8192 : undefined })

function uniqMentions(ms: Mention[]): Mention[] {
  const seen = new Map<string, Mention>()
  for (const m of ms) if (!seen.has(m.text)) seen.set(m.text, m)
  return [...seen.values()]
}

async function timed(fn: () => Promise<Omit<Prediction, 'wallMs'>>): Promise<Prediction> {
  const t = Date.now()
  const r = await fn()
  return { ...r, wallMs: Date.now() - t }
}

type Run = Awaited<ReturnType<typeof extract>>
function fold(runs: Run[]): Omit<Prediction, 'wallMs' | 'mentions' | 'relations'> {
  return {
    usage: runs.reduce((u, r) => addUsage(u, r.usage), EMPTY_USAGE),
    calls: runs.length,
    errors: runs.filter((r) => r.error).length,
    callMs: runs.reduce((s, r) => s + r.latencyMs, 0),
    truncated: runs.filter((r) => r.finishReason === 'length').length,
    errorSample: runs.find((r) => r.error)?.error?.slice(0, 300),
  }
}

const nerSchema = (s: ExtractionSchema): ExtractionSchema => ({ entities: s.entities, instructions: s.instructions })
const reSchema = (s: ExtractionSchema): ExtractionSchema => ({ relations: s.relations, instructions: s.instructions })

/** One call per chunk (part), all entity labels at once. */
const nerJoint: Strategy = {
  name: 'ner-all-labels',
  description: 'NER: one call per chunk with every entity label in one prompt',
  tasks: ['ner'],
  run: (ex, ctx) =>
    timed(async () => {
      const runs = await Promise.all(ex.parts.map((p) => extract(ctx.client, p, nerSchema(ctx.schema), { ...base(ctx) })))
      return { mentions: uniqMentions(runs.flatMap((r) => r.mentions)), relations: [], ...fold(runs) }
    }),
}

/** One call per window (all parts concatenated), all entity labels. */
const nerWindow: Strategy = {
  name: 'ner-all-labels-window',
  description: 'NER: one call per multi-chunk window with every entity label',
  tasks: ['ner'],
  run: (ex, ctx) =>
    timed(async () => {
      const r = await extract(ctx.client, ex.text, nerSchema(ctx.schema), { ...base(ctx) })
      return { mentions: r.mentions, relations: [], ...fold([r]) }
    }),
}

/** One call per chunk per entity label (structure of the legacy pipeline, generic prompt). */
const nerPerLabel: Strategy = {
  name: 'ner-per-label',
  description: 'NER: one call per chunk × entity label (legacy structure, new prompt)',
  tasks: ['ner'],
  run: (ex, ctx) =>
    timed(async () => {
      const runs = await Promise.all(
        ex.parts.flatMap((p) =>
          (ctx.schema.entities ?? []).map((label) =>
            extract(ctx.client, p, { entities: [label], instructions: ctx.schema.instructions }, { ...base(ctx) }),
          ),
        ),
      )
      // Mimic legacy: overlapping strings across labels → keep first label seen.
      return { mentions: uniqMentions(runs.flatMap((r) => r.mentions)), relations: [], ...fold(runs) }
    }),
}

/** Closed-world RE over the whole window given gold entities, all relation labels in one call. */
function reAll(evidence: boolean): Strategy {
  return {
    name: evidence ? 're-all-labels-evidence' : 're-all-labels',
    description: `RE: one call per window, all relation labels, gold entities given${evidence ? ', with evidence strings' : ''}`,
    tasks: ['re'],
    run: (ex, ctx) =>
      timed(async () => {
        const r = await extract(ctx.client, ex.text, reSchema(ctx.schema), {
          ...base(ctx),
          knownEntities: ex.gold.mentions,
          relationEvidence: evidence,
        })
        return { mentions: [], relations: r.relations, ...fold([r]) }
      }),
  }
}

const rePerLabel: Strategy = {
  name: 're-per-label',
  description: 'RE: one call per window × relation label, gold entities given (legacy structure, new prompt)',
  tasks: ['re'],
  run: (ex, ctx) =>
    timed(async () => {
      const runs = await Promise.all(
        (ctx.schema.relations ?? []).map((label) =>
          extract(ctx.client, ex.text, { relations: [label], instructions: ctx.schema.instructions }, {
            ...base(ctx),
            knownEntities: ex.gold.mentions,
          }),
        ),
      )
      return { mentions: [], relations: runs.flatMap((r) => r.relations), ...fold(runs) }
    }),
}

/** End-to-end: entities + relations in a single call per window. */
const jointNerRe: Strategy = {
  name: 'joint-ner-re',
  description: 'NER+RE: a single call per window extracts entities and relations together',
  tasks: ['ner', 're'],
  run: (ex, ctx) =>
    timed(async () => {
      const r = await extract(ctx.client, ex.text, ctx.schema, { ...base(ctx) })
      return { mentions: r.mentions, relations: r.relations, ...fold([r]) }
    }),
}

/** Production shape, end to end: window NER, then closed-world RE over the *predicted* entities. */
const pipeline: Strategy = {
  name: 'pipeline-ner-re',
  description: 'NER+RE: one NER call per window, then one RE call (with evidence) over the predicted entities',
  tasks: ['ner', 're'],
  run: (ex, ctx) =>
    timed(async () => {
      const ner = await extract(ctx.client, ex.text, nerSchema(ctx.schema), base(ctx))
      const re = await extract(ctx.client, ex.text, reSchema(ctx.schema), { ...base(ctx), knownEntities: ner.mentions, relationEvidence: true })
      return { mentions: ner.mentions, relations: re.relations, ...fold([ner, re]) }
    }),
}

// ------------------------------------------------------------ production, end to end

/** Wraps a client, recording every call's result (or failure) for cost accounting. */
export function recordingClient(inner: LlmClient) {
  const runs: ChatResult[] = []
  let failed = 0
  const client: LlmClient = {
    async chat(req) {
      try {
        const r = await inner.chat(req)
        runs.push(r)
        return r
      } catch (err) {
        failed++
        throw err
      }
    },
  }
  const totals = () => ({
    usage: runs.reduce((u, r) => addUsage(u, r.usage), EMPTY_USAGE),
    calls: runs.length + failed,
    errors: failed,
    callMs: runs.reduce((s, r) => s + r.latencyMs, 0),
    truncated: runs.filter((r) => r.finishReason === 'length').length,
  })
  return { client, totals }
}

export const toNodeTypes = (s: ExtractionSchema): NodeTypeInput[] =>
  (s.entities ?? []).map((e) => ({ name: e.name, definition: e.description ?? '', examples: e.examples ?? [] }))
export const toEdgeTypes = (s: ExtractionSchema): EdgeTypeInput[] =>
  (s.relations ?? []).map((r) => ({ name: r.name, reverseName: null, definition: r.description ?? '', examples: r.examples ?? [] }))

/**
 * The ingest workflow's extraction, run through the production functions
 * themselves (server/workflows/ingest-document.ts, phases 4 and 6):
 *  1. entities: `extractEntitiesBatch` over ENTITY_BATCH_CHUNKS chunks per call,
 *     then `removeOverlaps` per chunk — the rows production stores;
 *  2. relations: `relationWindows` over the chunks, one `extractRelationships`
 *     call per window given that window's stored entity rows;
 *  3. `anchorRelations` onto the stored mentions. A relation production cannot
 *     anchor is never stored, so only anchored relations are scored
 *     (`anchorDropped` counts the rest).
 * Production's schema wording (nodeTypesToSchema) replaces the dataset's
 * instructions, so on `lit` this measures production's prompt, not the benchmark's.
 */
const appPipeline: Strategy = {
  name: 'app-pipeline',
  description: 'Production ingest, end to end: batched NER + removeOverlaps, windowed RE, anchoring (production code)',
  tasks: ['ner', 're'],
  run: (ex, ctx) =>
    timed(async () => {
      const { client, totals } = recordingClient(ctx.client)
      const opts = { client, ...base(ctx) }
      const env = {} as Env // unused: every call goes through `client`
      const nodeTypes = toNodeTypes(ctx.schema)
      const edgeTypes = toEdgeTypes(ctx.schema)

      const batches: number[][] = []
      for (let i = 0; i < ex.parts.length; i += ENTITY_BATCH_CHUNKS) batches.push(ex.parts.map((_, j) => j).slice(i, i + ENTITY_BATCH_CHUNKS))
      const perChunk: ExtractedEntity[][] = new Array(ex.parts.length)
      await Promise.all(
        batches.map(async (idx) => {
          const raw = await extractEntitiesBatch(idx.map((i) => ex.parts[i]), nodeTypes, env, opts)
          idx.forEach((chunk, k) => (perChunk[chunk] = removeOverlaps(raw[k])))
        }),
      )
      let nextId = 0
      const rows = perChunk.flatMap((ents, chunk) => ents.map((e) => ({ ...e, id: nextId++, chunk })))
      const textOf = new Map(rows.map((r) => [r.id, r.text]))

      let anchorDropped = 0
      const relations = new Map<string, Relation>()
      await Promise.all(
        relationWindows(ex.parts.length).map(async ([start, end]) => {
          const inWindow = rows.filter((r) => r.chunk >= start && r.chunk < end)
          const rels = await extractRelationships(ex.parts.slice(start, end).join('\n'), inWindow, edgeTypes, env, opts)
          const mentions = inWindow.map((r) => ({ id: r.id, text: r.text, chunkId: r.chunk, chunkOrder: r.chunk, startIndex: r.startIndex }))
          const anchored = anchorRelations(rels, mentions)
          const anchoredKeys = new Set(anchored.map((a) => `${textOf.get(a.fromEntityId)}|${a.edgeType}|${textOf.get(a.toEntityId)}`))
          anchorDropped += rels.filter((r) => !anchoredKeys.has(`${r.fromText}|${r.edgeType}|${r.toText}`)).length
          for (const a of anchored) {
            const head = textOf.get(a.fromEntityId)!
            const tail = textOf.get(a.toEntityId)!
            relations.set(`${head}|${a.edgeType}|${tail}`, { head, label: a.edgeType, tail, evidence: a.explanation })
          }
        }),
      )
      const mentions = uniqMentions(rows.map((r) => ({ text: r.text, label: r.nodeType })))
      return { mentions, relations: [...relations.values()], anchorDropped, ...totals() }
    }),
}

// ------------------------------------------------------------ legacy baselines

/** Wrap rawRun as a fake Env whose AI.run records usage of every call. */
function recordingEnv(ctx: StrategyCtx) {
  const calls: Array<{ usage: ChatUsage; ms: number; finish: string | null }> = []
  let errors = 0
  const env = {
    AI: {
      run: async (model: string, args: Record<string, unknown>) => {
        const t = Date.now()
        let raw: Parameters<typeof normalizeCompletion>[1]
        try {
          raw = (await ctx.rawRun(model, args)) as Parameters<typeof normalizeCompletion>[1]
        } catch (err) {
          errors++
          throw err
        }
        const n = normalizeCompletion(model, raw, Date.now() - t)
        calls.push({ usage: n.usage, ms: n.latencyMs, finish: n.finishReason })
        return raw
      },
    },
  } as unknown as Env
  const totals = () => ({
    usage: calls.reduce((u, c) => addUsage(u, c.usage), EMPTY_USAGE),
    calls: calls.length,
    errors,
    callMs: calls.reduce((s, c) => s + c.ms, 0),
    truncated: calls.filter((c) => c.finish === 'length').length,
  })
  return { env, totals }
}

const legacyNer: Strategy = {
  name: 'legacy-ner',
  description: 'Current app pipeline: kimi-k2.6, one call per chunk × node type, then an LLM dedupe call',
  tasks: ['ner'],
  fixedModel: ENTITY_EXTRACTION_MODEL as string,
  run: (ex, ctx) =>
    timed(async () => {
      const { env, totals } = recordingEnv(ctx)
      const labels = (ctx.schema.entities ?? []).map((e) => ({ name: e.name, definition: e.description ?? '', examples: e.examples ?? [] }))
      const perChunk = await Promise.all(
        ex.parts.map(async (p) => {
          const runs = await extractEntitiesForNodeTypesWithUsage(p, labels, env)
          return deduplicateEntitiesLLM(p, runs.flatMap((r) => r.entities), env)
        }),
      )
      const mentions = uniqMentions(perChunk.flat().map((e) => ({ text: e.text, label: e.nodeType })))
      return { mentions, relations: [], ...totals() }
    }),
}

const legacyRe: Strategy = {
  name: 'legacy-re',
  description: 'Current app pipeline: kimi-k2.6, one call per window × edge type, gold entities given',
  tasks: ['re'],
  fixedModel: ENTITY_EXTRACTION_MODEL as string,
  run: (ex, ctx) =>
    timed(async () => {
      const { env, totals } = recordingEnv(ctx)
      const ents = ex.gold.mentions.map((m) => ({ nodeType: m.label, text: m.text }))
      const runs = await Promise.all(
        (ctx.schema.relations ?? []).map((r) =>
          extractRelationshipsForEdgeTypeWithUsage(ex.text, ents, { name: r.name, reverseName: null, definition: r.description ?? '', examples: r.examples ?? [] }, env),
        ),
      )
      const relations = runs.flatMap((r) => r.relationships.map((x) => ({ head: x.fromText, label: x.edgeType, tail: x.toText, evidence: x.explanation })))
      return { mentions: [], relations, ...totals() }
    }),
}

export const STRATEGIES: Strategy[] = [legacyNer, legacyRe, nerPerLabel, nerJoint, nerWindow, rePerLabel, reAll(false), reAll(true), jointNerRe, pipeline, appPipeline]

export function getStrategy(name: string): Strategy {
  const s = STRATEGIES.find((s) => s.name === name)
  if (!s) throw new Error(`unknown strategy ${name}; known: ${STRATEGIES.map((s) => s.name).join(', ')}`)
  return s
}

