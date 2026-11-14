// Re-embed chunks into CHUNK_VECTORS with the current embedding model. Needed
// whenever EMBEDDING_VERSION (model, dimensions or prompt scheme) changes:
// vectors from different models aren't comparable, so stale ones make semantic
// search and similar-chunk lookup return noise.
//
// Two entry points:
// - reembedDocument: manual, whole document, recorded as an enrichment run
//   (POST /api/library/document/:id/reembed, POST /api/library/reembed).
// - reembedStaleChunks: the low-priority cron sweep (server/index.ts
//   `scheduled`), a small batch of stale chunks per tick across all documents.

import {
  embedAndStoreChunks,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  EMBEDDING_VERSION,
  type ChunkToEmbed,
} from './embedding'
import { completeEnrichmentRun, failEnrichmentRun, startEnrichmentRun } from './enrichment-run'

// Per Workers AI call: at most this many chunks, and at most this many
// characters in total. Inputs may share the model's 8,192-token context and a
// Chinese character is roughly one token, so the character budget is what
// actually bounds a batch; a single oversized chunk goes alone.
export const REEMBED_BATCH_SIZE = 16
export const REEMBED_BATCH_CHARS = 4000
// Chunks per cron tick. Small on purpose: this is background catch-up work and
// shouldn't compete with ingestion for Workers AI capacity.
export const SWEEP_CHUNKS_PER_TICK = 64

export interface ReembedResult {
  documentId: number
  chunksEmbedded: number
}

export function batchChunks(chunks: ChunkToEmbed[]): ChunkToEmbed[][] {
  const batches: ChunkToEmbed[][] = []
  let current: ChunkToEmbed[] = []
  let chars = 0
  for (const c of chunks) {
    const full = current.length >= REEMBED_BATCH_SIZE
    if (current.length > 0 && (full || chars + c.content.length > REEMBED_BATCH_CHARS)) {
      batches.push(current)
      current = []
      chars = 0
    }
    current.push(c)
    chars += c.content.length
  }
  if (current.length > 0) batches.push(current)
  return batches
}

async function embedInBatches(env: Env, chunks: ChunkToEmbed[]): Promise<void> {
  for (const batch of batchChunks(chunks)) await embedAndStoreChunks(env, batch)
}

export async function reembedDocument(env: Env, documentId: number): Promise<ReembedResult> {
  const chunks = await env.DB.prepare(
    `SELECT id, source_document_id AS documentId, content
     FROM text_chunk WHERE source_document_id = ? ORDER BY chunk_order`
  )
    .bind(documentId)
    .all<ChunkToEmbed>()

  const runId = await startEnrichmentRun(env.DB, {
    documentId,
    kind: 'chunk_embedding',
    model: EMBEDDING_MODEL,
    params: {
      chunk_count: chunks.results.length,
      dimensions: EMBEDDING_DIMENSIONS,
      trigger: 'manual_reembed',
    },
    ontology: [],
  })

  try {
    await embedInBatches(env, chunks.results)
  } catch (err) {
    await failEnrichmentRun(env.DB, runId, err instanceof Error ? err.message : String(err))
    throw err
  }

  await completeEnrichmentRun(env.DB, runId, { chunks_embedded: chunks.results.length })
  return { documentId, chunksEmbedded: chunks.results.length }
}

export interface SweepResult {
  chunksEmbedded: number
  /** Chunks that failed this tick even when embedded on their own. */
  chunksFailed: number
  /** Stale chunks left after this tick (0 = fully caught up). */
  remaining: number
}

export async function reembedStaleChunks(
  env: Env,
  limit = SWEEP_CHUNKS_PER_TICK
): Promise<SweepResult> {
  const stale = await env.DB.prepare(
    `SELECT id, source_document_id AS documentId, content
     FROM text_chunk
     WHERE embedding_version IS NULL OR embedding_version != ?
     ORDER BY id
     LIMIT ?`
  )
    .bind(EMBEDDING_VERSION, limit)
    .all<ChunkToEmbed>()

  // A failing batch is retried chunk by chunk, so one bad chunk can't keep the
  // healthy chunks it was batched with stale (the sweep always starts from the
  // lowest stale id). Chunks that still fail are left stale for the next tick.
  const tryEmbed = async (chunks: ChunkToEmbed[]): Promise<boolean> => {
    try {
      await embedAndStoreChunks(env, chunks)
      return true
    } catch (err) {
      if (chunks.length === 1) console.warn(`[reembed] chunk ${chunks[0].id} failed`, err)
      return false
    }
  }

  let chunksEmbedded = 0
  let chunksFailed = 0
  for (const batch of batchChunks(stale.results)) {
    if (await tryEmbed(batch)) {
      chunksEmbedded += batch.length
    } else if (batch.length === 1) {
      chunksFailed++
    } else {
      for (const chunk of batch) {
        if (await tryEmbed([chunk])) chunksEmbedded++
        else chunksFailed++
      }
    }
  }

  const left = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM text_chunk
     WHERE embedding_version IS NULL OR embedding_version != ?`
  )
    .bind(EMBEDDING_VERSION)
    .first<{ n: number }>()

  return { chunksEmbedded, chunksFailed, remaining: left?.n ?? 0 }
}
