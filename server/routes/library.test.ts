import { describe, it, expect } from 'vitest'
import {
  canAssignDocumentScope,
  nearestAncestorAffinity,
  type FolderAffinityRow,
} from './library'

describe('nearestAncestorAffinity', () => {
  it('returns null when folderId is null', () => {
    expect(nearestAncestorAffinity([], null)).toBe(null)
  })

  it('returns the folder’s own affinity when set directly', () => {
    const folders: FolderAffinityRow[] = [{ id: 1, parent_id: null, knowledge_scope_id: 7 }]
    expect(nearestAncestorAffinity(folders, 1)).toBe(7)
  })

  it('inherits from the nearest ancestor with an affinity', () => {
    // 3 (none) -> 2 (none) -> 1 (scope 7)
    const folders: FolderAffinityRow[] = [
      { id: 1, parent_id: null, knowledge_scope_id: 7 },
      { id: 2, parent_id: 1, knowledge_scope_id: null },
      { id: 3, parent_id: 2, knowledge_scope_id: null },
    ]
    expect(nearestAncestorAffinity(folders, 3)).toBe(7)
  })

  it('prefers the closest ancestor when multiple ancestors have affinities', () => {
    // 3 (none) -> 2 (scope 9) -> 1 (scope 7); closest is 9
    const folders: FolderAffinityRow[] = [
      { id: 1, parent_id: null, knowledge_scope_id: 7 },
      { id: 2, parent_id: 1, knowledge_scope_id: 9 },
      { id: 3, parent_id: 2, knowledge_scope_id: null },
    ]
    expect(nearestAncestorAffinity(folders, 3)).toBe(9)
  })

  it('returns null when no ancestor has an affinity', () => {
    const folders: FolderAffinityRow[] = [
      { id: 1, parent_id: null, knowledge_scope_id: null },
      { id: 2, parent_id: 1, knowledge_scope_id: null },
    ]
    expect(nearestAncestorAffinity(folders, 2)).toBe(null)
  })

  it('returns null when the folder is missing from the set', () => {
    expect(nearestAncestorAffinity([], 99)).toBe(null)
  })

  it('is cycle-safe and returns null when a cycle has no affinity', () => {
    // 1 -> 2 -> 1 (cycle), neither has an affinity
    const folders: FolderAffinityRow[] = [
      { id: 1, parent_id: 2, knowledge_scope_id: null },
      { id: 2, parent_id: 1, knowledge_scope_id: null },
    ]
    expect(nearestAncestorAffinity(folders, 1)).toBe(null)
  })

  it('finds an affinity even within a cycle', () => {
    const folders: FolderAffinityRow[] = [
      { id: 1, parent_id: 2, knowledge_scope_id: null },
      { id: 2, parent_id: 1, knowledge_scope_id: 5 },
    ]
    expect(nearestAncestorAffinity(folders, 1)).toBe(5)
  })
})

describe('canAssignDocumentScope', () => {
  it('allows initial assignment when current scope is null', () => {
    expect(canAssignDocumentScope(null, 7)).toBe(true)
  })

  it('allows leaving scope null when it was already null', () => {
    expect(canAssignDocumentScope(null, null)).toBe(true)
  })

  it('allows idempotent re-assert of the same scope', () => {
    expect(canAssignDocumentScope(7, 7)).toBe(true)
  })

  it('rejects switching to a different scope once set', () => {
    expect(canAssignDocumentScope(7, 9)).toBe(false)
  })

  it('rejects clearing a scope that was already set', () => {
    expect(canAssignDocumentScope(7, null)).toBe(false)
  })
})
