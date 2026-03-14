import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers'
import { extractCedictZip, parseCedictText, type CedictEntry, type CedictMeta } from '../lib/cedict'

const CEDICT_URL = 'https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.zip'

// How many entries to store per R2 chunk file and process per workflow step.
// At avg ~4 definitions/entry, each step makes ~300 D1 batch subrequests — well under the 1000 limit.
const CHUNK_SIZE = 5000

// D1 batch() limit: 100 statements per call
const D1_BATCH_SIZE = 100

interface RefreshCedictParams {
  jobId: string
}

interface ChunkMeta {
  chunkCount: number
  meta: CedictMeta
}

export class RefreshCedictWorkflow extends WorkflowEntrypoint<Env, RefreshCedictParams> {
  async run(event: WorkflowEvent<RefreshCedictParams>, step: WorkflowStep) {
    const { jobId } = event.payload

    // Step 1: Fetch the CEDICT zip, parse it, and store entry chunks in R2.
    const { chunkCount, meta } = await step.do(
      'fetch-and-chunk',
      async (): Promise<ChunkMeta> => {
        const response = await fetch(CEDICT_URL, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
          },
        })
        if (!response.ok) throw new Error(`CEDICT fetch failed: ${response.status}`)

        const buffer = await response.arrayBuffer()
        const text = extractCedictZip(buffer)
        const { entries, meta } = parseCedictText(text)

        // Record total in the job row
        await this.env.DB.prepare(
          `UPDATE dictionary_refresh_job SET total_entries = ?, epoch = ? WHERE id = ?`
        )
          .bind(entries.length, meta.epoch, jobId)
          .run()

        // Split entries into chunks and store each as a JSON file in R2
        const chunkCount = Math.ceil(entries.length / CHUNK_SIZE)
        await Promise.all(
          Array.from({ length: chunkCount }, async (_, i) => {
            const chunk = entries.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)
            await this.env.DOCUMENTS.put(
              `cedict-refresh/${jobId}/chunk-${i}.json`,
              JSON.stringify(chunk),
              { httpMetadata: { contentType: 'application/json' } }
            )
          })
        )

        return { chunkCount, meta }
      }
    )

    // Steps 2–N: Process each chunk sequentially to avoid D1 write contention.
    for (let i = 0; i < chunkCount; i++) {
      await step.do(`process-chunk-${i}`, async () => {
        const r2Key = `cedict-refresh/${jobId}/chunk-${i}.json`
        const obj = await this.env.DOCUMENTS.get(r2Key)
        if (!obj) throw new Error(`Chunk file not found: ${r2Key}`)

        const entries: CedictEntry[] = await obj.json()
        await processChunk(entries, meta, this.env)

        // Update progress
        await this.env.DB.prepare(
          `UPDATE dictionary_refresh_job SET processed_entries = processed_entries + ? WHERE id = ?`
        )
          .bind(entries.length, jobId)
          .run()

        // Clean up the chunk file
        await this.env.DOCUMENTS.delete(r2Key)
      })
    }

    // Final step: mark job complete.
    await step.do('finalize', async () => {
      await this.env.DB.prepare(
        `UPDATE dictionary_refresh_job SET status = 'completed', completed_at = datetime('now') WHERE id = ?`
      )
        .bind(jobId)
        .run()
    })
  }
}

async function processChunk(entries: CedictEntry[], meta: CedictMeta, env: Env): Promise<void> {
  for (let i = 0; i < entries.length; i += D1_BATCH_SIZE) {
    const batch = entries.slice(i, i + D1_BATCH_SIZE)

    // Phase 1: Look up any existing cedict entry for each headword in this batch.
    const lookupResults = await env.DB.batch<{ id: number }>(
      batch.map((e) =>
        env.DB
          .prepare(
            `SELECT id FROM dictionary_entry
             WHERE traditional = ? AND simplified = ? AND pinyin = ? AND source LIKE 'cedict:%'`
          )
          .bind(e.traditional, e.simplified, e.pinyin)
      )
    )

    const existingIds: (number | null)[] = lookupResults.map((r) => r.results[0]?.id ?? null)
    const existingIdList = existingIds.filter((id): id is number => id !== null)

    // Phase 2: Fetch current definitions for all existing entries so we can compare.
    const defLookupResults =
      existingIdList.length > 0
        ? await env.DB.batch<{ definition: string }>(
            existingIdList.map((id) =>
              env.DB
                .prepare(
                  `SELECT definition FROM dictionary_definition WHERE entry_id = ? ORDER BY sort_order ASC`
                )
                .bind(id)
            )
          )
        : []

    // Map entry id → '\0'-joined definition string for easy equality check.
    const existingDefsById = new Map<number, string>()
    existingIdList.forEach((id, k) => {
      existingDefsById.set(id, defLookupResults[k].results.map((r) => r.definition).join('\0'))
    })

    // Phase 3: Classify each entry.
    //   toInsert  — new (trad, simp, pinyin), never seen before
    //   toUpdate  — existing entry whose definitions changed; gets a new source epoch
    //   toTouch   — existing entry, definitions unchanged; only last_seen_epoch is updated
    const toInsert: number[] = []
    const toUpdate: { j: number; id: number }[] = []
    const toTouch:  number[] = []    // entry IDs

    for (let j = 0; j < batch.length; j++) {
      const existingId = existingIds[j]
      if (existingId === null) {
        toInsert.push(j)
      } else {
        const newDefs = batch[j].definitions.join('\0')
        if (existingDefsById.get(existingId) !== newDefs) {
          toUpdate.push({ j, id: existingId })
        } else {
          toTouch.push(existingId)
        }
      }
    }

    // Phase 4: INSERT genuinely new entries.
    const insertedIds: (number | null)[] = new Array(batch.length).fill(null)
    if (toInsert.length > 0) {
      const insertResults = await env.DB.batch<{ id: number }>(
        toInsert.map((j) =>
          env.DB
            .prepare(
              `INSERT INTO dictionary_entry
                 (traditional, simplified, pinyin, source, last_seen_epoch, created_at, last_updated)
               VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
               RETURNING id`
            )
            .bind(batch[j].traditional, batch[j].simplified, batch[j].pinyin, meta.source, meta.epoch, meta.date)
        )
      )
      toInsert.forEach((j, k) => {
        insertedIds[j] = insertResults[k].results[0]?.id ?? null
      })
    }

    // Phase 5: UPDATE source + last_seen_epoch for entries whose definitions changed.
    for (let j = 0; j < toUpdate.length; j += D1_BATCH_SIZE) {
      await env.DB.batch(
        toUpdate.slice(j, j + D1_BATCH_SIZE).map(({ id }) =>
          env.DB
            .prepare(
              `UPDATE dictionary_entry SET source = ?, last_updated = ?, last_seen_epoch = ? WHERE id = ?`
            )
            .bind(meta.source, meta.date, meta.epoch, id)
        )
      )
    }

    // Phase 6: UPDATE only last_seen_epoch for unchanged entries (content stays as-is).
    for (let j = 0; j < toTouch.length; j += D1_BATCH_SIZE) {
      await env.DB.batch(
        toTouch.slice(j, j + D1_BATCH_SIZE).map((id) =>
          env.DB.prepare(`UPDATE dictionary_entry SET last_seen_epoch = ? WHERE id = ?`).bind(meta.epoch, id)
        )
      )
    }

    // Phase 7: Clear old definitions and FTS for entries whose definitions changed.
    for (let j = 0; j < toUpdate.length; j += D1_BATCH_SIZE) {
      const slice = toUpdate.slice(j, j + D1_BATCH_SIZE)
      await env.DB.batch(slice.map(({ id }) =>
        env.DB.prepare(`DELETE FROM dictionary_definition WHERE entry_id = ?`).bind(id)
      ))
      await env.DB.batch(slice.map(({ id }) =>
        env.DB.prepare(`DELETE FROM dictionary_fts WHERE rowid = ?`).bind(id)
      ))
    }

    // Phase 8: Insert fresh definitions and FTS for new entries and those with changed definitions.
    const defStatements: D1PreparedStatement[] = []
    const ftsStatements: D1PreparedStatement[] = []

    const activeEntries = [
      ...toInsert.map((j) => ({ j, id: insertedIds[j] })),
      ...toUpdate.map(({ j, id }) => ({ j, id })),
    ]

    for (const { j, id } of activeEntries) {
      if (!id) continue
      const entry = batch[j]

      for (let k = 0; k < entry.definitions.length; k++) {
        defStatements.push(
          env.DB
            .prepare(`INSERT INTO dictionary_definition (entry_id, definition, sort_order) VALUES (?, ?, ?)`)
            .bind(id, entry.definitions[k], k)
        )
      }

      ftsStatements.push(
        env.DB
          .prepare(
            `INSERT INTO dictionary_fts (rowid, simplified, traditional, pinyin, definitions_text)
             VALUES (?, ?, ?, ?, ?)`
          )
          .bind(id, entry.simplified, entry.traditional, entry.pinyin, entry.definitions.join(' '))
      )
    }

    for (let j = 0; j < defStatements.length; j += D1_BATCH_SIZE) {
      await env.DB.batch(defStatements.slice(j, j + D1_BATCH_SIZE))
    }
    for (let j = 0; j < ftsStatements.length; j += D1_BATCH_SIZE) {
      await env.DB.batch(ftsStatements.slice(j, j + D1_BATCH_SIZE))
    }
  }
}
