// Serves the container's virtual-host requests (http://workers-ai.tong/*)
// from inside the Workers runtime, via UmapContainer's outbound interception.

export const TOPIC_NAMING_MODEL = '@cf/moonshotai/kimi-k2.6'
export const KEYPHRASE_EMBEDDING_MODEL = '@cf/google/embeddinggemma-300m'

const EMBED_BATCH_SIZE = 90

interface ChatMessage {
  role: string
  content: string
}

interface ChatRequestBody {
  messages?: ChatMessage[]
  temperature?: number
  max_tokens?: number
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>
  response?: string
}

interface EmbedRequestBody {
  texts?: string[]
}

interface EmbeddingResponse {
  data?: number[][]
}

type AiRun = (model: string, args: Record<string, unknown>) => Promise<unknown>

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
  const result = (await (env.AI.run as AiRun)(TOPIC_NAMING_MODEL, {
    messages: body.messages,
    temperature: body.temperature ?? 0.4,
    // kimi-k2.6 ignores max_tokens; it wants max_completion_tokens. Thinking
    // mode must be off or reasoning eats the budget before the JSON answer.
    max_completion_tokens: Math.max(body.max_tokens ?? 1024, 1024),
    chat_template_kwargs: { thinking: false },
  })) as ChatCompletionResponse
  const content = result.choices?.[0]?.message?.content ?? result.response ?? ''
  return Response.json({ content })
}

async function handleEmbed(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as EmbedRequestBody
  if (!Array.isArray(body.texts) || body.texts.length === 0) {
    return Response.json({ error: 'texts required' }, { status: 400 })
  }
  const vectors: number[][] = []
  for (let i = 0; i < body.texts.length; i += EMBED_BATCH_SIZE) {
    const result = (await (env.AI.run as AiRun)(KEYPHRASE_EMBEDDING_MODEL, {
      text: body.texts.slice(i, i + EMBED_BATCH_SIZE),
    })) as EmbeddingResponse
    vectors.push(...(result.data ?? []))
  }
  return Response.json({ vectors })
}
