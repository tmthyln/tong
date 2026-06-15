// The user's action stream: the events the agent observes (temporal
// non-linearity). Pure types + reducers so the logic is unit-testable; the
// agent owns the action_log SQLite table and applies these.

export type ActionEvent =
  | { type: 'document_opened'; documentId: number; at: string }
  | { type: 'chunk_seen'; documentId: number; chunkId: number; at: string }
  | { type: 'translation_saved'; documentId: number; chunkId: number; draftNumber: number; at: string }
  | { type: 'entity_created'; documentId: number; chunkId: number; text: string; entityType: string; at: string }
  | { type: 'entity_deleted'; documentId: number; entityId: number; at: string }
  | { type: 'lookup'; term: string; documentId: number | null; chunkId: number | null; at: string }
  | { type: 'term_failed'; term: string; at: string }
  | { type: 'explain_requested'; term: string; documentId: number; chunkId: number; at: string }
  | { type: 'disambiguate_requested'; term: string; documentId: number; chunkId: number; at: string }

export type ActionType = ActionEvent['type']

export interface AgentFocus {
  documentId: number | null
  chunkId: number | null
  updatedAt: string | null
}

export const INITIAL_FOCUS: AgentFocus = { documentId: null, chunkId: null, updatedAt: null }

/** Fold a single action into the current focus (which document/chunk the user is on). */
export function reduceFocus(current: AgentFocus, event: ActionEvent): AgentFocus {
  switch (event.type) {
    case 'document_opened':
      return { documentId: event.documentId, chunkId: null, updatedAt: event.at }
    case 'chunk_seen':
    case 'translation_saved':
    case 'entity_created':
      return { documentId: event.documentId, chunkId: event.chunkId, updatedAt: event.at }
    case 'entity_deleted':
      return { documentId: event.documentId, chunkId: current.chunkId, updatedAt: event.at }
    case 'lookup':
    case 'explain_requested':
    case 'disambiguate_requested':
      return {
        documentId: event.documentId ?? current.documentId,
        chunkId: event.chunkId ?? current.chunkId,
        updatedAt: event.at,
      }
    case 'term_failed':
      return { ...current, updatedAt: event.at }
  }
}

/** Fold a batch of actions in order. */
export function reduceFocusBatch(current: AgentFocus, events: ActionEvent[]): AgentFocus {
  return events.reduce(reduceFocus, current)
}

/** One-line, LLM-friendly description of an action (used in turn summaries + logging). */
export function describeAction(event: ActionEvent): string {
  switch (event.type) {
    case 'document_opened':
      return `opened document ${event.documentId}`
    case 'chunk_seen':
      return `viewed chunk ${event.chunkId}`
    case 'translation_saved':
      return `saved a translation for chunk ${event.chunkId} (draft ${event.draftNumber})`
    case 'entity_created':
      return `created a ${event.entityType} entity "${event.text}" in chunk ${event.chunkId}`
    case 'entity_deleted':
      return `deleted entity ${event.entityId}`
    case 'lookup':
      return `looked up "${event.term}"`
    case 'term_failed':
      return `marked "${event.term}" as not known`
    case 'explain_requested':
      return `asked to explain "${event.term}"`
    case 'disambiguate_requested':
      return `asked to disambiguate "${event.term}"`
  }
}
