/**
 * Minimal chat-completion client abstraction for information extraction.
 *
 * Two implementations share one interface so the exact same extraction code
 * runs inside the Worker (via the `AI` binding) and in local eval scripts
 * (via the Workers AI REST API):
 *   - workersAiClient(env.AI)
 *   - workersAiRestClient({ accountId, apiToken })
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  maxCompletionTokens?: number
  temperature?: number
  /** Request a JSON object response (`response_format: json_object`). Default true. */
  json?: boolean
  /** Enable model "thinking" where supported. Default false. */
  thinking?: boolean
}

export interface ChatUsage {
  promptTokens: number
  completionTokens: number
  cachedPromptTokens: number
  /** Workers AI neurons billed for this call (0 when not reported). */
  neurons: number
}

export interface ChatResult {
  model: string
  content: string | null
  finishReason: string | null
  usage: ChatUsage
  latencyMs: number
}

export interface LlmClient {
  chat(req: ChatRequest): Promise<ChatResult>
}

/** Raw OpenAI-style chat completion as returned by Workers AI chat models. */
interface RawCompletion {
  choices?: Array<{
    message?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number } | null
    neurons?: number
  }
  /** Legacy (non-chat-completion) Workers AI shape. */
  response?: unknown
}

type AiRun = (model: string, args: Record<string, unknown>) => Promise<unknown>

export const EMPTY_USAGE: ChatUsage = { promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0, neurons: 0 }

export function addUsage(a: ChatUsage, b: ChatUsage): ChatUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    cachedPromptTokens: a.cachedPromptTokens + b.cachedPromptTokens,
    neurons: a.neurons + b.neurons,
  }
}

/**
 * Build the provider-specific argument object. Thinking toggles differ by model
 * family, so we send every known spelling; models ignore unknown kwargs.
 */
export function buildRunArgs(req: ChatRequest): Record<string, unknown> {
  const thinking = req.thinking ?? false
  const args: Record<string, unknown> = {
    messages: req.messages,
    temperature: req.temperature ?? 0,
    max_completion_tokens: req.maxCompletionTokens ?? 1024,
    // Some legacy models only honour max_tokens.
    max_tokens: req.maxCompletionTokens ?? 1024,
  }
  // Mistral tokenizers reject chat_template kwargs outright (HTTP 400).
  if (!/mistral/i.test(req.model)) args.chat_template_kwargs = { thinking, enable_thinking: thinking }
  if (req.json ?? true) args.response_format = { type: 'json_object' }
  // Reasoning models (gpt-oss) honour reasoning_effort; Mistral only accepts 'none' | 'high'.
  if (!thinking) args.reasoning_effort = /mistral/i.test(req.model) ? 'none' : 'low'
  return args
}

export function normalizeCompletion(model: string, raw: RawCompletion, latencyMs: number): ChatResult {
  const choice = raw.choices?.[0]
  let content: string | null = choice?.message?.content ?? null
  // Some reasoning models (e.g. qwen3 on Workers AI) put the answer in the
  // reasoning channel when thinking is disabled.
  if (content === null || content === '') {
    content = choice?.message?.reasoning_content ?? choice?.message?.reasoning ?? null
  }
  if (content === null && typeof raw.response === 'string') content = raw.response
  if (content === null && raw.response && typeof raw.response === 'object') content = JSON.stringify(raw.response)
  return {
    model,
    content,
    finishReason: choice?.finish_reason ?? null,
    usage: {
      promptTokens: raw.usage?.prompt_tokens ?? 0,
      completionTokens: raw.usage?.completion_tokens ?? 0,
      cachedPromptTokens: raw.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      neurons: raw.usage?.neurons ?? 0,
    },
    latencyMs,
  }
}

async function withRetry<T>(fn: () => Promise<T>, attempts: number): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1000 * 2 ** i))
    }
  }
  throw lastErr
}

/** Client backed by the Worker `AI` binding. */
export function workersAiClient(ai: Ai, opts: { attempts?: number } = {}): LlmClient {
  const run = ai.run.bind(ai) as unknown as AiRun
  return {
    async chat(req) {
      const start = Date.now()
      const raw = (await withRetry(() => run(req.model, buildRunArgs(req)), opts.attempts ?? 3)) as RawCompletion
      return normalizeCompletion(req.model, raw, Date.now() - start)
    },
  }
}

/** Client backed by the Workers AI REST API — for local scripts and evals. */
export function workersAiRestClient(cfg: {
  accountId: string
  /** Token, or a provider called per request (lets callers refresh expiring OAuth tokens). */
  apiToken: string | (() => string)
  attempts?: number
  fetchImpl?: typeof fetch
}): LlmClient {
  const f = cfg.fetchImpl ?? fetch
  return {
    async chat(req) {
      const start = Date.now()
      const raw = await withRetry(async () => {
        const res = await f(
          `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/ai/run/${req.model}`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${typeof cfg.apiToken === 'function' ? cfg.apiToken() : cfg.apiToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(buildRunArgs(req)),
          },
        )
        const body = (await res.json()) as { success?: boolean; result?: RawCompletion; errors?: unknown }
        if (!res.ok || !body.success || !body.result) {
          throw new Error(`Workers AI ${req.model} HTTP ${res.status}: ${JSON.stringify(body.errors ?? body)}`)
        }
        return body.result
      }, cfg.attempts ?? 3)
      return normalizeCompletion(req.model, raw, Date.now() - start)
    },
  }
}

/** Approximate USD cost of a call: Workers AI bills $0.011 per 1,000 neurons. */
export function neuronsToUsd(neurons: number): number {
  return (neurons / 1000) * 0.011
}
