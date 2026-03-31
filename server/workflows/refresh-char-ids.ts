import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers'
import { parseIdsFile, parseIds, IDS_OPERATORS, type CharIdsLine, type IdsNode } from '../lib/ids-parser'

const IDS_URL = 'https://raw.githubusercontent.com/cjkvi/cjkvi-ids/refs/heads/master/ids.txt'
const CHUNK_SIZE = 1000
const D1_BATCH_SIZE = 100

interface RefreshCharIdsParams {
  jobId: string
}

interface FetchAndChunkResult {
  chunkCount: number
  totalChars: number
}

export class RefreshCharIdsWorkflow extends WorkflowEntrypoint<Env, RefreshCharIdsParams> {
  async run(event: WorkflowEvent<RefreshCharIdsParams>, step: WorkflowStep) {
    const { jobId } = event.payload

    // Step 1: Fetch IDS file, parse, split into chunks, store in R2.
    const { chunkCount, totalChars } = await step.do(
      'fetch-and-chunk',
      async (): Promise<FetchAndChunkResult> => {
        const response = await fetch(IDS_URL)
        if (!response.ok) throw new Error(`IDS fetch failed: ${response.status}`)

        const text = await response.text()
        const lines = parseIdsFile(text)
        const totalChars = lines.length

        await this.env.DB.prepare(
          `UPDATE char_ids_refresh_job SET total_chars = ? WHERE id = ?`
        )
          .bind(totalChars, jobId)
          .run()

        const chunkCount = Math.ceil(lines.length / CHUNK_SIZE)
        await Promise.all(
          Array.from({ length: chunkCount }, async (_, i) => {
            const chunk = lines.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)
            await this.env.DOCUMENTS.put(
              `char-ids-refresh/${jobId}/chunk-${i}.json`,
              JSON.stringify(chunk),
              { httpMetadata: { contentType: 'application/json' } }
            )
          })
        )

        return { chunkCount, totalChars }
      }
    )

    // Step 2: Clear all existing IDS data atomically.
    await step.do('clear-existing', async () => {
      await this.env.DB.batch([
        this.env.DB.prepare(`DELETE FROM char_ids_node_link`),
        this.env.DB.prepare(`DELETE FROM char_ids_node`),
        this.env.DB.prepare(`DELETE FROM char_ids`),
      ])
    })

    // Steps 3..N: Create nodes for each chunk.
    for (let i = 0; i < chunkCount; i++) {
      await step.do(`create-nodes-${i}`, async () => {
        const r2Key = `char-ids-refresh/${jobId}/chunk-${i}.json`
        const obj = await this.env.DOCUMENTS.get(r2Key)
        if (!obj) throw new Error(`Chunk file not found: ${r2Key}`)

        const lines: CharIdsLine[] = await obj.json()
        await createNodesForChunk(lines, this.env)

        await this.env.DB.prepare(
          `UPDATE char_ids_refresh_job SET processed_chars = processed_chars + ? WHERE id = ?`
        )
          .bind(lines.length, jobId)
          .run()
      })
    }

    // Step N+1: Build and store the representative node map (char → root_node_ids).
    await step.do('build-rep-map', async () => {
      const { results } = await this.env.DB.prepare(
        `SELECT character, root_node_id FROM char_ids WHERE obsolete = 0 AND root_node_id IS NOT NULL`
      ).all<{ character: string; root_node_id: number }>()

      const repMap: Record<string, number[]> = {}
      for (const row of results) {
        if (!repMap[row.character]) repMap[row.character] = []
        repMap[row.character].push(row.root_node_id)
      }

      await this.env.DOCUMENTS.put(
        `char-ids-refresh/${jobId}/rep-map.json`,
        JSON.stringify(repMap),
        { httpMetadata: { contentType: 'application/json' } }
      )
    })

    // Steps N+2..M: Build edges for each chunk.
    for (let i = 0; i < chunkCount; i++) {
      await step.do(`build-edges-${i}`, async () => {
        const repMapObj = await this.env.DOCUMENTS.get(`char-ids-refresh/${jobId}/rep-map.json`)
        if (!repMapObj) throw new Error('Rep map not found')
        const repMap: Record<string, number[]> = await repMapObj.json()

        const r2Key = `char-ids-refresh/${jobId}/chunk-${i}.json`
        const chunkObj = await this.env.DOCUMENTS.get(r2Key)
        if (!chunkObj) throw new Error(`Chunk file not found: ${r2Key}`)
        const lines: CharIdsLine[] = await chunkObj.json()

        await buildEdgesForChunk(lines, repMap, this.env)
      })
    }

    // Final step: mark complete and clean up R2 artifacts.
    await step.do('finalize', async () => {
      await this.env.DB.prepare(
        `UPDATE char_ids_refresh_job SET status = 'completed', completed_at = datetime('now') WHERE id = ?`
      )
        .bind(jobId)
        .run()

      // Clean up all R2 artifacts
      const deletePromises: Promise<void>[] = []
      for (let i = 0; i < chunkCount; i++) {
        deletePromises.push(this.env.DOCUMENTS.delete(`char-ids-refresh/${jobId}/chunk-${i}.json`))
      }
      deletePromises.push(this.env.DOCUMENTS.delete(`char-ids-refresh/${jobId}/rep-map.json`))
      await Promise.all(deletePromises)
    })
  }
}

// ── Node creation ─────────────────────────────────────────────────────────────

async function createNodesForChunk(lines: CharIdsLine[], env: Env): Promise<void> {
  for (let i = 0; i < lines.length; i += D1_BATCH_SIZE) {
    const batch = lines.slice(i, i + D1_BATCH_SIZE)
    await createNodesBatch(batch, env)
  }
}

async function createNodesBatch(lines: CharIdsLine[], env: Env): Promise<void> {
  const nodeInserts: D1PreparedStatement[] = []
  const charIdsInserts: D1PreparedStatement[] = []

  for (const line of lines) {
    if (line.decompositions.length === 0) {
      // Atomic character: insert a 'char' node and one char_ids row
      nodeInserts.push(
        env.DB.prepare(
          `INSERT INTO char_ids_node (node_type, character) VALUES ('char', ?) RETURNING id`
        ).bind(line.character)
      )
    } else {
      // Non-atomic: insert one 'op' node per non-obsolete variant
      for (const decomp of line.decompositions) {
        if (!decomp.obsolete && decomp.idsString) {
          const rootOp = Array.from(decomp.idsString)[0]
          if (IDS_OPERATORS[rootOp] !== undefined) {
            nodeInserts.push(
              env.DB.prepare(
                `INSERT INTO char_ids_node (node_type, operator) VALUES ('op', ?) RETURNING id`
              ).bind(rootOp)
            )
          }
        }
      }
    }
  }

  if (nodeInserts.length === 0) return

  // Execute node inserts in batches
  const allNodeIds: number[] = []
  for (let i = 0; i < nodeInserts.length; i += D1_BATCH_SIZE) {
    const batchResults = await env.DB.batch<{ id: number }>(nodeInserts.slice(i, i + D1_BATCH_SIZE))
    for (const r of batchResults) {
      allNodeIds.push(r.results[0]?.id ?? 0)
    }
  }

  // Now build char_ids insert statements with the node IDs
  let nodeIdIndex = 0
  for (const line of lines) {
    if (line.decompositions.length === 0) {
      // Atomic char
      const nodeId = allNodeIds[nodeIdIndex++]
      charIdsInserts.push(
        env.DB.prepare(
          `INSERT INTO char_ids (codepoint, character, ids_string, tags, obsolete, root_node_id) VALUES (?, ?, NULL, NULL, 0, ?)`
        ).bind(line.codepoint, line.character, nodeId)
      )
    } else {
      for (const decomp of line.decompositions) {
        if (!decomp.obsolete && decomp.idsString) {
          const rootOp = Array.from(decomp.idsString)[0]
          if (IDS_OPERATORS[rootOp] !== undefined) {
            const nodeId = allNodeIds[nodeIdIndex++]
            charIdsInserts.push(
              env.DB.prepare(
                `INSERT INTO char_ids (codepoint, character, ids_string, tags, obsolete, root_node_id) VALUES (?, ?, ?, ?, 0, ?)`
              ).bind(line.codepoint, line.character, decomp.idsString, decomp.tags, nodeId)
            )
          } else {
            // IDS string doesn't start with an operator (unusual) — store without node
            charIdsInserts.push(
              env.DB.prepare(
                `INSERT INTO char_ids (codepoint, character, ids_string, tags, obsolete, root_node_id) VALUES (?, ?, ?, ?, 0, NULL)`
              ).bind(line.codepoint, line.character, decomp.idsString, decomp.tags)
            )
          }
        } else if (decomp.obsolete) {
          // Obsolete variants: store with root_node_id=NULL
          charIdsInserts.push(
            env.DB.prepare(
              `INSERT INTO char_ids (codepoint, character, ids_string, tags, obsolete, root_node_id) VALUES (?, ?, ?, ?, 1, NULL)`
            ).bind(line.codepoint, line.character, decomp.idsString, decomp.tags)
          )
        }
      }
    }
  }

  for (let i = 0; i < charIdsInserts.length; i += D1_BATCH_SIZE) {
    await env.DB.batch(charIdsInserts.slice(i, i + D1_BATCH_SIZE))
  }
}

// ── Edge building ─────────────────────────────────────────────────────────────

async function buildEdgesForChunk(
  lines: CharIdsLine[],
  repMap: Record<string, number[]>,
  env: Env
): Promise<void> {
  // Batch-query root_node_ids for all codepoints in this chunk
  const codepoints = lines.map((l) => l.codepoint)
  const rootNodeMap = new Map<string, Map<string, number>>() // codepoint → idsString → root_node_id

  for (let i = 0; i < codepoints.length; i += 90) {
    const slice = codepoints.slice(i, i + 90)
    const ph = slice.map(() => '?').join(', ')
    const { results } = await env.DB.prepare(
      `SELECT codepoint, ids_string, root_node_id FROM char_ids WHERE codepoint IN (${ph}) AND obsolete = 0 AND root_node_id IS NOT NULL`
    )
      .bind(...slice)
      .all<{ codepoint: string; ids_string: string | null; root_node_id: number }>()

    for (const row of results) {
      if (!rootNodeMap.has(row.codepoint)) rootNodeMap.set(row.codepoint, new Map())
      const key = row.ids_string ?? ''
      rootNodeMap.get(row.codepoint)!.set(key, row.root_node_id)
    }
  }

  // Process each line's decompositions
  for (const line of lines) {
    if (line.decompositions.length === 0) continue

    for (const decomp of line.decompositions) {
      if (decomp.obsolete || !decomp.idsString) continue

      const rootNodeId = rootNodeMap.get(line.codepoint)?.get(decomp.idsString)
      if (!rootNodeId) continue

      const tree = parseIds(decomp.idsString)
      if (!tree || tree.type !== 'op') continue

      // DFS to build edges; inline op nodes are inserted sequentially
      await buildEdgesDfs(rootNodeId, tree, repMap, env)
    }
  }
}

async function buildEdgesDfs(
  parentId: number,
  node: IdsNode,
  repMap: Record<string, number[]>,
  env: Env
): Promise<void> {
  if (!node.children) return

  const linkBatch: D1PreparedStatement[] = []

  for (let pos = 0; pos < node.children.length; pos++) {
    const child = node.children[pos]

    if (child.type === 'char') {
      // Look up all representative node IDs for this character
      const repIds = repMap[child.character!] ?? []
      for (const repId of repIds) {
        linkBatch.push(
          env.DB.prepare(
            `INSERT OR IGNORE INTO char_ids_node_link (parent_id, child_id, position) VALUES (?, ?, ?)`
          ).bind(parentId, repId, pos)
        )
      }
      // If no rep IDs, we can't link (component not in dataset)
    } else if (child.type === 'unencoded') {
      // Insert an unencoded node and link it
      const result = await env.DB.prepare(
        `INSERT INTO char_ids_node (node_type, stroke_count) VALUES ('unencoded', ?) RETURNING id`
      )
        .bind(child.strokeCount!)
        .first<{ id: number }>()

      if (result) {
        linkBatch.push(
          env.DB.prepare(
            `INSERT OR IGNORE INTO char_ids_node_link (parent_id, child_id, position) VALUES (?, ?, ?)`
          ).bind(parentId, result.id, pos)
        )
      }
    } else if (child.type === 'op') {
      // Inline op node: insert it, link it, then recurse
      const result = await env.DB.prepare(
        `INSERT INTO char_ids_node (node_type, operator) VALUES ('op', ?) RETURNING id`
      )
        .bind(child.operator!)
        .first<{ id: number }>()

      if (result) {
        linkBatch.push(
          env.DB.prepare(
            `INSERT OR IGNORE INTO char_ids_node_link (parent_id, child_id, position) VALUES (?, ?, ?)`
          ).bind(parentId, result.id, pos)
        )
        // Flush current batch before recursing so parent IDs exist
        if (linkBatch.length >= D1_BATCH_SIZE) {
          await env.DB.batch(linkBatch.splice(0, linkBatch.length))
        }
        await buildEdgesDfs(result.id, child, repMap, env)
      }
    }
  }

  // Flush remaining links
  for (let i = 0; i < linkBatch.length; i += D1_BATCH_SIZE) {
    await env.DB.batch(linkBatch.slice(i, i + D1_BATCH_SIZE))
  }
}
