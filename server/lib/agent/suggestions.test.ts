import { describe, it, expect } from 'vitest'
import {
  makeSuggestion,
  addSuggestion,
  setSuggestionStatus,
  findSuggestion,
  pendingSuggestions,
  DEFAULT_SURFACE,
} from './suggestions'

describe('makeSuggestion', () => {
  it('derives kind, surface, and anchors from a translation payload', () => {
    const s = makeSuggestion({
      id: 'a',
      createdAt: 't',
      payload: { kind: 'translation', documentId: 1, chunkId: 4, translation: 'hello' },
    })
    expect(s).toMatchObject({
      id: 'a',
      kind: 'translation',
      surface: 'inline',
      status: 'pending',
      documentId: 1,
      chunkId: 4,
      entityId: null,
      originBranchId: null,
    })
  })

  it('routes questions to the panel and entity-delete to the entityId anchor', () => {
    const q = makeSuggestion({ id: 'q', createdAt: 't', payload: { kind: 'question', question: 'Which sense?' } })
    expect(q.surface).toBe(DEFAULT_SURFACE.question)
    expect(q.surface).toBe('panel')

    const d = makeSuggestion({
      id: 'd',
      createdAt: 't',
      payload: { kind: 'entity-delete', documentId: 1, entityId: 99, label: 'X' },
    })
    expect(d).toMatchObject({ kind: 'entity-delete', surface: 'inline', entityId: 99, chunkId: null })
  })

  it('honors an explicit surface override and originBranchId', () => {
    const s = makeSuggestion({
      id: 'a',
      createdAt: 't',
      payload: { kind: 'translation', documentId: 1, chunkId: 4, translation: 'x' },
      surface: 'panel',
      originBranchId: 'branch-1',
    })
    expect(s.surface).toBe('panel')
    expect(s.originBranchId).toBe('branch-1')
  })
})

describe('suggestion reducers', () => {
  const base = makeSuggestion({ id: 'a', createdAt: 't', payload: { kind: 'question', question: 'q' } })

  it('adds, finds, sets status, and filters pending', () => {
    let list = addSuggestion([], base)
    list = addSuggestion(list, makeSuggestion({ id: 'b', createdAt: 't', payload: { kind: 'question', question: 'q2' } }))
    expect(findSuggestion(list, 'a')).toBe(base)
    expect(findSuggestion(list, 'zzz')).toBeNull()

    list = setSuggestionStatus(list, 'a', 'accepted')
    expect(findSuggestion(list, 'a')!.status).toBe('accepted')
    expect(pendingSuggestions(list).map((s) => s.id)).toEqual(['b'])
  })

  it('setSuggestionStatus does not mutate the input list', () => {
    const list = addSuggestion([], base)
    const next = setSuggestionStatus(list, 'a', 'dismissed')
    expect(list[0].status).toBe('pending')
    expect(next[0].status).toBe('dismissed')
  })
})
