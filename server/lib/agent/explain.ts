// Shared core for the "Explain" and "Disambiguate" capabilities.
//
// Extracted from server/routes/dictionary.ts so the same logic can be used both
// standalone (the existing POST /api/dictionary/explain|disambiguate routes) and
// by the translation agent. The routes stay thin wrappers over these functions;
// behavior is unchanged.

const EXPLAIN_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'

const TUTOR_SYSTEM_PROMPT =
  'You are a Chinese language tutor. Give direct, compact explanations in English. ' +
  'Never use filler phrases like "In this passage", "The context suggests", "Here,", ' +
  'or "This word". Start immediately with the meaning or usage.'

export interface ExplainEntry {
  traditional: string
  simplified: string
  pinyin: string
  definitions: string[]
}

export interface DisambiguateEntry extends ExplainEntry {
  id: number
}

export interface ExplainParams {
  term: string
  entries: ExplainEntry[]
  documentId: number
  chunkId: number
}

export interface DisambiguateParams {
  term: string
  entries: DisambiguateEntry[]
  documentId: number
  chunkId: number
}

export type ExplainResult =
  | { ok: true; explanation: string }
  | { ok: false; status: 404; error: string }

export type DisambiguateResult =
  | { ok: true; explanation: string; entryId: number | undefined }
  | { ok: false; status: 404; error: string }

/**
 * Fetch the target chunk plus its ±2 neighbors, concatenated for prompt context.
 * Returns `null` if the chunk does not exist in the given document.
 */
async function fetchContextWindow(
  env: Env,
  documentId: number,
  chunkId: number,
): Promise<string | null> {
  const targetChunk = await env.DB
    .prepare('SELECT chunk_order FROM text_chunk WHERE id = ? AND source_document_id = ?')
    .bind(chunkId, documentId)
    .first<{ chunk_order: number }>()

  if (!targetChunk) return null

  const order = targetChunk.chunk_order

  const { results: contextChunks } = await env.DB
    .prepare(
      `SELECT content FROM text_chunk
       WHERE source_document_id = ?
         AND chunk_order BETWEEN ? AND ?
       ORDER BY chunk_order`,
    )
    .bind(documentId, order - 2, order + 2)
    .all<{ content: string }>()

  return contextChunks.map((r) => r.content).join('\n\n')
}

function formatEntry(e: ExplainEntry): string {
  return `${e.traditional} (${e.pinyin}): ${e.definitions.join('; ')}`
}

/** Explain how `term` is used in its surrounding context (1–2 sentences). */
export async function explainTermInContext(
  env: Env,
  params: ExplainParams,
): Promise<ExplainResult> {
  const { term, entries, documentId, chunkId } = params

  const contextText = await fetchContextWindow(env, documentId, chunkId)
  if (contextText === null) return { ok: false, status: 404, error: 'Chunk not found' }

  const topEntry = entries[0]
  const otherEntries = entries.slice(1, 5)
  const topEntryText = topEntry ? formatEntry(topEntry) : term
  const otherEntriesText =
    otherEntries.length > 0 ? otherEntries.map(formatEntry).join('\n') : '(none)'

  const messages = [
    { role: 'system' as const, content: TUTOR_SYSTEM_PROMPT },
    {
      role: 'user' as const,
      content: `The learner selected: "${term}"

Dictionary entry shown:
${topEntryText}

Other returned entries (not shown to learner):
${otherEntriesText}

Text:
${contextText}

In 1–2 sentences, explain how "${term}" is used here. Skip anything obvious from the dictionary gloss.`,
    },
  ]

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await env.AI.run(EXPLAIN_MODEL as any, {
    messages,
    temperature: 0.3,
    max_tokens: 250,
  })

  const explanation = (result as { response?: string }).response ?? ''
  return { ok: true, explanation }
}

/** Pick which dictionary entry best matches the usage and explain why. */
export async function disambiguateTerm(
  env: Env,
  params: DisambiguateParams,
): Promise<DisambiguateResult> {
  const { term, entries, documentId, chunkId } = params

  const contextText = await fetchContextWindow(env, documentId, chunkId)
  if (contextText === null) return { ok: false, status: 404, error: 'Chunk not found' }

  const entriesList = entries
    .map((e, i) => `${i + 1}. [id=${e.id}] ${e.traditional} (${e.pinyin}): ${e.definitions.join('; ')}`)
    .join('\n')

  const messages = [
    { role: 'system' as const, content: TUTOR_SYSTEM_PROMPT },
    {
      role: 'user' as const,
      content: `The learner selected: "${term}"

Dictionary entries (numbered):
${entriesList}

Surrounding text:
${contextText}

Which entry best matches how "${term}" is used here?
Reply with JSON: { "entryId": <number>, "explanation": "<1–2 sentences>" }
The explanation should say which meaning applies and why, without filler phrases.`,
    },
  ]

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await env.AI.run(EXPLAIN_MODEL as any, {
    messages,
    temperature: 0.3,
    max_tokens: 250,
    response_format: { type: 'json_object' },
  })

  const raw = (result as { response?: string }).response ?? '{}'
  let parsed: { entryId?: unknown; explanation?: unknown } = {}
  try {
    parsed = JSON.parse(raw)
  } catch {
    /* fall through to defaults */
  }

  const validIds = new Set(entries.map((e) => e.id))
  const entryId =
    typeof parsed.entryId === 'number' && validIds.has(parsed.entryId)
      ? parsed.entryId
      : entries[0]?.id
  const explanation = typeof parsed.explanation === 'string' ? parsed.explanation : ''

  return { ok: true, explanation, entryId }
}
