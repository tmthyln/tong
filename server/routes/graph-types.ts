import { Hono } from 'hono'

const graphTypeRoutes = new Hono<{ Bindings: Env }>()

interface NodeTypeRow {
  id: number
  name: string
  definition: string
  examples_json: string
  version: number
  is_current: number
  date_created: string
}

interface EdgeTypeRow {
  id: number
  name: string
  reverse_name: string | null
  definition: string
  examples_json: string
  version: number
  is_current: number
  date_created: string
}

function parseExamples(json: string): string[] {
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : []
  } catch {
    return []
  }
}

function serializeExamples(examples: string[]): string {
  return JSON.stringify(examples)
}

// ── Node Types ──────────────────────────────────────────────

graphTypeRoutes.get('/node-type', async (c) => {
  const types = await c.env.DB.prepare(
    'SELECT id, name, definition, examples_json, version, date_created FROM node_type WHERE is_current = 1 ORDER BY name'
  ).all<Omit<NodeTypeRow, 'is_current'>>()

  return c.json(
    types.results.map((t) => ({
      id: t.id,
      name: t.name,
      definition: t.definition,
      examples: parseExamples(t.examples_json),
      version: t.version,
    }))
  )
})

graphTypeRoutes.post('/node-type', async (c) => {
  const body = await c.req.json<{ name: string; definition: string; examples?: string[] }>()

  if (!body.name?.trim()) return c.json({ error: 'Name is required' }, 400)
  if (!body.definition?.trim()) return c.json({ error: 'Definition is required' }, 400)

  const name = body.name.trim()
  const existing = await c.env.DB.prepare(
    'SELECT id FROM node_type WHERE name = ? AND is_current = 1'
  )
    .bind(name)
    .first()
  if (existing) return c.json({ error: 'A node type with this name already exists' }, 409)

  const examples = (body.examples ?? []).map((s) => s.trim()).filter(Boolean)

  const result = await c.env.DB.prepare(
    `INSERT INTO node_type (name, definition, examples_json, version, is_current, date_created)
     VALUES (?, ?, ?, 1, 1, ?) RETURNING id`
  )
    .bind(name, body.definition.trim(), serializeExamples(examples), new Date().toISOString())
    .first<{ id: number }>()

  if (!result) return c.json({ error: 'Failed to create node type' }, 500)
  return c.json({ id: result.id, version: 1 }, 201)
})

graphTypeRoutes.put('/node-type/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10)
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400)

  const body = await c.req.json<{ name?: string; definition: string }>()
  if (!body.definition?.trim()) return c.json({ error: 'Definition is required' }, 400)

  const current = await c.env.DB.prepare(
    'SELECT id, name, definition, examples_json, version FROM node_type WHERE id = ? AND is_current = 1'
  )
    .bind(id)
    .first<Pick<NodeTypeRow, 'id' | 'name' | 'definition' | 'examples_json' | 'version'>>()
  if (!current) return c.json({ error: 'Node type not found' }, 404)

  if (body.name !== undefined && body.name.trim() !== current.name) {
    return c.json({ error: 'Node type name is immutable across versions' }, 400)
  }

  const newId = await bumpNodeTypeVersion(c.env.DB, current, {
    definition: body.definition.trim(),
    examples_json: current.examples_json,
  })

  return c.json({ id: newId, version: current.version + 1 })
})

graphTypeRoutes.delete('/node-type/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10)
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400)

  await c.env.DB.prepare(
    'UPDATE node_type SET is_current = 0 WHERE id = ? AND is_current = 1'
  )
    .bind(id)
    .run()
  return c.json({ success: true })
})

graphTypeRoutes.get('/node-type/:name/versions', async (c) => {
  const name = c.req.param('name')
  const rows = await c.env.DB.prepare(
    'SELECT id, name, definition, examples_json, version, is_current, date_created FROM node_type WHERE name = ? ORDER BY version DESC'
  )
    .bind(name)
    .all<NodeTypeRow>()

  return c.json(
    rows.results.map((r) => ({
      id: r.id,
      name: r.name,
      definition: r.definition,
      examples: parseExamples(r.examples_json),
      version: r.version,
      isCurrent: r.is_current === 1,
      dateCreated: r.date_created,
    }))
  )
})

// ── Node Type Examples ──────────────────────────────────────

graphTypeRoutes.post('/node-type/:id/example', async (c) => {
  const id = parseInt(c.req.param('id'), 10)
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400)

  const body = await c.req.json<{ example: string }>()
  const example = body.example?.trim()
  if (!example) return c.json({ error: 'Example is required' }, 400)

  const current = await c.env.DB.prepare(
    'SELECT id, name, definition, examples_json, version FROM node_type WHERE id = ? AND is_current = 1'
  )
    .bind(id)
    .first<Pick<NodeTypeRow, 'id' | 'name' | 'definition' | 'examples_json' | 'version'>>()
  if (!current) return c.json({ error: 'Node type not found' }, 404)

  const examples = parseExamples(current.examples_json)
  if (!examples.includes(example)) examples.push(example)

  const newId = await bumpNodeTypeVersion(c.env.DB, current, {
    definition: current.definition,
    examples_json: serializeExamples(examples),
  })

  return c.json({ id: newId, version: current.version + 1 }, 201)
})

graphTypeRoutes.delete('/node-type/:id/example', async (c) => {
  const id = parseInt(c.req.param('id'), 10)
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400)

  const body = await c.req.json<{ example: string }>().catch(() => ({ example: '' }))
  const example = body.example?.trim()
  if (!example) return c.json({ error: 'Example is required' }, 400)

  const current = await c.env.DB.prepare(
    'SELECT id, name, definition, examples_json, version FROM node_type WHERE id = ? AND is_current = 1'
  )
    .bind(id)
    .first<Pick<NodeTypeRow, 'id' | 'name' | 'definition' | 'examples_json' | 'version'>>()
  if (!current) return c.json({ error: 'Node type not found' }, 404)

  const examples = parseExamples(current.examples_json).filter((e) => e !== example)
  const newId = await bumpNodeTypeVersion(c.env.DB, current, {
    definition: current.definition,
    examples_json: serializeExamples(examples),
  })

  return c.json({ id: newId, version: current.version + 1 })
})

// ── Edge Types ──────────────────────────────────────────────

graphTypeRoutes.get('/edge-type', async (c) => {
  const types = await c.env.DB.prepare(
    'SELECT id, name, reverse_name, definition, examples_json, version, date_created FROM edge_type WHERE is_current = 1 ORDER BY name'
  ).all<Omit<EdgeTypeRow, 'is_current'>>()

  return c.json(
    types.results.map((t) => ({
      id: t.id,
      name: t.name,
      reverseName: t.reverse_name,
      definition: t.definition,
      examples: parseExamples(t.examples_json),
      version: t.version,
    }))
  )
})

graphTypeRoutes.post('/edge-type', async (c) => {
  const body = await c.req.json<{
    name: string
    reverseName?: string | null
    definition: string
    examples?: string[]
  }>()

  if (!body.name?.trim()) return c.json({ error: 'Name is required' }, 400)
  if (!body.definition?.trim()) return c.json({ error: 'Definition is required' }, 400)

  const name = body.name.trim()
  const existing = await c.env.DB.prepare(
    'SELECT id FROM edge_type WHERE name = ? AND is_current = 1'
  )
    .bind(name)
    .first()
  if (existing) return c.json({ error: 'An edge type with this name already exists' }, 409)

  const examples = (body.examples ?? []).map((s) => s.trim()).filter(Boolean)

  const result = await c.env.DB.prepare(
    `INSERT INTO edge_type (name, reverse_name, definition, examples_json, version, is_current, date_created)
     VALUES (?, ?, ?, ?, 1, 1, ?) RETURNING id`
  )
    .bind(
      name,
      body.reverseName?.trim() || null,
      body.definition.trim(),
      serializeExamples(examples),
      new Date().toISOString()
    )
    .first<{ id: number }>()

  if (!result) return c.json({ error: 'Failed to create edge type' }, 500)
  return c.json({ id: result.id, version: 1 }, 201)
})

graphTypeRoutes.put('/edge-type/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10)
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400)

  const body = await c.req.json<{ name?: string; reverseName?: string | null; definition: string }>()
  if (!body.definition?.trim()) return c.json({ error: 'Definition is required' }, 400)

  const current = await c.env.DB.prepare(
    'SELECT id, name, reverse_name, definition, examples_json, version FROM edge_type WHERE id = ? AND is_current = 1'
  )
    .bind(id)
    .first<Pick<EdgeTypeRow, 'id' | 'name' | 'reverse_name' | 'definition' | 'examples_json' | 'version'>>()
  if (!current) return c.json({ error: 'Edge type not found' }, 404)

  if (body.name !== undefined && body.name.trim() !== current.name) {
    return c.json({ error: 'Edge type name is immutable across versions' }, 400)
  }

  const reverseName = body.reverseName === undefined
    ? current.reverse_name
    : (body.reverseName?.trim() || null)

  const newId = await bumpEdgeTypeVersion(c.env.DB, current, {
    reverse_name: reverseName,
    definition: body.definition.trim(),
    examples_json: current.examples_json,
  })

  return c.json({ id: newId, version: current.version + 1 })
})

graphTypeRoutes.delete('/edge-type/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10)
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400)

  await c.env.DB.prepare(
    'UPDATE edge_type SET is_current = 0 WHERE id = ? AND is_current = 1'
  )
    .bind(id)
    .run()
  return c.json({ success: true })
})

graphTypeRoutes.get('/edge-type/:name/versions', async (c) => {
  const name = c.req.param('name')
  const rows = await c.env.DB.prepare(
    'SELECT id, name, reverse_name, definition, examples_json, version, is_current, date_created FROM edge_type WHERE name = ? ORDER BY version DESC'
  )
    .bind(name)
    .all<EdgeTypeRow>()

  return c.json(
    rows.results.map((r) => ({
      id: r.id,
      name: r.name,
      reverseName: r.reverse_name,
      definition: r.definition,
      examples: parseExamples(r.examples_json),
      version: r.version,
      isCurrent: r.is_current === 1,
      dateCreated: r.date_created,
    }))
  )
})

// ── Edge Type Examples ──────────────────────────────────────

graphTypeRoutes.post('/edge-type/:id/example', async (c) => {
  const id = parseInt(c.req.param('id'), 10)
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400)

  const body = await c.req.json<{ example: string }>()
  const example = body.example?.trim()
  if (!example) return c.json({ error: 'Example is required' }, 400)

  const current = await c.env.DB.prepare(
    'SELECT id, name, reverse_name, definition, examples_json, version FROM edge_type WHERE id = ? AND is_current = 1'
  )
    .bind(id)
    .first<Pick<EdgeTypeRow, 'id' | 'name' | 'reverse_name' | 'definition' | 'examples_json' | 'version'>>()
  if (!current) return c.json({ error: 'Edge type not found' }, 404)

  const examples = parseExamples(current.examples_json)
  if (!examples.includes(example)) examples.push(example)

  const newId = await bumpEdgeTypeVersion(c.env.DB, current, {
    reverse_name: current.reverse_name,
    definition: current.definition,
    examples_json: serializeExamples(examples),
  })

  return c.json({ id: newId, version: current.version + 1 }, 201)
})

graphTypeRoutes.delete('/edge-type/:id/example', async (c) => {
  const id = parseInt(c.req.param('id'), 10)
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400)

  const body = await c.req.json<{ example: string }>().catch(() => ({ example: '' }))
  const example = body.example?.trim()
  if (!example) return c.json({ error: 'Example is required' }, 400)

  const current = await c.env.DB.prepare(
    'SELECT id, name, reverse_name, definition, examples_json, version FROM edge_type WHERE id = ? AND is_current = 1'
  )
    .bind(id)
    .first<Pick<EdgeTypeRow, 'id' | 'name' | 'reverse_name' | 'definition' | 'examples_json' | 'version'>>()
  if (!current) return c.json({ error: 'Edge type not found' }, 404)

  const examples = parseExamples(current.examples_json).filter((e) => e !== example)
  const newId = await bumpEdgeTypeVersion(c.env.DB, current, {
    reverse_name: current.reverse_name,
    definition: current.definition,
    examples_json: serializeExamples(examples),
  })

  return c.json({ id: newId, version: current.version + 1 })
})

// ── Version-bump helpers ────────────────────────────────────

async function bumpNodeTypeVersion(
  db: D1Database,
  current: { id: number; name: string; version: number },
  next: { definition: string; examples_json: string }
): Promise<number> {
  const inserted = await db
    .prepare(
      `INSERT INTO node_type (name, definition, examples_json, version, is_current, date_created)
       VALUES (?, ?, ?, ?, 1, ?) RETURNING id`
    )
    .bind(
      current.name,
      next.definition,
      next.examples_json,
      current.version + 1,
      new Date().toISOString()
    )
    .first<{ id: number }>()
  if (!inserted) throw new Error('Failed to insert new node type version')

  await db
    .prepare('UPDATE node_type SET is_current = 0 WHERE id = ?')
    .bind(current.id)
    .run()
  return inserted.id
}

async function bumpEdgeTypeVersion(
  db: D1Database,
  current: { id: number; name: string; version: number },
  next: { reverse_name: string | null; definition: string; examples_json: string }
): Promise<number> {
  const inserted = await db
    .prepare(
      `INSERT INTO edge_type (name, reverse_name, definition, examples_json, version, is_current, date_created)
       VALUES (?, ?, ?, ?, ?, 1, ?) RETURNING id`
    )
    .bind(
      current.name,
      next.reverse_name,
      next.definition,
      next.examples_json,
      current.version + 1,
      new Date().toISOString()
    )
    .first<{ id: number }>()
  if (!inserted) throw new Error('Failed to insert new edge type version')

  await db
    .prepare('UPDATE edge_type SET is_current = 0 WHERE id = ?')
    .bind(current.id)
    .run()
  return inserted.id
}

export { parseExamples, serializeExamples }
export default graphTypeRoutes
