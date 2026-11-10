/**
 * Map text-level relations (head text, tail text) extracted from a multi-chunk
 * window onto concrete chunk-scope entity mention ids.
 *
 * The old approach linked every mention of the head text to every mention of
 * the tail text in the window (n × m rows per relation — one fact could become
 * ~1000 rows). Instead we anchor each relation once per chunk in which head and
 * tail co-occur (first mention of each in that chunk); if they never share a
 * chunk, we anchor once on the first mention of each in the window.
 */

export interface WindowMention {
  id: number
  text: string
  chunkId: number
  /** Order of the chunk in the document (for "first mention" tie-breaking). */
  chunkOrder: number
  startIndex: number
}

export interface TextRelation {
  fromText: string
  toText: string
  edgeType: string
  explanation: string
}

export interface AnchoredRelation {
  fromEntityId: number
  toEntityId: number
  edgeType: string
  explanation: string
}

export function anchorRelations(relations: TextRelation[], mentions: WindowMention[]): AnchoredRelation[] {
  // text → chunkId → first mention in that chunk
  const byText = new Map<string, Map<number, WindowMention>>()
  const sorted = [...mentions].sort((a, b) => a.chunkOrder - b.chunkOrder || a.startIndex - b.startIndex)
  for (const m of sorted) {
    let perChunk = byText.get(m.text)
    if (!perChunk) byText.set(m.text, (perChunk = new Map()))
    if (!perChunk.has(m.chunkId)) perChunk.set(m.chunkId, m)
  }

  const out: AnchoredRelation[] = []
  const seen = new Set<string>()
  const push = (from: WindowMention, to: WindowMention, rel: TextRelation) => {
    if (from.id === to.id) return
    const key = `${from.id}|${to.id}|${rel.edgeType}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ fromEntityId: from.id, toEntityId: to.id, edgeType: rel.edgeType, explanation: rel.explanation })
  }

  for (const rel of relations) {
    const heads = byText.get(rel.fromText)
    const tails = byText.get(rel.toText)
    if (!heads || !tails) continue
    let anchored = false
    for (const [chunkId, head] of heads) {
      const tail = tails.get(chunkId)
      if (tail) {
        push(head, tail, rel)
        anchored = true
      }
    }
    if (!anchored) push(heads.values().next().value!, tails.values().next().value!, rel)
  }
  return out
}
