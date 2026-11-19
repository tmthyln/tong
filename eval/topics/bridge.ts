/**
 * Local stand-in for server/lib/workers-ai-bridge.ts, so the production Python
 * pipeline (container/topics.py) runs unmodified against any Workers AI model.
 *
 *   POST /m/<model>/chat   {messages, temperature, max_tokens} → {content}
 *   POST /fresh/m/<model>/chat   same, bypassing the response cache (timing runs)
 *   POST /m/<model>/embed  {texts} → {vectors}   (embeddinggemma-2, 'clustering' task)
 *
 * Responses are cached on disk (keyed by model + request) so reruns are free and
 * deterministic, and every billed call is appended to results/usage.jsonl.
 */
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { clients } from '../common/workers-ai'
import { mapLimit } from '../../server/lib/map-limit'
import { embedTexts, type EmbeddingTask } from '../../server/lib/embedding'
import type { ChatMessage } from '../../server/lib/extraction/llm'
import { DATA_DIR } from './corpus'
import { isRateLimit } from '../../server/lib/workers-ai-bridge'

export const RESULTS_DIR = join(process.cwd(), 'eval/topics/results')
const CACHE = join(DATA_DIR, 'cache')

const sha = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 24)

/** fresh: skip the cache read (still write) — for timing runs. */
function cached<T>(kind: string, key: unknown, make: () => Promise<T>, fresh = false): Promise<T> {
  const dir = join(CACHE, kind)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, sha(key) + '.json')
  if (!fresh && existsSync(path)) return Promise.resolve(JSON.parse(readFileSync(path, 'utf8')) as T)
  return make().then((v) => (writeFileSync(path, JSON.stringify(v)), v))
}

function logUsage(row: Record<string, unknown>) {
  mkdirSync(RESULTS_DIR, { recursive: true })
  appendFileSync(join(RESULTS_DIR, 'usage.jsonl'), JSON.stringify({ t: Date.now(), ...row }) + '\n')
}

/** A fake `env` whose AI.run goes to the REST API — lets lib/embedding run locally. */
export function restEnv(): Env {
  const { rawRun } = clients()
  return { AI: { run: (m: string, a: Record<string, unknown>) => rawRun(m, a) } } as unknown as Env
}

/** Embed with the production embedder, cached per text. */
export async function embedCached(texts: string[], task: EmbeddingTask): Promise<number[][]> {
  const env = restEnv()
  const out: number[][] = new Array(texts.length)
  const missing: number[] = []
  const dir = join(CACHE, `embed-${task}`)
  mkdirSync(dir, { recursive: true })
  texts.forEach((t, i) => {
    const p = join(dir, sha(t) + '.json')
    if (existsSync(p)) out[i] = JSON.parse(readFileSync(p, 'utf8'))
    else missing.push(i)
  })
  const batches: number[][] = []
  for (let i = 0; i < missing.length; i += 50) batches.push(missing.slice(i, i + 50))
  await mapLimit(batches, 4, async (b) => {
    const vecs = await embedTexts(env, b.map((i) => texts[i]), task)
    b.forEach((i, k) => {
      out[i] = vecs[k]
      writeFileSync(join(dir, sha(texts[i]) + '.json'), JSON.stringify(vecs[k]))
    })
  })
  if (missing.length) logUsage({ kind: 'embed', task, texts: missing.length, chars: missing.reduce((n, i) => n + texts[i].length, 0) })
  return out
}

export async function chatCached(model: string, messages: ChatMessage[], temperature: number, maxTokens: number, tag: string, fresh = false): Promise<string> {
  const { client } = clients()
  return cached('chat', { model, messages, temperature, maxTokens }, async () => {
    const r = await client.chat({ model, messages, temperature, maxCompletionTokens: maxTokens, json: false })
    logUsage({ kind: 'chat', tag, model, neurons: r.usage.neurons, prompt: r.usage.promptTokens, completion: r.usage.completionTokens, ms: r.latencyMs, finish: r.finishReason })
    return r.content ?? ''
  }, fresh)
}

export function serveBridge(port: number) {
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    try {
      const m = /^\/(fresh\/)?m\/([^/]+)\/(chat|embed)$/.exec(req.url ?? '')
      if (req.method !== 'POST' || !m) return send(404, { error: 'not found' })
      const model = decodeURIComponent(m[2])
      let raw = ''
      for await (const c of req) raw += c
      const body = JSON.parse(raw) as { messages?: ChatMessage[]; temperature?: number; max_tokens?: number; texts?: string[] }
      if (m[3] === 'embed') return send(200, { vectors: await embedCached(body.texts ?? [], 'clustering') })
      // Same defaults as the production bridge.
      const content = await chatCached(model, body.messages ?? [], body.temperature ?? 0.4, body.max_tokens ?? 1024, 'namer', !!m[1])
      send(200, { content })
    } catch (err) {
      console.error(err)
      const message = err instanceof Error ? err.message : String(err)
      // Same status mapping as the production bridge.
      send(isRateLimit(message) ? 429 : 500, { error: message })
    }
  })
  server.listen(port, '127.0.0.1', () => console.log(`bridge on http://127.0.0.1:${port}`))
  return server
}
