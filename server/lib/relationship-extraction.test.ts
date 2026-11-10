import { describe, it, expect, vi } from 'vitest'
import {
  extractRelationships,
  extractRelationshipsForEdgeType,
  relationWindows,
  uniqueEntities,
  type EdgeTypeInput,
} from './relationship-extraction'
import { extractEntitiesBatch } from './entity-extraction'

const edge = (name: string): EdgeTypeInput => ({ name, reverseName: null, definition: name, examples: [] })
const reply = (content: string) => ({ choices: [{ message: { content }, finish_reason: 'stop' }] })
const ents = [
  { nodeType: 'PERSON', text: '唐三' },
  { nodeType: 'ORGANIZATION', text: '唐门' },
  { nodeType: 'PERSON', text: '唐三' },
]

describe('extractRelationships', () => {
  it('covers all edge types in one call and lists each entity once', async () => {
    const run = vi.fn().mockResolvedValue(reply('{"relations":[["唐三","MEMBER_OF","唐门","唐三是唐门弟子"],["唐三","BOGUS","唐门"]]}'))
    const rels = await extractRelationships('唐三是唐门弟子', ents, [edge('MEMBER_OF'), edge('FOUNDED')], { AI: { run } } as unknown as Env)
    expect(run).toHaveBeenCalledTimes(1)
    const user = run.mock.calls[0][1].messages[1].content as string
    expect(user.match(/唐三 \(PERSON\)/g)).toHaveLength(1)
    expect(rels).toEqual([{ edgeType: 'MEMBER_OF', fromText: '唐三', toText: '唐门', explanation: '唐三是唐门弟子' }])
  })

  it('skips the call when fewer than two distinct entities', async () => {
    const run = vi.fn()
    expect(await extractRelationships('x', [ents[0], ents[2]], [edge('A')], { AI: { run } } as unknown as Env)).toEqual([])
    expect(run).not.toHaveBeenCalled()
  })

  it('throws on model failure so workflow steps retry', async () => {
    const run = vi.fn().mockRejectedValue(new Error('down'))
    await expect(
      extractRelationships('唐三唐门', ents, [edge('A')], { AI: { run } } as unknown as Env, {
        client: { chat: () => Promise.reject(new Error('down')) },
      }),
    ).rejects.toThrow('down')
  })

  it('single-edge-type wrapper still works', async () => {
    const run = vi.fn().mockResolvedValue(reply('{"relations":[["唐三","MEMBER_OF","唐门"]]}'))
    const rels = await extractRelationshipsForEdgeType('唐三唐门', ents, edge('MEMBER_OF'), { AI: { run } } as unknown as Env)
    expect(rels).toHaveLength(1)
  })
})

describe('uniqueEntities', () => {
  it('dedupes by text', () => {
    expect(uniqueEntities(ents)).toEqual([
      { text: '唐三', label: 'PERSON' },
      { text: '唐门', label: 'ORGANIZATION' },
    ])
  })
})

describe('relationWindows', () => {
  it('tiles chunks with overlap and ends at the last chunk', () => {
    expect(relationWindows(10, 6, 4)).toEqual([
      [0, 6],
      [4, 10],
    ])
    expect(relationWindows(11, 6, 4)).toEqual([
      [0, 6],
      [4, 10],
      [8, 11],
    ])
    expect(relationWindows(3, 6, 4)).toEqual([[0, 3]])
    expect(relationWindows(0)).toEqual([])
  })
})

describe('extractEntitiesBatch', () => {
  it('extracts several chunks in one call and maps spans back per chunk', async () => {
    const run = vi.fn().mockResolvedValue(reply('{"entities":{"PERSON":["唐三"],"GPE":["诺丁城"]}}'))
    const out = await extractEntitiesBatch(
      ['唐三来了', '他去诺丁城找唐三'],
      [
        { name: 'PERSON', definition: '', examples: [] },
        { name: 'GPE', definition: '', examples: [] },
      ],
      { AI: { run } } as unknown as Env,
    )
    expect(run).toHaveBeenCalledTimes(1)
    expect(out[0]).toEqual([{ nodeType: 'PERSON', text: '唐三', startIndex: 0, endIndex: 2 }])
    expect(out[1]).toEqual([
      { nodeType: 'GPE', text: '诺丁城', startIndex: 2, endIndex: 5 },
      { nodeType: 'PERSON', text: '唐三', startIndex: 6, endIndex: 8 },
    ])
  })
})
