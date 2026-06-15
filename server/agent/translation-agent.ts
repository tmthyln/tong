import { AIChatAgent } from '@cloudflare/ai-chat'
import { convertToModelMessages, streamText } from 'ai'
import { createWorkersAI } from 'workers-ai-provider'

/**
 * Model that drives the agent's reasoning/tool loop. Llama 3.3 70b supports
 * function-calling on Workers AI and is the same model the standalone Explain
 * feature already uses. Heavy extraction tasks keep using Kimi-K2.6 via their
 * existing pipelines (called as tools later).
 */
const AGENT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'

type OnFinish = Parameters<AIChatAgent<Env>['onChatMessage']>[0]
type OnChatOptions = Parameters<AIChatAgent<Env>['onChatMessage']>[1]

/**
 * Per-user collaborative translation agent (issue #12).
 *
 * Phase 0 scaffold: a minimal `AIChatAgent` that streams a reply so the
 * runtime, routing, DO binding, and the AI-SDK-v6 + workers-ai-provider stack
 * are validated end to end. Tools, the action stream, the suggestion model, and
 * the context-tree branch engine are layered on in later phases.
 *
 * Instance name = userId (see `server/index.ts` routing). The agent is a thin
 * orchestration shell; logic lives in testable functions under
 * `server/lib/agent/`.
 */
export class TranslationAgent extends AIChatAgent<Env> {
  async onChatMessage(onFinish: OnFinish, options?: OnChatOptions): Promise<Response | undefined> {
    const workersai = createWorkersAI({ binding: this.env.AI })
    const result = streamText({
      model: workersai(AGENT_MODEL),
      system:
        'You are a collaborative translation assistant for a Chinese (Mandarin) reading app. ' +
        '(Phase 0 scaffold — tools and proactive behavior are not wired up yet.)',
      messages: await convertToModelMessages(this.messages),
      abortSignal: options?.abortSignal,
      onFinish,
    })
    return result.toUIMessageStreamResponse()
  }
}
