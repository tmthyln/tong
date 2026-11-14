// Single owner of the text-embedding model. Vectors in CHUNK_VECTORS are only
// comparable with vectors from the same model + dimensions + prompt scheme, so
// every embedding call goes through here.

export const EMBEDDING_MODEL = '@cf/google/embeddinggemma-2'
// Must match the CHUNK_VECTORS index (tong-doc-chunks, 768-d cosine).
export const EMBEDDING_DIMENSIONS = 768
// Bump the trailing scheme tag whenever TASK_PREFIX changes for 'document'.
// Stored per chunk in text_chunk.embedding_version; any mismatch is re-embedded
// by the scheduled sweep (lib/reembed.ts).
export const EMBEDDING_VERSION = `${EMBEDDING_MODEL}:${EMBEDDING_DIMENSIONS}:p1`

// EmbeddingGemma task prompts. Documents and retrieval queries are asymmetric;
// clustering is its own task.
export type EmbeddingTask = 'document' | 'query' | 'clustering'

const TASK_PREFIX: Record<EmbeddingTask, string> = {
  document: 'title: none | text: ',
  query: 'task: search result | query: ',
  clustering: 'task: clustering | query: ',
}

interface EmbeddingGemmaResponse {
  data?: Array<{ index: number; embedding: number[] }>
}

type AiRun = (model: string, args: Record<string, unknown>) => Promise<unknown>

export async function embedTexts(
  env: Env,
  texts: string[],
  task: EmbeddingTask
): Promise<number[][]> {
  if (texts.length === 0) return []
  const result = (await (env.AI.run as AiRun)(EMBEDDING_MODEL, {
    input: texts.map((t) => TASK_PREFIX[task] + t),
    dimensions: EMBEDDING_DIMENSIONS,
  })) as EmbeddingGemmaResponse
  const data = [...(result.data ?? [])].sort((a, b) => a.index - b.index)
  return data.map((d) => d.embedding)
}

export async function embedText(
  env: Env,
  text: string,
  task: EmbeddingTask
): Promise<number[] | undefined> {
  const [vector] = await embedTexts(env, [text], task)
  return vector
}

export async function embedAndStoreChunk(
  chunkId: number,
  documentId: number,
  content: string,
  env: Env
): Promise<void> {
  await embedAndStoreChunks(env, [{ id: chunkId, documentId, content }])
}

export interface ChunkToEmbed {
  id: number
  documentId: number
  content: string
}

// Embed a batch of chunks (one AI call), upsert their vectors, and record the
// embedding version on each chunk. Callers batch via lib/reembed.ts
// batchChunks: inputs may share the model's 8,192-token context, and D1 caps
// bound parameters at 100 per statement.
export async function embedAndStoreChunks(env: Env, chunks: ChunkToEmbed[]): Promise<void> {
  if (chunks.length === 0) return
  const vectors = await embedTexts(
    env,
    chunks.map((c) => c.content),
    'document'
  )
  if (vectors.length !== chunks.length) {
    throw new Error(`expected ${chunks.length} embeddings, got ${vectors.length}`)
  }
  await env.CHUNK_VECTORS.upsert(chunks.map((c, i) => chunkVector(c.id, c.documentId, vectors[i])))

  const placeholders = chunks.map(() => '?').join(', ')
  await env.DB.prepare(`UPDATE text_chunk SET embedding_version = ? WHERE id IN (${placeholders})`)
    .bind(EMBEDDING_VERSION, ...chunks.map((c) => c.id))
    .run()
}

export function chunkVector(
  chunkId: number,
  documentId: number,
  values: number[]
): VectorizeVector {
  return {
    id: chunkId.toString(),
    values,
    namespace: 'document',
    metadata: {
      sourceDocumentId: documentId,
      chunkId: chunkId,
      lang: 'zh',
      window: 1,
    },
  }
}
