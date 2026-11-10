/**
 * Shared plumbing for the local Workers AI evals (eval/extraction, eval/resolution):
 * auth (API token or the wrangler OAuth login, refreshed as it expires), the
 * REST client, a raw `ai.run` for legacy code paths, and small helpers.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execSync } from 'node:child_process'
import { workersAiRestClient, type LlmClient } from '../../server/lib/extraction/llm'

// ------------------------------------------------------------------ auth

let tokenCache: { token: string; exp: number } | null = null
function wranglerToken(): string {
  if (tokenCache && tokenCache.exp - Date.now() > 10 * 60_000) return tokenCache.token
  const path = join(homedir(), '.config/.wrangler/config/default.toml')
  const read = () => {
    const toml = readFileSync(path, 'utf8')
    return {
      token: /oauth_token\s*=\s*"([^"]+)"/.exec(toml)?.[1],
      exp: /expiration_time\s*=\s*"([^"]+)"/.exec(toml)?.[1],
    }
  }
  let { token, exp } = read()
  if (!token || !exp || Date.parse(exp) - Date.now() < 10 * 60_000) {
    execSync('npx wrangler whoami', { stdio: 'ignore' }) // refreshes the OAuth token
    ;({ token, exp } = read())
  }
  if (!token || !exp) throw new Error('No Cloudflare credentials: set CLOUDFLARE_API_TOKEN or run `npx wrangler login`')
  tokenCache = { token, exp: Date.parse(exp) }
  return token
}

function accountId(): string {
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID
  const out = execSync('npx wrangler whoami', { encoding: 'utf8' })
  const id = /│\s*[^│]+│\s*([0-9a-f]{32})\s*│/.exec(out)?.[1]
  if (!id) throw new Error('Could not determine account id; set CLOUDFLARE_ACCOUNT_ID')
  return id
}

let cached: { client: LlmClient; rawRun: (m: string, a: Record<string, unknown>) => Promise<unknown> } | null = null
export function clients() {
  if (cached) return cached
  const acct = accountId()
  const token = () => process.env.CLOUDFLARE_API_TOKEN ?? wranglerToken()
  const client = workersAiRestClient({ accountId: acct, apiToken: token, attempts: 7 })
  const rawRun = async (model: string, args: Record<string, unknown>) => {
    for (let i = 0; ; i++) {
      const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/ai/run/${model}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      })
      const body = (await res.json()) as { success?: boolean; result?: unknown; errors?: unknown }
      if (res.ok && body.success) return body.result
      if (i >= 6) throw new Error(`HTTP ${res.status} ${JSON.stringify(body.errors)}`)
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i))
    }
  }
  cached = { client, rawRun }
  return cached
}

// ------------------------------------------------------------------ helpers

export async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i], i)
      }
    }),
  )
  return out
}

export const slug = (s: string) => s.replace(/^@cf\//, '').replace(/[^a-z0-9.-]+/gi, '_')
