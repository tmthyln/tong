import { Hono } from 'hono'

const charIdsRoutes = new Hono<{ Bindings: Env }>()

// ── IDS structural search types ──────────────────────────────────────────────

type TemplateNode =
  | { type: 'op'; operator: string; children: Array<TemplateNode | null> }
  | { type: 'char'; character: string }
  | null

const IDS_OPERATORS: Record<string, number> = {
  '⿰': 2, '⿱': 2, '⿴': 2, '⿵': 2, '⿶': 2, '⿷': 2, '⿸': 2, '⿹': 2, '⿺': 2, '⿻': 2,
  '⿲': 3, '⿳': 3,
}

interface PatternQuery {
  joins: string[]
  conditions: string[]
  params: (string | number)[]
}

function validateTemplateNode(node: unknown, depth: number, count: { n: number }): string | null {
  if (node === null) return null
  if (depth > 6) return 'Template too deep (max 6)'
  if (count.n > 25) return 'Template too large (max 25 nodes)'
  if (typeof node !== 'object') return 'Invalid node'
  const n = node as Record<string, unknown>
  if (n.type === 'char') {
    if (typeof n.character !== 'string') return 'char node missing character'
    // Must be exactly one Unicode codepoint
    if ([...n.character].length !== 1) return 'character must be a single Unicode codepoint'
    count.n++
    return null
  }
  if (n.type === 'op') {
    if (typeof n.operator !== 'string' || !(n.operator in IDS_OPERATORS))
      return `Unknown operator: ${n.operator}`
    if (!Array.isArray(n.children)) return 'op node missing children array'
    count.n++
    for (const child of n.children) {
      const err = validateTemplateNode(child, depth + 1, count)
      if (err) return err
    }
    return null
  }
  return 'Invalid node type'
}

function buildPatternQuery(node: TemplateNode, alias: string, q: PatternQuery): void {
  if (node === null) return
  if (node.type === 'char') {
    q.conditions.push(`${alias}.node_type = 'char'`, `${alias}.character = ?`)
    q.params.push(node.character)
    return
  }
  // type === 'op'
  q.conditions.push(`${alias}.node_type = 'op'`, `${alias}.operator = ?`)
  q.params.push(node.operator)
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i]
    if (child === null) continue
    const linkAlias = `l${alias.slice(1)}_${i}`
    const childAlias = `${alias}_${i}`
    q.joins.push(
      `JOIN char_ids_node_link ${linkAlias} ON ${linkAlias}.parent_id = ${alias}.id AND ${linkAlias}.position = ${i}`,
      `JOIN char_ids_node ${childAlias} ON ${childAlias}.id = ${linkAlias}.child_id`
    )
    buildPatternQuery(child, childAlias, q)
  }
}

// POST /api/dictionary/components/search
// Searches for characters matching a structural IDS template.
charIdsRoutes.post('/search', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object') return c.json({ error: 'Invalid request body' }, 400)
  const { template, mode } = body as { template: unknown; mode: unknown }

  if (template === null || template === undefined) return c.json({ error: 'Template required' }, 400)
  if (mode !== 'exact' && mode !== 'contains') return c.json({ error: 'mode must be exact or contains' }, 400)

  const count = { n: 0 }
  const validationErr = validateTemplateNode(template, 0, count)
  if (validationErr) return c.json({ error: validationErr }, 400)

  const q: PatternQuery = { joins: [], conditions: [], params: [] }
  buildPatternQuery(template as TemplateNode, 'n0', q)

  const joinsSql = q.joins.join('\n  ')
  const whereSql = q.conditions.join(' AND ')

  let sql: string
  if (mode === 'exact') {
    sql = `
      SELECT DISTINCT c.codepoint, c.character
      FROM char_ids c
      WHERE c.root_node_id IN (
        SELECT DISTINCT n0.id FROM char_ids_node n0
        ${joinsSql}
        WHERE ${whereSql}
      ) AND c.obsolete = 0
      ORDER BY c.character LIMIT 500`
  } else {
    sql = `
      WITH RECURSIVE pattern_roots AS (
        SELECT DISTINCT n0.id as match_id FROM char_ids_node n0
        ${joinsSql}
        WHERE ${whereSql}
      ),
      ancestors(node_id) AS (
        SELECT match_id FROM pattern_roots
        UNION ALL
        SELECT l.parent_id FROM char_ids_node_link l JOIN ancestors a ON l.child_id = a.node_id
      )
      SELECT DISTINCT c.codepoint, c.character
      FROM ancestors a
      JOIN char_ids c ON c.root_node_id = a.node_id AND c.obsolete = 0
      ORDER BY c.character LIMIT 500`
  }

  const { results } = await c.env.DB.prepare(sql)
    .bind(...q.params)
    .all<{ codepoint: string; character: string }>()

  return c.json({ chars: results })
})

// POST /api/dictionary/components/refresh
// Starts a char IDS refresh workflow. Returns immediately with the job ID.
charIdsRoutes.post('/refresh', async (c) => {
  const jobId = `char-ids-refresh-${Date.now()}`

  await c.env.DB.prepare(
    `INSERT INTO char_ids_refresh_job (id) VALUES (?)`
  )
    .bind(jobId)
    .run()

  await c.env.REFRESH_CHAR_IDS_WORKFLOW.create({ id: jobId, params: { jobId } })

  return c.json({ jobId })
})

// GET /api/dictionary/components/refresh/:jobId
// Returns the current status of a char IDS refresh job.
charIdsRoutes.get('/refresh/:jobId', async (c) => {
  const { jobId } = c.req.param()

  const job = await c.env.DB.prepare(
    `SELECT id, status, total_chars, processed_chars, started_at, completed_at, error
     FROM char_ids_refresh_job WHERE id = ?`
  )
    .bind(jobId)
    .first<{
      id: string
      status: string
      total_chars: number | null
      processed_chars: number
      started_at: string
      completed_at: string | null
      error: string | null
    }>()

  if (!job) return c.json({ error: 'Job not found' }, 404)

  const percent =
    job.total_chars && job.total_chars > 0
      ? Math.round((job.processed_chars / job.total_chars) * 100)
      : null

  return c.json({
    jobId: job.id,
    status: job.status,
    totalChars: job.total_chars,
    processedChars: job.processed_chars,
    percent,
    startedAt: job.started_at,
    completedAt: job.completed_at,
    error: job.error,
  })
})

// GET /api/dictionary/components/:char
// Returns all IDS decomposition variants for a character.
charIdsRoutes.get('/:char', async (c) => {
  const char = c.req.param('char')

  const rows = await c.env.DB.prepare(
    `SELECT id, codepoint, ids_string, tags, root_node_id
     FROM char_ids
     WHERE character = ? AND obsolete = 0
     ORDER BY id`
  )
    .bind(char)
    .all<{
      id: number
      codepoint: string
      ids_string: string | null
      tags: string | null
      root_node_id: number | null
    }>()

  if (rows.results.length === 0) return c.json({ error: 'Character not found' }, 404)

  const first = rows.results[0]
  return c.json({
    codepoint: first.codepoint,
    character: char,
    entries: rows.results.map((r) => ({
      id: r.id,
      idsString: r.ids_string,
      tags: r.tags,
      rootNodeId: r.root_node_id,
    })),
  })
})

// GET /api/dictionary/components/by-component/:char
// Returns characters that contain the given character as a component.
// ?indirect=true for transitive (recursive) containment.
charIdsRoutes.get('/by-component/:char', async (c) => {
  const char = c.req.param('char')
  const indirect = c.req.query('indirect') === 'true'

  // Resolve representative node IDs for the component character
  const repRows = await c.env.DB.prepare(
    `SELECT root_node_id FROM char_ids WHERE character = ? AND obsolete = 0 AND root_node_id IS NOT NULL`
  )
    .bind(char)
    .all<{ root_node_id: number }>()

  if (repRows.results.length === 0) {
    return c.json({ chars: [] })
  }

  const repNodeIds = repRows.results.map((r) => r.root_node_id)
  const ph = repNodeIds.map(() => '?').join(', ')

  let chars: Array<{ codepoint: string; character: string }>

  if (!indirect) {
    // Direct containment: characters whose root_node has an edge to one of our rep nodes
    const { results } = await c.env.DB.prepare(
      `SELECT DISTINCT c2.codepoint, c2.character
       FROM char_ids_node_link l
       JOIN char_ids c2 ON c2.root_node_id = l.parent_id AND c2.obsolete = 0
       WHERE l.child_id IN (${ph})
       ORDER BY c2.character`
    )
      .bind(...repNodeIds)
      .all<{ codepoint: string; character: string }>()
    chars = results
  } else {
    // Transitive containment: recursive backwards CTE following parent links
    const { results } = await c.env.DB.prepare(
      `WITH RECURSIVE ancestors(node_id) AS (
         SELECT root_node_id FROM char_ids WHERE character = ? AND obsolete = 0 AND root_node_id IS NOT NULL
         UNION ALL
         SELECT l.parent_id FROM char_ids_node_link l JOIN ancestors a ON l.child_id = a.node_id
       )
       SELECT DISTINCT c.codepoint, c.character
       FROM ancestors a
       JOIN char_ids c ON c.root_node_id = a.node_id AND c.obsolete = 0
       ORDER BY c.character`
    )
      .bind(char)
      .all<{ codepoint: string; character: string }>()
    chars = results
  }

  return c.json({ chars })
})

export default charIdsRoutes
