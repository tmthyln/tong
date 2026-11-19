/**
 * Per-call response cache for the eval harnesses.
 *
 * A call is keyed by its model, the exact Workers AI arguments production would
 * send (`buildRunArgs`), and a replicate index. The whole result is stored —
 * content, finish reason, usage and latency — so a replayed run reports the
 * same cost as the live one, and changing a parser or a metric only needs a
 * rescore, not new calls. Replicate `rep` > 0 gets its own keys, so repeat runs
 * of a configuration are independent samples that are themselves cached
 * (rep 0 keeps the plain key).
 *
 * `fresh` skips reads but still writes: for timing runs, which need real calls.
 * Wall-clock times of a run with cache hits are not meaningful; `stats` says how
 * many calls were replayed.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildRunArgs, type ChatResult, type LlmClient } from '../../server/lib/extraction/llm'

export interface CacheOpts {
  dir: string
  /** Replicate index; 0 (default) is the plain key. */
  rep?: number
  /** Skip cache reads (still write). */
  fresh?: boolean
}

export interface CacheStats {
  hits: number
  misses: number
}

const key = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex')

function store(dir: string) {
  return {
    get<T>(k: string): T | undefined {
      const path = join(dir, k.slice(0, 2), `${k}.json`)
      return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : undefined
    },
    put(k: string, v: unknown) {
      const sub = join(dir, k.slice(0, 2))
      mkdirSync(sub, { recursive: true })
      // Write-then-rename, so an interrupted run never leaves a truncated entry.
      const tmp = join(sub, `${k}.${process.pid}.tmp`)
      writeFileSync(tmp, JSON.stringify(v))
      renameSync(tmp, join(sub, `${k}.json`))
    },
  }
}

async function through<T>(s: ReturnType<typeof store>, k: string, opts: CacheOpts, stats: CacheStats, make: () => Promise<T>): Promise<T> {
  if (!opts.fresh) {
    const hit = s.get<T>(k)
    if (hit !== undefined) {
      stats.hits++
      return hit
    }
  }
  stats.misses++
  const v = await make() // failures propagate and are not cached
  s.put(k, v)
  return v
}

export function cachedClient(inner: LlmClient, opts: CacheOpts, stats: CacheStats = { hits: 0, misses: 0 }): LlmClient & { stats: CacheStats } {
  const s = store(join(opts.dir, 'chat'))
  return {
    stats,
    chat: (req) => through<ChatResult>(s, key({ model: req.model, args: buildRunArgs(req), rep: opts.rep || undefined }), opts, stats, () => inner.chat(req)),
  }
}

type RawRun = (model: string, args: Record<string, unknown>) => Promise<unknown>

/** The same cache for raw `AI.run` calls (legacy code paths). */
export function cachedRawRun(inner: RawRun, opts: CacheOpts, stats: CacheStats = { hits: 0, misses: 0 }): RawRun {
  const s = store(join(opts.dir, 'raw'))
  return (model, args) => through(s, key({ model, args, rep: opts.rep || undefined }), opts, stats, () => inner(model, args))
}
