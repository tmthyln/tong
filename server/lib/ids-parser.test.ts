import { describe, it, expect } from 'vitest'
import { parseIdsFile, parseIds } from './ids-parser'

// ── parseIdsFile ──────────────────────────────────────────────────────────────

describe('parseIdsFile', () => {
  it('skips lines starting with #', () => {
    const text = '# This is a comment\nU+4E00\t一\t一'
    const result = parseIdsFile(text)
    expect(result).toHaveLength(1)
    expect(result[0].codepoint).toBe('U+4E00')
  })

  it('parses atomic char (self-referential variant skipped)', () => {
    const text = 'U+4E00\t一\t一'
    const result = parseIdsFile(text)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      codepoint: 'U+4E00',
      character: '一',
      decompositions: [],
    })
  })

  it('parses simple decomposition', () => {
    const text = 'U+4E01\t丁\t⿱一亅'
    const result = parseIdsFile(text)
    expect(result).toHaveLength(1)
    expect(result[0].decompositions).toHaveLength(1)
    expect(result[0].decompositions[0]).toEqual({
      idsString: '⿱一亅',
      tags: null,
      obsolete: false,
    })
  })

  it('parses multiple decomposition variants', () => {
    const text = 'U+4E0E\t与\t⿹②一[GTKV]\t⿻②一[J]'
    const result = parseIdsFile(text)
    expect(result).toHaveLength(1)
    expect(result[0].decompositions).toHaveLength(2)
    expect(result[0].decompositions[0].tags).toBe('GTKV')
    expect(result[0].decompositions[1].tags).toBe('J')
  })

  it('parses obsolete tag [O]', () => {
    const text = 'U+5999\t妙\t⿱少女[O]'
    const result = parseIdsFile(text)
    expect(result[0].decompositions[0].obsolete).toBe(true)
    expect(result[0].decompositions[0].tags).toBeNull()
  })

  it('parses combined obsolete tag [GO]', () => {
    const text = 'U+5999\t妙\t⿱少女[GO]'
    const result = parseIdsFile(text)
    expect(result[0].decompositions[0].obsolete).toBe(true)
    // "O" stripped, "G" remains
    expect(result[0].decompositions[0].tags).toBe('G')
  })

  it('strips bracket suffix from idsString', () => {
    const text = 'U+4E01\t丁\t⿱一亅[GTKV]'
    const result = parseIdsFile(text)
    expect(result[0].decompositions[0].idsString).toBe('⿱一亅')
  })

  it('handles supplementary-plane chars in codepoint', () => {
    // U+1B0A6 is a supplementary-plane character
    const text = 'U+1B0A6\t𛂦\t⿰木𛂦'
    const result = parseIdsFile(text)
    expect(result[0].codepoint).toBe('U+1B0A6')
    expect(result[0].decompositions).toHaveLength(1)
  })

  it('skips lines with only 2 columns', () => {
    const text = 'U+4E00\t一'
    const result = parseIdsFile(text)
    expect(result).toHaveLength(0)
  })
})

// ── parseIds ──────────────────────────────────────────────────────────────────

describe('parseIds', () => {
  it('returns null for empty string', () => {
    expect(parseIds('')).toBeNull()
  })

  it('parses simple binary operator', () => {
    const node = parseIds('⿱一亅')
    expect(node).toEqual({
      type: 'op',
      operator: '⿱',
      children: [
        { type: 'char', character: '一' },
        { type: 'char', character: '亅' },
      ],
    })
  })

  it('parses nested binary operators', () => {
    const node = parseIds('⿰⿱一丨亅')
    expect(node).toEqual({
      type: 'op',
      operator: '⿰',
      children: [
        {
          type: 'op',
          operator: '⿱',
          children: [
            { type: 'char', character: '一' },
            { type: 'char', character: '丨' },
          ],
        },
        { type: 'char', character: '亅' },
      ],
    })
  })

  it('parses ternary operator', () => {
    const node = parseIds('⿲氵彳木')
    expect(node).toEqual({
      type: 'op',
      operator: '⿲',
      children: [
        { type: 'char', character: '氵' },
        { type: 'char', character: '彳' },
        { type: 'char', character: '木' },
      ],
    })
  })

  it('parses unencoded DC (stroke count)', () => {
    const node = parseIds('⿱一③')
    expect(node).toEqual({
      type: 'op',
      operator: '⿱',
      children: [
        { type: 'char', character: '一' },
        { type: 'unencoded', strokeCount: 3 },
      ],
    })
  })

  it('parses deeply nested: ⿰讠⿱五口 (語-like)', () => {
    const node = parseIds('⿰讠⿱五口')
    expect(node).toEqual({
      type: 'op',
      operator: '⿰',
      children: [
        { type: 'char', character: '讠' },
        {
          type: 'op',
          operator: '⿱',
          children: [
            { type: 'char', character: '五' },
            { type: 'char', character: '口' },
          ],
        },
      ],
    })
  })

  it('parses single atomic char reference', () => {
    const node = parseIds('木')
    expect(node).toEqual({ type: 'char', character: '木' })
  })

  it('handles supplementary-plane component via Array.from', () => {
    // 𠀀 is U+20000, a supplementary-plane character (encoded as surrogate pair in JS strings)
    const node = parseIds('⿰木𠀀')
    expect(node).not.toBeNull()
    expect(node!.type).toBe('op')
    expect(node!.children).toHaveLength(2)
    expect(node!.children![1]).toEqual({ type: 'char', character: '𠀀' })
  })

  it('parses ② unencoded DC correctly (strokeCount=2)', () => {
    const node = parseIds('⿹②一')
    expect(node!.children![0]).toEqual({ type: 'unencoded', strokeCount: 2 })
  })
})
