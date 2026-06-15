import { AIChatAgent } from '@cloudflare/ai-chat'
import { convertToModelMessages, streamText, stepCountIs } from 'ai'
import { createWorkersAI } from 'workers-ai-provider'
import { callable } from 'agents'
import { createSelfTools, createUserFacingTools } from '../lib/agent/tools'
import {
  explainTermInContext,
  disambiguateTerm,
  type ExplainParams,
  type DisambiguateParams,
  type ExplainResult,
  type DisambiguateResult,
} from '../lib/agent/explain'
import { INITIAL_FOCUS, reduceFocusBatch, type ActionEvent } from '../lib/agent/actions'
import type { TranslationAgentState } from '../lib/agent/state'
import {
  makeSuggestion,
  addSuggestion,
  setSuggestionStatus,
  findSuggestion,
  type Suggestion,
  type SuggestionPayload,
  type SuggestionStatus,
} from '../lib/agent/suggestions'
import { createEntityFromText, deleteEntityCascade, enrichAfterEntityChange } from '../lib/agent/entities'
import { writeAgentTranslationDraft } from '../lib/translation'

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
export class TranslationAgent extends AIChatAgent<Env, TranslationAgentState> {
  initialState: TranslationAgentState = { focus: INITIAL_FOCUS, status: 'idle', suggestions: [] }

  async onChatMessage(onFinish: OnFinish, options?: OnChatOptions): Promise<Response | undefined> {
    const workersai = createWorkersAI({ binding: this.env.AI })
    // `this.name` is the instance name, which we key by userId.
    const tools = {
      ...createSelfTools({
        env: this.env,
        userId: this.name,
        documentId: this.state.focus.documentId ?? undefined,
      }),
      ...createUserFacingTools({ addSuggestion: (payload) => this.queueSuggestion(payload) }),
    }

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

  /** Append a suggestion to synced state (used by user-facing tools). Returns its id. */
  private queueSuggestion(payload: SuggestionPayload, originBranchId: string | null = null): string {
    const suggestion = makeSuggestion({
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      payload,
      originBranchId,
    })
    this.setState({ ...this.state, suggestions: addSuggestion(this.state.suggestions, suggestion) })
    return suggestion.id
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

  /**
   * Ingest a batch of user actions (the action stream). Appends them to the
   * action_log and updates the focus. The client batches these (mirroring the
   * existing /api/library/chunks/seen batching). Proactive turns off this log
   * arrive in Phase 6.
   */
  @callable()
  async recordActions(events: ActionEvent[]): Promise<void> {
    this.appendActions(events)
  }

  /** Persist actions to the action_log and fold focus into state. */
  private appendActions(events: ActionEvent[]): void {
    if (events.length === 0) return

    this.sql`CREATE TABLE IF NOT EXISTS action_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      at TEXT NOT NULL
    )`

    for (const event of events) {
      this.sql`INSERT INTO action_log (type, payload, at)
               VALUES (${event.type}, ${JSON.stringify(event)}, ${event.at})`
    }

    const focus = reduceFocusBatch(this.state.focus, events)
    this.setState({ ...this.state, focus })
  }

  /**
   * Resolve a suggestion: accept (perform the real mutation), dismiss, or answer
   * a question. On accept the corresponding ActionEvent is logged so the
   * proactive engine (Phase 6) sees the outcome.
   */
  @callable()
  async resolveSuggestion(
    id: string,
    action: 'accept' | 'dismiss' | 'answer',
    payload?: { translation?: string; answer?: string },
  ): Promise<ResolveSuggestionResult> {
    const suggestion = findSuggestion(this.state.suggestions, id)
    if (!suggestion) return { ok: false, error: 'Suggestion not found' }

    if (action === 'dismiss') {
      this.markSuggestion(id, 'dismissed')
      return { ok: true, status: 'dismissed' }
    }

    if (action === 'answer') {
      // Question answered — record acceptance; the answer can inform later turns.
      this.markSuggestion(id, 'accepted')
      return { ok: true, status: 'accepted' }
    }

    const outcome = await this.applySuggestion(suggestion, payload)
    if (!outcome.ok) return { ok: false, error: outcome.error }
    this.markSuggestion(id, 'accepted')
    return { ok: true, status: 'accepted', outcome: outcome.message }
  }

  private markSuggestion(id: string, status: SuggestionStatus): void {
    this.setState({ ...this.state, suggestions: setSuggestionStatus(this.state.suggestions, id, status) })
  }

  /** Perform the real mutation behind an accepted suggestion via the shared libs. */
  private async applySuggestion(
    s: Suggestion,
    payload?: { translation?: string },
  ): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
    const p = s.payload
    const at = new Date().toISOString()

    switch (p.kind) {
      case 'translation': {
        const content = payload?.translation ?? p.translation
        const { draftNumber } = await writeAgentTranslationDraft(this.env, p.chunkId, content)
        this.appendActions([
          { type: 'translation_saved', documentId: p.documentId, chunkId: p.chunkId, draftNumber, at },
        ])
        return { ok: true, message: `Wrote draft ${draftNumber} for chunk ${p.chunkId}.` }
      }
      case 'entity-create': {
        const r = await createEntityFromText(this.env, {
          text: p.text,
          entityType: p.entityType,
          chunkId: p.chunkId,
          documentId: p.documentId,
        })
        if (!r.ok) return { ok: false, error: r.error }
        this.ctx.waitUntil(enrichAfterEntityChange(this.env, p.chunkId, p.documentId))
        this.appendActions([
          { type: 'entity_created', documentId: p.documentId, chunkId: p.chunkId, text: p.text, entityType: p.entityType, at },
        ])
        return { ok: true, message: `Created ${r.ids.length} entity occurrence(s).` }
      }
      case 'entity-delete': {
        const r = await deleteEntityCascade(this.env, p.entityId)
        if (!r.ok) return { ok: false, error: r.error }
        this.appendActions([{ type: 'entity_deleted', documentId: p.documentId, entityId: p.entityId, at }])
        return { ok: true, message: `Deleted entity ${p.entityId}.` }
      }
      case 'question':
        return { ok: false, error: 'Questions are resolved with action "answer", not "accept".' }
    }
  }
}

export type ResolveSuggestionResult =
  | { ok: true; status: SuggestionStatus; outcome?: string }
  | { ok: false; error: string }
