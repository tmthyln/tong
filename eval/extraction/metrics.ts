import type { Mention, Relation } from '../../server/lib/extraction/extract'

export interface PRF {
  tp: number
  fp: number
  fn: number
  p: number
  r: number
  f1: number
}

export function prf(tp: number, fp: number, fn: number): PRF {
  const p = tp + fp === 0 ? 0 : tp / (tp + fp)
  const r = tp + fn === 0 ? 0 : tp / (tp + fn)
  return { tp, fp, fn, p, r, f1: p + r === 0 ? 0 : (2 * p * r) / (p + r) }
}

export function addPrf(a: PRF, b: PRF): PRF {
  return prf(a.tp + b.tp, a.fp + b.fp, a.fn + b.fn)
}

export const ZERO: PRF = prf(0, 0, 0)

function setScore(pred: Set<string>, gold: Set<string>): PRF {
  let tp = 0
  for (const k of pred) if (gold.has(k)) tp++
  return prf(tp, pred.size - tp, gold.size - tp)
}

const norm = (s: string) => s.replace(/[\s《》“”"「」]/g, '')

export function scoreMentions(pred: Mention[], gold: Mention[]): { typed: PRF; untyped: PRF } {
  return {
    typed: setScore(new Set(pred.map((m) => `${norm(m.text)}|${m.label}`)), new Set(gold.map((m) => `${norm(m.text)}|${m.label}`))),
    untyped: setScore(new Set(pred.map((m) => norm(m.text))), new Set(gold.map((m) => norm(m.text)))),
  }
}

export function scoreRelations(pred: Relation[], gold: Relation[]): { strict: PRF; undirected: PRF } {
  const strict = (r: Relation) => `${norm(r.head)}|${r.label}|${norm(r.tail)}`
  const undirected = (r: Relation) => {
    const [a, b] = [norm(r.head), norm(r.tail)].sort()
    return `${a}|${r.label}|${b}`
  }
  return {
    strict: setScore(new Set(pred.map(strict)), new Set(gold.map(strict))),
    undirected: setScore(new Set(pred.map(undirected)), new Set(gold.map(undirected))),
  }
}

/** Indices of points on the Pareto frontier: minimise cost, maximise quality. */
export function paretoFrontier(points: Array<{ cost: number; quality: number }>): number[] {
  const idx = points.map((_, i) => i).sort((a, b) => points[a].cost - points[b].cost || points[b].quality - points[a].quality)
  const out: number[] = []
  let best = -Infinity
  for (const i of idx) {
    if (points[i].quality > best) {
      out.push(i)
      best = points[i].quality
    }
  }
  return out
}

// ------------------------------------------------------------------ noise

/** Deterministic PRNG (mulberry32), so intervals are reproducible. */
function mulberry(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pooledF1 = (xs: PRF[], idx: number[]) => {
  let tp = 0, fp = 0, fn = 0
  for (const i of idx) (tp += xs[i].tp), (fp += xs[i].fp), (fn += xs[i].fn)
  return prf(tp, fp, fn).f1
}

const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]

export interface Interval {
  lo: number
  hi: number
}

/**
 * 95% percentile bootstrap interval of pooled (micro) F1, resampling examples:
 * how much the score depends on which passages happened to be sampled.
 */
export function bootstrapF1(perExample: PRF[], iters = 2000, seed = 1): Interval {
  const n = perExample.length
  if (n === 0) return { lo: 0, hi: 0 }
  const rand = mulberry(seed)
  const stats: number[] = []
  for (let b = 0; b < iters; b++) stats.push(pooledF1(perExample, Array.from({ length: n }, () => Math.floor(rand() * n))))
  stats.sort((x, y) => x - y)
  return { lo: quantile(stats, 0.025), hi: quantile(stats, 0.975) }
}

export interface PairedDelta extends Interval {
  /** F1(a) − F1(b) on the full set. */
  delta: number
  /** Share of resamples where a beats b. */
  pBetter: number
}

/**
 * Paired bootstrap of F1(a) − F1(b) over the same examples (index-aligned):
 * resampling pairs cancels the per-passage difficulty both strategies share,
 * so it is far tighter than comparing two separate intervals.
 */
export function pairedBootstrap(a: PRF[], b: PRF[], iters = 2000, seed = 1): PairedDelta {
  if (a.length !== b.length) throw new Error('pairedBootstrap: example lists differ in length')
  const n = a.length
  const all = Array.from({ length: n }, (_, i) => i)
  const delta = pooledF1(a, all) - pooledF1(b, all)
  if (n === 0) return { delta, lo: 0, hi: 0, pBetter: 0 }
  const rand = mulberry(seed)
  const ds: number[] = []
  let wins = 0
  for (let it = 0; it < iters; it++) {
    const idx = Array.from({ length: n }, () => Math.floor(rand() * n))
    const d = pooledF1(a, idx) - pooledF1(b, idx)
    ds.push(d)
    if (d > 0) wins++
  }
  ds.sort((x, y) => x - y)
  return { delta, lo: quantile(ds, 0.025), hi: quantile(ds, 0.975), pBetter: wins / iters }
}

/** Mean and sample standard deviation (run-to-run spread across replicates). */
export function meanSd(xs: number[]): { mean: number; sd: number; n: number } {
  const n = xs.length
  const mean = n ? xs.reduce((s, x) => s + x, 0) / n : NaN
  const sd = n > 1 ? Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0
  return { mean, sd, n }
}
