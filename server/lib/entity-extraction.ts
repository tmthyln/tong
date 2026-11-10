/**
 * App-facing entity extraction: maps the configurable node-type taxonomy onto
 * the generic schema-driven extractor in ./extraction.
 *
 * One LLM call extracts every node type at once (the old pipeline made one
 * call per node type plus an LLM dedupe call). Each string gets exactly one
 * type in the response, so type conflicts are resolved by the model in the
 * same call; residual span overlaps use deterministic longest-span rules.
 */
import { extractJsonObject } from './llm-utils'
import { extract, type ExtractionRun } from './extraction/extract'
import { workersAiClient, type LlmClient } from './extraction/llm'
import type { ExtractionSchema } from './extraction/schema'

export interface NodeTypeInput {
  name: string
  definition: string
  examples: string[]
}

export interface ExtractedEntity {
  nodeType: string
  text: string
  startIndex: number
  endIndex: number
}

/** Selected from the local efficiency-frontier eval (eval/extraction, see README). */
export const ENTITY_EXTRACTION_MODEL = '@cf/google/gemma-4-26b-a4b-it' as keyof AiModels
const MODEL = ENTITY_EXTRACTION_MODEL as string

/**
 * Consecutive chunks per entity-extraction call (see extractEntitiesBatch).
 * Batching amortizes the node-type prompt; in the eval it cut cost ~3× for a
 * small F1 change.
 */
export const ENTITY_BATCH_CHUNKS = 4

export interface ExtractOptions {
  thinking?: boolean
  maxCompletionTokens?: number
  model?: string
  /** Inject a client (tests, local scripts). Defaults to the env.AI binding. */
  client?: LlmClient
}

export interface NodeTypeExtractionRun {
  nodeType: string
  entities: ExtractedEntity[]
  usage: { promptTokens: number; completionTokens: number; totalTokens: number }
  finishReason: string | null
  latencyMs: number
  rawContent: string | null
}

export function nodeTypesToSchema(nodeTypes: NodeTypeInput[]): ExtractionSchema {
  return {
    entities: nodeTypes.map((t) => ({ name: t.name, description: t.definition, examples: t.examples })),
    instructions: 'The text is Chinese (Mandarin) prose.',
  }
}

const clientFor = (env: Env, opts: ExtractOptions) => opts.client ?? workersAiClient(env.AI)

function toEntities(run: Pick<ExtractionRun, 'spans'>, text: string, offset = 0): ExtractedEntity[] {
  return run.spans
    .filter((s) => s.start >= offset && s.end <= offset + text.length)
    .map((s) => ({ nodeType: s.label, text: s.text, startIndex: s.start - offset, endIndex: s.end - offset }))
}

/** One extraction call over all `nodeTypes` with full usage metadata. */
export async function extractEntitiesRun(
  chunkContent: string,
  nodeTypes: NodeTypeInput[],
  env: Env,
  opts: ExtractOptions = {},
): Promise<ExtractionRun> {
  return extract(clientFor(env, opts), chunkContent, nodeTypesToSchema(nodeTypes), {
    model: opts.model ?? MODEL,
    thinking: opts.thinking ?? false,
    maxCompletionTokens: opts.maxCompletionTokens,
    // Callers decide overlap policy (removeOverlaps / deduplicateEntitiesLLM).
    keepOverlaps: true,
  })
}

/**
 * Extract entities of all given node types from a chunk in a single LLM call.
 * Returns every occurrence of each extracted string. Does NOT apply overlap
 * removal — callers should apply removeOverlaps if needed. Throws if the model
 * call failed, so durable workflow steps can retry.
 */
export async function extractEntitiesForNodeTypes(
  chunkContent: string,
  nodeTypes: NodeTypeInput[],
  env: Env,
  opts: ExtractOptions = {},
): Promise<ExtractedEntity[]> {
  if (nodeTypes.length === 0) return []
  const run = await extractEntitiesRun(chunkContent, nodeTypes, env, opts)
  if (run.error) throw new Error(`entity extraction failed: ${run.error}`)
  return toEntities(run, chunkContent)
}

/**
 * Per-node-type runs with usage/latency/raw content, for the dev-eval tooling
 * that compares modes per type. (Production uses the single-call path.)
 */
export async function extractEntitiesForNodeTypesWithUsage(
  chunkContent: string,
  nodeTypes: NodeTypeInput[],
  env: Env,
  opts: ExtractOptions = {},
): Promise<NodeTypeExtractionRun[]> {
  return Promise.all(
    nodeTypes.map(async (nodeType): Promise<NodeTypeExtractionRun> => {
      const run = await extractEntitiesRun(chunkContent, [nodeType], env, opts)
      if (run.error) console.warn(`[entity-extraction] AI.run failed for ${nodeType.name}:`, run.error)
      return {
        nodeType: nodeType.name,
        entities: toEntities(run, chunkContent),
        usage: {
          promptTokens: run.usage.promptTokens,
          completionTokens: run.usage.completionTokens,
          totalTokens: run.usage.promptTokens + run.usage.completionTokens,
        },
        finishReason: run.finishReason,
        latencyMs: run.latencyMs,
        rawContent: run.rawContent,
      }
    }),
  )
}

/**
 * Extract entities of all given node types from a chunk of text, with overlap removal.
 * Convenience wrapper for in-process use (e.g. tests, one-off calls).
 */
export async function extractEntities(
  chunkContent: string,
  nodeTypes: NodeTypeInput[],
  env: Env,
  opts: ExtractOptions = {},
): Promise<ExtractedEntity[]> {
  const run = await extractEntitiesRun(chunkContent, nodeTypes, env, opts)
  if (run.error) console.warn('[entity-extraction] AI.run failed:', run.error)
  return removeOverlaps(toEntities(run, chunkContent))
}

/**
 * Extract entities for several chunks with ONE call over their concatenation,
 * then split the spans back per chunk. Amortizes the (large, static) schema
 * prompt across chunks. Throws on model failure.
 */
export async function extractEntitiesBatch(
  chunks: string[],
  nodeTypes: NodeTypeInput[],
  env: Env,
  opts: ExtractOptions = {},
): Promise<ExtractedEntity[][]> {
  if (nodeTypes.length === 0 || chunks.length === 0) return chunks.map(() => [])
  const SEP = '\n\n'
  const joined = chunks.join(SEP)
  const run = await extractEntitiesRun(joined, nodeTypes, env, opts)
  if (run.error) throw new Error(`entity extraction failed: ${run.error}`)
  let offset = 0
  return chunks.map((chunk) => {
    const ents = toEntities(run, chunk, offset)
    offset += chunk.length + SEP.length
    return ents
  })
}

/**
 * Use an LLM to resolve entity type conflicts (overlapping spans tagged with multiple types).
 * If no conflicts exist, returns entities as-is without making an LLM call.
 * Falls back to longest-span rule for any conflict the LLM fails to resolve.
 *
 * No longer needed after single-call extraction (the model assigns one type
 * per string); kept for callers that merge results from several extractors.
 */
export async function deduplicateEntitiesLLM(
  chunkContent: string,
  entities: ExtractedEntity[],
  env: Env,
): Promise<ExtractedEntity[]> {
  const sorted = [...entities].sort((a, b) => {
    if (a.startIndex !== b.startIndex) return a.startIndex - b.startIndex
    return b.endIndex - b.startIndex - (a.endIndex - a.startIndex)
  })

  const conflictGroups: ExtractedEntity[][] = []
  const nonConflicting: ExtractedEntity[] = []

  let i = 0
  while (i < sorted.length) {
    const group = [sorted[i]]
    let j = i + 1
    while (j < sorted.length && sorted[j].startIndex < sorted[i].endIndex) {
      group.push(sorted[j])
      j++
    }
    if (group.length > 1) {
      conflictGroups.push(group)
      i = j
    } else {
      nonConflicting.push(sorted[i])
      i++
    }
  }

  if (conflictGroups.length === 0) return entities

  const conflictDescriptions = conflictGroups.map((group, idx) => {
    const end = Math.max(...group.map((e) => e.endIndex))
    const span = chunkContent.slice(group[0].startIndex, end)
    const candidates = group.map((e) => e.nodeType).join(', ')
    return `${idx + 1}. "${span}" spans [${group[0].startIndex},${end}]: candidates: [${candidates}]`
  })

  let resolved: Array<{ text: string; nodeType: string }> = []
  try {
    const result = await workersAiClient(env.AI, { attempts: 1 }).chat({
      model: MODEL,
      messages: [
        {
          role: 'system',
          content: `You resolve entity type conflicts in Chinese text extraction.\nReturn JSON: { "resolutions": [{ "text": "...", "nodeType": "..." }] }`,
        },
        {
          role: 'user',
          content: `Text: "${chunkContent}"\n\nResolve these conflicts (each group has overlapping spans — pick exactly one):\n${conflictDescriptions.join('\n')}\n\nReply with JSON { "resolutions": [ { "text": "<exact text>", "nodeType": "<chosen type>" } ] }`,
        },
      ],
    })
    if (typeof result.content === 'string') {
      const parsed = JSON.parse(extractJsonObject(result.content)) as { resolutions?: Array<{ text: string; nodeType: string }> } | null
      if (parsed?.resolutions && Array.isArray(parsed.resolutions)) resolved = parsed.resolutions
    }
  } catch (err) {
    console.warn('[entity-extraction] deduplicateEntitiesLLM LLM call failed, falling back to longest-span:', err)
  }

  const resolvedEntities: ExtractedEntity[] = [...nonConflicting]
  for (const group of conflictGroups) {
    const groupText = chunkContent.slice(group[0].startIndex, Math.max(...group.map((e) => e.endIndex)))
    const llmResolution = resolved.find((r) => r.text === groupText)
    const chosen = llmResolution ? (group.find((e) => e.nodeType === llmResolution.nodeType) ?? group[0]) : group[0]
    resolvedEntities.push(chosen)
  }
  return resolvedEntities.sort((a, b) => a.startIndex - b.startIndex)
}

/**
 * Remove overlapping entities, preferring longer spans (longest-first greedy).
 */
export function removeOverlaps(entities: ExtractedEntity[]): ExtractedEntity[] {
  const byLength = entities
    .map((e, i) => ({ e, i }))
    .sort(
      (a, b) =>
        b.e.endIndex - b.e.startIndex - (a.e.endIndex - a.e.startIndex) || a.e.startIndex - b.e.startIndex || a.i - b.i,
    )
  const kept: ExtractedEntity[] = []
  for (const { e } of byLength) {
    if (kept.every((k) => e.endIndex <= k.startIndex || e.startIndex >= k.endIndex)) kept.push(e)
  }
  return kept.sort((a, b) => a.startIndex - b.startIndex)
}
