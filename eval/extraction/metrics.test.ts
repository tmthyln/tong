import { describe, expect, it } from 'vitest'
import { bootstrapF1, meanSd, pairedBootstrap, prf, type PRF } from './metrics'

const ex = (tp: number, fp: number, fn: number): PRF => prf(tp, fp, fn)

describe('bootstrapF1', () => {
  it('is degenerate when every example scores the same', () => {
    const xs = Array.from({ length: 10 }, () => ex(3, 1, 1))
    const ci = bootstrapF1(xs)
    expect(ci.lo).toBeCloseTo(0.75)
    expect(ci.hi).toBeCloseTo(0.75)
  })

  it('brackets the pooled F1 and widens with heterogeneous examples', () => {
    const mixed = [ex(10, 0, 0), ex(0, 5, 5), ex(8, 1, 1), ex(1, 4, 4), ex(6, 2, 2), ex(2, 3, 3)]
    const ci = bootstrapF1(mixed)
    const pooled = prf(27, 15, 15).f1
    expect(ci.lo).toBeLessThan(pooled)
    expect(ci.hi).toBeGreaterThan(pooled)
    expect(ci.hi - ci.lo).toBeGreaterThan(0.15)
    expect(bootstrapF1(mixed)).toEqual(ci) // seeded
  })
})

describe('pairedBootstrap', () => {
  it('detects a consistent per-example gain that separate intervals would blur', () => {
    const base = [ex(10, 0, 0), ex(0, 5, 5), ex(8, 1, 1), ex(1, 4, 4), ex(6, 2, 2), ex(2, 3, 3)]
    const better = base.map((p) => ex(p.tp + 1, Math.max(0, p.fp - 1), Math.max(0, p.fn - 1)))
    const d = pairedBootstrap(better, base)
    expect(d.delta).toBeGreaterThan(0)
    expect(d.lo).toBeGreaterThan(0)
    expect(d.pBetter).toBe(1)
    // Unpaired intervals overlap heavily.
    expect(bootstrapF1(better).lo).toBeLessThan(bootstrapF1(base).hi)
  })

  it('centres on zero for identical inputs', () => {
    const xs = [ex(3, 1, 2), ex(1, 2, 0)]
    expect(pairedBootstrap(xs, xs)).toMatchObject({ delta: 0, lo: 0, hi: 0, pBetter: 0 })
  })
})

describe('meanSd', () => {
  it('uses the sample standard deviation', () => {
    expect(meanSd([0.4, 0.5, 0.6])).toEqual({ mean: 0.5, sd: expect.closeTo(0.1, 10), n: 3 })
    expect(meanSd([0.3])).toEqual({ mean: 0.3, sd: 0, n: 1 })
  })
})
