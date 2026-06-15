import { describe, it, expect, vi } from 'vitest'
import { searchDictionary, segmentText } from './dictionary-search'

type Route = { match: string; all?: unknown }

function dbFromRoutes(routes: Route[]) {
  const prepare = vi.fn((sql: string) => {
    const r = routes.find((x) => sql.includes(x.match))
    return {
      bind: vi.fn(() => ({
        all: vi.fn().mockResolvedValue(r?.all ?? { results: [] }),
        first: vi.fn().mockResolvedValue(null),
      })),
    }
  })
  return { DB: { prepare } } as unknown as Env
}

describe('searchDictionary', () => {
  it('returns [] when there is no active filter', async () => {
    const env = dbFromRoutes([])
    expect(await searchDictionary(env, {})).toEqual([])
  })

  it('runs the bare tone path and groups definitions by entry', async () => {
    const env = dbFromRoutes([
      { match: 'WHERE e.pinyin LIKE', all: { results: [{ id: 7, traditional: '好', simplified: '好', pinyin: 'hao3' }] } },
      { match: 'FROM dictionary_definition', all: { results: [
        { entry_id: 7, definition: 'good' },
        { entry_id: 7, definition: 'well' },
      ] } },
    ])
    const results = await searchDictionary(env, { tone: '3' })
    expect(results).toEqual([
      { id: 7, traditional: '好', simplified: '好', pinyin: 'hao3', definitions: ['good', 'well'] },
    ])
  })
})

describe('segmentText', () => {
  it('returns empty result for empty input', async () => {
    const env = dbFromRoutes([])
    expect(await segmentText(env, '   ')).toEqual({ query: '', segmentations: [] })
  })

  it('prefers the longer (higher-scoring) segmentation', async () => {
    // Candidates for "你好": the whole word plus each character.
    const env = dbFromRoutes([
      {
        match: 'instr(',
        all: {
          results: [
            { id: 1, traditional: '你好', simplified: '你好', pinyin: 'ni3 hao3' },
            { id: 2, traditional: '你', simplified: '你', pinyin: 'ni3' },
            { id: 3, traditional: '好', simplified: '好', pinyin: 'hao3' },
          ],
        },
      },
      { match: 'FROM dictionary_definition', all: { results: [] } },
    ])
    const { query, segmentations } = await segmentText(env, '你好')
    expect(query).toBe('你好')
    // Best path: single "你好" segment (score 4) beats "你"+"好" (score 2).
    expect(segmentations[0].segments.map((s) => s.text)).toEqual(['你好'])
    expect(segmentations[0].score).toBe(4)
  })
})
