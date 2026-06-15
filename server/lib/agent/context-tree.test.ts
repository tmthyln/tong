import { describe, it, expect } from 'vitest'
import {
  addNode,
  setNodeStatus,
  ancestorPath,
  assembleBranchView,
  synthesizeSuggestions,
  formatFindings,
  ROOT_NODE_ID,
  type ContextNode,
  type Finding,
} from './context-tree'

function node(id: string, parentId: string | null): ContextNode {
  return { id, parentId, kind: parentId === null ? 'root' : 'branch', goal: `goal-${id}`, status: 'open', createdAt: 't', updatedAt: 't' }
}

function finding(id: string, nodeId: string, shared: boolean, text = id): Finding {
  return { id, nodeId, payload: { kind: 'fact', text }, shared, createdAt: 't' }
}

const tree: ContextNode[] = [
  node(ROOT_NODE_ID, null),
  node('b1', ROOT_NODE_ID),
  node('b2', ROOT_NODE_ID),
  node('b1a', 'b1'),
]

describe('ancestorPath', () => {
  it('returns root→parent for a nested branch', () => {
    expect(ancestorPath(tree, 'b1a').map((n) => n.id)).toEqual([ROOT_NODE_ID, 'b1'])
  })
  it('returns [] for the root', () => {
    expect(ancestorPath(tree, ROOT_NODE_ID)).toEqual([])
  })
})

describe('assembleBranchView', () => {
  const findings: Finding[] = [
    finding('f-root', ROOT_NODE_ID, false),
    finding('f-b1', 'b1', false),
    finding('f-b2-shared', 'b2', true),
    finding('f-b1a', 'b1a', false),
  ]

  it('a nested branch sees ancestor findings, shared findings, and its own', () => {
    const view = assembleBranchView(tree, findings, 'b1a')
    expect(view.goal).toBe('goal-b1a')
    expect(view.visibleFindings.map((f) => f.id).sort()).toEqual(['f-b1', 'f-b1a', 'f-b2-shared', 'f-root'])
  })

  it('a sibling does not see the other branch private findings', () => {
    const view = assembleBranchView(tree, findings, 'b2')
    // b2 sees root finding + its own shared finding; NOT b1/b1a private findings.
    expect(view.visibleFindings.map((f) => f.id).sort()).toEqual(['f-b2-shared', 'f-root'])
  })
})

describe('synthesizeSuggestions', () => {
  it('promotes only shared candidate-suggestions, deduped', () => {
    const payload = { kind: 'translation' as const, documentId: 1, chunkId: 4, translation: 'hi' }
    const findings: Finding[] = [
      { id: '1', nodeId: 'b1', shared: true, createdAt: 't', payload: { kind: 'candidate-suggestion', suggestion: payload, rationale: 'r' } },
      { id: '2', nodeId: 'b2', shared: true, createdAt: 't', payload: { kind: 'candidate-suggestion', suggestion: payload } }, // dup
      { id: '3', nodeId: 'b1', shared: false, createdAt: 't', payload: { kind: 'candidate-suggestion', suggestion: { kind: 'question', question: 'q' } } }, // not shared
      finding('4', 'b1', true), // plain fact, ignored
    ]
    const out = synthesizeSuggestions(findings)
    expect(out).toEqual([{ suggestion: payload, rationale: 'r' }])
  })
})

describe('tree reducers + formatting', () => {
  it('addNode / setNodeStatus are immutable', () => {
    const nodes = addNode([], node('x', null))
    const next = setNodeStatus(nodes, 'x', 'done', 't2')
    expect(nodes[0].status).toBe('open')
    expect(next[0]).toMatchObject({ status: 'done', updatedAt: 't2' })
  })

  it('formatFindings renders facts and candidate suggestions', () => {
    const text = formatFindings([
      finding('f', 'b1', true, 'a fact'),
      { id: 'c', nodeId: 'b1', shared: true, createdAt: 't', payload: { kind: 'candidate-suggestion', suggestion: { kind: 'question', question: 'q' }, rationale: 'why' } },
    ])
    expect(text).toContain('fact: a fact')
    expect(text).toContain('candidate question suggestion: why')
  })
})
