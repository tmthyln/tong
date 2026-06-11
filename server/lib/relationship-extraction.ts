import { extractJsonObject } from './llm-utils'

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

export const RELATIONSHIP_EXTRACTION_MODEL = '@cf/moonshotai/kimi-k2.6' as keyof AiModels
const MODEL = RELATIONSHIP_EXTRACTION_MODEL

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}

export interface RelationshipExtractOptions {
  thinking?: boolean
  maxCompletionTokens?: number
}

export interface EdgeTypeExtractionRun {
  edgeType: string
  relationships: ExtractedRelationship[]
  usage: { promptTokens: number; completionTokens: number; totalTokens: number }
  finishReason: string | null
  latencyMs: number
  rawContent: string | null
}

async function runAiWithRetry(
  env: Env,
  args: Record<string, unknown>,
  attempts = 3
): Promise<ChatCompletionResponse> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return (await (env.AI.run as (model: string, args: Record<string, unknown>) => Promise<unknown>)(
        MODEL,
        args
      )) as ChatCompletionResponse
    } catch (err) {
      lastErr = err
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, i)))
      }
    }
  }
  throw lastErr
}

function buildMessages(
  chunkContent: string,
  entities: Array<{ nodeType: string; text: string }>,
  edgeType: EdgeTypeInput
) {
  const entityList = entities.map((e) => `- ${e.text} (${e.nodeType})`).join('\n')
  const examplesBlock =
    edgeType.examples.length > 0
      ? `Examples of ${edgeType.name} relationships: ${edgeType.examples.join(', ')}`
      : ''

  const systemPrompt = `You are a relationship extraction system. Extract relationships between named entities in Chinese text.

Relationship type: ${edgeType.name}
Definition: ${edgeType.definition}
${examplesBlock}

Entities found in this text:
${entityList}

Return a JSON object with a "relationships" array. Each relationship should have:
- "from": exact text of the source entity (must match exactly from the entity list above)
- "to": exact text of the target entity (must match exactly from the entity list above)
- "explanation": brief reason why this relationship holds

Only include relationships where both entities appear in the entity list. Do not invent entities.
If no relationships of this type are found, return: {"relationships": []}

Example response format: {"relationships": [{"from": "北京", "to": "中国", "explanation": "北京 is the capital city of 中国"}]}`

  return [
    { role: 'system' as const, content: systemPrompt },
    { role: 'user' as const, content: chunkContent },
  ]
}

/**
 * Extract relationships of a single edge type from a chunk of text and return
 * full usage/latency/rawContent metadata. Used by eval tooling and by the
 * thin `extractRelationshipsForEdgeType` wrapper below.
 */
export async function extractRelationshipsForEdgeTypeWithUsage(
  chunkContent: string,
  entities: Array<{ nodeType: string; text: string }>,
  edgeType: EdgeTypeInput,
  env: Env,
  opts: RelationshipExtractOptions = {}
): Promise<EdgeTypeExtractionRun> {
  const thinking = opts.thinking ?? false
  const maxCompletionTokens = opts.maxCompletionTokens ?? 2048

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

  const messages = buildMessages(chunkContent, entities, edgeType)
  const start = Date.now()
  let result: ChatCompletionResponse
  try {
    result = await runAiWithRetry(env, {
      messages,
      temperature: 0,
      max_completion_tokens: maxCompletionTokens,
      response_format: { type: 'json_object' },
      chat_template_kwargs: { thinking },
    })
  } catch (err) {
    const latencyMs = Date.now() - start
    console.warn(`[relationship-extraction] AI.run failed for ${edgeType.name} after retries:`, err)
    return {
      edgeType: edgeType.name,
      relationships: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: 'error',
      latencyMs,
      rawContent: null,
    }
  }
  const latencyMs = Date.now() - start
  const relationships = parseResponse(result, entities, edgeType.name)
  const choice = result.choices?.[0]
  return {
    edgeType: edgeType.name,
    relationships,
    usage: {
      promptTokens: result.usage?.prompt_tokens ?? 0,
      completionTokens: result.usage?.completion_tokens ?? 0,
      totalTokens: result.usage?.total_tokens ?? 0,
    },
    finishReason: choice?.finish_reason ?? null,
    latencyMs,
    rawContent: choice?.message?.content ?? null,
  }
}

/**
 * Extract relationships of a single edge type from a chunk of text.
 * Default: no thinking, no chain-of-thought. Pass `opts.thinking = true` to enable.
 */
export async function extractRelationshipsForEdgeType(
  chunkContent: string,
  entities: Array<{ nodeType: string; text: string }>,
  edgeType: EdgeTypeInput,
  env: Env,
  opts: RelationshipExtractOptions = {}
): Promise<ExtractedRelationship[]> {
  const run = await extractRelationshipsForEdgeTypeWithUsage(
    chunkContent,
    entities,
    edgeType,
    env,
    opts
  )
  return run.relationships
}

function parseResponse(
  result: ChatCompletionResponse,
  entities: Array<{ text: string }>,
  edgeTypeName: string
): ExtractedRelationship[] {
  const content = result.choices?.[0]?.message?.content
  if (typeof content !== 'string') {
    console.warn(
      `[relationship-extraction] No content in response for ${edgeTypeName}, result:`,
      JSON.stringify(result)
    )
    return []
  }

  let parsed:
    | { relationships?: Array<{ from: string; to: string; explanation?: string }> }
    | null = null
  try {
    parsed = JSON.parse(extractJsonObject(content))
  } catch (err) {
    console.warn(`[relationship-extraction] JSON parse failed for ${edgeTypeName}:`, err)
    console.warn(`[relationship-extraction] Raw content: ${content}`)
    return []
  }

  if (!parsed || !parsed.relationships || !Array.isArray(parsed.relationships)) return []

  const entityTexts = new Set(entities.map((e) => e.text))
  const relationships: ExtractedRelationship[] = []

  for (const rel of parsed.relationships) {
    if (
      typeof rel.from === 'string' &&
      typeof rel.to === 'string' &&
      rel.from !== rel.to &&
      entityTexts.has(rel.from) &&
      entityTexts.has(rel.to)
    ) {
      relationships.push({
        edgeType: edgeTypeName,
        fromText: rel.from,
        toText: rel.to,
        explanation: typeof rel.explanation === 'string' ? rel.explanation : '',
      })
    }
  }

  return relationships
}
