/**
 * Bulk reads of chunk embeddings from Vectorize, and the binary frame the
 * document map sends them to the UMAP container in.
 */
import { mapLimit } from './map-limit'

/** Vectorize getByIds accepts at most 20 ids per call. */
export const GET_BY_IDS_BATCH = 20
/** getByIds calls in flight at once. */
export const GET_BY_IDS_CONCURRENCY = 6

interface StoredVector {
  id: string
  values?: ArrayLike<number> | null
}

/** Vectorize's binding; its generated type omits getByIds' namespace option, which the runtime honours. */
interface VectorReader {
  getByIds(ids: string[], options?: { namespace?: string }): Promise<Array<StoredVector | null>>
}

/** Fetch vectors by id in parallel batches. Ids without a stored vector are absent from the map. */
export async function fetchVectorsByIds(
  index: VectorReader,
  ids: string[],
  { namespace = 'document' }: { namespace?: string } = {}
): Promise<Map<string, Float32Array>> {
  const batches: string[][] = []
  for (let i = 0; i < ids.length; i += GET_BY_IDS_BATCH) batches.push(ids.slice(i, i + GET_BY_IDS_BATCH))
  const results = await mapLimit(batches, GET_BY_IDS_CONCURRENCY, (batch) => index.getByIds(batch, { namespace }))
  const out = new Map<string, Float32Array>()
  for (const result of results) {
    for (const v of result) {
      if (v?.values && v.values.length) out.set(v.id, v.values instanceof Float32Array ? v.values : Float32Array.from(v.values))
    }
  }
  return out
}

export const VECTOR_FRAME_CONTENT_TYPE = 'application/vnd.tong.vectors'

/**
 * Binary request body for the container's /reduce (container/app.py
 * parse_vector_frame):
 *
 *   u32 LE  header length H
 *   H bytes UTF-8 JSON header: {count, dim, ...meta}
 *   0-3     zero bytes padding to a 4-byte boundary
 *   count * dim float32 LE, row-major
 *
 * About a fifth the size of the same vectors as JSON numbers, and the Worker
 * never builds the JSON string.
 */
export function encodeVectorFrame(rows: ArrayLike<number>[], meta: Record<string, unknown> = {}): Uint8Array {
  const dim = rows.length ? rows[0].length : 0
  const header = new TextEncoder().encode(JSON.stringify({ ...meta, count: rows.length, dim }))
  const offset = 4 + header.length + ((4 - ((4 + header.length) % 4)) % 4)
  const buffer = new ArrayBuffer(offset + rows.length * dim * 4)
  new DataView(buffer).setUint32(0, header.length, true)
  const bytes = new Uint8Array(buffer)
  bytes.set(header, 4)
  // Float32Array uses platform byte order; Workers (and every target we run on) are little-endian.
  const floats = new Float32Array(buffer, offset, rows.length * dim)
  rows.forEach((row, i) => {
    if (row.length !== dim) throw new Error(`vector ${i} has ${row.length} dims, expected ${dim}`)
    floats.set(row, i * dim)
  })
  return bytes
}
