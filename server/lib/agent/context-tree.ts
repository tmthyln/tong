// The context tree (investigative non-linearity): a shared root context plus
// branches that investigate separately and share findings on a blackboard, then
// recombine. Pure types + reducers + view assembly + synthesis so the logic is
// unit-testable; the agent owns the SQLite tables and runs branches as fibers.

import type { SuggestionPayload } from './suggestions'

export type NodeKind = 'root' | 'branch'
export type NodeStatus = 'open' | 'investigating' | 'done' | 'failed'

export interface ContextNode {
  id: string
  parentId: string | null
  kind: NodeKind
  goal: string
  status: NodeStatus
  createdAt: string
  updatedAt: string
}

export type FindingPayload =
  | { kind: 'fact'; text: string }
  | { kind: 'observation'; text: string }
  | { kind: 'candidate-suggestion'; suggestion: SuggestionPayload; rationale?: string }

export interface Finding {
  id: string
  nodeId: string
  payload: FindingPayload
  shared: boolean
  createdAt: string
}

export const ROOT_NODE_ID = 'root'

// ── Tree reducers ──────────────────────────────────────────────────────────

export function addNode(nodes: ContextNode[], node: ContextNode): ContextNode[] {
  return [...nodes, node]
}

export function getNode(nodes: ContextNode[], id: string): ContextNode | null {
  return nodes.find((n) => n.id === id) ?? null
}

export function setNodeStatus(
  nodes: ContextNode[],
  id: string,
  status: NodeStatus,
  at: string,
): ContextNode[] {
  return nodes.map((n) => (n.id === id ? { ...n, status, updatedAt: at } : n))
}

/** Ancestors from root down to the node's parent (excludes the node itself). */
export function ancestorPath(nodes: ContextNode[], id: string): ContextNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const path: ContextNode[] = []
  let current = byId.get(id)?.parentId ?? null
  const guard = new Set<string>()
  while (current && !guard.has(current)) {
    guard.add(current)
    const node = byId.get(current)
    if (!node) break
    path.unshift(node)
    current = node.parentId
  }
  return path
}

export function addFinding(findings: Finding[], f: Finding): Finding[] {
  return [...findings, f]
}

// ── Branch view ──────────────────────────────────────────────────────────────

export interface BranchView {
  goal: string
  /** Findings visible to this branch: its ancestors' findings, any shared finding, and its own. */
  visibleFindings: Finding[]
}

export function assembleBranchView(
  nodes: ContextNode[],
  findings: Finding[],
  branchId: string,
): BranchView {
  const node = getNode(nodes, branchId)
  const goal = node?.goal ?? ''
  const ancestorIds = new Set(ancestorPath(nodes, branchId).map((n) => n.id))

  const visibleFindings = findings.filter(
    (f) => f.nodeId === branchId || f.shared || ancestorIds.has(f.nodeId),
  )

  return { goal, visibleFindings }
}

/** Promote shared candidate-suggestions into concrete suggestion payloads (deduped). */
export function synthesizeSuggestions(
  findings: Finding[],
): { suggestion: SuggestionPayload; rationale?: string }[] {
  const out: { suggestion: SuggestionPayload; rationale?: string }[] = []
  const seen = new Set<string>()
  for (const f of findings) {
    if (f.payload.kind !== 'candidate-suggestion' || !f.shared) continue
    const key = JSON.stringify(f.payload.suggestion)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ suggestion: f.payload.suggestion, rationale: f.payload.rationale })
  }
  return out
}

/** Render findings as a compact bullet list for prompts. */
export function formatFindings(findings: Finding[]): string {
  if (findings.length === 0) return '(none yet)'
  return findings
    .map((f) => {
      if (f.payload.kind === 'candidate-suggestion') {
        return `- candidate ${f.payload.suggestion.kind} suggestion${f.payload.rationale ? `: ${f.payload.rationale}` : ''}`
      }
      return `- ${f.payload.kind}: ${f.payload.text}`
    })
    .join('\n')
}
