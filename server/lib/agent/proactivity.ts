// Proactivity policy (temporal non-linearity): when, on its own cadence, the
// agent should consider helping. Pure functions so the policy is unit-testable;
// the agent debounces via this.schedule and runs the turn.

import { describeAction, type ActionEvent, type AgentFocus } from './actions'

/** How long after the last action to wait before considering a proactive turn. */
export const PROACTIVE_DEBOUNCE_SECONDS = 20

/**
 * Whether a proactive turn is worth running. Passive viewing (chunk_seen,
 * document_opened) alone does not trigger the model — only intent-bearing
 * actions do, so we don't burn LLM calls on scrolling.
 */
export function shouldConsider(newActions: ActionEvent[]): boolean {
  return newActions.some(
    (a) =>
      a.type === 'translation_saved' ||
      a.type === 'entity_created' ||
      a.type === 'entity_deleted' ||
      a.type === 'lookup' ||
      a.type === 'term_failed' ||
      a.type === 'explain_requested' ||
      a.type === 'disambiguate_requested',
  )
}

export function summarizeRecentActions(actions: ActionEvent[]): string {
  if (actions.length === 0) return '(no recent actions)'
  return actions.map((a) => `- ${describeAction(a)}`).join('\n')
}

export function buildProactivePrompt(focus: AgentFocus, summary: string): string {
  const focusLine =
    focus.documentId != null
      ? `The user is on document ${focus.documentId}${focus.chunkId != null ? `, chunk ${focus.chunkId}` : ''}.`
      : 'The user has no document focused.'

  return `You are proactively assisting a single user reading Chinese (Mandarin).

${focusLine}

Recent actions:
${summary}

Decide whether to help. You may:
- call a user-facing tool (suggestTranslation, askUser, suggestCreateEntity, suggestDeleteEntity) to surface a suggestion the user can accept or dismiss;
- call investigate(goal) to spin off a deeper investigation branch for a complex, multi-part task;
- or do nothing if there is nothing genuinely useful to add.

Be sparing — only surface high-value help, and use the lookup tools to verify before suggesting.`
}
