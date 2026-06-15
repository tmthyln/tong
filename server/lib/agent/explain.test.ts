import { describe, it, expect, vi } from 'vitest'
import { explainTermInContext, disambiguateTerm } from './explain'

// Mocks env.DB (prepare→bind→first/all) and env.AI.run. The DB chain is shared:
// fetchContextWindow calls first() (chunk order) then all() (context chunks).
function makeEnv(opts: {
  chunkOrder: number | null
  context?: { content: string }[]
  aiResponse?: string
}) {
  const first = vi.fn().mockResolvedValue(
    opts.chunkOrder === null ? null : { chunk_order: opts.chunkOrder },
  )
  const all = vi.fn().mockResolvedValue({ results: opts.context ?? [] })
  const bind = vi.fn(() => ({ first, all }))
  const prepare = vi.fn(() => ({ bind }))
  const run = vi.fn().mockResolvedValue({ response: opts.aiResponse ?? '' })
  const env = { DB: { prepare }, AI: { run } } as unknown as Env
  return { env, prepare, first, all, run }
}

const EXPLAIN_ENTRIES = [
  { traditional: '如此', simplified: '如此', pinyin: 'ru2 ci3', definitions: ['so', 'thus'] },
]

const DISAMBIG_ENTRIES = [
  { id: 10, traditional: '行', simplified: '行', pinyin: 'xing2', definitions: ['to walk'] },
  { id: 20, traditional: '行', simplified: '行', pinyin: 'hang2', definitions: ['a row; a trade'] },
]

describe('explainTermInContext', () => {
  it('returns the model explanation when the chunk is found', async () => {
    const { env, run } = makeEnv({
      chunkOrder: 5,
      context: [{ content: '前文。' }, { content: '目标句。' }],
      aiResponse: '强调程度。',
    })

    const result = await explainTermInContext(env, {
      term: '如此',
      entries: EXPLAIN_ENTRIES,
      documentId: 1,
      chunkId: 2,
    })

    expect(result).toEqual({ ok: true, explanation: '强调程度。' })
    expect(run).toHaveBeenCalledTimes(1)
    // Context window and term are threaded into the prompt.
    const promptArgs = run.mock.calls[0][1] as { messages: { content: string }[] }
    expect(promptArgs.messages[1].content).toContain('如此')
    expect(promptArgs.messages[1].content).toContain('目标句。')
  })

  it('returns a 404 result and skips the model when the chunk is missing', async () => {
    const { env, run } = makeEnv({ chunkOrder: null })

    const result = await explainTermInContext(env, {
      term: '如此',
      entries: EXPLAIN_ENTRIES,
      documentId: 1,
      chunkId: 999,
    })

    expect(result).toEqual({ ok: false, status: 404, error: 'Chunk not found' })
    expect(run).not.toHaveBeenCalled()
  })
})

describe('disambiguateTerm', () => {
  it('returns the chosen entryId and explanation from valid JSON', async () => {
    const { env } = makeEnv({
      chunkOrder: 3,
      context: [{ content: '银行营业。' }],
      aiResponse: '{"entryId": 20, "explanation": "means a trade/row here"}',
    })

    const result = await disambiguateTerm(env, {
      term: '行',
      entries: DISAMBIG_ENTRIES,
      documentId: 1,
      chunkId: 2,
    })

    expect(result).toEqual({ ok: true, entryId: 20, explanation: 'means a trade/row here' })
  })

  it('falls back to the first entry id when the model returns an unknown id', async () => {
    const { env } = makeEnv({
      chunkOrder: 3,
      aiResponse: '{"entryId": 999, "explanation": "x"}',
    })

    const result = await disambiguateTerm(env, {
      term: '行',
      entries: DISAMBIG_ENTRIES,
      documentId: 1,
      chunkId: 2,
    })

    expect(result).toMatchObject({ ok: true, entryId: 10, explanation: 'x' })
  })

  it('falls back to the first entry id and empty explanation on malformed JSON', async () => {
    const { env } = makeEnv({ chunkOrder: 3, aiResponse: 'not json at all' })

    const result = await disambiguateTerm(env, {
      term: '行',
      entries: DISAMBIG_ENTRIES,
      documentId: 1,
      chunkId: 2,
    })

    expect(result).toEqual({ ok: true, entryId: 10, explanation: '' })
  })

  it('returns a 404 result when the chunk is missing', async () => {
    const { env, run } = makeEnv({ chunkOrder: null })

    const result = await disambiguateTerm(env, {
      term: '行',
      entries: DISAMBIG_ENTRIES,
      documentId: 1,
      chunkId: 999,
    })

    expect(result).toEqual({ ok: false, status: 404, error: 'Chunk not found' })
    expect(run).not.toHaveBeenCalled()
  })
})
