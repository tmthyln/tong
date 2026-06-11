import { Hono } from 'hono'
import {
  extractEntitiesForNodeTypesWithUsage,
  removeOverlaps,
  type NodeTypeInput,
  type NodeTypeExtractionRun,
} from '../lib/entity-extraction'
import {
  extractRelationshipsForEdgeTypeWithUsage,
  RELATIONSHIP_EXTRACTION_MODEL,
  type EdgeTypeInput,
  type EdgeTypeExtractionRun,
} from '../lib/relationship-extraction'

const devEvalRoutes = new Hono<{ Bindings: Env }>()

interface InitBody {
  count?: number
  chunkIds?: number[]
  minChunkLength?: number
}

interface ChunkBody {
  chunkId: number
  content: string
  nodeTypes: NodeTypeInput[]
  maxCompletionTokensThinking?: number
  maxCompletionTokensInstant?: number
}

interface ModeResult {
  mode: 'thinking' | 'instant'
  runs: NodeTypeExtractionRun[]
  totalEntities: number
  dedupedEntities: number
  totalLatencyMs: number
  totalPromptTokens: number
  totalCompletionTokens: number
  nullContentCount: number
  lengthFinishCount: number
}

interface ChunkResult {
  chunkId: number
  content: string
  thinking: ModeResult
  instant: ModeResult
}

function summarize(mode: 'thinking' | 'instant', runs: NodeTypeExtractionRun[]): ModeResult {
  const allEntities = runs.flatMap(r => r.entities)
  return {
    mode,
    runs,
    totalEntities: allEntities.length,
    dedupedEntities: removeOverlaps(allEntities).length,
    totalLatencyMs: runs.reduce((s, r) => s + r.latencyMs, 0),
    totalPromptTokens: runs.reduce((s, r) => s + r.usage.promptTokens, 0),
    totalCompletionTokens: runs.reduce((s, r) => s + r.usage.completionTokens, 0),
    nullContentCount: runs.filter(r => r.rawContent === null).length,
    lengthFinishCount: runs.filter(r => r.finishReason === 'length').length,
  }
}

// Step 1: sample chunks and load node types.
devEvalRoutes.post('/entity-extraction/init', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as InitBody
  const count = body.count ?? 8
  const minLen = body.minChunkLength ?? 100

  let chunks: Array<{ id: number; content: string }>
  if (body.chunkIds && body.chunkIds.length > 0) {
    const placeholders = body.chunkIds.map(() => '?').join(',')
    const rows = await c.env.DB.prepare(
      `SELECT id, content FROM text_chunk WHERE id IN (${placeholders})`,
    ).bind(...body.chunkIds).all<{ id: number; content: string }>()
    chunks = rows.results
  } else {
    const rows = await c.env.DB.prepare(
      'SELECT id, content FROM text_chunk WHERE LENGTH(content) > ? ORDER BY RANDOM() LIMIT ?',
    ).bind(minLen, count).all<{ id: number; content: string }>()
    chunks = rows.results
  }

  const nodeTypesResult = await c.env.DB.prepare(
    'SELECT name, definition, examples_json FROM node_type WHERE is_current = 1 ORDER BY name',
  ).all<{ name: string; definition: string; examples_json: string }>()

  const parseExamples = (json: string): string[] => {
    try {
      const v = JSON.parse(json)
      return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []
    } catch {
      return []
    }
  }
  const nodeTypes: NodeTypeInput[] = nodeTypesResult.results.map((t) => ({
    name: t.name,
    definition: t.definition,
    examples: parseExamples(t.examples_json),
  }))

  return c.json({
    model: '@cf/moonshotai/kimi-k2.6',
    chunks,
    nodeTypes,
  })
})

// Step 2: run one chunk's two modes. Client calls this once per chunk.
devEvalRoutes.post('/entity-extraction/chunk', async (c) => {
  const body = (await c.req.json()) as ChunkBody
  const maxTokThinking = body.maxCompletionTokensThinking ?? 8192
  const maxTokInstant = body.maxCompletionTokensInstant ?? 1024

  const [instantRuns, thinkingRuns] = await Promise.all([
    extractEntitiesForNodeTypesWithUsage(body.content, body.nodeTypes, c.env, {
      thinking: false,
      maxCompletionTokens: maxTokInstant,
    }),
    extractEntitiesForNodeTypesWithUsage(body.content, body.nodeTypes, c.env, {
      thinking: true,
      maxCompletionTokens: maxTokThinking,
    }),
  ])

  const data: ChunkResult = {
    chunkId: body.chunkId,
    content: body.content,
    instant: summarize('instant', instantRuns),
    thinking: summarize('thinking', thinkingRuns),
  }
  return c.json(data)
})

// ── Relationship extraction evaluation ──────────────────────

interface RelInitBody {
  count?: number
  chunkIds?: number[]
  minEntities?: number
}

interface ChunkWithEntities {
  id: number
  content: string
  entities: Array<{ nodeType: string; text: string }>
}

interface RelChunkBody {
  chunkId: number
  content: string
  entities: Array<{ nodeType: string; text: string }>
  edgeTypes: EdgeTypeInput[]
  maxCompletionTokensThinking?: number
  maxCompletionTokensInstant?: number
}

interface RelModeResult {
  mode: 'thinking' | 'instant'
  runs: EdgeTypeExtractionRun[]
  totalRelationships: number
  totalLatencyMs: number
  totalPromptTokens: number
  totalCompletionTokens: number
  nullContentCount: number
  lengthFinishCount: number
}

interface RelChunkResult {
  chunkId: number
  content: string
  entities: Array<{ nodeType: string; text: string }>
  thinking: RelModeResult
  instant: RelModeResult
}

function summarizeRel(mode: 'thinking' | 'instant', runs: EdgeTypeExtractionRun[]): RelModeResult {
  const allRels = runs.flatMap((r) => r.relationships)
  return {
    mode,
    runs,
    totalRelationships: allRels.length,
    totalLatencyMs: runs.reduce((s, r) => s + r.latencyMs, 0),
    totalPromptTokens: runs.reduce((s, r) => s + r.usage.promptTokens, 0),
    totalCompletionTokens: runs.reduce((s, r) => s + r.usage.completionTokens, 0),
    nullContentCount: runs.filter((r) => r.rawContent === null).length,
    lengthFinishCount: runs.filter((r) => r.finishReason === 'length').length,
  }
}

// Step 1: sample chunks that already have ≥minEntities extracted entities,
// load their entities + the edge type ontology.
devEvalRoutes.post('/relationship-extraction/init', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as RelInitBody
  const count = body.count ?? 8
  const minEntities = body.minEntities ?? 2

  let chunkIds: number[]
  if (body.chunkIds && body.chunkIds.length > 0) {
    chunkIds = body.chunkIds
  } else {
    // Pick chunks that have at least minEntities extracted chunk-scope entities.
    const rows = await c.env.DB.prepare(
      `SELECT source_chunk_id AS id FROM extracted_entity
       WHERE scope = 'chunk' AND extracted_text IS NOT NULL
       GROUP BY source_chunk_id
       HAVING COUNT(*) >= ?
       ORDER BY RANDOM()
       LIMIT ?`
    )
      .bind(minEntities, count)
      .all<{ id: number }>()
    chunkIds = rows.results.map((r) => r.id)
  }

  if (chunkIds.length === 0) {
    return c.json({ model: RELATIONSHIP_EXTRACTION_MODEL, chunks: [], edgeTypes: [] })
  }

  const placeholders = chunkIds.map(() => '?').join(',')
  const [contentRows, entityRows, edgeTypeRows] = await Promise.all([
    c.env.DB.prepare(`SELECT id, content FROM text_chunk WHERE id IN (${placeholders})`)
      .bind(...chunkIds)
      .all<{ id: number; content: string }>(),
    c.env.DB.prepare(
      `SELECT source_chunk_id, entity_type, extracted_text FROM extracted_entity
       WHERE source_chunk_id IN (${placeholders}) AND scope = 'chunk' AND extracted_text IS NOT NULL`
    )
      .bind(...chunkIds)
      .all<{ source_chunk_id: number; entity_type: string; extracted_text: string }>(),
    c.env.DB.prepare(
      'SELECT name, reverse_name, definition, examples_json FROM edge_type WHERE is_current = 1 ORDER BY name'
    ).all<{
      name: string
      reverse_name: string | null
      definition: string
      examples_json: string
    }>(),
  ])

  const parseExamples = (json: string): string[] => {
    try {
      const v = JSON.parse(json)
      return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []
    } catch {
      return []
    }
  }
  const edgeTypes: EdgeTypeInput[] = edgeTypeRows.results.map((t) => ({
    name: t.name,
    reverseName: t.reverse_name,
    definition: t.definition,
    examples: parseExamples(t.examples_json),
  }))

  const entitiesByChunk = new Map<number, Array<{ nodeType: string; text: string }>>()
  for (const e of entityRows.results) {
    const arr = entitiesByChunk.get(e.source_chunk_id) ?? []
    arr.push({ nodeType: e.entity_type, text: e.extracted_text })
    entitiesByChunk.set(e.source_chunk_id, arr)
  }

  const chunks: ChunkWithEntities[] = contentRows.results.map((r) => ({
    id: r.id,
    content: r.content,
    entities: entitiesByChunk.get(r.id) ?? [],
  }))

  return c.json({ model: RELATIONSHIP_EXTRACTION_MODEL, chunks, edgeTypes })
})

// Step 2: run one chunk's two modes (thinking vs instant) for all edge types.
devEvalRoutes.post('/relationship-extraction/chunk', async (c) => {
  const body = (await c.req.json()) as RelChunkBody
  const maxTokThinking = body.maxCompletionTokensThinking ?? 8192
  const maxTokInstant = body.maxCompletionTokensInstant ?? 2048

  const runOne = (thinking: boolean, maxCompletionTokens: number) =>
    Promise.all(
      body.edgeTypes.map((edgeType) =>
        extractRelationshipsForEdgeTypeWithUsage(
          body.content,
          body.entities,
          edgeType,
          c.env,
          { thinking, maxCompletionTokens }
        )
      )
    )

  const [instantRuns, thinkingRuns] = await Promise.all([
    runOne(false, maxTokInstant),
    runOne(true, maxTokThinking),
  ])

  const data: RelChunkResult = {
    chunkId: body.chunkId,
    content: body.content,
    entities: body.entities,
    instant: summarizeRel('instant', instantRuns),
    thinking: summarizeRel('thinking', thinkingRuns),
  }
  return c.json(data)
})

export default devEvalRoutes
