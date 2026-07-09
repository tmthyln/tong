import { describe, it, expect } from 'vitest'
import { isTranslationNotReady } from './translationReadiness'

describe('isTranslationNotReady', () => {
  it('returns true when there are no runs at all', () => {
    expect(isTranslationNotReady([])).toBe(true)
  })

  it('returns true when only initial_translation is completed', () => {
    expect(
      isTranslationNotReady([{ kind: 'initial_translation', status: 'completed' }])
    ).toBe(true)
  })

  it('returns false when both kinds are completed', () => {
    expect(
      isTranslationNotReady([
        { kind: 'initial_translation', status: 'completed' },
        { kind: 'initial_translation_refinement', status: 'completed' },
      ])
    ).toBe(false)
  })

  it('returns true when the refinement failed', () => {
    expect(
      isTranslationNotReady([
        { kind: 'initial_translation', status: 'completed' },
        { kind: 'initial_translation_refinement', status: 'failed' },
      ])
    ).toBe(true)
  })

  it('uses the first (latest) run per kind and ignores older duplicates', () => {
    expect(
      isTranslationNotReady([
        { kind: 'initial_translation', status: 'failed' },
        { kind: 'initial_translation_refinement', status: 'completed' },
        { kind: 'initial_translation', status: 'completed' },
      ])
    ).toBe(true)
  })
})
