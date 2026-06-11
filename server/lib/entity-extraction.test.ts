import { describe, it, expect, vi, beforeEach } from 'vitest'
import { extractEntities, extractEntitiesForNodeTypesWithUsage, deduplicateEntitiesLLM, removeOverlaps } from './entity-extraction'
import type { NodeTypeInput, ExtractedEntity } from './entity-extraction'

function kimiResponse(content: string) {
  return { choices: [{ message: { content } }] }
}

describe('entity-extraction with kimi-k2.6 response shape', () => {
  let mockEnv: { AI: { run: ReturnType<typeof vi.fn> } }

  beforeEach(() => {
    mockEnv = { AI: { run: vi.fn() } }
  })

  it('extracts entities from a chat-completion-shaped response', async () => {
    mockEnv.AI.run.mockResolvedValue(
      kimiResponse('{"entities":[{"text":"北京"}]}'),
    )
    const nodeTypes: NodeTypeInput[] = [
      { name: 'Location', definition: 'A place', examples: [] },
    ]
    const chunk = '北京是首都。'

    const entities = await extractEntities(chunk, nodeTypes, mockEnv as unknown as Env)

    expect(mockEnv.AI.run).toHaveBeenCalledWith(
      '@cf/moonshotai/kimi-k2.6',
      expect.objectContaining({
        max_completion_tokens: 1024,
        response_format: { type: 'json_object' },
        chat_template_kwargs: { thinking: false },
      }),
    )
    expect(entities).toEqual([
      { nodeType: 'Location', text: '北京', startIndex: 0, endIndex: 2 },
    ])
  })

  it('finds all occurrences of an extracted entity', async () => {
    mockEnv.AI.run.mockResolvedValue(
      kimiResponse('{"entities":[{"text":"北京"}]}'),
    )
    const entities = await extractEntities(
      '北京和北京',
      [{ name: 'Location', definition: '', examples: [] }],
      mockEnv as unknown as Env,
    )
    expect(entities).toHaveLength(2)
    expect(entities[0].startIndex).toBe(0)
    expect(entities[1].startIndex).toBe(3)
  })

  it('returns [] when the response has no choices', async () => {
    mockEnv.AI.run.mockResolvedValue({ choices: [] })
    const entities = await extractEntities(
      '北京',
      [{ name: 'Location', definition: '', examples: [] }],
      mockEnv as unknown as Env,
    )
    expect(entities).toEqual([])
  })

  it('returns [] when the content is malformed JSON', async () => {
    mockEnv.AI.run.mockResolvedValue(kimiResponse('not json at all'))
    const entities = await extractEntities(
      '北京',
      [{ name: 'Location', definition: '', examples: [] }],
      mockEnv as unknown as Env,
    )
    expect(entities).toEqual([])
  })

  it('handles JSON wrapped in markdown fences', async () => {
    mockEnv.AI.run.mockResolvedValue(
      kimiResponse('```json\n{"entities":[{"text":"北京"}]}\n```'),
    )
    const entities = await extractEntities(
      '北京',
      [{ name: 'Location', definition: '', examples: [] }],
      mockEnv as unknown as Env,
    )
    expect(entities).toHaveLength(1)
    expect(entities[0].text).toBe('北京')
  })
})

describe('deduplicateEntitiesLLM with kimi-k2.6 response shape', () => {
  it('returns entities unchanged when there are no conflicts', async () => {
    const env = { AI: { run: vi.fn() } }
    const entities: ExtractedEntity[] = [
      { nodeType: 'Location', text: '北京', startIndex: 0, endIndex: 2 },
      { nodeType: 'Person', text: '张三', startIndex: 5, endIndex: 7 },
    ]
    const result = await deduplicateEntitiesLLM('北京去找张三', entities, env as unknown as Env)
    expect(env.AI.run).not.toHaveBeenCalled()
    expect(result).toEqual(entities)
  })

  it('resolves a conflict group using a chat-completion-shaped LLM response', async () => {
    const env = {
      AI: {
        run: vi.fn().mockResolvedValue(
          kimiResponse('{"resolutions":[{"text":"北京大学","nodeType":"Organization"}]}'),
        ),
      },
    }
    const entities: ExtractedEntity[] = [
      { nodeType: 'Location', text: '北京', startIndex: 0, endIndex: 2 },
      { nodeType: 'Organization', text: '北京大学', startIndex: 0, endIndex: 4 },
    ]
    const result = await deduplicateEntitiesLLM('北京大学很好', entities, env as unknown as Env)
    expect(env.AI.run).toHaveBeenCalledTimes(1)
    expect(result).toEqual([
      { nodeType: 'Organization', text: '北京大学', startIndex: 0, endIndex: 4 },
    ])
  })

  it('falls back to longest-span when the LLM call throws', async () => {
    const env = {
      AI: { run: vi.fn().mockRejectedValue(new Error('boom')) },
    }
    const entities: ExtractedEntity[] = [
      { nodeType: 'Location', text: '北京', startIndex: 0, endIndex: 2 },
      { nodeType: 'Organization', text: '北京大学', startIndex: 0, endIndex: 4 },
    ]
    const result = await deduplicateEntitiesLLM('北京大学很好', entities, env as unknown as Env)
    expect(result).toHaveLength(1)
    expect(result[0].text).toBe('北京大学')
  })
})

describe('extractEntitiesForNodeTypesWithUsage options propagation', () => {
  it('propagates thinking=true and a custom max_completion_tokens', async () => {
    const env = {
      AI: {
        run: vi.fn().mockResolvedValue({
          ...kimiResponse('{"entities":[]}'),
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        }),
      },
    }
    await extractEntitiesForNodeTypesWithUsage(
      '北京',
      [{ name: 'Location', definition: '', examples: [] }],
      env as unknown as Env,
      { thinking: true, maxCompletionTokens: 8192 },
    )
    expect(env.AI.run).toHaveBeenCalledWith(
      '@cf/moonshotai/kimi-k2.6',
      expect.objectContaining({
        max_completion_tokens: 8192,
        chat_template_kwargs: { thinking: true },
      }),
    )
  })

  it('returns usage, finish_reason, latencyMs, and rawContent per run', async () => {
    const env = {
      AI: {
        run: vi.fn().mockResolvedValue({
          choices: [{ message: { content: '{"entities":[{"text":"北京"}]}' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 200, completion_tokens: 30, total_tokens: 230 },
        }),
      },
    }
    const runs = await extractEntitiesForNodeTypesWithUsage(
      '北京',
      [{ name: 'Location', definition: '', examples: [] }],
      env as unknown as Env,
    )
    expect(runs).toHaveLength(1)
    expect(runs[0].nodeType).toBe('Location')
    expect(runs[0].entities).toHaveLength(1)
    expect(runs[0].usage).toEqual({ promptTokens: 200, completionTokens: 30, totalTokens: 230 })
    expect(runs[0].finishReason).toBe('stop')
    expect(runs[0].rawContent).toBe('{"entities":[{"text":"北京"}]}')
    expect(typeof runs[0].latencyMs).toBe('number')
    expect(runs[0].latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('defaults to thinking=false and max_completion_tokens=1024', async () => {
    const env = {
      AI: {
        run: vi.fn().mockResolvedValue(kimiResponse('{"entities":[]}')),
      },
    }
    await extractEntitiesForNodeTypesWithUsage(
      '北京',
      [{ name: 'Location', definition: '', examples: [] }],
      env as unknown as Env,
    )
    expect(env.AI.run).toHaveBeenCalledWith(
      '@cf/moonshotai/kimi-k2.6',
      expect.objectContaining({
        max_completion_tokens: 1024,
        chat_template_kwargs: { thinking: false },
      }),
    )
  })
})

describe('removeOverlaps', () => {
  it('keeps the longer of two overlapping entities', () => {
    const input: ExtractedEntity[] = [
      { nodeType: 'Location', text: '北京', startIndex: 0, endIndex: 2 },
      { nodeType: 'Organization', text: '北京大学', startIndex: 0, endIndex: 4 },
    ]
    expect(removeOverlaps(input)).toEqual([
      { nodeType: 'Organization', text: '北京大学', startIndex: 0, endIndex: 4 },
    ])
  })
})
