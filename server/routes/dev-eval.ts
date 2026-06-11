import { Hono } from 'hono'
import {
  extractEntitiesForNodeTypesWithUsage,
  removeOverlaps,
  type NodeTypeInput,
  type NodeTypeExtractionRun,
} from '../lib/entity-extraction'

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

  const [nodeTypesResult, nodeExamplesResult] = await Promise.all([
    c.env.DB.prepare('SELECT id, name, definition FROM node_type ORDER BY name').all<{
      id: number
      name: string
      definition: string
    }>(),
    c.env.DB.prepare(
      'SELECT node_type_id, example FROM node_type_example ORDER BY id',
    ).all<{ node_type_id: number; example: string }>(),
  ])

  const examplesByType: Record<number, string[]> = {}
  for (const ex of nodeExamplesResult.results) {
    if (!examplesByType[ex.node_type_id]) examplesByType[ex.node_type_id] = []
    examplesByType[ex.node_type_id].push(ex.example)
  }
  const nodeTypes: NodeTypeInput[] = nodeTypesResult.results.map(t => ({
    name: t.name,
    definition: t.definition,
    examples: examplesByType[t.id] ?? [],
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

export default devEvalRoutes
