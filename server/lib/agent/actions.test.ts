import { describe, it, expect } from 'vitest'
import {
  INITIAL_FOCUS,
  reduceFocus,
  reduceFocusBatch,
  describeAction,
  type ActionEvent,
} from './actions'

describe('reduceFocus', () => {
  it('sets the document and clears the chunk when a document opens', () => {
    const focus = reduceFocus(
      { documentId: 1, chunkId: 9, updatedAt: 't0' },
      { type: 'document_opened', documentId: 2, at: 't1' },
    )
    expect(focus).toEqual({ documentId: 2, chunkId: null, updatedAt: 't1' })
  })

  it('tracks the chunk on view / save / entity-create', () => {
    expect(reduceFocus(INITIAL_FOCUS, { type: 'chunk_seen', documentId: 2, chunkId: 5, at: 't' })).toEqual({
      documentId: 2,
      chunkId: 5,
      updatedAt: 't',
    })
    expect(
      reduceFocus(INITIAL_FOCUS, { type: 'translation_saved', documentId: 2, chunkId: 6, draftNumber: 3, at: 't' }),
    ).toMatchObject({ documentId: 2, chunkId: 6 })
  })

  it('keeps the current chunk when an entity is deleted', () => {
    const focus = reduceFocus(
      { documentId: 2, chunkId: 5, updatedAt: 't0' },
      { type: 'entity_deleted', documentId: 2, entityId: 11, at: 't1' },
    )
    expect(focus).toEqual({ documentId: 2, chunkId: 5, updatedAt: 't1' })
  })

  it('lookups fall back to the current document/chunk when unspecified', () => {
    const focus = reduceFocus(
      { documentId: 2, chunkId: 5, updatedAt: 't0' },
      { type: 'lookup', term: '鱼', documentId: null, chunkId: null, at: 't1' },
    )
    expect(focus).toEqual({ documentId: 2, chunkId: 5, updatedAt: 't1' })
  })

  it('term_failed only bumps the timestamp', () => {
    const focus = reduceFocus(
      { documentId: 2, chunkId: 5, updatedAt: 't0' },
      { type: 'term_failed', term: '难', at: 't1' },
    )
    expect(focus).toEqual({ documentId: 2, chunkId: 5, updatedAt: 't1' })
  })
})

describe('reduceFocusBatch', () => {
  it('applies events in order', () => {
    const events: ActionEvent[] = [
      { type: 'document_opened', documentId: 3, at: 't1' },
      { type: 'chunk_seen', documentId: 3, chunkId: 7, at: 't2' },
      { type: 'chunk_seen', documentId: 3, chunkId: 8, at: 't3' },
    ]
    expect(reduceFocusBatch(INITIAL_FOCUS, events)).toEqual({ documentId: 3, chunkId: 8, updatedAt: 't3' })
  })

  it('returns the starting focus for an empty batch', () => {
    expect(reduceFocusBatch(INITIAL_FOCUS, [])).toBe(INITIAL_FOCUS)
  })
})

describe('describeAction', () => {
  it('produces concise descriptions for each action type', () => {
    expect(describeAction({ type: 'translation_saved', documentId: 1, chunkId: 4, draftNumber: 2, at: 't' })).toBe(
      'saved a translation for chunk 4 (draft 2)',
    )
    expect(describeAction({ type: 'entity_created', documentId: 1, chunkId: 4, text: '孔子', entityType: 'PERSON', at: 't' })).toBe(
      'created a PERSON entity "孔子" in chunk 4',
    )
    expect(describeAction({ type: 'lookup', term: '鱼', documentId: 1, chunkId: 4, at: 't' })).toBe('looked up "鱼"')
  })
})
