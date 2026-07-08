import { describe, it, expect, vi } from 'vitest'
import {
  handleWorkersAiRequest,
  TOPIC_NAMING_MODEL,
  KEYPHRASE_EMBEDDING_MODEL,
} from './workers-ai-bridge'

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
  it('forwards messages to kimi and returns choices content', async () => {
    const run = vi.fn().mockResolvedValue({
      choices: [{ message: { content: '{"topic_name": "唐诗"}' } }],
    })
    const res = await handleWorkersAiRequest(
      post('/chat', { messages: [{ role: 'user', content: 'hi' }], temperature: 0.2, max_tokens: 2048 }),
      makeEnv(run)
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ content: '{"topic_name": "唐诗"}' })
    expect(run).toHaveBeenCalledWith(TOPIC_NAMING_MODEL, {
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.2,
      max_completion_tokens: 2048,
      chat_template_kwargs: { thinking: false },
    })
  })

  it('falls back to .response and applies default params', async () => {
    const run = vi.fn().mockResolvedValue({ response: 'plain' })
    const res = await handleWorkersAiRequest(
      post('/chat', { messages: [{ role: 'user', content: 'hi' }] }),
      makeEnv(run)
    )
    expect(await res.json()).toEqual({ content: 'plain' })
    expect(run).toHaveBeenCalledWith(TOPIC_NAMING_MODEL, {
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.4,
      max_completion_tokens: 1024,
      chat_template_kwargs: { thinking: false },
    })
  })

  it('rejects missing messages', async () => {
    const res = await handleWorkersAiRequest(post('/chat', {}), makeEnv(vi.fn()))
    expect(res.status).toBe(400)
  })
})

describe('handleWorkersAiRequest /embed', () => {
  it('batches texts by 90 and concatenates vectors', async () => {
    const run = vi.fn().mockImplementation((_model: string, args: { text: string[] }) =>
      Promise.resolve({ data: args.text.map(() => [0.1, 0.2]) })
    )
    const texts = Array.from({ length: 200 }, (_, i) => `t${i}`)
    const res = await handleWorkersAiRequest(post('/embed', { texts }), makeEnv(run))
    const body = (await res.json()) as { vectors: number[][] }
    expect(body.vectors).toHaveLength(200)
    expect(run).toHaveBeenCalledTimes(3)
    expect(run).toHaveBeenCalledWith(KEYPHRASE_EMBEDDING_MODEL, { text: texts.slice(0, 90) })
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

  it('500s when AI.run throws', async () => {
    const run = vi.fn().mockRejectedValue(new Error('boom'))
    const res = await handleWorkersAiRequest(
      post('/chat', { messages: [{ role: 'user', content: 'hi' }] }),
      makeEnv(run)
    )
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'boom' })
  })
})
