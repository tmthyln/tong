import { describe, it, expect, vi } from 'vitest'
import { createSelfTools, createUserFacingTools } from './tools'
import type { SuggestionPayload } from './suggestions'

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

describe('createUserFacingTools', () => {
  const opts = { toolCallId: 't', messages: [] } as never

  it('exposes the four user-facing tools', () => {
    const tools = createUserFacingTools({ addSuggestion: () => 'id' })
    expect(Object.keys(tools).sort()).toEqual([
      'askUser',
      'suggestCreateEntity',
      'suggestDeleteEntity',
      'suggestTranslation',
    ])
  })

  it('each tool queues a suggestion of the right kind and reports the id', async () => {
    const queued: SuggestionPayload[] = []
    const tools = createUserFacingTools({
      addSuggestion: (p) => {
        queued.push(p)
        return `sug-${queued.length}`
      },
    })

    const t = await tools.suggestTranslation.execute!(
      { documentId: 1, chunkId: 4, translation: 'hi', rationale: 'fits' },
      opts,
    )
    expect(t).toContain('sug-1')

    await tools.askUser.execute!({ question: 'Which sense?' }, opts)
    await tools.suggestCreateEntity.execute!({ documentId: 1, chunkId: 4, text: '孔子', entityType: 'PERSON' }, opts)
    await tools.suggestDeleteEntity.execute!({ documentId: 1, entityId: 9 }, opts)

    expect(queued.map((p) => p.kind)).toEqual(['translation', 'question', 'entity-create', 'entity-delete'])
  })
})
