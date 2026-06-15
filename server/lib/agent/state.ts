// The agent's synced state — broadcast to connected clients (the side panel and
// inline surfaces both render from this). Kept deliberately small and
// UI-agnostic so the HCI layer can be retuned without touching the agent core.
//
// Extended across phases: focus (Phase 3), suggestions (Phase 4), branches
// (Phase 5).

import type { AgentFocus } from './actions'
import type { Suggestion } from './suggestions'

export type AgentStatus = 'idle' | 'thinking'

export interface TranslationAgentState {
  /** Which document/chunk the user is currently focused on. */
  focus: AgentFocus
  /** Whether the agent is mid-turn (for a subtle UI indicator). */
  status: AgentStatus
  /** Pending + resolved suggestions; the UI renders from this list. */
  suggestions: Suggestion[]
}
