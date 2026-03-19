import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { getUserId, userType } from '../lib/auth'
import { Lexicon } from '../lexicon'

export interface Env {
  LEXICON: DurableObjectNamespace<Lexicon>
}

const authRoutes = new Hono<{ Bindings: Env }>()

authRoutes.get('/me', (c) => {
  const raw = getCookie(c, 'session') || 'public'
  const userId = getUserId(c)
  const type = userType(userId)

  let expiresAt: string | undefined
  if (raw.startsWith('test:')) {
    const parts = raw.split(':')
    if (parts.length >= 3) {
      expiresAt = parts.slice(2).join(':')
    }
  }

  return c.json({ userId, userType: type, ...(expiresAt ? { expiresAt } : {}) })
})

authRoutes.post('/login', async (c) => {
  const body = await c.req.json<{ account: string }>()
  const account = body.account

  if (account !== 'alice' && account !== 'bob') {
    return c.json({ error: 'Unknown account' }, 400)
  }

  const userId = `user:${account}`
  setCookie(c, 'session', userId, { httpOnly: true, sameSite: 'Lax', path: '/' })

  return c.json({ userId, userType: 'authenticated' })
})

authRoutes.post('/logout', async (c) => {
  const userId = getUserId(c)
  if (userId.startsWith('test:')) {
    const id = c.env.LEXICON.idFromName(userId)
    const stub = c.env.LEXICON.get(id)
    await stub.destroy()
  }
  deleteCookie(c, 'session', { path: '/' })
  return c.json({ userId: 'public', userType: 'public' })
})

authRoutes.post('/test-account', async (c) => {
  const uuid = crypto.randomUUID()
  const userId = `test:${uuid}`
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)

  const id = c.env.LEXICON.idFromName(userId)
  const stub = c.env.LEXICON.get(id)
  await stub.setAlarm()

  const cookieValue = `${userId}:${expiresAt.toISOString()}`
  setCookie(c, 'session', cookieValue, { httpOnly: true, sameSite: 'Lax', path: '/' })

  return c.json({ userId, userType: 'test', expiresAt: expiresAt.toISOString() })
})

export default authRoutes
