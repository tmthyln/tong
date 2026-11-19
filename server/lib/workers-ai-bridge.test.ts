import { describe, it, expect, vi } from 'vitest'
import {
  handleWorkersAiRequest,
  TOPIC_NAMING_MODEL,
} from './workers-ai-bridge'
import { EMBEDDING_MODEL } from './embedding'
import { buildRunArgs } from './extraction/llm'

function makeEnv(run: ReturnType<typeof vi.fn>): Env {
  return { AI: { run } } as unknown as Env
}

function post(path: string, body: unknown): Request {
  return new Request(`http://workers-ai.tong${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('handleWorkersAiRequest /chat', () => {
  it('forwards messages to the naming model and returns choices content', async () => {
    const run = vi.fn().mockResolvedValue({
      choices: [{ message: { content: '{"topic_name": "唐诗"}' } }],
    })
    const res = await handleWorkersAiRequest(
      post('/chat', { messages: [{ role: 'user', content: 'hi' }], temperature: 0.2, max_tokens: 2048 }),
      makeEnv(run)
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ content: '{"topic_name": "唐诗"}' })
    expect(TOPIC_NAMING_MODEL).toBe('@cf/zai-org/glm-5.3-flash')
    // Same arguments the eval scored: thinking off, no JSON mode.
    expect(run).toHaveBeenCalledWith(
      TOPIC_NAMING_MODEL,
      buildRunArgs({ model: TOPIC_NAMING_MODEL, messages: [{ role: 'user', content: 'hi' }], temperature: 0.2, maxCompletionTokens: 2048, json: false })
    )
    const args = run.mock.calls[0][1]
    expect(args.response_format).toBeUndefined()
    expect(args.chat_template_kwargs).toEqual({ thinking: false, enable_thinking: false })
  })

  it('falls back to .response and applies default params', async () => {
    const run = vi.fn().mockResolvedValue({ response: 'plain' })
    const res = await handleWorkersAiRequest(
      post('/chat', { messages: [{ role: 'user', content: 'hi' }] }),
      makeEnv(run)
    )
    expect(await res.json()).toEqual({ content: 'plain' })
    expect(run.mock.calls[0][1]).toMatchObject({ temperature: 0.4, max_completion_tokens: 1024 })
  })

  it('rejects missing messages', async () => {
    const res = await handleWorkersAiRequest(post('/chat', {}), makeEnv(vi.fn()))
    expect(res.status).toBe(400)
  })
})

describe('handleWorkersAiRequest /embed', () => {
  it('batches texts by 90 and concatenates vectors', async () => {
    const run = vi.fn().mockImplementation((_model: string, args: { input: string[] }) =>
      Promise.resolve({ data: args.input.map((_, index) => ({ index, embedding: [0.1, 0.2] })) })
    )
    const texts = Array.from({ length: 200 }, (_, i) => `t${i}`)
    const res = await handleWorkersAiRequest(post('/embed', { texts }), makeEnv(run))
    const body = (await res.json()) as { vectors: number[][] }
    expect(body.vectors).toHaveLength(200)
    expect(run).toHaveBeenCalledTimes(3)
    expect(run).toHaveBeenCalledWith(EMBEDDING_MODEL, {
      input: texts.slice(0, 90).map((t) => `task: clustering | query: ${t}`),
      dimensions: 768,
    })
  })

  it('rejects missing texts', async () => {
    const res = await handleWorkersAiRequest(post('/embed', {}), makeEnv(vi.fn()))
    expect(res.status).toBe(400)
  })
})

describe('handleWorkersAiRequest routing', () => {
  it('404s unknown paths', async () => {
    const res = await handleWorkersAiRequest(post('/nope', {}), makeEnv(vi.fn()))
    expect(res.status).toBe(404)
  })

  it('405s non-POST', async () => {
    const res = await handleWorkersAiRequest(
      new Request('http://workers-ai.tong/chat'),
      makeEnv(vi.fn())
    )
    expect(res.status).toBe(405)
  })

  it('500s when AI.run keeps throwing', async () => {
    const run = vi.fn().mockRejectedValue(new Error('boom'))
    const res = await handleWorkersAiRequest(
      post('/chat', { messages: [{ role: 'user', content: 'hi' }] }),
      makeEnv(run)
    )
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'boom' })
  })
})
