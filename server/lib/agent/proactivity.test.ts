import { describe, it, expect } from 'vitest'
import { shouldConsider, summarizeRecentActions, buildProactivePrompt } from './proactivity'
import { INITIAL_FOCUS, type ActionEvent } from './actions'

describe('shouldConsider', () => {
  it('ignores passive viewing alone', () => {
    const actions: ActionEvent[] = [
      { type: 'document_opened', documentId: 1, at: 't' },
      { type: 'chunk_seen', documentId: 1, chunkId: 2, at: 't' },
    ]
    expect(shouldConsider(actions)).toBe(false)
  })

  it('triggers on intent-bearing actions', () => {
    expect(shouldConsider([{ type: 'lookup', term: '鱼', documentId: 1, chunkId: 2, at: 't' }])).toBe(true)
    expect(
      shouldConsider([{ type: 'translation_saved', documentId: 1, chunkId: 2, draftNumber: 1, at: 't' }]),
    ).toBe(true)
  })

  it('is false for an empty batch', () => {
    expect(shouldConsider([])).toBe(false)
  })
})

describe('summarizeRecentActions', () => {
  it('renders a bullet summary', () => {
    const summary = summarizeRecentActions([
      { type: 'lookup', term: '鱼', documentId: 1, chunkId: 2, at: 't' },
      { type: 'term_failed', term: '难', at: 't' },
    ])
    expect(summary).toBe('- looked up "鱼"\n- marked "难" as not known')
  })
})

describe('buildProactivePrompt', () => {
  it('includes focus and the action summary', () => {
    const prompt = buildProactivePrompt({ documentId: 7, chunkId: 3, updatedAt: 't' }, '- looked up "鱼"')
    expect(prompt).toContain('document 7, chunk 3')
    expect(prompt).toContain('- looked up "鱼"')
    expect(prompt).toContain('investigate(goal)')
  })

  it('handles no focus', () => {
    expect(buildProactivePrompt(INITIAL_FOCUS, '(no recent actions)')).toContain('no document focused')
  })
})
