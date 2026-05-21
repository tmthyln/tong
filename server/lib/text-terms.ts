function isCJK(code: number): boolean {
  return (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)
}

function isAllCJK(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.codePointAt(i)
    if (code == null || !isCJK(code)) return false
  }
  return true
}

export async function extractTermsFromText(text: string, db: D1Database): Promise<string[]> {
  // Extract individual CJK characters
  const chars = new Set<string>()
  const candidates = new Set<string>()

  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i)
    if (code == null || !isCJK(code)) continue
    chars.add(text[i]!)

    // Generate 2–6 char all-CJK substrings starting at this position
    for (let len = 2; len <= 6; len++) {
      const end = i + len
      if (end > text.length) break
      const substr = text.slice(i, end)
      if (!isAllCJK(substr)) break // once a non-CJK char appears, longer substrings won't be all-CJK either
      candidates.add(substr)
    }
  }

  if (candidates.size === 0) {
    return [...chars]
  }

  // Verify candidates against dictionary in batches of 99 (D1 param limit)
  const candidateArray = [...candidates]
  const verified = new Set<string>()

  for (let i = 0; i < candidateArray.length; i += 99) {
    const batch = candidateArray.slice(i, i + 99)
    const placeholders = batch.map(() => '?').join(', ')
    const result = await db
      .prepare(`SELECT DISTINCT simplified FROM dictionary_entry WHERE simplified IN (${placeholders})`)
      .bind(...batch)
      .all<{ simplified: string }>()
    for (const row of result.results) {
      verified.add(row.simplified)
    }
  }

  return [...new Set([...chars, ...verified])]
}
