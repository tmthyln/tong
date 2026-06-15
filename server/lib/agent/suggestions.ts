// The suggestion model — the single source of truth the UI renders (side panel
// + inline cards both read from it). User-facing tools append suggestions; the
// user resolves them via the agent's resolveSuggestion RPC. Pure types +
// reducers so the logic is unit-testable.

export type SuggestionKind = 'translation' | 'entity-create' | 'entity-delete' | 'question'
export type SuggestionSurface = 'inline' | 'panel'
export type SuggestionStatus = 'pending' | 'accepted' | 'dismissed'

export type SuggestionPayload =
  | { kind: 'translation'; documentId: number; chunkId: number; translation: string; rationale?: string }
  | { kind: 'entity-create'; documentId: number; chunkId: number; text: string; entityType: string; rationale?: string }
  | { kind: 'entity-delete'; documentId: number; entityId: number; label?: string; rationale?: string }
  | { kind: 'question'; question: string; options?: string[] }

export interface Suggestion {
  id: string
  kind: SuggestionKind
  surface: SuggestionSurface
  status: SuggestionStatus
  documentId: number | null
  chunkId: number | null
  entityId: number | null
  payload: SuggestionPayload
  /** Which investigation branch proposed this (null = the root agent). */
  originBranchId: string | null
  createdAt: string
}

/**
 * Default surface for each kind — the main HCI tuning knob. Important,
 * spatially-anchored suggestions go inline; open-ended questions go to the panel.
 */
export const DEFAULT_SURFACE: Record<SuggestionKind, SuggestionSurface> = {
  translation: 'inline',
  'entity-create': 'inline',
  'entity-delete': 'inline',
  question: 'panel',
}

export interface MakeSuggestionArgs {
  id: string
  createdAt: string
  payload: SuggestionPayload
  surface?: SuggestionSurface
  originBranchId?: string | null
}

/** Build a Suggestion, deriving kind/surface/anchors from the payload. */
export function makeSuggestion(args: MakeSuggestionArgs): Suggestion {
  const { id, createdAt, payload } = args
  const kind = payload.kind
  return {
    id,
    kind,
    surface: args.surface ?? DEFAULT_SURFACE[kind],
    status: 'pending',
    documentId: 'documentId' in payload ? payload.documentId : null,
    chunkId: 'chunkId' in payload ? payload.chunkId : null,
    entityId: payload.kind === 'entity-delete' ? payload.entityId : null,
    payload,
    originBranchId: args.originBranchId ?? null,
    createdAt,
  }
}

export function addSuggestion(list: Suggestion[], s: Suggestion): Suggestion[] {
  return [...list, s]
}

export function setSuggestionStatus(
  list: Suggestion[],
  id: string,
  status: SuggestionStatus,
): Suggestion[] {
  return list.map((s) => (s.id === id ? { ...s, status } : s))
}

export function findSuggestion(list: Suggestion[], id: string): Suggestion | null {
  return list.find((s) => s.id === id) ?? null
}

export function pendingSuggestions(list: Suggestion[]): Suggestion[] {
  return list.filter((s) => s.status === 'pending')
}
