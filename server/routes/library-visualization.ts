import { Hono } from 'hono'
import { encodeVectorFrame, fetchVectorsByIds, VECTOR_FRAME_CONTENT_TYPE } from '../lib/chunk-vectors'

interface ReduceResponse {
  coords: [number, number][]
  topicsKey?: string | null
}

export interface ChunkRow {
  id: number
  source_document_id: number
}

// The key is minted by (and opaque to everyone but) the container; only check
// that it is URL-safe, not its format.
export function isValidTopicsKey(key: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(key)
}

export function computeDocMaxVectors(
  chunks: ChunkRow[],
  vectorMap: Map<string, Float32Array>
): Map<number, Float32Array> {
  const docVectorMap = new Map<number, Float32Array>()
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

// Not @cloudflare/containers' getContainer: importing that package here pulls
// the workerd-only `cloudflare:workers` module into this file's pure helpers,
// breaking node-run vitest.
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

  // 3. Fetch vectors from Vectorize (parallel batches of 20)
  const vectorMap = await fetchVectorsByIds(c.env.CHUNK_VECTORS, allChunkIds)

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
  //    Binary float32 frame: ~1/5 the bytes of JSON numbers (container/app.py).
  const reduceResponse = await getUmapContainer(c.env).fetch('http://localhost/reduce', {
    method: 'POST',
    headers: { 'Content-Type': VECTOR_FRAME_CONTENT_TYPE },
    body: encodeVectorFrame([...chunkVectors, ...docMaxVectors], {
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
  // Pure passthrough — no need to parse and re-serialize the container's JSON.
  return new Response(response.body, { headers: { 'Content-Type': 'application/json' } })
})

export default libraryVisualizationRoutes
