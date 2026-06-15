import { AIChatAgent } from '@cloudflare/ai-chat'
import { convertToModelMessages, streamText, stepCountIs } from 'ai'
import { createWorkersAI } from 'workers-ai-provider'
import { callable } from 'agents'
import { createSelfTools } from '../lib/agent/tools'
import {
  explainTermInContext,
  disambiguateTerm,
  type ExplainParams,
  type DisambiguateParams,
  type ExplainResult,
  type DisambiguateResult,
} from '../lib/agent/explain'

/**
 * Model that drives the agent's reasoning/tool loop. Llama 3.3 70b supports
 * function-calling on Workers AI and is the same model the standalone Explain
 * feature already uses. Heavy extraction tasks keep using Kimi-K2.6 via their
 * existing pipelines (called as tools later).
 */
const AGENT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'

const SYSTEM_PROMPT = `You are a collaborative translation assistant for a single user reading Chinese (Mandarin) documents in a web app.

You help with translation and knowledge-management tasks. You have tools to look things up:
- dictionarySearch: CEDICT dictionary (characters, pinyin, or English)
- semanticChunkSearch: find related passages
- entitySearch: find named entities already extracted for a document
- userKnowsTerms: check whether the user already knows specific characters/terms

Use tools before answering when a lookup would make your answer more accurate. Keep replies concise and direct; never use filler phrases. Prefer the user's own context (the document they are reading) over general knowledge.`

const MAX_TOOL_STEPS = 6

type OnFinish = Parameters<AIChatAgent<Env>['onChatMessage']>[0]
type OnChatOptions = Parameters<AIChatAgent<Env>['onChatMessage']>[1]

/**
 * Per-user collaborative translation agent (issue #12).
 *
 * Phases 0–2: `AIChatAgent` with a tool-using loop over the agent's self-tools,
 * plus `@callable` entry points for the Explain/Disambiguate actions (which the
 * standalone routes still expose independently). The action stream, suggestion
 * model, and context-tree branch engine arrive in later phases.
 *
 * Instance name = userId (see `server/index.ts` routing). The class is a thin
 * orchestration shell; logic lives in testable functions under `server/lib/agent/`.
 */
export class TranslationAgent extends AIChatAgent<Env> {
  async onChatMessage(onFinish: OnFinish, options?: OnChatOptions): Promise<Response | undefined> {
    const workersai = createWorkersAI({ binding: this.env.AI })
    // `this.name` is the instance name, which we key by userId.
    const tools = createSelfTools({ env: this.env, userId: this.name })

    const result = streamText({
      model: workersai(AGENT_MODEL),
      system: SYSTEM_PROMPT,
      messages: await convertToModelMessages(this.messages),
      tools,
      stopWhen: stepCountIs(MAX_TOOL_STEPS),
      abortSignal: options?.abortSignal,
      onFinish,
    })

    return result.toUIMessageStreamResponse()
  }

  /**
   * Explain how a term is used in context. Same logic as POST
   * /api/dictionary/explain; exposed here so the toolbar can route through the
   * agent (and the agent gains the context of what the user looked up).
   */
  @callable()
  async explain(params: ExplainParams): Promise<ExplainResult> {
    return explainTermInContext(this.env, params)
  }

  /** Disambiguate which dictionary entry best fits the usage (see /disambiguate). */
  @callable()
  async disambiguate(params: DisambiguateParams): Promise<DisambiguateResult> {
    return disambiguateTerm(this.env, params)
  }
}
