import { Hono } from 'hono'
import charIdsRoutes from './char-ids'
import {
  explainTermInContext,
  disambiguateTerm,
  type ExplainEntry,
  type DisambiguateEntry,
} from '../lib/agent/explain'
import { searchDictionary, segmentText } from '../lib/agent/dictionary-search'

const dictionaryRoutes = new Hono<{ Bindings: Env }>()

// GET /api/dictionary/search
//
// Query params (all optional, all ANDed together):
//   q          – text search: Chinese chars, pinyin, or English; supports * (prefix) and _ (single-char) wildcards
//   tone       – 1|2|3|4|5  filter entries whose pinyin contains this tone digit
//   def        – definition keyword (full-text search on definitions)
//   headwords  – 1 restricts text search to simplified/traditional/pinyin columns
//   limit      – default 50, max 200
//
// Core logic lives in lib/agent/dictionary-search.ts so it is shared with the agent.
dictionaryRoutes.get('/search', async (c) => {
  const results = await searchDictionary(c.env, {
    q: c.req.query('q'),
    tone: c.req.query('tone'),
    def: c.req.query('def'),
    headwordsOnly: c.req.query('headwords') === '1',
    limit: c.req.query('limit') ? parseInt(c.req.query('limit')!, 10) : undefined,
  })
  return c.json({ results })
})

// GET /api/dictionary/segment
//
// Segments an input string (typically Chinese characters) into the best-ranked
// sequence(s) of dictionary entries using beam-search dynamic programming.
//
// Query params:
//   q      – input string (max 20 characters)
//   limit  – number of segmentations to return (default 5, max 10)
dictionaryRoutes.get('/segment', async (c) => {
  const limitParam = c.req.query('limit')
  const result = await segmentText(c.env, c.req.query('q') ?? '', limitParam ? parseInt(limitParam, 10) : 5)
  return c.json(result)
})

// POST /api/dictionary/explain
//
// Request body: { term, entries, documentId, chunkId }
// Returns: { explanation: string }
dictionaryRoutes.post('/explain', async (c) => {
  const body = await c.req.json<{
    term: string
    entries: ExplainEntry[]
    documentId: number
    chunkId: number
  }>()

  const result = await explainTermInContext(c.env, body)
  if (!result.ok) return c.json({ error: result.error }, result.status)

  return c.json({ explanation: result.explanation })
})

// POST /api/dictionary/disambiguate
//
// Request body: { term, entries, documentId, chunkId }
// Returns: { explanation: string, entryId: number }
dictionaryRoutes.post('/disambiguate', async (c) => {
  const body = await c.req.json<{
    term: string
    entries: DisambiguateEntry[]
    documentId: number
    chunkId: number
  }>()

  const result = await disambiguateTerm(c.env, body)
  if (!result.ok) return c.json({ error: result.error }, result.status)

  return c.json({ explanation: result.explanation, entryId: result.entryId })
})

// POST /api/dictionary/refresh
// Starts a CEDICT refresh workflow. Returns immediately with the job ID.
dictionaryRoutes.post('/refresh', async (c) => {
  const jobId = `cedict-refresh-${Date.now()}`

  await c.env.DB.prepare(`INSERT INTO dictionary_refresh_job (id) VALUES (?)`).bind(jobId).run()

  await c.env.REFRESH_CEDICT_WORKFLOW.create({ id: jobId, params: { jobId } })

  return c.json({ jobId })
})

// GET /api/dictionary/refresh/:jobId
// Returns the current status and progress of a refresh job.
dictionaryRoutes.get('/refresh/:jobId', async (c) => {
  const { jobId } = c.req.param()

  const job = await c.env.DB.prepare(
    `SELECT id, status, total_entries, processed_entries, epoch, started_at, completed_at, error
     FROM dictionary_refresh_job WHERE id = ?`,
  )
    .bind(jobId)
    .first<{
      id: string
      status: string
      total_entries: number | null
      processed_entries: number
      epoch: number | null
      started_at: string
      completed_at: string | null
      error: string | null
    }>()

  if (!job) return c.json({ error: 'Job not found' }, 404)

  const percent =
    job.total_entries && job.total_entries > 0
      ? Math.round((job.processed_entries / job.total_entries) * 100)
      : null

  return c.json({
    jobId: job.id,
    status: job.status,
    totalEntries: job.total_entries,
    processedEntries: job.processed_entries,
    percent,
    epoch: job.epoch,
    startedAt: job.started_at,
    completedAt: job.completed_at,
    error: job.error,
  })
})

dictionaryRoutes.route('/components', charIdsRoutes)

export default dictionaryRoutes
