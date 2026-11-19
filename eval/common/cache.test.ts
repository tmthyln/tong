import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatRequest, LlmClient } from '../../server/lib/extraction/llm'
import { cachedClient, cachedRawRun } from './cache'

const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'eval-cache-'))
  dirs.push(d)
  return d
}
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

function counting(fail = false) {
  let n = 0
  const client: LlmClient = {
    async chat(req) {
      n++
      if (fail) throw new Error('rate limit')
      return { model: req.model, content: `answer ${n}`, finishReason: 'stop', usage: { promptTokens: 3, completionTokens: 2, cachedPromptTokens: 0, neurons: 7 }, latencyMs: 120 }
    },
  }
  return { client, calls: () => n }
}

const req: ChatRequest = { model: 'm', messages: [{ role: 'user', content: '你好' }] }

describe('cachedClient', () => {
  it('replays the whole result, usage and latency included', async () => {
    const dir = tmp()
    const inner = counting()
    const a = await cachedClient(inner.client, { dir }).chat(req)
    const c = cachedClient(inner.client, { dir })
    const b = await c.chat(req)
    expect(inner.calls()).toBe(1)
    expect(b).toEqual(a)
    expect(b.usage.neurons).toBe(7)
    expect(c.stats).toEqual({ hits: 1, misses: 0 })
  })

  it('keys on the production run arguments, so any request change misses', async () => {
    const dir = tmp()
    const inner = counting()
    const c = cachedClient(inner.client, { dir })
    await c.chat(req)
    await c.chat({ ...req, temperature: 0.4 })
    await c.chat({ ...req, json: false })
    await c.chat({ ...req, model: 'other' })
    expect(inner.calls()).toBe(4)
  })

  it('gives each replicate its own entries; rep 0 is the plain key', async () => {
    const dir = tmp()
    const inner = counting()
    await cachedClient(inner.client, { dir }).chat(req)
    await cachedClient(inner.client, { dir, rep: 0 }).chat(req)
    const r1 = await cachedClient(inner.client, { dir, rep: 1 }).chat(req)
    const r1again = await cachedClient(inner.client, { dir, rep: 1 }).chat(req)
    expect(inner.calls()).toBe(2)
    expect(r1again).toEqual(r1)
  })

  it('fresh skips reads but refreshes the entry', async () => {
    const dir = tmp()
    const inner = counting()
    await cachedClient(inner.client, { dir }).chat(req)
    const fresh = await cachedClient(inner.client, { dir, fresh: true }).chat(req)
    const after = await cachedClient(inner.client, { dir }).chat(req)
    expect(inner.calls()).toBe(2)
    expect(after.content).toBe(fresh.content)
  })

  it('does not cache failures', async () => {
    const dir = tmp()
    await expect(cachedClient(counting(true).client, { dir }).chat(req)).rejects.toThrow()
    const ok = counting()
    await cachedClient(ok.client, { dir }).chat(req)
    expect(ok.calls()).toBe(1)
    expect(readdirSync(join(dir, 'chat')).length).toBe(1)
  })
})

describe('cachedRawRun', () => {
  it('caches raw AI.run calls by model and arguments', async () => {
    const dir = tmp()
    let n = 0
    const run = cachedRawRun(async () => ({ response: ++n }), { dir })
    expect(await run('m', { a: 1 })).toEqual({ response: 1 })
    expect(await run('m', { a: 1 })).toEqual({ response: 1 })
    expect(await run('m', { a: 2 })).toEqual({ response: 2 })
  })
})
