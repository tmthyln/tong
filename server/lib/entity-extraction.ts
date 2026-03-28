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

import { extractJsonObject } from './llm-utils'

const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
type ModelOutput = AiModels[typeof MODEL]['postProcessedOutputs']

/**
 * Extract entities for a subset of node types from a chunk of text.
 * Each node type is processed independently in a separate LLM call.
 * Does NOT apply overlap removal — callers should apply removeOverlaps if needed.
 */
export async function extractEntitiesForNodeTypes(
  chunkContent: string,
  nodeTypes: NodeTypeInput[],
  env: Env
): Promise<ExtractedEntity[]> {
  const allEntities: ExtractedEntity[] = []

  for (const nodeType of nodeTypes) {
    const messages = buildMessages(chunkContent, nodeType)

    const result = await env.AI.run(MODEL, { messages, temperature: 0, max_tokens: 1024, response_format: { type: 'json_object' } })

    const entities = parseResponse(result, chunkContent, nodeType.name)
    allEntities.push(...entities)
  }

  return allEntities
}

/**
 * Extract entities of all given node types from a chunk of text, with overlap removal.
 * Convenience wrapper for in-process use (e.g. tests, one-off calls).
 */
export async function extractEntities(
  chunkContent: string,
  nodeTypes: NodeTypeInput[],
  env: Env
): Promise<ExtractedEntity[]> {
  console.log(`[entity-extraction] Starting extraction for ${nodeTypes.length} types, chunk length: ${chunkContent.length}`)
  const allEntities = await extractEntitiesForNodeTypes(chunkContent, nodeTypes, env)
  const deduped = removeOverlaps(allEntities)
  console.log(`[entity-extraction] Total: ${deduped.length} entities (${allEntities.length} before overlap removal)`)
  return deduped
}

function buildMessages(chunkContent: string, nodeType: NodeTypeInput) {
  const examplesBlock =
    nodeType.examples.length > 0
      ? `Examples of ${nodeType.name} entities: ${nodeType.examples.join(', ')}`
      : ''

  const systemPrompt = `You are an entity extraction system. You extract named entities from Chinese text.

You are extracting entities of type: ${nodeType.name}
Definition: ${nodeType.definition}
${examplesBlock}

Return a JSON object with an "entities" array. Each entity should have:
- "text": the exact text as it appears in the input (do not modify or translate it)

If no entities of this type are found, return: {"entities": []}

Example response format: {"entities": [{"text": "北京"}, {"text": "上海"}]}`

  return [
    { role: 'system' as const, content: systemPrompt },
    { role: 'user' as const, content: chunkContent },
  ]
}

function parseResponse(
  result: ModelOutput,
  chunkContent: string,
  nodeTypeName: string
): ExtractedEntity[] {
  if (typeof result === 'string') return []
  // Handle different response formats
  let parsed: { entities?: Array<{ text: string }> } | Array<{ text: string }> | null = null

  // Case 1: response is a string (parse as JSON)
  if ('response' in result && typeof result.response === 'string') {
    try {
      parsed = JSON.parse(extractJsonObject(result.response))
    } catch (err) {
      console.warn(`[entity-extraction] JSON parse failed for ${nodeTypeName}:`, err)
      console.warn(`[entity-extraction] Raw response: ${result.response}`)
      return []
    }
  }
  // Case 2: response is already an object/array
  else if ('response' in result && result.response && typeof result.response === 'object') {
    parsed = result.response as typeof parsed
  }
  // Case 3: no response
  else {
    console.warn(`[entity-extraction] No valid response for ${nodeTypeName}, result:`, JSON.stringify(result))
    return []
  }

  if (!parsed) {
    console.warn(`[entity-extraction] Null parsed result for ${nodeTypeName}`)
    return []
  }

  // Extract entities array from response
  let items: Array<{ text: string }>
  if (Array.isArray(parsed)) {
    items = parsed
  } else if (parsed.entities && Array.isArray(parsed.entities)) {
    items = parsed.entities
  } else {
    console.warn(`[entity-extraction] Unexpected response structure for ${nodeTypeName}:`, JSON.stringify(parsed))
    return []
  }

  const entities: ExtractedEntity[] = []

  for (const item of items) {
    if (!item.text || typeof item.text !== 'string') continue

    // Find all occurrences of this entity text in the chunk
    let searchFrom = 0
    while (true) {
      const idx = chunkContent.indexOf(item.text, searchFrom)
      if (idx === -1) break

      entities.push({
        nodeType: nodeTypeName,
        text: item.text,
        startIndex: idx,
        endIndex: idx + item.text.length,
      })

      searchFrom = idx + item.text.length
    }
  }

  return entities
}

/**
 * Use an LLM to resolve entity type conflicts (overlapping spans tagged with multiple types).
 * If no conflicts exist, returns entities as-is without making an LLM call.
 * Falls back to longest-span rule for any conflict the LLM fails to resolve.
 */
export async function deduplicateEntitiesLLM(
  chunkContent: string,
  entities: ExtractedEntity[],
  env: Env
): Promise<ExtractedEntity[]> {
  // Find conflict groups: entities whose spans overlap with entities of a different type
  const sorted = [...entities].sort((a, b) => {
    if (a.startIndex !== b.startIndex) return a.startIndex - b.startIndex
    return (b.endIndex - b.startIndex) - (a.endIndex - a.startIndex)
  })

  // Group overlapping entities together
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

  if (conflictGroups.length === 0) {
    return entities
  }

  // Build LLM prompt for all conflict groups
  const conflictDescriptions = conflictGroups.map((group, idx) => {
    const span = chunkContent.slice(group[0].startIndex, Math.max(...group.map(e => e.endIndex)))
    const candidates = group.map(e => e.nodeType).join(', ')
    return `${idx + 1}. "${span}" spans [${group[0].startIndex},${Math.max(...group.map(e => e.endIndex))}]: candidates: [${candidates}]`
  })

  const systemPrompt = `You resolve entity type conflicts in Chinese text extraction.
Return JSON: { "resolutions": [{ "text": "...", "nodeType": "..." }] }`

  const userPrompt = `Text: "${chunkContent}"

Resolve these conflicts (each group has overlapping spans — pick exactly one):
${conflictDescriptions.join('\n')}

Reply with JSON { "resolutions": [ { "text": "<exact text>", "nodeType": "<chosen type>" } ] }`

  let resolved: Array<{ text: string; nodeType: string }> = []
  try {
    const result = await env.AI.run(MODEL, {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0,
      max_tokens: 1024,
      response_format: { type: 'json_object' },
    })

    let parsed: { resolutions?: Array<{ text: string; nodeType: string }> } | null = null
    if (typeof result !== 'string' && 'response' in result && typeof result.response === 'string') {
      parsed = JSON.parse(extractJsonObject(result.response))
    } else if (typeof result !== 'string' && 'response' in result && result.response && typeof result.response === 'object') {
      parsed = result.response as typeof parsed
    }
    if (parsed?.resolutions && Array.isArray(parsed.resolutions)) {
      resolved = parsed.resolutions
    }
  } catch (err) {
    console.warn('[entity-extraction] deduplicateEntitiesLLM LLM call failed, falling back to longest-span:', err)
    // Non-fatal: fall back to longest-span for all conflict groups
  }

  // Resolve each conflict group
  const resolvedEntities: ExtractedEntity[] = [...nonConflicting]

  for (const group of conflictGroups) {
    const groupText = chunkContent.slice(group[0].startIndex, Math.max(...group.map(e => e.endIndex)))
    const llmResolution = resolved.find((r) => r.text === groupText)

    if (llmResolution) {
      // Find the entity in the group matching the chosen type
      const chosen = group.find((e) => e.nodeType === llmResolution.nodeType) ?? group[0]
      resolvedEntities.push(chosen)
    } else {
      // Fallback: longest span (first in sorted order since we sorted longest-first)
      resolvedEntities.push(group[0])
    }
  }

  return resolvedEntities.sort((a, b) => a.startIndex - b.startIndex)
}

/**
 * Remove overlapping entities from a sorted list, preferring longer spans.
 * When two entities overlap, the longer one is kept.
 * If equal length, the one encountered first is kept.
 */
export function removeOverlaps(entities: ExtractedEntity[]): ExtractedEntity[] {
  // Sort by startIndex, then by longer span first
  const sorted = [...entities].sort((a, b) => {
    if (a.startIndex !== b.startIndex) return a.startIndex - b.startIndex
    return (b.endIndex - b.startIndex) - (a.endIndex - a.startIndex)
  })

  const result: ExtractedEntity[] = []
  let lastEnd = -1

  for (const entity of sorted) {
    if (entity.startIndex >= lastEnd) {
      result.push(entity)
      lastEnd = entity.endIndex
    }
  }

  return result
}