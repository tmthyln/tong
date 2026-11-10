import { describe, it, expect, vi } from 'vitest'
import { extract, parseExtraction } from './extract'
import { buildSystemPrompt, buildUserPrompt, type ExtractionSchema } from './schema'
import { locateMentions, resolveOverlaps } from './spans'
import { buildRunArgs, normalizeCompletion, workersAiClient, type LlmClient } from './llm'

const schema: ExtractionSchema = {
  entities: [
    { name: 'PERSON', description: 'A person', examples: ['孔子'] },
    { name: 'GPE', description: 'A city or country' },
  ],
  relations: [{ name: 'BORN_IN', description: 'born in', headLabels: ['PERSON'], tailLabels: ['GPE'] }],
}

describe('spans', () => {
  it('locates every verbatim occurrence and drops absent mentions', () => {
    const spans = locateMentions('唐三在诺丁城，唐三很好', [
      { text: '唐三', label: 'PERSON' },
      { text: '北京', label: 'GPE' },
    ])
    expect(spans.map((s) => s.start)).toEqual([0, 7])
  })

  it('resolves overlaps longest-first', () => {
    const kept = resolveOverlaps([
      { start: 0, end: 2, label: 'A', text: '' },
      { start: 1, end: 5, label: 'B', text: '' },
      { start: 5, end: 6, label: 'C', text: '' },
    ])
    expect(kept.map((s) => s.label)).toEqual(['B', 'C'])
  })
})

describe('prompts', () => {
  it('system prompt is independent of the text and known entities (cacheable)', () => {
    const a = buildSystemPrompt({ relations: schema.relations }, { knownEntities: [{ text: 'x', label: 'PERSON' }] })
    const b = buildSystemPrompt({ relations: schema.relations }, { knownEntities: [] })
    expect(a).toBe(b)
    expect(a).toContain('BORN_IN')
    expect(a).toContain('[PERSON → GPE]')
  })

  it('closed-world relation prompts list known entities in the user message', () => {
    const u = buildUserPrompt('文本', { relations: schema.relations }, { knownEntities: [{ text: '孔子', label: 'PERSON' }] })
    expect(u).toContain('- 孔子 (PERSON)')
    expect(u.endsWith('文本')).toBe(true)
  })

  it('joint prompts send the bare text', () => {
    expect(buildUserPrompt('文本', schema)).toBe('文本')
  })
})

describe('parseExtraction', () => {
  const text = '孔子生于鲁国陬邑。孔子是儒家创始人。'

  it('parses grouped entities, validates substrings, dedupes across labels', () => {
    const out = parseExtraction(
      '{"entities":{"PERSON":["孔子","老子"],"GPE":["鲁国","孔子"],"BOGUS":["陬邑"]}}',
      text,
      schema,
    )
    expect(out.mentions).toEqual([
      { text: '孔子', label: 'PERSON' },
      { text: '鲁国', label: 'GPE' },
    ])
    expect(out.spans.filter((s) => s.text === '孔子')).toHaveLength(2)
  })

  it('accepts list-of-objects entity output', () => {
    const out = parseExtraction('{"entities":[{"text":"孔子","type":"PERSON"}]}', text, schema)
    expect(out.mentions).toEqual([{ text: '孔子', label: 'PERSON' }])
  })

  it('keeps only relations between extracted entities that satisfy type constraints', () => {
    const out = parseExtraction(
      JSON.stringify({
        entities: { PERSON: ['孔子'], GPE: ['鲁国'] },
        relations: [
          ['孔子', 'BORN_IN', '鲁国', '孔子生于鲁国'],
          ['鲁国', 'BORN_IN', '孔子'], // wrong direction → violates head/tail labels
          ['孔子', 'BORN_IN', '北京'], // unknown entity
          ['孔子', 'NOPE', '鲁国'], // unknown relation
          { head: '孔子', relation: 'BORN_IN', tail: '鲁国' }, // duplicate
        ],
      }),
      text,
      schema,
    )
    expect(out.relations).toEqual([{ head: '孔子', label: 'BORN_IN', tail: '鲁国', evidence: '孔子生于鲁国' }])
  })

  it('validates closed-world relation arguments against known entities', () => {
    const out = parseExtraction('{"relations":[["孔子","BORN_IN","鲁国"],["孔子","BORN_IN","陬邑"]]}', text, { relations: schema.relations }, {
      knownEntities: [
        { text: '孔子', label: 'PERSON' },
        { text: '鲁国', label: 'GPE' },
      ],
    })
    expect(out.relations).toHaveLength(1)
  })

  it('parses classifications', () => {
    const out = parseExtraction('{"tone":"formal","topics":["history","nope","history"]}', text, {
      classifications: [
        { name: 'tone', labels: [{ name: 'formal' }, { name: 'casual' }] },
        { name: 'topics', labels: [{ name: 'history' }, { name: 'music' }], multiLabel: true },
      ],
    })
    expect(out.classifications).toEqual({ tone: ['formal'], topics: ['history'] })
  })

  it('returns empty output for unparseable content', () => {
    expect(parseExtraction('not json', text, schema).mentions).toEqual([])
    expect(parseExtraction(null, text, schema).relations).toEqual([])
  })
})

describe('llm client', () => {
  it('falls back to reasoning_content when content is empty', () => {
    const r = normalizeCompletion('m', { choices: [{ message: { content: null, reasoning_content: '{"a":1}' }, finish_reason: 'stop' }] }, 5)
    expect(r.content).toBe('{"a":1}')
  })

  it('reports usage incl. cached tokens and neurons', () => {
    const r = normalizeCompletion('m', { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 8 }, neurons: 1.5 } }, 5)
    expect(r.usage).toEqual({ promptTokens: 10, completionTokens: 2, cachedPromptTokens: 8, neurons: 1.5 })
  })

  it('disables thinking and requests JSON by default', () => {
    const args = buildRunArgs({ model: 'm', messages: [] })
    expect(args.chat_template_kwargs).toEqual({ thinking: false, enable_thinking: false })
    expect(args.response_format).toEqual({ type: 'json_object' })
  })

  it('workersAiClient calls the AI binding', async () => {
    const run = vi.fn().mockResolvedValue({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] })
    const client = workersAiClient({ run } as unknown as Ai)
    const r = await client.chat({ model: '@cf/x', messages: [{ role: 'user', content: 'hi' }] })
    expect(run).toHaveBeenCalledWith('@cf/x', expect.objectContaining({ temperature: 0 }))
    expect(r.content).toBe('{}')
  })
})

describe('extract', () => {
  it('never throws on transport errors', async () => {
    const client: LlmClient = { chat: vi.fn().mockRejectedValue(new Error('boom')) }
    const r = await extract(client, '孔子', schema, { model: 'm' })
    expect(r.error).toBe('boom')
    expect(r.mentions).toEqual([])
  })
})

describe('buildRunArgs model quirks', () => {
  it('omits chat_template_kwargs for Mistral models', () => {
    const args = buildRunArgs({ model: '@cf/mistralai/mistral-small-3.1-24b-instruct', messages: [] })
    expect(args.chat_template_kwargs).toBeUndefined()
    expect(args.reasoning_effort).toBe('none')
  })
})
