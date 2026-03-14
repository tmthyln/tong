import { Hono } from 'hono'

const dictionaryRoutes = new Hono<{ Bindings: Env }>()

// POST /api/dictionary/refresh
// Starts a CEDICT refresh workflow. Returns immediately with the job ID.
dictionaryRoutes.post('/refresh', async (c) => {
  const jobId = `cedict-refresh-${Date.now()}`

  await c.env.DB.prepare(
    `INSERT INTO dictionary_refresh_job (id) VALUES (?)`
  )
    .bind(jobId)
    .run()

  await c.env.REFRESH_CEDICT_WORKFLOW.create({ id: jobId, params: { jobId } })

  return c.json({ jobId })
})

// GET /api/dictionary/refresh/:jobId
// Returns the current status and progress of a refresh job.
dictionaryRoutes.get('/refresh/:jobId', async (c) => {
  const { jobId } = c.req.param()

  const job = await c.env.DB.prepare(
    `SELECT id, status, total_entries, processed_entries, epoch, started_at, completed_at, error
     FROM dictionary_refresh_job WHERE id = ?`
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

export default dictionaryRoutes
