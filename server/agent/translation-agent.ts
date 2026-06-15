import { AIChatAgent } from '@cloudflare/ai-chat'
import { convertToModelMessages, streamText, generateText, stepCountIs } from 'ai'
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
import type { TranslationAgentState, BranchSummary } from '../lib/agent/state'
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
import {
  ROOT_NODE_ID,
  assembleBranchView,
  synthesizeSuggestions,
  type ContextNode,
  type Finding,
  type FindingPayload,
  type NodeStatus,
} from '../lib/agent/context-tree'
import { createBranchTools, buildBranchSystemPrompt } from '../lib/agent/branch'
import {
  PROACTIVE_DEBOUNCE_SECONDS,
  shouldConsider,
  summarizeRecentActions,
  buildProactivePrompt,
} from '../lib/agent/proactivity'
import { tool } from 'ai'
import { z } from 'zod'

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
const BRANCH_MAX_STEPS = 8

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
  initialState: TranslationAgentState = { focus: INITIAL_FOCUS, status: 'idle', suggestions: [], branches: [] }

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
    await this.scheduleConsider()
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

  // ── Context tree + durable-fiber branches (investigative non-linearity) ──────

  /**
   * Launch an investigation branch toward `goal`, as a child of `parentId`
   * (root by default). The branch runs as a durable fiber: it assembles a view
   * of shared + ancestor findings, investigates with the branch tools, and
   * records findings. On completion, shared candidate suggestions are promoted.
   */
  @callable()
  async investigate(goal: string, parentId: string = ROOT_NODE_ID): Promise<{ branchId: string }> {
    this.ensureTreeSchema()
    this.ensureRootNode()
    const branchId = crypto.randomUUID()
    const now = new Date().toISOString()
    this.sql`INSERT INTO context_node (id, parent_id, kind, goal, status, created_at, updated_at)
             VALUES (${branchId}, ${parentId}, 'branch', ${goal}, 'open', ${now}, ${now})`
    this.refreshBranchesState()
    this.ctx.waitUntil(this.runBranch(branchId))
    return { branchId }
  }

  private async runBranch(branchId: string): Promise<void> {
    this.setBranchStatus(branchId, 'investigating')
    const { nodes, findings } = this.loadTree()
    const view = assembleBranchView(nodes, findings, branchId)
    const tools = createBranchTools({
      env: this.env,
      userId: this.name,
      documentId: this.state.focus.documentId ?? undefined,
      recordFinding: (payload, shared) => this.insertFinding(branchId, payload, shared),
    })
    const workersai = createWorkersAI({ binding: this.env.AI })

    try {
      // Durable fiber: the LLM investigation is checkpointed against eviction.
      await this.runFiber(branchId, async () => {
        await generateText({
          model: workersai(AGENT_MODEL),
          system: buildBranchSystemPrompt(view),
          prompt: 'Begin your investigation now.',
          tools,
          stopWhen: stepCountIs(BRANCH_MAX_STEPS),
        })
      })
      this.setBranchStatus(branchId, 'done')
    } catch (err) {
      console.error('[agent] branch failed', branchId, err)
      this.setBranchStatus(branchId, 'failed')
    }

    this.promoteFindings()
  }

  /** On DO restart, fail any branch that was mid-investigation (no auto-resume). */
  async onFiberRecovered(ctx: { name: string }): Promise<void> {
    this.setBranchStatus(ctx.name, 'failed')
  }

  private ensureTreeSchema(): void {
    this.sql`CREATE TABLE IF NOT EXISTS context_node (
      id TEXT PRIMARY KEY, parent_id TEXT, kind TEXT NOT NULL, goal TEXT NOT NULL,
      status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`
    this.sql`CREATE TABLE IF NOT EXISTS finding (
      id TEXT PRIMARY KEY, node_id TEXT NOT NULL, payload TEXT NOT NULL,
      shared INTEGER NOT NULL, created_at TEXT NOT NULL
    )`
  }

  private ensureRootNode(): void {
    const existing = this.sql<{ id: string }>`SELECT id FROM context_node WHERE id = ${ROOT_NODE_ID}`
    if (existing.length > 0) return
    const now = new Date().toISOString()
    this.sql`INSERT INTO context_node (id, parent_id, kind, goal, status, created_at, updated_at)
             VALUES (${ROOT_NODE_ID}, NULL, 'root', 'shared context', 'open', ${now}, ${now})`
  }

  private loadTree(): { nodes: ContextNode[]; findings: Finding[] } {
    const nodeRows = this.sql<{
      id: string; parent_id: string | null; kind: string; goal: string; status: string; created_at: string; updated_at: string
    }>`SELECT id, parent_id, kind, goal, status, created_at, updated_at FROM context_node`
    const findingRows = this.sql<{
      id: string; node_id: string; payload: string; shared: number; created_at: string
    }>`SELECT id, node_id, payload, shared, created_at FROM finding`

    const nodes: ContextNode[] = nodeRows.map((r) => ({
      id: r.id,
      parentId: r.parent_id,
      kind: r.kind as ContextNode['kind'],
      goal: r.goal,
      status: r.status as NodeStatus,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }))
    const findings: Finding[] = findingRows.map((r) => ({
      id: r.id,
      nodeId: r.node_id,
      payload: JSON.parse(r.payload) as FindingPayload,
      shared: Number(r.shared) === 1,
      createdAt: r.created_at,
    }))
    return { nodes, findings }
  }

  private insertFinding(nodeId: string, payload: FindingPayload, shared: boolean): void {
    const now = new Date().toISOString()
    this.sql`INSERT INTO finding (id, node_id, payload, shared, created_at)
             VALUES (${crypto.randomUUID()}, ${nodeId}, ${JSON.stringify(payload)}, ${shared ? 1 : 0}, ${now})`
  }

  private setBranchStatus(branchId: string, status: NodeStatus): void {
    const now = new Date().toISOString()
    this.sql`UPDATE context_node SET status = ${status}, updated_at = ${now} WHERE id = ${branchId}`
    this.refreshBranchesState()
  }

  private refreshBranchesState(): void {
    const rows = this.sql<{ id: string; goal: string; status: string }>`
      SELECT id, goal, status FROM context_node WHERE kind = 'branch' ORDER BY created_at`
    const branches: BranchSummary[] = rows.map((r) => ({ id: r.id, goal: r.goal, status: r.status as NodeStatus }))
    this.setState({ ...this.state, branches })
  }

  /** Promote shared candidate-suggestions from the blackboard into state.suggestions. */
  private promoteFindings(): void {
    const { findings } = this.loadTree()
    const existing = new Set(this.state.suggestions.map((s) => JSON.stringify(s.payload)))
    for (const { suggestion } of synthesizeSuggestions(findings)) {
      const key = JSON.stringify(suggestion)
      if (existing.has(key)) continue
      this.queueSuggestion(suggestion)
      existing.add(key)
    }
  }

  // ── Proactive engine (temporal non-linearity) ───────────────────────────────

  /** Debounce: (re)schedule a single proactive consideration once activity settles. */
  private async scheduleConsider(): Promise<void> {
    for (const s of this.getSchedules()) {
      if (s.callback === 'considerProactively') await this.cancelSchedule(s.id)
    }
    await this.schedule(PROACTIVE_DEBOUNCE_SECONDS, 'considerProactively', {})
  }

  /**
   * Scheduled handler: review actions since the last consideration and maybe
   * help — surface suggestions and/or spawn investigation branches. The model is
   * free to do nothing.
   */
  async considerProactively(): Promise<void> {
    const cursor = Number(this.getMeta('lastConsideredActionId') ?? '0')
    const rows = this.sql<{ id: number; payload: string }>`
      SELECT id, payload FROM action_log WHERE id > ${cursor} ORDER BY id LIMIT 50`
    if (rows.length === 0) return

    const actions = rows.map((r) => JSON.parse(r.payload) as ActionEvent)
    this.setMeta('lastConsideredActionId', String(rows[rows.length - 1].id))

    if (!shouldConsider(actions)) return

    this.setState({ ...this.state, status: 'thinking' })
    try {
      const workersai = createWorkersAI({ binding: this.env.AI })
      const tools = {
        ...createSelfTools({ env: this.env, userId: this.name, documentId: this.state.focus.documentId ?? undefined }),
        ...createUserFacingTools({ addSuggestion: (payload) => this.queueSuggestion(payload) }),
        investigate: tool({
          description:
            'Spin off a deeper investigation branch for a complex, multi-part task. Returns once the branch is launched.',
          inputSchema: z.object({ goal: z.string().describe('What the branch should investigate') }),
          execute: async ({ goal }) => {
            const { branchId } = await this.investigate(goal)
            return `Launched investigation branch ${branchId}.`
          },
        }),
      }

      await generateText({
        model: workersai(AGENT_MODEL),
        system: buildProactivePrompt(this.state.focus, summarizeRecentActions(actions)),
        prompt: 'Consider whether to help right now.',
        tools,
        stopWhen: stepCountIs(MAX_TOOL_STEPS),
      })
    } catch (err) {
      console.error('[agent] proactive turn failed', err)
    } finally {
      this.setState({ ...this.state, status: 'idle' })
    }
  }

  private ensureMetaSchema(): void {
    this.sql`CREATE TABLE IF NOT EXISTS agent_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`
  }

  private getMeta(key: string): string | null {
    this.ensureMetaSchema()
    const rows = this.sql<{ value: string }>`SELECT value FROM agent_meta WHERE key = ${key}`
    return rows.length > 0 ? rows[0].value : null
  }

  private setMeta(key: string, value: string): void {
    this.ensureMetaSchema()
    this.sql`INSERT INTO agent_meta (key, value) VALUES (${key}, ${value})
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  }
}

export type ResolveSuggestionResult =
  | { ok: true; status: SuggestionStatus; outcome?: string }
  | { ok: false; error: string }
