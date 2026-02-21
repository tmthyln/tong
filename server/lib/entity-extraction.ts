interface NodeTypeInput {
  name: string
  definition: string
  examples: string[]
}

interface ExtractedEntity {
  nodeType: string
  text: string
  startIndex: number
  endIndex: number
}

const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast' as BaseAiTextGenerationModels

/**
 * Extract entities of the given node types from a chunk of text.
 * Each node type is processed independently in a separate LLM call.
 */
export async function extractEntities(
  chunkContent: string,
  nodeTypes: NodeTypeInput[],
  env: Env
): Promise<ExtractedEntity[]> {
  console.log(`[entity-extraction] Starting extraction for ${nodeTypes.length} types, chunk length: ${chunkContent.length}`)
  const allEntities: ExtractedEntity[] = []

  for (const nodeType of nodeTypes) {
    console.log(`[entity-extraction] Calling AI for ${nodeType.name}...`)
    const messages = buildMessages(chunkContent, nodeType)

    let result: AiTextGenerationOutput
    try {
      result = await env.AI.run(MODEL, {
        messages,
        temperature: 0,
        response_format: { type: 'json_object' },
      })
    } catch (err) {
      console.warn(`[entity-extraction] AI.run failed for ${nodeType.name}:`, err)
      continue
    }
    console.log(`[entity-extraction] AI responded for ${nodeType.name}`)

    const entities = parseResponse(result, chunkContent, nodeType.name)
    console.log(`[entity-extraction] ${nodeType.name}: ${entities.length} entities`)
    allEntities.push(...entities)
  }

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
  result: AiTextGenerationOutput,
  chunkContent: string,
  nodeTypeName: string
): ExtractedEntity[] {
  // Handle different response formats
  let parsed: { entities?: Array<{ text: string }> } | Array<{ text: string }> | null = null

  // Case 1: response is a string (parse as JSON)
  if ('response' in result && typeof result.response === 'string') {
    try {
      parsed = JSON.parse(result.response)
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
 * Remove overlapping entities, preferring longer spans.
 * When two entities overlap, the longer one is kept.
 * If equal length, the one encountered first is kept.
 */
function removeOverlaps(entities: ExtractedEntity[]): ExtractedEntity[] {
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