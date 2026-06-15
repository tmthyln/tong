import { describe, it, expect, vi } from 'vitest'
import { createSelfTools } from './tools'

// Minimal env: dictionarySearch (no active filter) returns [] without DB hits.
function makeEnv() {
  const prepare = vi.fn(() => ({ bind: vi.fn(() => ({ all: vi.fn().mockResolvedValue({ results: [] }), first: vi.fn().mockResolvedValue(null) })) }))
  return { DB: { prepare } } as unknown as Env
}

describe('createSelfTools', () => {
  it('exposes the four self-tools with executable handlers', () => {
    const tools = createSelfTools({ env: makeEnv(), userId: 'user:alice', documentId: 1 })
    expect(Object.keys(tools).sort()).toEqual([
      'dictionarySearch',
      'entitySearch',
      'semanticChunkSearch',
      'userKnowsTerms',
    ])
    for (const t of Object.values(tools)) {
      expect(typeof t.execute).toBe('function')
    }
  })

  it('dictionarySearch.execute delegates to the dictionary lib', async () => {
    const tools = createSelfTools({ env: makeEnv(), userId: 'user:alice' })
    // Empty-filter search returns [] (no q/tone/def) — exercises the wiring.
    const out = await tools.dictionarySearch.execute!({ query: '' }, {
      toolCallId: 't1',
      messages: [],
    } as never)
    expect(out).toEqual([])
  })
})
