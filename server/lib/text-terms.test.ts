import { describe, it, expect, vi } from 'vitest'
import { extractTermsFromText } from './text-terms'

function makeMockDb(dictionaryTerms: string[]): D1Database {
  const dict = new Set(dictionaryTerms)
  const all = vi.fn(async (...binds: string[]) => ({
    results: [...new Set(binds)]
      .filter((t) => dict.has(t))
      .map((simplified) => ({ simplified })),
    success: true,
    meta: {},
  }))
  const bind = vi.fn(function (this: { _binds: string[] }, ...binds: string[]) {
    this._binds = binds
    return {
      all: () => all(...binds),
    }
  })
  const prepare = vi.fn(() => ({
    bind,
  }))
  return { prepare } as unknown as D1Database
}

describe('extractTermsFromText', () => {
  it('returns empty array for empty input', async () => {
    const db = makeMockDb([])
    const result = await extractTermsFromText('', db)
    expect(result).toEqual([])
  })

  it('returns only individual characters when no candidates match the dictionary', async () => {
    const db = makeMockDb([])
    const result = await extractTermsFromText('你好', db)
    expect(result.sort()).toEqual(['你', '好'].sort())
  })

  it('returns characters plus dictionary-verified multi-char terms', async () => {
    const db = makeMockDb(['你好', '学习', '中文'])
    const result = await extractTermsFromText('你好，我在学习中文。', db)
    expect(new Set(result)).toEqual(new Set(['你', '好', '我', '在', '学', '习', '中', '文', '你好', '学习', '中文']))
  })

  it('ignores non-CJK characters', async () => {
    const db = makeMockDb([])
    const result = await extractTermsFromText('hello 123 !@#', db)
    expect(result).toEqual([])
  })

  it('does not generate substrings across non-CJK boundaries', async () => {
    // 你 and 好 are separated by punctuation — "你好" must NOT appear as a candidate
    const db = makeMockDb(['你好']) // dictionary has it, but text never produces it
    const result = await extractTermsFromText('你,好', db)
    expect(result).not.toContain('你好')
    expect(result.sort()).toEqual(['你', '好'].sort())
  })

  it('returns deduplicated characters when repeated', async () => {
    const db = makeMockDb([])
    const result = await extractTermsFromText('好好好好', db)
    expect(result).toEqual(['好'])
  })

  it('handles mixed CJK and ASCII text', async () => {
    const db = makeMockDb(['中文'])
    const result = await extractTermsFromText('Learning 中文 is fun', db)
    expect(new Set(result)).toEqual(new Set(['中', '文', '中文']))
  })

  it('caps candidate substrings at length 6', async () => {
    // dictionary has both a 6-char term (valid) and a 7-char term (must not be queried)
    const db = makeMockDb(['一二三四五六', '一二三四五六七'])
    const text = '一二三四五六七'
    const result = await extractTermsFromText(text, db)
    expect(result).toContain('一二三四五六')
    expect(result).not.toContain('一二三四五六七')
  })

  it('batches dictionary queries at the D1 99-param limit', async () => {
    // Build a text long enough that >99 unique 2-char candidates exist.
    // Using a large unique-character string: 100+ chars yields ~99+ unique 2-grams.
    let text = ''
    for (let i = 0; i < 120; i++) {
      // CJK range starting at U+4E00 — pick 120 sequential characters
      text += String.fromCodePoint(0x4e00 + i)
    }
    const db = makeMockDb([])
    const prepareSpy = (db.prepare as ReturnType<typeof vi.fn>)
    await extractTermsFromText(text, db)
    // Should have called prepare more than once (multiple batches)
    expect(prepareSpy.mock.calls.length).toBeGreaterThan(1)
  })

  it('includes CJK Extension A characters (U+3400–U+4DBF)', async () => {
    const text = String.fromCodePoint(0x3400) + String.fromCodePoint(0x4dbf)
    const db = makeMockDb([])
    const result = await extractTermsFromText(text, db)
    expect(result.length).toBe(2)
  })

  it('excludes characters outside the supported CJK ranges', async () => {
    // U+2F800 (CJK Compatibility Supplement) — outside the supported ranges
    const text = '你' + String.fromCodePoint(0x2f800) + '好'
    const db = makeMockDb([])
    const result = await extractTermsFromText(text, db)
    expect(result.sort()).toEqual(['你', '好'].sort())
  })
})
