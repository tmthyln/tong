// Semantic chunk search: embed a query and find the nearest chunk vectors,
// then resolve their text. Wraps the existing embedding model + Vectorize index
// so it can be used as an agent self-tool. (The ingestion pipeline writes these
// vectors via lib/embedding.ts.)

export interface ChunkSearchHit {
  chunkId: number
  documentId: number | null
  content: string
  score: number
}

export interface ChunkSearchParams {
  query: string
  documentId?: number
  topK?: number
}

export async function searchChunksByText(
  env: Env,
  params: ChunkSearchParams,
): Promise<ChunkSearchHit[]> {
  const query = params.query?.trim() ?? ''
  if (!query) return []
  const topK = Math.min(params.topK ?? 8, 20)

  const embedding = await env.AI.run('@cf/google/embeddinggemma-300m', { text: query })
  const vector = embedding.data?.[0]
  if (!vector) return []

  const queryResult = await env.CHUNK_VECTORS.query(vector, {
    topK,
    namespace: 'document',
    filter: params.documentId != null ? { sourceDocumentId: { $eq: params.documentId } } : undefined,
  })

  const matches = queryResult.matches ?? []
  const scoreById = new Map<number, number>()
  for (const m of matches) {
    const id = parseInt(m.id, 10)
    if (!Number.isNaN(id)) scoreById.set(id, m.score)
  }
  const ids = [...scoreById.keys()]
  if (ids.length === 0) return []

  const ph = ids.map(() => '?').join(', ')
  const { results } = await env.DB
    .prepare(`SELECT id, source_document_id, content FROM text_chunk WHERE id IN (${ph})`)
    .bind(...ids)
    .all<{ id: number; source_document_id: number | null; content: string }>()

  const byId = new Map(results.map((r) => [r.id, r]))
  // Preserve match order (by similarity, highest first).
  return ids
    .map((id): ChunkSearchHit | null => {
      const row = byId.get(id)
      if (!row) return null
      return { chunkId: id, documentId: row.source_document_id, content: row.content, score: scoreById.get(id) ?? 0 }
    })
    .filter((h): h is ChunkSearchHit => h !== null)
}
