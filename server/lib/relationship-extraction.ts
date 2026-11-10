/**
 * App-facing relationship extraction: maps the configurable edge-type taxonomy
 * onto the generic schema-driven extractor in ./extraction (closed-world:
 * relation arguments must come from the supplied entity list).
 *
 * One LLM call covers every edge type (the old pipeline made one call per edge
 * type, which both multiplied cost and pushed the model to "find something"
 * for every type — e.g. tagging one person/organization pair with five
 * different relations).
 */
import { extract, type ExtractionRun } from './extraction/extract'
import { workersAiClient, type LlmClient } from './extraction/llm'
import type { ExtractionSchema, KnownEntity } from './extraction/schema'

export interface EdgeTypeInput {
  name: string
  reverseName: string | null
  definition: string
  examples: string[]
}

export interface ExtractedRelationship {
  edgeType: string
  fromText: string
  toText: string
  explanation: string
}

/** Selected from the local efficiency-frontier eval (eval/extraction, see README). */
export const RELATIONSHIP_EXTRACTION_MODEL = '@cf/google/gemma-4-26b-a4b-it' as keyof AiModels
const MODEL = RELATIONSHIP_EXTRACTION_MODEL as string

export interface RelationshipExtractOptions {
  thinking?: boolean
  maxCompletionTokens?: number
  model?: string
  /** Ask for a short evidence string per relation (stored as `explanation`). Default true. */
  explain?: boolean
  client?: LlmClient
}

export interface EdgeTypeExtractionRun {
  edgeType: string
  relationships: ExtractedRelationship[]
  usage: { promptTokens: number; completionTokens: number; totalTokens: number }
  finishReason: string | null
  latencyMs: number
  rawContent: string | null
}

export function edgeTypesToSchema(edgeTypes: EdgeTypeInput[]): ExtractionSchema {
  return {
    relations: edgeTypes.map((t) => ({ name: t.name, description: t.definition, examples: t.examples })),
    instructions: 'The text is Chinese (Mandarin) prose.',
  }
}

/** Unique (text, type) entities; the same string listed 20× wastes prompt tokens. */
export function uniqueEntities(entities: Array<{ nodeType: string; text: string }>): KnownEntity[] {
  const seen = new Map<string, KnownEntity>()
  for (const e of entities) if (!seen.has(e.text)) seen.set(e.text, { text: e.text, label: e.nodeType })
  return [...seen.values()]
}

/** One closed-world extraction call over all `edgeTypes` with full usage metadata. */
export async function extractRelationshipsRun(
  windowContent: string,
  entities: Array<{ nodeType: string; text: string }>,
  edgeTypes: EdgeTypeInput[],
  env: Env,
  opts: RelationshipExtractOptions = {},
): Promise<ExtractionRun> {
  return extract(opts.client ?? workersAiClient(env.AI), windowContent, edgeTypesToSchema(edgeTypes), {
    model: opts.model ?? MODEL,
    thinking: opts.thinking ?? false,
    maxCompletionTokens: opts.maxCompletionTokens,
    knownEntities: uniqueEntities(entities),
    relationEvidence: opts.explain ?? true,
  })
}

const toRelationships = (run: ExtractionRun): ExtractedRelationship[] =>
  run.relations.map((r) => ({ edgeType: r.label, fromText: r.head, toText: r.tail, explanation: r.evidence }))

/**
 * Extract relationships of every given edge type from a text window in a
 * single call. Throws if the model call failed, so workflow steps can retry.
 */
export async function extractRelationships(
  windowContent: string,
  entities: Array<{ nodeType: string; text: string }>,
  edgeTypes: EdgeTypeInput[],
  env: Env,
  opts: RelationshipExtractOptions = {},
): Promise<ExtractedRelationship[]> {
  if (edgeTypes.length === 0 || uniqueEntities(entities).length < 2) return []
  const run = await extractRelationshipsRun(windowContent, entities, edgeTypes, env, opts)
  if (run.error) throw new Error(`relationship extraction failed: ${run.error}`)
  return toRelationships(run)
}

/**
 * Extract relationships of a single edge type with usage/latency/raw content
 * (dev-eval tooling). Never throws; errors are reported via finishReason.
 */
export async function extractRelationshipsForEdgeTypeWithUsage(
  chunkContent: string,
  entities: Array<{ nodeType: string; text: string }>,
  edgeType: EdgeTypeInput,
  env: Env,
  opts: RelationshipExtractOptions = {},
): Promise<EdgeTypeExtractionRun> {
  if (entities.length === 0) {
    return {
      edgeType: edgeType.name,
      relationships: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: 'skipped',
      latencyMs: 0,
      rawContent: null,
    }
  }
  const run = await extractRelationshipsRun(chunkContent, entities, [edgeType], env, opts)
  if (run.error) console.warn(`[relationship-extraction] AI.run failed for ${edgeType.name}:`, run.error)
  return {
    edgeType: edgeType.name,
    relationships: toRelationships(run),
    usage: {
      promptTokens: run.usage.promptTokens,
      completionTokens: run.usage.completionTokens,
      totalTokens: run.usage.promptTokens + run.usage.completionTokens,
    },
    finishReason: run.finishReason,
    latencyMs: run.latencyMs,
    rawContent: run.rawContent,
  }
}

/** Extract relationships of a single edge type (kept for existing callers). */
export async function extractRelationshipsForEdgeType(
  chunkContent: string,
  entities: Array<{ nodeType: string; text: string }>,
  edgeType: EdgeTypeInput,
  env: Env,
  opts: RelationshipExtractOptions = {},
): Promise<ExtractedRelationship[]> {
  return (await extractRelationshipsForEdgeTypeWithUsage(chunkContent, entities, edgeType, env, opts)).relationships
}

/**
 * Relationship windows: RELATION_WINDOW_CHUNKS consecutive chunks, advancing by
 * RELATION_WINDOW_STRIDE. Any two chunks at most (WINDOW - STRIDE) apart share
 * a window. Previously 7-chunk windows every 2 chunks (each chunk re-read ~3.5×
 * per edge type); now each chunk is read ~1.5× once for all edge types.
 */
export const RELATION_WINDOW_CHUNKS = 6
export const RELATION_WINDOW_STRIDE = 4

export function relationWindows(chunkCount: number, size = RELATION_WINDOW_CHUNKS, stride = RELATION_WINDOW_STRIDE): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let start = 0; start < chunkCount; start += stride) {
    const end = Math.min(chunkCount, start + size)
    out.push([start, end])
    if (end === chunkCount) break
  }
  return out
}
