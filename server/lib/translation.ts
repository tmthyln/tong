// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast' as any

const SYSTEM_PROMPT = `You are a literary translator. Translate the target Chinese text into fluent English.
Preserve names, titles, and proper nouns in their Chinese form (pinyin or romanisation).
Do not add commentary. Output only the translated text.`

async function fetchSurroundingChunks(
  documentId: number,
  chunkId: number,
  env: Env
): Promise<{ preceding: Array<{ id: number; content: string }>; following: Array<{ id: number; content: string }> }> {
  const currentChunk = await env.DB.prepare(
    'SELECT chunk_order FROM text_chunk WHERE id = ?'
  )
    .bind(chunkId)
    .first<{ chunk_order: number }>()

  if (!currentChunk) return { preceding: [], following: [] }

  const order = currentChunk.chunk_order

  const [precedingResult, followingResult] = await Promise.all([
    env.DB.prepare(
      'SELECT id, content FROM text_chunk WHERE source_document_id = ? AND chunk_order >= ? AND chunk_order < ? ORDER BY chunk_order ASC'
    )
      .bind(documentId, order - 3, order)
      .all<{ id: number; content: string }>(),
    env.DB.prepare(
      'SELECT id, content FROM text_chunk WHERE source_document_id = ? AND chunk_order > ? AND chunk_order <= ? ORDER BY chunk_order ASC'
    )
      .bind(documentId, order, order + 2)
      .all<{ id: number; content: string }>(),
  ])

  return {
    preceding: precedingResult.results,
    following: followingResult.results,
  }
}

async function fetchSimilarChunksWithTranslations(
  chunkId: number,
  content: string,
  excludeIds: number[],
  env: Env
): Promise<Array<{ content: string; translation: string }>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let embeddingResult: any
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    embeddingResult = await (env.AI as any).run('@cf/google/embeddinggemma-300m', {
      text: [content],
    })
  } catch {
    return []
  }

  const vector = embeddingResult?.data?.[0]
  if (!vector) return []

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let queryResult: any
  try {
    queryResult = await env.CHUNK_VECTORS.query(vector, { topK: 8, namespace: 'document' })
  } catch {
    return []
  }

  const candidateIds = (queryResult?.matches ?? [])
    .map((m: { id: string }) => Number(m.id))
    .filter((id: number) => id !== chunkId && !excludeIds.includes(id))
    .slice(0, 3)

  if (candidateIds.length === 0) return []

  const placeholders = candidateIds.map(() => '?').join(',')
  const rows = await env.DB.prepare(
    `SELECT tc.content AS chunk_content, tr.content AS translation
     FROM text_chunk tc
     JOIN translation_chunk tr ON tr.text_chunk_id = tc.id
     WHERE tc.id IN (${placeholders})
     GROUP BY tc.id
     ORDER BY tr.draft_number DESC, tr.date_created DESC`
  )
    .bind(...candidateIds)
    .all<{ chunk_content: string; translation: string }>()

  return rows.results.map((r) => ({ content: r.chunk_content, translation: r.translation }))
}

function buildInitialDraftMessages(
  content: string,
  preceding: Array<{ content: string }>,
  following: Array<{ content: string }>,
  similar: Array<{ content: string; translation: string }>
) {
  const parts: string[] = []

  if (preceding.length > 0) {
    parts.push('=== Preceding context ===')
    parts.push(preceding.map((c) => c.content).join('\n'))
  }

  parts.push('=== Text to translate ===')
  parts.push(content)

  if (following.length > 0) {
    parts.push('=== Following context ===')
    parts.push(following.map((c) => c.content).join('\n'))
  }

  if (similar.length > 0) {
    parts.push('=== Similar passages (with translations) ===')
    parts.push(similar.map((s) => `${s.content} → ${s.translation}`).join('\n'))
  }

  parts.push('\nTranslate only the "Text to translate" section.')

  return [
    { role: 'system' as const, content: SYSTEM_PROMPT },
    { role: 'user' as const, content: parts.join('\n\n') },
  ]
}

function buildRevisionMessages(
  content: string,
  preceding: Array<{ content: string }>,
  following: Array<{ content: string }>,
  similar: Array<{ content: string; translation: string }>,
  precedingTranslations: string[],
  followingTranslations: string[],
  previousDraft: string
) {
  const parts: string[] = []

  if (preceding.length > 0) {
    parts.push('=== Preceding context ===')
    parts.push(preceding.map((c) => c.content).join('\n'))
  }

  parts.push('=== Text to translate ===')
  parts.push(content)

  if (following.length > 0) {
    parts.push('=== Following context ===')
    parts.push(following.map((c) => c.content).join('\n'))
  }

  if (precedingTranslations.length > 0) {
    parts.push('=== Preceding translations ===')
    parts.push(precedingTranslations.join('\n'))
  }

  if (followingTranslations.length > 0) {
    parts.push('=== Following translations ===')
    parts.push(followingTranslations.join('\n'))
  }

  if (similar.length > 0) {
    parts.push('=== Similar passages (with translations) ===')
    parts.push(similar.map((s) => `${s.content} → ${s.translation}`).join('\n'))
  }

  parts.push('=== Your previous draft ===')
  parts.push(previousDraft)

  parts.push(
    '\nImprove the translation of only the "Text to translate" section, targeting consistency with surrounding translations.'
  )

  return [
    { role: 'system' as const, content: SYSTEM_PROMPT },
    { role: 'user' as const, content: parts.join('\n\n') },
  ]
}

async function runTranslation(
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  env: Env
): Promise<string> {
  const result = await env.AI.run(MODEL, { messages, temperature: 0.3 })

  const text = 'response' in result && typeof result.response === 'string' ? result.response : undefined
  if (!text) throw new Error('Translation failed: no response from LLM')
  return text.trim()
}

async function storeTranslation(
  chunkId: number,
  content: string,
  draftNumber: number,
  env: Env
): Promise<void> {
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO translation_chunk (text_chunk_id, content, translator, draft_number, date_created, date_last_modified)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(chunkId, content, 'ai:llama3', draftNumber, now, now)
    .run()
}

export async function translateChunkInitialDraft(
  chunkId: number,
  documentId: number,
  content: string,
  env: Env
): Promise<void> {
  const { preceding, following } = await fetchSurroundingChunks(documentId, chunkId, env)
  const excludeIds = [chunkId, ...preceding.map((c) => c.id), ...following.map((c) => c.id)]
  const similar = await fetchSimilarChunksWithTranslations(chunkId, content, excludeIds, env)

  const messages = buildInitialDraftMessages(content, preceding, following, similar)
  const translation = await runTranslation(messages, env)
  await storeTranslation(chunkId, translation, 1, env)
}

export async function translateChunkRevision(
  chunkId: number,
  documentId: number,
  content: string,
  env: Env
): Promise<void> {
  const { preceding, following } = await fetchSurroundingChunks(documentId, chunkId, env)
  const excludeIds = [chunkId, ...preceding.map((c) => c.id), ...following.map((c) => c.id)]
  const similar = await fetchSimilarChunksWithTranslations(chunkId, content, excludeIds, env)

  // Fetch latest translation for each surrounding chunk
  const fetchLatest = async (id: number): Promise<string | null> => {
    const row = await env.DB.prepare(
      'SELECT content FROM translation_chunk WHERE text_chunk_id = ? ORDER BY draft_number DESC, date_created DESC LIMIT 1'
    )
      .bind(id)
      .first<{ content: string }>()
    return row?.content ?? null
  }

  const [precedingTranslations, followingTranslations, previousDraftRow] = await Promise.all([
    Promise.all(preceding.map((c) => fetchLatest(c.id))),
    Promise.all(following.map((c) => fetchLatest(c.id))),
    env.DB.prepare(
      'SELECT content FROM translation_chunk WHERE text_chunk_id = ? ORDER BY draft_number DESC, date_created DESC LIMIT 1'
    )
      .bind(chunkId)
      .first<{ content: string }>(),
  ])

  const previousDraft = previousDraftRow?.content ?? ''

  const messages = buildRevisionMessages(
    content,
    preceding,
    following,
    similar,
    precedingTranslations.filter((t): t is string => t !== null),
    followingTranslations.filter((t): t is string => t !== null),
    previousDraft
  )
  const translation = await runTranslation(messages, env)
  await storeTranslation(chunkId, translation, 2, env)
}
