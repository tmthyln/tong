import { describe, it, expect, vi } from 'vitest'
import { userKnowsTerms } from './lexicon-knowledge'

function makeEnv(entries: { term: string; learnCount: number; failCount: number }[]) {
  const getAll = vi.fn().mockResolvedValue(
    entries.map((e) => ({
      term: e.term,
      learnCount: e.learnCount,
      failCount: e.failCount,
      firstLearned: null,
      lastLearned: null,
      lastFailed: null,
      firstSeen: null,
      lastSeen: null,
      firstFailed: null,
      tags: [],
    })),
  )
  const idFromName = vi.fn(() => 'id')
  const get = vi.fn(() => ({ getAll }))
  const env = { LEXICON: { idFromName, get } } as unknown as Env
  return { env, getAll }
}

describe('userKnowsTerms', () => {
  it('classifies known, seen-but-failing, and unseen terms', async () => {
    const { env } = makeEnv([
      { term: '好', learnCount: 3, failCount: 0 },
      { term: '难', learnCount: 0, failCount: 2 },
    ])

    const result = await userKnowsTerms(env, 'user:alice', ['好', '难', '陌生'])

    expect(result).toEqual([
      { term: '好', seen: true, known: true, learnCount: 3, failCount: 0 },
      { term: '难', seen: true, known: false, learnCount: 0, failCount: 2 },
      { term: '陌生', seen: false, known: false, learnCount: 0, failCount: 0 },
    ])
  })
})
