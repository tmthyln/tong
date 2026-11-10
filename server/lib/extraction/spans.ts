/**
 * Span utilities: turn verbatim mention strings returned by an LLM into
 * character-offset spans, and resolve overlaps.
 */

export interface Span {
  label: string
  text: string
  start: number
  end: number
}

/**
 * Find every occurrence of each mention in `text`. Mentions that never occur
 * verbatim are dropped (the model hallucinated or normalized them).
 */
export function locateMentions(text: string, mentions: Array<{ text: string; label: string }>): Span[] {
  const spans: Span[] = []
  const seen = new Set<string>()
  for (const m of mentions) {
    if (!m.text) continue
    const key = `${m.label}\u0000${m.text}`
    if (seen.has(key)) continue
    seen.add(key)
    let from = 0
    while (true) {
      const idx = text.indexOf(m.text, from)
      if (idx === -1) break
      spans.push({ label: m.label, text: m.text, start: idx, end: idx + m.text.length })
      from = idx + m.text.length
    }
  }
  return spans
}

/**
 * Greedy flat-NER overlap resolution: keep the longest span at each position,
 * drop any span overlapping an already-kept span. Ties keep the first seen.
 * Result is sorted by start offset.
 */
export function resolveOverlaps<T extends { start: number; end: number }>(spans: T[]): T[] {
  const byLength = spans
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s.end - b.s.start - (a.s.end - a.s.start) || a.s.start - b.s.start || a.i - b.i)
  const kept: T[] = []
  for (const { s } of byLength) {
    if (kept.every((k) => s.end <= k.start || s.start >= k.end)) kept.push(s)
  }
  return kept.sort((a, b) => a.start - b.start)
}
