import { Hono } from 'hono'

const graphTypeRoutes = new Hono<{ Bindings: Env }>()

// ── Node Types ──────────────────────────────────────────────

graphTypeRoutes.get('/node-type', async (c) => {
  const types = await c.env.DB.prepare(
    'SELECT id, name, definition FROM node_type ORDER BY name'
  ).all<{ id: number; name: string; definition: string }>()

  const examples = await c.env.DB.prepare(
    'SELECT id, node_type_id, example FROM node_type_example ORDER BY id'
  ).all<{ id: number; node_type_id: number; example: string }>()

  const examplesByType: Record<number, Array<{ id: number; example: string }>> = {}
  for (const ex of examples.results) {
    if (!examplesByType[ex.node_type_id]) examplesByType[ex.node_type_id] = []
    examplesByType[ex.node_type_id].push({ id: ex.id, example: ex.example })
  }

  return c.json(
    types.results.map((t) => ({
      id: t.id,
      name: t.name,
      definition: t.definition,
      examples: examplesByType[t.id] || [],
    }))
  )
})

graphTypeRoutes.post('/node-type', async (c) => {
  const body = await c.req.json<{ name: string; definition: string; examples?: string[] }>()

  if (!body.name?.trim()) return c.json({ error: 'Name is required' }, 400)
  if (!body.definition?.trim()) return c.json({ error: 'Definition is required' }, 400)

  const result = await c.env.DB.prepare(
    'INSERT INTO node_type (name, definition) VALUES (?, ?) RETURNING id'
  )
    .bind(body.name.trim(), body.definition.trim())
    .first<{ id: number }>()

  if (!result) return c.json({ error: 'Failed to create node type' }, 500)

  if (body.examples?.length) {
    const stmt = c.env.DB.prepare(
      'INSERT INTO node_type_example (node_type_id, example) VALUES (?, ?)'
    )
    await c.env.DB.batch(body.examples.map((ex) => stmt.bind(result.id, ex.trim())))
  }

  return c.json({ id: result.id }, 201)
})

graphTypeRoutes.put('/node-type/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10)
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400)

  const body = await c.req.json<{ name: string; definition: string }>()

  if (!body.name?.trim()) return c.json({ error: 'Name is required' }, 400)
  if (!body.definition?.trim()) return c.json({ error: 'Definition is required' }, 400)

  const existing = await c.env.DB.prepare('SELECT id FROM node_type WHERE id = ?').bind(id).first()
  if (!existing) return c.json({ error: 'Node type not found' }, 404)

  await c.env.DB.prepare('UPDATE node_type SET name = ?, definition = ? WHERE id = ?')
    .bind(body.name.trim(), body.definition.trim(), id)
    .run()

  return c.json({ success: true })
})

graphTypeRoutes.delete('/node-type/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10)
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400)

  await c.env.DB.prepare('DELETE FROM node_type WHERE id = ?').bind(id).run()
  return c.json({ success: true })
})

// ── Node Type Examples ──────────────────────────────────────

graphTypeRoutes.post('/node-type/:id/example', async (c) => {
  const typeId = parseInt(c.req.param('id'), 10)
  if (isNaN(typeId)) return c.json({ error: 'Invalid ID' }, 400)

  const body = await c.req.json<{ example: string }>()
  if (!body.example?.trim()) return c.json({ error: 'Example is required' }, 400)

  const result = await c.env.DB.prepare(
    'INSERT INTO node_type_example (node_type_id, example) VALUES (?, ?) RETURNING id'
  )
    .bind(typeId, body.example.trim())
    .first<{ id: number }>()

  if (!result) return c.json({ error: 'Failed to add example' }, 500)
  return c.json({ id: result.id }, 201)
})

graphTypeRoutes.delete('/node-type-example/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10)
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400)

  await c.env.DB.prepare('DELETE FROM node_type_example WHERE id = ?').bind(id).run()
  return c.json({ success: true })
})

// ── Edge Types ──────────────────────────────────────────────

graphTypeRoutes.get('/edge-type', async (c) => {
  const types = await c.env.DB.prepare(
    'SELECT id, name, reverse_name, definition FROM edge_type ORDER BY name'
  ).all<{ id: number; name: string; reverse_name: string | null; definition: string }>()

  const examples = await c.env.DB.prepare(
    'SELECT id, edge_type_id, example FROM edge_type_example ORDER BY id'
  ).all<{ id: number; edge_type_id: number; example: string }>()

  const examplesByType: Record<number, Array<{ id: number; example: string }>> = {}
  for (const ex of examples.results) {
    if (!examplesByType[ex.edge_type_id]) examplesByType[ex.edge_type_id] = []
    examplesByType[ex.edge_type_id].push({ id: ex.id, example: ex.example })
  }

  return c.json(
    types.results.map((t) => ({
      id: t.id,
      name: t.name,
      reverseName: t.reverse_name,
      definition: t.definition,
      examples: examplesByType[t.id] || [],
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

  const result = await c.env.DB.prepare(
    'INSERT INTO edge_type (name, reverse_name, definition) VALUES (?, ?, ?) RETURNING id'
  )
    .bind(body.name.trim(), body.reverseName?.trim() || null, body.definition.trim())
    .first<{ id: number }>()

  if (!result) return c.json({ error: 'Failed to create edge type' }, 500)

  if (body.examples?.length) {
    const stmt = c.env.DB.prepare(
      'INSERT INTO edge_type_example (edge_type_id, example) VALUES (?, ?)'
    )
    await c.env.DB.batch(body.examples.map((ex) => stmt.bind(result.id, ex.trim())))
  }

  return c.json({ id: result.id }, 201)
})

graphTypeRoutes.put('/edge-type/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10)
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400)

  const body = await c.req.json<{ name: string; reverseName?: string | null; definition: string }>()

  if (!body.name?.trim()) return c.json({ error: 'Name is required' }, 400)
  if (!body.definition?.trim()) return c.json({ error: 'Definition is required' }, 400)

  const existing = await c.env.DB.prepare('SELECT id FROM edge_type WHERE id = ?').bind(id).first()
  if (!existing) return c.json({ error: 'Edge type not found' }, 404)

  await c.env.DB.prepare(
    'UPDATE edge_type SET name = ?, reverse_name = ?, definition = ? WHERE id = ?'
  )
    .bind(body.name.trim(), body.reverseName?.trim() || null, body.definition.trim(), id)
    .run()

  return c.json({ success: true })
})

graphTypeRoutes.delete('/edge-type/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10)
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400)

  await c.env.DB.prepare('DELETE FROM edge_type WHERE id = ?').bind(id).run()
  return c.json({ success: true })
})

// ── Edge Type Examples ──────────────────────────────────────

graphTypeRoutes.post('/edge-type/:id/example', async (c) => {
  const typeId = parseInt(c.req.param('id'), 10)
  if (isNaN(typeId)) return c.json({ error: 'Invalid ID' }, 400)

  const body = await c.req.json<{ example: string }>()
  if (!body.example?.trim()) return c.json({ error: 'Example is required' }, 400)

  const result = await c.env.DB.prepare(
    'INSERT INTO edge_type_example (edge_type_id, example) VALUES (?, ?) RETURNING id'
  )
    .bind(typeId, body.example.trim())
    .first<{ id: number }>()

  if (!result) return c.json({ error: 'Failed to add example' }, 500)
  return c.json({ id: result.id }, 201)
})

graphTypeRoutes.delete('/edge-type-example/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10)
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400)

  await c.env.DB.prepare('DELETE FROM edge_type_example WHERE id = ?').bind(id).run()
  return c.json({ success: true })
})

export default graphTypeRoutes