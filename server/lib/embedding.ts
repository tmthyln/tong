export async function embedAndStoreChunk(
  chunkId: number,
  documentId: number,
  content: string,
  env: Env
): Promise<void> {
  const result = await env.AI.run('@cf/google/embeddinggemma-300m', {
    text: content,
  })

  await env.CHUNK_VECTORS.upsert([
    {
      id: chunkId.toString(),
      values: result.data[0],
      namespace: 'document',
      metadata: {
        sourceDocumentId: documentId,
        chunkId: chunkId,
        lang: 'zh',
        window: 1,
      },
    },
  ])
}