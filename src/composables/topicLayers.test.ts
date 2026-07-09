import { describe, it, expect } from 'vitest'
import { visibleLayerIndex } from './topicLayers'

describe('visibleLayerIndex', () => {
  it('returns -1 for zero layers', () => {
    expect(visibleLayerIndex(1, 0)).toBe(-1)
  })

  it('always returns 0 for a single layer', () => {
    expect(visibleLayerIndex(0.2, 1)).toBe(0)
    expect(visibleLayerIndex(20, 1)).toBe(0)
  })

  it('shows the coarsest layer fully zoomed out and the finest fully zoomed in', () => {
    expect(visibleLayerIndex(0.2, 3)).toBe(0)
    expect(visibleLayerIndex(20, 3)).toBe(2)
  })

  it('clamps k outside the zoom extent', () => {
    expect(visibleLayerIndex(0.01, 3)).toBe(0)
    expect(visibleLayerIndex(100, 3)).toBe(2)
  })

  it('is monotonic in k', () => {
    let prev = -1
    for (const k of [0.2, 0.5, 1, 2, 4, 8, 16, 20]) {
      const idx = visibleLayerIndex(k, 4)
      expect(idx).toBeGreaterThanOrEqual(prev)
      prev = idx
    }
  })
})
