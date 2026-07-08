import { Hono } from 'hono'

// VectorizeVector is a global type from worker-configuration.d.ts
type VectorizeVector = { id: string; values: Float32Array | number[]; namespace?: string; metadata?: Record<string, unknown> }

interface ReduceResponse {
  coords: [number, number][]
  topicsKey?: string | null
}

export interface ChunkRow {
  id: number
  source_document_id: number
}

export function isValidTopicsKey(key: string): boolean {
  return /^[0-9a-f]{16}$/.test(key)
}

export function computeDocMaxVectors(
  chunks: ChunkRow[],
  vectorMap: Map<string, number[]>
): Map<number, number[]> {
  const docVectorMap = new Map<number, number[]>()
  for (const chunk of chunks) {
    const vec = vectorMap.get(String(chunk.id))
    if (!vec) continue
    const existing = docVectorMap.get(chunk.source_document_id)
    if (!existing) {
      docVectorMap.set(chunk.source_document_id, vec.slice())
    } else {
      for (let d = 0; d < vec.length; d++) {
        if (vec[d] > existing[d]) existing[d] = vec[d]
      }
    }
  }
  return docVectorMap
}

function getUmapContainer(env: Env) {
  return env.UMAP_CONTAINER.get(env.UMAP_CONTAINER.idFromName('singleton'))
}

const libraryVisualizationRoutes = new Hono<{ Bindings: Env }>()

libraryVisualizationRoutes.get('/', async (c) => {
  // 1. Query all documents
  const docsResult = await c.env.DB.prepare(
    'SELECT id, title, original_doc_filename FROM document ORDER BY id'
  ).all<{ id: number; title: string | null; original_doc_filename: string }>()

  // 2. Query all chunks (content feeds the topic-labeling job)
  const chunksResult = await c.env.DB.prepare(
    'SELECT id, source_document_id, content FROM text_chunk ORDER BY id'
  ).all<{ id: number; source_document_id: number; content: string }>()

  const allChunkIds = chunksResult.results.map((c) => String(c.id))

  // 3. Batch-fetch vectors from Vectorize in batches of 20
  const vectorMap = new Map<string, number[]>()
  for (let i = 0; i < allChunkIds.length; i += 20) {
    const batch = allChunkIds.slice(i, i + 20)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (c.env.CHUNK_VECTORS as any).getByIds(batch, { namespace: 'document' }) as VectorizeVector[]
    for (const match of result) {
      if (match.values) {
        vectorMap.set(match.id, Array.from(match.values))
      }
    }
  }

  // 4. Build ordered list of chunks that have vectors
  const chunksWithVectors = chunksResult.results.filter((chunk) => vectorMap.has(String(chunk.id)))
  const chunkVectors = chunksWithVectors.map((chunk) => vectorMap.get(String(chunk.id))!)

  // 5. Compute per-document elementwise max embeddings
  const docVectorMap = computeDocMaxVectors(chunksWithVectors, vectorMap)

  // Only include documents that have at least one chunk with a vector
  const docsWithVectors = docsResult.results.filter((doc) => docVectorMap.has(doc.id))
  const docMaxVectors = docsWithVectors.map((doc) => docVectorMap.get(doc.id)!)

  // Need at least 2 points to run UMAP
  const totalPoints = chunkVectors.length + docMaxVectors.length
  if (totalPoints < 2) {
    return c.json({ chunks: [], documents: [], topicsKey: null })
  }

  // 6. Call UMAP container; chunk vectors first so texts align with them
  const reduceResponse = await getUmapContainer(c.env).fetch('http://localhost/reduce', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      vectors: [...chunkVectors, ...docMaxVectors],
      texts: chunksWithVectors.map((chunk) => chunk.content),
    }),
  })

  if (!reduceResponse.ok) {
    const detail = (await reduceResponse.text()).slice(0, 300)
    console.error('[viz] container /reduce failed', reduceResponse.status, detail)
    return c.json({ error: 'UMAP reduction failed', detail }, 500)
  }

  const { coords, topicsKey } = (await reduceResponse.json()) as ReduceResponse

  // 7. Split coords at chunksWithVectors.length offset
  const chunkCoords = coords.slice(0, chunksWithVectors.length)
  const docCoords = coords.slice(chunksWithVectors.length)

  return c.json({
    chunks: chunksWithVectors.map((chunk, i) => ({
      id: chunk.id,
      documentId: chunk.source_document_id,
      x: chunkCoords[i][0],
      y: chunkCoords[i][1],
    })),
    documents: docsWithVectors.map((doc, i) => ({
      id: doc.id,
      title: doc.title,
      filename: doc.original_doc_filename,
      x: docCoords[i][0],
      y: docCoords[i][1],
    })),
    topicsKey: topicsKey ?? null,
  })
})

libraryVisualizationRoutes.get('/topics', async (c) => {
  const key = c.req.query('key')
  if (!key || !isValidTopicsKey(key)) {
    return c.json({ status: 'error', error: 'invalid key' }, 400)
  }
  const response = await getUmapContainer(c.env).fetch(`http://localhost/topics/${key}`)
  if (!response.ok) {
    // The Container DO answers with plain text when the container can't start.
    const detail = (await response.text()).slice(0, 300)
    return c.json({ status: 'error', error: detail }, 502)
  }
  const body = (await response.json()) as Record<string, unknown>
  return c.json(body)
})

export default libraryVisualizationRoutes
