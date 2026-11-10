import { describe, it, expect } from 'vitest'
import {
  resolveCoreference,
  parseCorefGroups,
  linkEntities,
  parseLinks,
  nameSimilarity,
  retrieveCandidates,
  exactAliasMatch,
  type KbEntity,
  type LinkQuery,
} from './resolve'
import type { ChatRequest, ChatResult, LlmClient } from './llm'

function fakeClient(reply: (req: ChatRequest) => string | Error): LlmClient & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = []
  return {
    requests,
    async chat(req): Promise<ChatResult> {
      requests.push(req)
      const r = reply(req)
      if (r instanceof Error) throw r
      return { model: req.model, content: r, finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 5, cachedPromptTokens: 0, neurons: 1 }, latencyMs: 1 }
    },
  }
}

describe('parseCorefGroups', () => {
  it('keeps valid groups of ≥2, drops unknown and reused ids', () => {
    const g = parseCorefGroups('{"groups":[{"ids":[1,2],"label":"劉備"},{"ids":[2,3]},{"ids":[4,99]},[5,"6"]]}', new Set([1, 2, 3, 4, 5, 6]))
    expect(g).toEqual([
      { ids: [1, 2], label: '劉備' },
      { ids: [5, 6], label: null },
    ])
  })

  it('returns nothing for malformed output', () => {
    expect(parseCorefGroups('not json', new Set([1]))).toEqual([])
    expect(parseCorefGroups(null, new Set([1]))).toEqual([])
  })
})

describe('resolveCoreference', () => {
  const forms = [
    { text: '劉備', type: 'PERSON', count: 3, context: '【劉備】' },
    { text: '玄德', type: 'PERSON', count: 9 },
    { text: '涿縣', type: 'GPE', count: 1 },
    { text: '涿縣', type: 'LOCATION', count: 2 },
  ]

  it('merges identical texts before the call and maps groups back to forms', async () => {
    const client = fakeClient(() => '{"groups":[{"ids":[1,2],"label":"劉備"}]}')
    const r = await resolveCoreference(client, forms, { model: 'm' })
    expect(client.requests).toHaveLength(1)
    // 涿縣 is shown once, under its more frequent type
    expect(client.requests[0].messages[1].content).toContain('3 | LOCATION | ×3 | 涿縣')
    expect(r.entities).toEqual([
      { label: '劉備', forms: [0, 1] },
      { label: '涿縣', forms: [2, 3] },
    ])
  })

  it('labels a group by its most frequent form when the model gives none', async () => {
    const r = await resolveCoreference(fakeClient(() => '{"groups":[[1,2]]}'), forms, { model: 'm' })
    expect(r.entities[0].label).toBe('玄德')
  })

  it('falls back to identical-text merges when the call fails', async () => {
    const r = await resolveCoreference(fakeClient(() => new Error('boom')), forms, { model: 'm' })
    expect(r.errors).toHaveLength(1)
    expect(r.entities.map((e) => e.forms)).toEqual([[0], [1], [2, 3]])
  })

  it('splits into one call per type when asked', async () => {
    const client = fakeClient(() => '{"groups":[]}')
    await resolveCoreference(client, forms, { model: 'm', perType: true })
    // PERSON has 2 nodes; LOCATION has 1 (skipped)
    expect(client.requests).toHaveLength(1)
  })
})

describe('retrieval helpers', () => {
  it('scores names', () => {
    expect(nameSimilarity('劉備', '劉備')).toBe(1)
    expect(nameSimilarity('諾丁城', '諾丁')).toBe(0.8)
    expect(nameSimilarity('劉備', '劉表')).toBeCloseTo(1 / 3)
    expect(nameSimilarity('玄德', '劉備')).toBe(0)
  })

  const kb: KbEntity[] = [
    { id: 'a', type: 'PERSON', label: '劉備', aliases: ['劉備', '玄德'], contexts: [] },
    { id: 'b', type: 'PERSON', label: '劉表', aliases: ['劉表'], contexts: [] },
    { id: 'c', type: 'GPE', label: '洛陽', aliases: ['洛陽'], contexts: [] },
  ]
  const q = (aliases: string[], type = 'PERSON'): LinkQuery => ({ id: 'q', type, label: aliases[0], aliases })

  it('retrieves by alias overlap, best first', () => {
    expect(retrieveCandidates(q(['玄德']), kb, 5).map((e) => e.id)).toEqual(['a'])
    expect(retrieveCandidates(q(['劉焉']), kb, 5).map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('finds unambiguous exact alias matches only', () => {
    expect(exactAliasMatch(q(['玄德']), kb)?.id).toBe('a')
    expect(exactAliasMatch(q(['曹操']), kb)).toBeNull()
    const dup = [...kb, { id: 'd', type: 'PERSON', label: '玄德', aliases: ['玄德'], contexts: [] }]
    expect(exactAliasMatch(q(['玄德']), dup)).toBeNull()
  })
})

describe('linkEntities', () => {
  const kb: KbEntity[] = [
    { id: 'liubei', type: 'PERSON', label: '劉備', aliases: ['劉備'], contexts: ['…【劉備】…'] },
    { id: 'luoyang', type: 'GPE', label: '洛陽', aliases: ['洛陽'], contexts: [] },
  ]
  const queries: LinkQuery[] = [
    { id: 'x1', type: 'PERSON', label: '劉備', aliases: ['劉備'] },
    { id: 'x2', type: 'PERSON', label: '劉玄德', aliases: ['劉玄德'] },
    { id: 'x3', type: 'PERSON', label: '曹操', aliases: ['曹操'] },
  ]

  it('auto-links exact matches and asks the model only about the rest', async () => {
    const client = fakeClient(() => '{"links":{"Q1":"K1"}}')
    const r = await linkEntities(client, queries, kb, { model: 'm', retrieval: 'topk', autoLinkExact: true })
    expect(client.requests).toHaveLength(1)
    const prompt = client.requests[0].messages[1].content
    expect(prompt).toContain('Q1 | PERSON | 劉玄德')
    expect(prompt).not.toContain('曹操') // no candidates → NIL without a call
    expect([...r.links]).toEqual([
      ['x1', 'liubei'],
      ['x2', 'liubei'],
      ['x3', null],
    ])
  })

  it('leaves queries unlinked when the call fails', async () => {
    const r = await linkEntities(fakeClient(() => new Error('x')), queries, kb, { model: 'm', retrieval: 'all' })
    expect([...r.links.values()]).toEqual([null, null, null])
    expect(r.errors).toHaveLength(1)
  })

  it('ignores unknown ids in model output', () => {
    const m = parseLinks('{"links":{"Q1":"K9","Q2":"K1","Q7":"K1"}}', new Set(['Q1', 'Q2']), new Set(['K1']))
    expect([...m]).toEqual([
      ['Q1', null],
      ['Q2', 'K1'],
    ])
  })
})
