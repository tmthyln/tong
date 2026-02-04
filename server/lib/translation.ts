export async function translateAndStoreChunk(
  chunkId: number,
  content: string,
  env: Env
): Promise<void> {
  const result = await env.AI.run('@cf/meta/m2m100-1.2b', {
    text: content,
    source_lang: 'chinese',
    target_lang: 'english',
  })

  const translatedText =
    'translated_text' in result ? result.translated_text : undefined
  if (!translatedText) {
    throw new Error('Translation failed: no translated_text in response')
  }

  const now = new Date().toISOString()

  await env.DB.prepare(
    `INSERT INTO translation_chunk (text_chunk_id, content, translator, date_created, date_last_modified)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(chunkId, translatedText, 'ai:m2m100-1.2b', now, now)
    .run()
}