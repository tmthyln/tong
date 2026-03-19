import type { Context } from 'hono'
import { getCookie } from 'hono/cookie'

/** Returns the userId, stripping the expiry suffix from test cookies. */
export function getUserId(c: Context): string {
  const raw = getCookie(c, 'session') || 'public'
  // test:{uuid}:{isoExpiresAt} → test:{uuid}
  if (raw.startsWith('test:')) {
    const parts = raw.split(':')
    return `test:${parts[1]}`
  }
  return raw
}

export function userType(userId: string): 'public' | 'authenticated' | 'test' {
  if (userId === 'public') return 'public'
  if (userId.startsWith('user:')) return 'authenticated'
  return 'test'
}
