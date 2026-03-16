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
}

const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast' as BaseAiTextGenerationModels

/**
 * Extract relationships of a single edge type from a chunk of text.
 * Requires a list of already-extracted entities to constrain the output.
 */
export async function extractRelationshipsForEdgeType(
  chunkContent: string,
  entities: Array<{ nodeType: string; text: string }>,
  edgeType: EdgeTypeInput,
  env: Env
): Promise<ExtractedRelationship[]> {
  if (entities.length === 0) return []

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

Only include relationships where both entities appear in the entity list. Do not invent entities.
If no relationships of this type are found, return: {"relationships": []}

Example response format: {"relationships": [{"from": "北京", "to": "中国"}]}`

  const result = await env.AI.run(MODEL, {
    messages: [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: chunkContent },
    ],
    temperature: 0,
    response_format: { type: 'json_object' },
  })

  return parseResponse(result, entities, edgeType.name)
}

function parseResponse(
  result: AiTextGenerationOutput,
  entities: Array<{ text: string }>,
  edgeTypeName: string
): ExtractedRelationship[] {
  let parsed: { relationships?: Array<{ from: string; to: string }> } | null = null

  if ('response' in result && typeof result.response === 'string') {
    try {
      parsed = JSON.parse(result.response)
    } catch {
      console.warn(`[relationship-extraction] JSON parse failed for ${edgeTypeName}`)
      return []
    }
  } else if ('response' in result && result.response && typeof result.response === 'object') {
    parsed = result.response as typeof parsed
  } else {
    console.warn(`[relationship-extraction] No valid response for ${edgeTypeName}`)
    return []
  }

  if (!parsed?.relationships || !Array.isArray(parsed.relationships)) return []

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
      relationships.push({ edgeType: edgeTypeName, fromText: rel.from, toText: rel.to })
    }
  }

  return relationships
}
