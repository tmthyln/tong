import { describe, it, expect } from 'vitest'
import { computeDocMaxVectors, isValidTopicsKey } from './library-visualization'

describe('isValidTopicsKey', () => {
  it('accepts opaque URL-safe tokens', () => {
    expect(isValidTopicsKey('deadbeef01234567')).toBe(true)
    expect(isValidTopicsKey('AbC-123_xyz')).toBe(true)
  })
  it('rejects path-traversal, empty, and oversized input', () => {
    expect(isValidTopicsKey('../secrets/xxxxx')).toBe(false)
    expect(isValidTopicsKey('a/b')).toBe(false)
    expect(isValidTopicsKey('')).toBe(false)
    expect(isValidTopicsKey('x'.repeat(65))).toBe(false)
  })
})

describe('computeDocMaxVectors', () => {
  it('takes the elementwise max across a document’s chunks', () => {
    const chunks = [
      { id: 1, source_document_id: 10 },
      { id: 2, source_document_id: 10 },
      { id: 3, source_document_id: 20 },
    ]
    const vectorMap = new Map<string, number[]>([
      ['1', [1, 5]],
      ['2', [3, 2]],
      ['3', [0, 0]],
    ])
    const result = computeDocMaxVectors(chunks, vectorMap)
    expect(result.get(10)).toEqual([3, 5])
    expect(result.get(20)).toEqual([0, 0])
  })

  it('skips chunks without vectors', () => {
    const result = computeDocMaxVectors([{ id: 1, source_document_id: 10 }], new Map())
    expect(result.size).toBe(0)
  })
})
