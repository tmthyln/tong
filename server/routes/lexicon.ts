import { Hono } from 'hono'
import { Lexicon } from '../lexicon'
import { getUserId, userType } from '../lib/auth'

export interface Env {
  LEXICON: DurableObjectNamespace<Lexicon>
}

const lexiconRoutes = new Hono<{ Bindings: Env }>()

function getLexicon(c: Parameters<typeof getUserId>[0], env: Env) {
  const id = env.LEXICON.idFromName(getUserId(c))
  return env.LEXICON.get(id)
}

lexiconRoutes.get('/', async (c) => {
  const lexicon = getLexicon(c, c.env)
  const entries = await lexicon.getAll()
  return c.json({ entries })
})

lexiconRoutes.get('/:term', async (c) => {
  const term = c.req.param('term')
  const lexicon = getLexicon(c, c.env)
  const entry = await lexicon.getTerm(term)

  if (!entry) {
    return c.json({ error: 'Term not found' }, 404)
  }
  return c.json({ entry })
})

lexiconRoutes.post('/:term', async (c) => {
  if (userType(getUserId(c)) === 'public') {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const term = c.req.param('term')
  const lexicon = getLexicon(c, c.env)

  const body = await c.req.json<{ tags?: string[] }>().catch(() => ({ tags: [] }))
  const result = await lexicon.addOrRelearn(term, body.tags)

  return c.json(
    {
      message: result.relearned ? 'Term marked as relearned' : 'Term added to lexicon',
      entry: result.entry,
      relearned: result.relearned,
    },
    result.relearned ? 200 : 201
  )
})

lexiconRoutes.post('/:term/fail', async (c) => {
  if (userType(getUserId(c)) === 'public') {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const term = c.req.param('term')
  const lexicon = getLexicon(c, c.env)
  const entry = await lexicon.markFailed(term)

  if (!entry) {
    return c.json({ error: 'Term not found' }, 404)
  }
  return c.json({ message: 'Term marked as failed', entry })
})

lexiconRoutes.put('/:term/tags', async (c) => {
  if (userType(getUserId(c)) === 'public') {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const term = c.req.param('term')
  const lexicon = getLexicon(c, c.env)

  const body = await c.req.json<{ tags: string[] }>()
  const entry = await lexicon.updateTags(term, body.tags)

  if (!entry) {
    return c.json({ error: 'Term not found' }, 404)
  }
  return c.json({ message: 'Tags updated', entry })
})

export default lexiconRoutes
