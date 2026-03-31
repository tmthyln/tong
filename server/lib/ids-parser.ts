export const IDS_OPERATORS: Record<string, number> = {
  '⿰': 2, '⿱': 2, '⿴': 2, '⿵': 2, '⿶': 2, '⿷': 2, '⿸': 2, '⿹': 2, '⿺': 2, '⿻': 2,
  '⿲': 3, '⿳': 3,
}

export interface IdsNode {
  type: 'op' | 'char' | 'unencoded'
  operator?: string       // if type='op'
  character?: string      // if type='char'
  strokeCount?: number    // if type='unencoded': 1–20
  children?: IdsNode[]    // if type='op': exactly arity-many children
}

export interface CharIdsDecomp {
  idsString: string      // raw IDS (tags stripped)
  tags: string | null    // e.g. "GTKV"; null if untagged; "O" removed and put in obsolete
  obsolete: boolean
}

export interface CharIdsLine {
  codepoint: string      // e.g. "U+4E01"
  character: string
  decompositions: CharIdsDecomp[]  // empty = atomic character
}

// ── Tag parsing ───────────────────────────────────────────────────────────────

const TAG_PATTERN = /\[([A-Z]+)\]$/

function parseVariant(raw: string): CharIdsDecomp {
  const match = TAG_PATTERN.exec(raw)
  let idsString = raw
  let tags: string | null = null
  let obsolete = false

  if (match) {
    idsString = raw.slice(0, match.index)
    const rawTags = match[1]
    if (rawTags.includes('O')) {
      obsolete = true
      const stripped = rawTags.replace(/O/g, '')
      tags = stripped.length > 0 ? stripped : null
    } else {
      tags = rawTags
    }
  }

  return { idsString, tags, obsolete }
}

// ── IDS recursive descent parser ─────────────────────────────────────────────

export function parseIds(ids: string): IdsNode | null {
  if (!ids) return null

  const chars = Array.from(ids)
  if (chars.length === 0) return null

  let pos = 0

  function parseNode(): IdsNode {
    if (pos >= chars.length) throw new Error('Unexpected end of IDS string')

    const ch = chars[pos]
    const cp = ch.codePointAt(0)!

    // Unencoded DC: ①–⑳ (U+2460–U+2473)
    if (cp >= 0x2460 && cp <= 0x2473) {
      pos++
      return { type: 'unencoded', strokeCount: cp - 0x2460 + 1 }
    }

    // IDS operator
    const arity = IDS_OPERATORS[ch]
    if (arity !== undefined) {
      pos++
      const children: IdsNode[] = []
      for (let i = 0; i < arity; i++) {
        children.push(parseNode())
      }
      return { type: 'op', operator: ch, children }
    }

    // Regular character
    pos++
    return { type: 'char', character: ch }
  }

  const node = parseNode()
  return node
}

// ── File parser ───────────────────────────────────────────────────────────────

export function parseIdsFile(text: string): CharIdsLine[] {
  const lines = text.split('\n')
  const result: CharIdsLine[] = []

  for (const line of lines) {
    // Skip comments and empty lines
    if (line.startsWith('#') || line.trim() === '') continue

    const cols = line.split('\t')
    if (cols.length < 2) continue

    const codepoint = cols[0].trim()
    const character = cols[1]

    // No IDS variants — skip (just codepoint+character, no decomposition data)
    if (cols.length < 3) continue

    const variants = cols.slice(2)
    const decompositions: CharIdsDecomp[] = []

    for (const raw of variants) {
      if (!raw || raw.trim() === '') continue

      const parsed = parseVariant(raw.trim())

      // Skip self-referential variants (IDS string === character itself)
      if (parsed.idsString === character) continue

      decompositions.push(parsed)
    }

    result.push({ codepoint, character, decompositions })
  }

  return result
}
