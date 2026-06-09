import { Hono } from 'hono'
import { getUserId, userType } from '../lib/auth'

const knowledgeScopeRoutes = new Hono<{ Bindings: Env }>()

interface ScopeNode {
  id: number
  name: string
  parentId: number | null
  children: ScopeNode[]
  documents: { id: number; name: string }[]
}

// GET /api/knowledge-scope
// Returns the nested knowledge-scope tree, each node listing its assigned documents.
knowledgeScopeRoutes.get('/', async (c) => {
  const [scopeRows, docRows] = await Promise.all([
    c.env.DB.prepare('SELECT id, name, parent_id FROM knowledge_scope ORDER BY name').all<{
      id: number
      name: string
      parent_id: number | null
    }>(),
    c.env.DB.prepare(
      `SELECT id, COALESCE(title, original_doc_filename) AS name, knowledge_scope_id
       FROM document WHERE knowledge_scope_id IS NOT NULL`
    ).all<{ id: number; name: string; knowledge_scope_id: number }>(),
  ])

  const nodeMap = new Map<number, ScopeNode>()
  for (const s of scopeRows.results) {
    nodeMap.set(s.id, { id: s.id, name: s.name, parentId: s.parent_id, children: [], documents: [] })
  }

  for (const d of docRows.results) {
    nodeMap.get(d.knowledge_scope_id)?.documents.push({ id: d.id, name: d.name })
  }

  const roots: ScopeNode[] = []
  for (const node of nodeMap.values()) {
    if (node.parentId === null) {
      roots.push(node)
    } else {
      nodeMap.get(node.parentId)?.children.push(node)
    }
  }

  return c.json({ tree: roots })
})

// POST /api/knowledge-scope  { name, parentId? }
knowledgeScopeRoutes.post('/', async (c) => {
  if (userType(getUserId(c)) === 'public') {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const body = await c.req.json<{ name: string; parentId?: number | null }>()
  if (!body.name || body.name.trim() === '') {
    return c.json({ error: 'Scope name is required' }, 400)
  }

  const parentId = body.parentId ?? null
  if (parentId !== null) {
    const parent = await c.env.DB.prepare('SELECT id FROM knowledge_scope WHERE id = ?')
      .bind(parentId)
      .first()
    if (!parent) return c.json({ error: 'Parent scope not found' }, 404)
  }

  const result = await c.env.DB.prepare(
    'INSERT INTO knowledge_scope (name, parent_id) VALUES (?, ?) RETURNING id'
  )
    .bind(body.name.trim(), parentId)
    .first<{ id: number }>()

  if (!result) return c.json({ error: 'Failed to create scope' }, 500)

  return c.json({ id: result.id, name: body.name.trim(), parentId }, 201)
})

// PATCH /api/knowledge-scope/:id  { name?, parentId? }  rename and/or re-nest
knowledgeScopeRoutes.patch('/:id', async (c) => {
  if (userType(getUserId(c)) === 'public') {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const id = parseInt(c.req.param('id'), 10)
  if (isNaN(id)) return c.json({ error: 'Invalid scope ID' }, 400)

  const body = await c.req.json<{ name?: string; parentId?: number | null }>()

  const scope = await c.env.DB.prepare('SELECT id FROM knowledge_scope WHERE id = ?')
    .bind(id)
    .first()
  if (!scope) return c.json({ error: 'Scope not found' }, 404)

  if (body.name !== undefined) {
    if (body.name.trim() === '') return c.json({ error: 'Scope name is required' }, 400)
    await c.env.DB.prepare('UPDATE knowledge_scope SET name = ? WHERE id = ?')
      .bind(body.name.trim(), id)
      .run()
  }

  if (body.parentId !== undefined) {
    const parentId = body.parentId
    if (parentId !== null) {
      if (parentId === id) return c.json({ error: 'Scope cannot be its own parent' }, 400)
      // Walk up the proposed parent's ancestry to reject cycles.
      const rows = await c.env.DB.prepare('SELECT id, parent_id FROM knowledge_scope').all<{
        id: number
        parent_id: number | null
      }>()
      const parentOf = new Map(rows.results.map((r) => [r.id, r.parent_id]))
      let cursor: number | null = parentId
      while (cursor !== null) {
        if (cursor === id) {
          return c.json({ error: 'Cannot move a scope under its own descendant' }, 400)
        }
        cursor = parentOf.get(cursor) ?? null
      }
      const parent = await c.env.DB.prepare('SELECT id FROM knowledge_scope WHERE id = ?')
        .bind(parentId)
        .first()
      if (!parent) return c.json({ error: 'Parent scope not found' }, 404)
    }
    await c.env.DB.prepare('UPDATE knowledge_scope SET parent_id = ? WHERE id = ?')
      .bind(parentId, id)
      .run()
  }

  return c.json({ success: true })
})

// DELETE /api/knowledge-scope/:id
// Cascades child scopes + scope-level entities/relationships; detaches documents.
knowledgeScopeRoutes.delete('/:id', async (c) => {
  if (userType(getUserId(c)) === 'public') {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const id = parseInt(c.req.param('id'), 10)
  if (isNaN(id)) return c.json({ error: 'Invalid scope ID' }, 400)

  const scope = await c.env.DB.prepare('SELECT id FROM knowledge_scope WHERE id = ?')
    .bind(id)
    .first()
  if (!scope) return c.json({ error: 'Scope not found' }, 404)

  await c.env.DB.prepare('DELETE FROM knowledge_scope WHERE id = ?').bind(id).run()

  return new Response(null, { status: 204 })
})

export default knowledgeScopeRoutes
