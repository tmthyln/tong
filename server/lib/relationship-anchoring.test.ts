import { describe, it, expect } from 'vitest'
import { anchorRelations, type WindowMention } from './relationship-anchoring'

const m = (id: number, text: string, chunkId: number, startIndex = 0): WindowMention => ({
  id,
  text,
  chunkId,
  chunkOrder: chunkId,
  startIndex,
})

const rel = { fromText: '唐三', toText: '唐门', edgeType: 'MEMBER_OF', explanation: '' }

describe('anchorRelations', () => {
  it('anchors once per co-occurring chunk instead of the n×m cross product', () => {
    const mentions = [m(1, '唐三', 1, 0), m(2, '唐三', 1, 10), m(3, '唐门', 1, 20), m(4, '唐三', 2), m(5, '唐门', 2, 5), m(6, '唐三', 3)]
    const out = anchorRelations([rel], mentions)
    expect(out.map((r) => [r.fromEntityId, r.toEntityId])).toEqual([
      [1, 3],
      [4, 5],
    ])
  })

  it('falls back to the first mention of each when they never share a chunk', () => {
    const out = anchorRelations([rel], [m(7, '唐三', 2), m(8, '唐门', 4), m(9, '唐门', 3)])
    expect(out.map((r) => [r.fromEntityId, r.toEntityId])).toEqual([[7, 9]])
  })

  it('skips relations whose arguments are not mentioned', () => {
    expect(anchorRelations([rel], [m(1, '唐三', 1)])).toEqual([])
  })

  it('dedupes identical anchored relations', () => {
    const mentions = [m(1, '唐三', 1), m(2, '唐门', 1)]
    expect(anchorRelations([rel, rel], mentions)).toHaveLength(1)
  })
})
