// Client-side contract for the translation agent's synced state + RPC.
// Mirrors the server source of truth in server/lib/agent/{state,suggestions,
// actions,context-tree}.ts. Kept here (rather than imported across the
// app/worker tsconfig boundary) so the Vue bundle never pulls in Worker code.

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
  originBranchId: string | null
  createdAt: string
}

export type NodeStatus = 'open' | 'investigating' | 'done' | 'failed'

export interface BranchSummary {
  id: string
  goal: string
  status: NodeStatus
}

export interface AgentFocus {
  documentId: number | null
  chunkId: number | null
  updatedAt: string | null
}

export type AgentStatus = 'idle' | 'thinking'

export interface TranslationAgentState {
  focus: AgentFocus
  status: AgentStatus
  suggestions: Suggestion[]
  branches: BranchSummary[]
}

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

// ── RPC param/return shapes used by the client ───────────────────────────────

export interface DictEntry {
  id: number
  traditional: string
  simplified: string
  pinyin: string
  definitions: string[]
}

export interface ExplainParams {
  term: string
  entries: DictEntry[]
  documentId: number
  chunkId: number
}

export interface DisambiguateParams extends ExplainParams {
  entries: DictEntry[]
}

export type ExplainResult = { ok: true; explanation: string } | { ok: false; status: number; error: string }
export type DisambiguateResult =
  | { ok: true; explanation: string; entryId: number | undefined }
  | { ok: false; status: number; error: string }
export type ResolveSuggestionResult =
  | { ok: true; status: SuggestionStatus; outcome?: string }
  | { ok: false; error: string }

export type ResolveAction = 'accept' | 'dismiss' | 'answer'
