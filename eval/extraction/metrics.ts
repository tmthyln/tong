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
