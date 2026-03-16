const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast' as BaseAiTextGenerationModels

interface ChunkEntity {
  id: number
  entityType: string
  extractedText: string
  sourceChunkId: number
  chunkOrder: number
  context: string
}

function normalizedEditDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i)

  for (let i = 1; i <= m; i++) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= n; j++) {
      const temp = dp[j]
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1])
      prev = temp
    }
  }

  return dp[n] / Math.max(m, n)
}

function parseLLMResponse(result: AiTextGenerationOutput): Record<string, unknown> | null {
  if ('response' in result && typeof result.response === 'string') {
    return JSON.parse(result.response) as Record<string, unknown>
  }
  if ('response' in result && result.response && typeof result.response === 'object') {
    return result.response as Record<string, unknown>
  }
  return null
}

/**
 * Resolve document-wide entity coreference: group chunk-scoped entities that refer
 * to the same real-world entity and create document-scoped parent entities.
 * Idempotent: deletes any existing document-scope entities before re-creating them.
 */
export async function resolveDocumentCoreference(documentId: number, env: Env): Promise<void> {
  // Idempotency: clear previous coreference results
  await env.DB.prepare(
    `UPDATE extracted_entity SET parent_id = NULL WHERE source_document_id = ? AND scope = 'chunk'`
  )
    .bind(documentId)
    .run()
  await env.DB.prepare(
    `DELETE FROM extracted_entity WHERE source_document_id = ? AND scope = 'document'`
  )
    .bind(documentId)
    .run()

  // Step 1: Load all chunk entities with context snippets
  const rows = await env.DB.prepare(
    `SELECT ee.id, ee.entity_type, ee.extracted_text, ee.source_chunk_id,
            ee.chunk_start_index, ee.chunk_end_index,
            tc.chunk_order, tc.content AS chunk_content
     FROM extracted_entity ee
     JOIN text_chunk tc ON tc.id = ee.source_chunk_id
     WHERE ee.source_document_id = ? AND ee.scope = 'chunk'
     ORDER BY tc.chunk_order`
  )
    .bind(documentId)
    .all<{
      id: number
      entity_type: string
      extracted_text: string | null
      source_chunk_id: number
      chunk_start_index: number | null
      chunk_end_index: number | null
      chunk_order: number
      chunk_content: string
    }>()

  const entities: ChunkEntity[] = rows.results
    .filter((r) => r.extracted_text !== null)
    .map((r) => {
      const text = r.extracted_text!
      const start = r.chunk_start_index ?? 0
      const end = r.chunk_end_index ?? text.length
      const content = r.chunk_content
      const contextStart = Math.max(0, start - 80)
      const contextEnd = Math.min(content.length, end + 80)
      return {
        id: r.id,
        entityType: r.entity_type,
        extractedText: text,
        sourceChunkId: r.source_chunk_id,
        chunkOrder: r.chunk_order,
        context: content.slice(contextStart, contextEnd),
      }
    })

  if (entities.length === 0) {
    console.log(`[coreference] No chunk entities for document ${documentId}`)
    return
  }

  // Step 2: Candidate filtering — find entities that could be coreferent
  const candidateIds = new Set<number>()

  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      const a = entities[i]
      const b = entities[j]

      // Exact match (different chunks or same chunk different span is fine)
      if (a.extractedText === b.extractedText) {
        candidateIds.add(a.id)
        candidateIds.add(b.id)
        continue
      }

      // Fuzzy match: same type, both length >= 3, distance < 0.3
      if (
        a.entityType === b.entityType &&
        a.extractedText.length >= 3 &&
        b.extractedText.length >= 3 &&
        normalizedEditDistance(a.extractedText, b.extractedText) < 0.3
      ) {
        candidateIds.add(a.id)
        candidateIds.add(b.id)
      }
    }
  }

  if (candidateIds.size === 0) {
    console.log(`[coreference] No candidate pairs for document ${documentId}`)
    return
  }

  const candidates = entities.filter((e) => candidateIds.has(e.id))
  console.log(
    `[coreference] Document ${documentId}: ${candidates.length} candidates from ${entities.length} chunk entities`
  )

  // Step 3: LLM grouping call
  const entityLines = candidates
    .map((e) => `${e.id} | ${e.entityType} | ${e.extractedText} | ...${e.context}...`)
    .join('\n')

  const systemPrompt = `You are a coreference resolution system for Chinese text.
Group entities that refer to the same real-world entity.
The same text string may refer to different entities (e.g. homonymous names) — use context to decide.
Entities of different types should not be merged.
Return JSON: { "groups": [[id, id, ...], ...] }
Only include groups of 2 or more. Omit entities that should remain distinct.`

  const userPrompt = `Document entities (id | type | text | context):
${entityLines}

Group the entity IDs that refer to the same real-world entity.
Reply with JSON { "groups": [[id, id, ...], ...] }`

  let groups: number[][] = []
  try {
    const result = await env.AI.run(MODEL, {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0,
      response_format: { type: 'json_object' },
    })

    const parsed = parseLLMResponse(result)
    if (parsed?.groups && Array.isArray(parsed.groups)) {
      groups = (parsed.groups as unknown[]).filter(
        (g): g is number[] =>
          Array.isArray(g) && g.length >= 2 && g.every((id) => typeof id === 'number')
      )
    }
  } catch (err) {
    console.warn(`[coreference] LLM grouping call failed for document ${documentId}:`, err)
    return
  }

  if (groups.length === 0) {
    console.log(`[coreference] LLM found no merge groups for document ${documentId}`)
    return
  }

  console.log(`[coreference] LLM confirmed ${groups.length} merge groups for document ${documentId}`)

  // Step 4: Label generation + Step 5: Persist
  const entityById = new Map(candidates.map((e) => [e.id, e]))

  for (const group of groups) {
    const members = group.map((id) => entityById.get(id)).filter(Boolean) as ChunkEntity[]
    if (members.length < 2) continue

    const texts = [...new Set(members.map((e) => e.extractedText))]
    const entityType = members[0].entityType

    let label: string
    if (texts.length === 1) {
      // All same text — no LLM call needed
      label = texts[0]
    } else {
      // Mixed texts — ask LLM for canonical label
      try {
        const result = await env.AI.run(MODEL, {
          messages: [
            {
              role: 'system',
              content:
                'Generate a canonical short label for this Chinese entity given its variants. Return only the label text, no explanation.',
            },
            {
              role: 'user',
              content: `Entity type: ${entityType}\nVariants: ${texts.map((t) => `"${t}"`).join(', ')}`,
            },
          ],
          temperature: 0,
        })

        let raw = ''
        if ('response' in result && typeof result.response === 'string') {
          raw = result.response.trim()
        }
        label = raw || texts[0]
      } catch (err) {
        console.warn(`[coreference] Label generation failed, falling back to first variant:`, err)
        label = texts[0]
      }
    }

    // Insert document-scoped parent entity
    const parentRow = await env.DB.prepare(
      `INSERT INTO extracted_entity
        (source_document_id, source_chunk_id, entity_type, extracted_text, label, scope)
       VALUES (?, NULL, ?, NULL, ?, 'document')
       RETURNING id`
    )
      .bind(documentId, entityType, label)
      .first<{ id: number }>()

    if (!parentRow) {
      console.warn(`[coreference] Failed to insert parent entity for group ${JSON.stringify(group)}`)
      continue
    }

    // Update chunk entities to point at this parent
    const placeholders = members.map(() => '?').join(', ')
    await env.DB.prepare(
      `UPDATE extracted_entity SET parent_id = ? WHERE id IN (${placeholders})`
    )
      .bind(parentRow.id, ...members.map((e) => e.id))
      .run()
  }

  console.log(`[coreference] Coreference resolution complete for document ${documentId}`)
}
