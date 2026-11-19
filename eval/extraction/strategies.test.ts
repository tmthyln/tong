import { describe, expect, it } from 'vitest'
import type { ChatRequest, LlmClient } from '../../server/lib/extraction/llm'
import type { ExtractionSchema } from '../../server/lib/extraction/schema'
import { getStrategy } from './strategies'
import type { Example } from './datasets'

const schema: ExtractionSchema = {
  entities: [
    { name: 'PERSON', description: 'A person' },
    { name: 'PLACE', description: 'A place' },
  ],
  relations: [{ name: 'LIKES', description: 'head likes tail' }],
  instructions: 'The text is Chinese (Mandarin) prose.',
}

const parts = ['唐三在诺丁城。', '小舞喜欢唐三。', '唐三去了史莱克。', '小舞也在。', '大师在诺丁城。']
const ex: Example = { id: 'x', text: parts.join('\n'), parts, gold: { mentions: [], relations: [] } }

function fakeClient() {
  const calls: ChatRequest[] = []
  const client: LlmClient = {
    async chat(req) {
      calls.push(req)
      const user = req.messages[req.messages.length - 1].content
      const isRe = req.messages[0].content.includes('LIKES')
      const content = isRe
        ? JSON.stringify({ relations: user.includes('小舞喜欢唐三') ? [['小舞', 'LIKES', '唐三', '小舞喜欢唐三']] : [] })
        : JSON.stringify({ entities: { PERSON: ['唐三', '唐', '小舞', '大师'], PLACE: ['诺丁城', '史莱克'] } })
      return { model: req.model, content, finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 5, cachedPromptTokens: 0, neurons: 2 }, latencyMs: 1 }
    },
  }
  return { client, calls }
}

describe('app-pipeline', () => {
  it('runs production batching, overlap removal, windowing and anchoring', async () => {
    const { client, calls } = fakeClient()
    const pred = await getStrategy('app-pipeline').run(ex, { client, rawRun: async () => null, model: 'm', thinking: false, schema })

    // 5 chunks → NER batches of 4 + 1; relation windows [0,5) only (6-chunk windows).
    const ner = calls.filter((c) => !c.messages[0].content.includes('LIKES'))
    const re = calls.filter((c) => c.messages[0].content.includes('LIKES'))
    expect(ner).toHaveLength(2)
    expect(re).toHaveLength(1)
    expect(pred.calls).toBe(3)
    expect(pred.usage.neurons).toBe(6)

    // removeOverlaps drops 唐 nested inside 唐三.
    expect(pred.mentions.map((m) => m.text).sort()).toEqual(['史莱克', '唐三', '大师', '小舞', '诺丁城'].sort())
    expect(pred.relations).toEqual([{ head: '小舞', label: 'LIKES', tail: '唐三', evidence: '小舞喜欢唐三' }])
    expect(pred.anchorDropped).toBe(0)
  })

  it('propagates a failed call, as the workflow step does (runOne records it)', async () => {
    const client: LlmClient = { chat: async () => { throw new Error('boom') } }
    await expect(getStrategy('app-pipeline').run(ex, { client, rawRun: async () => null, model: 'm', thinking: false, schema })).rejects.toThrow()
  })
})
