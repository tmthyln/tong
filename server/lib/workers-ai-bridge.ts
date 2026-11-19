// Serves the container's virtual-host requests (http://workers-ai.tong/*)
// from inside the Workers runtime, via UmapContainer's outbound interception.

import { embedTexts } from './embedding'
import { workersAiClient } from './extraction/llm'

/**
 * Names the document map's topic clusters. Chosen by the label-quality eval
 * (eval/topics): best on descriptive (4.47 vs kimi-k2.6's 4.33) and fully
 * faithful labels (0.87 vs 0.79), as discriminative, at ~1/6 the cost per run.
 */
export const TOPIC_NAMING_MODEL = '@cf/zai-org/glm-5.3-flash'

// Single owner of the virtual hostname: umap.ts uses it as the interception
// key and injects it into the container as WORKERS_AI_BASE_URL.
export const WORKERS_AI_VIRTUAL_HOST = 'workers-ai.tong'

const EMBED_BATCH_SIZE = 90

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface ChatRequestBody {
  messages?: ChatMessage[]
  temperature?: number
  max_tokens?: number
}

interface EmbedRequestBody {
  texts?: string[]
}

export async function handleWorkersAiRequest(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return Response.json({ error: 'method not allowed' }, { status: 405 })
  }
  const path = new URL(request.url).pathname
  try {
    if (path === '/chat') return await handleChat(request, env)
    if (path === '/embed') return await handleEmbed(request, env)
    return Response.json({ error: 'not found' }, { status: 404 })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'workers-ai bridge failure'
    return Response.json({ error: message }, { status: 500 })
  }
}

async function handleChat(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as ChatRequestBody
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return Response.json({ error: 'messages required' }, { status: 400 })
  }
  // Same call shape as the eval (thinking off, plain-text answer); token-budget
  // policy lives in the Python caller (workers_ai.py).
  const result = await workersAiClient(env.AI, { attempts: 2 }).chat({
    model: TOPIC_NAMING_MODEL,
    messages: body.messages as ChatMessage[],
    temperature: body.temperature ?? 0.4,
    maxCompletionTokens: body.max_tokens ?? 1024,
    json: false,
  })
  const content = result.content ?? ''
  return Response.json({ content })
}

async function handleEmbed(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as EmbedRequestBody
  if (!Array.isArray(body.texts) || body.texts.length === 0) {
    return Response.json({ error: 'texts required' }, { status: 400 })
  }
  const batches: Promise<number[][]>[] = []
  for (let i = 0; i < body.texts.length; i += EMBED_BATCH_SIZE) {
    batches.push(embedTexts(env, body.texts.slice(i, i + EMBED_BATCH_SIZE), 'clustering'))
  }
  const results = await Promise.all(batches)
  return Response.json({ vectors: results.flat() })
}
