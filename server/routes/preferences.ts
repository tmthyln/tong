import { Hono } from 'hono'
import { Lexicon } from '../lexicon'
import { getUserId, userType } from '../lib/auth'

export interface Env {
  LEXICON: DurableObjectNamespace<Lexicon>
}

const preferencesRoutes = new Hono<{ Bindings: Env }>()

function getLexicon(c: Parameters<typeof getUserId>[0], env: Env) {
  const id = env.LEXICON.idFromName(getUserId(c))
  return env.LEXICON.get(id)
}

preferencesRoutes.get('/', async (c) => {
  if (userType(getUserId(c)) === 'public') {
    return c.json({ script: 'traditional', pronunciationPrimary: 'pinyin', pronunciationSecondaries: [], theme: 'light' })
  }
  const lexicon = getLexicon(c, c.env)
  const prefs = await lexicon.getPreferences()
  return c.json(prefs)
})

preferencesRoutes.patch('/', async (c) => {
  if (userType(getUserId(c)) === 'public') {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  const body = await c.req.json<{ script?: string; pronunciationPrimary?: string; pronunciationSecondaries?: string[]; theme?: string }>().catch(() => ({}))
  const lexicon = getLexicon(c, c.env)
  const updated = await lexicon.setPreferences(body)
  return c.json(updated)
})

export default preferencesRoutes
