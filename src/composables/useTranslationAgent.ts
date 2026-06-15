import { ref } from 'vue'
import { AgentClient } from 'agents/client'
import type {
  TranslationAgentState,
  ActionEvent,
  ExplainParams,
  DisambiguateParams,
  ExplainResult,
  DisambiguateResult,
  ResolveAction,
  ResolveSuggestionResult,
  SuggestionPayload,
} from '@/types/agent'

// Module-level singleton: one WebSocket connection shared across the app, so
// every view/composable reads the same synced agent state and feeds the same
// action stream.

const ACTION_BATCH_MS = 1500

const state = ref<TranslationAgentState | null>(null)
const connected = ref(false)

let client: AgentClient | null = null
let currentUserId: string | null = null
let queue: ActionEvent[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
let hideListenerAttached = false

function connect(userId: string): void {
  if (client && currentUserId === userId) return
  disconnect()
  currentUserId = userId
  client = new AgentClient({
    agent: 'translation-agent',
    name: userId,
    host: window.location.host,
    onStateUpdate: (next) => {
      state.value = next as TranslationAgentState
    },
  })
  client.addEventListener('open', () => {
    connected.value = true
  })
  client.addEventListener('close', () => {
    connected.value = false
  })

  if (!hideListenerAttached && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void flushActions()
    })
    hideListenerAttached = true
  }
}

function disconnect(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  queue = []
  client?.close()
  client = null
  currentUserId = null
  connected.value = false
  state.value = null
}

async function flushActions(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (!client || queue.length === 0) return
  const batch = queue
  queue = []
  try {
    await client.call('recordActions', [batch])
  } catch {
    /* best-effort: drop on failure */
  }
}

function recordAction(event: ActionEvent): void {
  if (!client) return
  queue.push(event)
  if (!flushTimer) flushTimer = setTimeout(() => void flushActions(), ACTION_BATCH_MS)
}

async function resolveSuggestion(
  id: string,
  action: ResolveAction,
  payload?: { translation?: string; answer?: string },
): Promise<ResolveSuggestionResult | null> {
  if (!client) return null
  try {
    return await client.call<ResolveSuggestionResult>('resolveSuggestion', [id, action, payload])
  } catch {
    return null
  }
}

/** Explain via the agent; returns null on failure so callers can fall back to the route. */
async function explain(params: ExplainParams): Promise<{ explanation: string } | null> {
  if (!client) return null
  try {
    const r = await client.call<ExplainResult>('explain', [params])
    return r.ok ? { explanation: r.explanation } : null
  } catch {
    return null
  }
}

async function disambiguate(
  params: DisambiguateParams,
): Promise<{ explanation: string; entryId: number | undefined } | null> {
  if (!client) return null
  try {
    const r = await client.call<DisambiguateResult>('disambiguate', [params])
    return r.ok ? { explanation: r.explanation, entryId: r.entryId } : null
  } catch {
    return null
  }
}

async function investigate(goal: string): Promise<void> {
  if (!client) return
  try {
    await client.call('investigate', [goal])
  } catch {
    /* ignore */
  }
}

async function chat(message: string): Promise<string | null> {
  if (!client) return null
  try {
    const r = await client.call<{ reply: string }>('chat', [message])
    return r.reply
  } catch {
    return null
  }
}

export function useTranslationAgent() {
  return {
    state,
    connected,
    connect,
    disconnect,
    recordAction,
    flushActions,
    resolveSuggestion,
    explain,
    disambiguate,
    investigate,
    chat,
  }
}

export type { SuggestionPayload }
