// Shared core for dictionary search + beam-search segmentation.
//
// Extracted verbatim from server/routes/dictionary.ts so the same logic backs
// both the standalone routes and the agent's `dictionarySearch` self-tool.

export interface DictEntry {
  id: number
  traditional: string
  simplified: string
  pinyin: string
  definitions: string[]
}

interface EntryRow {
  id: number
  traditional: string
  simplified: string
  pinyin: string
}

interface DefinitionRow {
  entry_id: number
  definition: string
}

// Strip FTS5 operator characters from user input (keep * for prefix search).
function sanitizeFts5(q: string): string {
  return q.replace(/["()^]/g, '').trim()
}

// Append * to each space-separated part ending in an ASCII letter (a pinyin
// syllable with no tone digit) so FTS5 prefix-matches the tokenized syllable.
function addPinyinWildcards(sanitized: string): string {
  return sanitized
    .split(' ')
    .filter((p) => p.length > 0)
    .map((part) => (/[a-zA-Z]$/.test(part) ? `${part}*` : part))
    .join(' ')
}

// True if the pattern needs LIKE semantics (underscore wildcard, or * not just
// at the end — FTS5 only supports trailing prefix wildcards).
function needsLike(pattern: string): boolean {
  return pattern.includes('_') || (pattern.includes('*') && !pattern.endsWith('*'))
}

function toLikePattern(pattern: string): string {
  return pattern.replace(/\*/g, '%')
}

async function fetchDefinitionsByEntry(
  env: Env,
  ids: number[],
  chunkSize = 90,
): Promise<Map<number, string[]>> {
  const defsByEntry = new Map<number, string[]>()
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize)
    const ph = chunk.map(() => '?').join(', ')
    const { results } = await env.DB
      .prepare(
        `SELECT entry_id, definition
         FROM dictionary_definition
         WHERE entry_id IN (${ph})
         ORDER BY entry_id, sort_order`,
      )
      .bind(...chunk)
      .all<DefinitionRow>()
    for (const row of results) {
      const arr = defsByEntry.get(row.entry_id) ?? []
      arr.push(row.definition)
      defsByEntry.set(row.entry_id, arr)
    }
  }
  return defsByEntry
}

export interface SearchParams {
  q?: string
  tone?: string
  def?: string
  headwordsOnly?: boolean
  limit?: number
}

/** Full dictionary search (FTS5 / LIKE / bare strategies). Returns up to `limit` entries. */
export async function searchDictionary(env: Env, params: SearchParams): Promise<DictEntry[]> {
  const q = params.q?.trim() ?? ''
  const tone = params.tone?.trim() ?? ''
  const def_ = params.def?.trim() ?? ''
  const headwordsOnly = params.headwordsOnly ?? false
  const limit = Math.min(params.limit ?? 50, 200)

  const validTone = /^[1-5]$/.test(tone) ? tone : ''

  type Strategy = 'fts' | 'like' | 'bare'
  let strategy: Strategy = 'bare'
  const ftsMatchParts: string[] = []
  let likePattern = ''

  if (q) {
    if (needsLike(q)) {
      strategy = 'like'
      likePattern = toLikePattern(q)
    } else {
      strategy = 'fts'
      const sanitized = sanitizeFts5(q)
      const withWildcards = addPinyinWildcards(sanitized)
      const base =
        withWildcards !== sanitized
          ? withWildcards
          : /^[a-zA-Z0-9\s]+$/.test(q) && !q.endsWith('*')
            ? sanitized + '*'
            : sanitized
      const ftsQ = headwordsOnly ? `{simplified traditional pinyin}:${base}` : base
      if (ftsQ) ftsMatchParts.push(ftsQ)
    }
  }

  if (def_) {
    if (strategy !== 'like') {
      strategy = 'fts'
      const defQ =
        /^[a-zA-Z0-9\s]+$/.test(def_) && !def_.endsWith('*')
          ? `definitions_text:${sanitizeFts5(def_)}*`
          : `definitions_text:${sanitizeFts5(def_)}`
      ftsMatchParts.push(defQ)
    }
  }

  let entryRows: EntryRow[] = []

  if (strategy === 'fts' && ftsMatchParts.length > 0) {
    const matchExpr = ftsMatchParts.join(' AND ')
    const extraConds: string[] = []
    const extraBinds: (string | number)[] = []
    if (validTone) {
      extraConds.push('e.pinyin LIKE ?')
      extraBinds.push(`%${validTone}%`)
    }
    const extraWhere = extraConds.length ? `AND ${extraConds.join(' AND ')}` : ''
    const sql = `
      SELECT e.id, e.traditional, e.simplified, e.pinyin
      FROM dictionary_entry e
      WHERE e.id IN (SELECT rowid FROM dictionary_fts WHERE dictionary_fts MATCH ?)
      ${extraWhere}
      ORDER BY length(e.simplified), e.simplified
      LIMIT ?
    `
    try {
      const { results } = await env.DB.prepare(sql).bind(matchExpr, ...extraBinds, limit).all<EntryRow>()
      entryRows = results
    } catch (err) {
      console.error('[dictionary/search] FTS query error:', err)
      return []
    }
  } else if (strategy === 'like') {
    const conds: string[] = ['(e.simplified LIKE ? OR e.traditional LIKE ?)']
    const binds: (string | number)[] = [likePattern, likePattern]
    if (def_) {
      conds.push('f.definitions_text LIKE ?')
      binds.push(`%${def_}%`)
    }
    if (validTone) {
      conds.push('e.pinyin LIKE ?')
      binds.push(`%${validTone}%`)
    }
    const sql = `
      SELECT e.id, e.traditional, e.simplified, e.pinyin
      FROM dictionary_entry e
      JOIN dictionary_fts f ON f.rowid = e.id
      WHERE ${conds.join(' AND ')}
      ORDER BY length(e.simplified), e.simplified
      LIMIT ?
    `
    const { results } = await env.DB.prepare(sql).bind(...binds, limit).all<EntryRow>()
    entryRows = results
  } else if (strategy === 'bare' && validTone) {
    const sql = `
      SELECT e.id, e.traditional, e.simplified, e.pinyin
      FROM dictionary_entry e
      WHERE e.pinyin LIKE ?
      ORDER BY length(e.simplified), e.simplified
      LIMIT ?
    `
    const { results } = await env.DB.prepare(sql).bind(`%${validTone}%`, limit).all<EntryRow>()
    entryRows = results
  } else {
    return []
  }

  if (entryRows.length === 0) return []

  const defsByEntry = await fetchDefinitionsByEntry(env, entryRows.map((r) => r.id))

  return entryRows.map((entry) => ({
    id: entry.id,
    traditional: entry.traditional,
    simplified: entry.simplified,
    pinyin: entry.pinyin,
    definitions: defsByEntry.get(entry.id) ?? [],
  }))
}

export interface SegmentationSegment {
  text: string
  entries: DictEntry[]
}

export interface Segmentation {
  segments: SegmentationSegment[]
  score: number
}

export interface SegmentResult {
  query: string
  segmentations: Segmentation[]
}

/** Beam-search DP segmentation of an input string into dictionary entries. */
export async function segmentText(env: Env, rawQuery: string, limit = 5): Promise<SegmentResult> {
  const raw = (rawQuery ?? '').trim()
  const topN = Math.min(limit, 10)
  if (!raw) return { query: '', segmentations: [] }

  const q = raw.slice(0, 20)

  const { results: candidateRows } = await env.DB
    .prepare(
      `SELECT id, traditional, simplified, pinyin
       FROM dictionary_entry
       WHERE (simplified  != '' AND instr(?, simplified)  > 0)
          OR (traditional != '' AND traditional != simplified AND instr(?, traditional) > 0)`,
    )
    .bind(q, q)
    .all<EntryRow>()

  if (candidateRows.length === 0) return { query: q, segmentations: [] }

  const defsByEntry = await fetchDefinitionsByEntry(env, candidateRows.map((r) => r.id))

  const entries: DictEntry[] = candidateRows.map((r) => ({
    ...r,
    definitions: defsByEntry.get(r.id) ?? [],
  }))

  // Build position map: pos → length → entries (homographs bundled).
  const posMap = new Map<number, Map<number, DictEntry[]>>()
  for (const entry of entries) {
    const forms = new Set([entry.simplified, entry.traditional].filter(Boolean))
    const seenPosLen = new Set<string>()
    for (const form of forms) {
      let from = 0
      while (from <= q.length - form.length) {
        const pos = q.indexOf(form, from)
        if (pos === -1) break
        const len = form.length
        const key = `${pos}:${len}`
        if (!seenPosLen.has(key)) {
          seenPosLen.add(key)
          if (!posMap.has(pos)) posMap.set(pos, new Map())
          const lenMap = posMap.get(pos)!
          const list = lenMap.get(len) ?? []
          list.push(entry)
          lenMap.set(len, list)
        }
        from = pos + 1
      }
    }
  }

  type Segment = { text: string; entries: DictEntry[] }
  type Path = { segs: Segment[]; score: number }

  const BEAM = topN * 4
  const dp: Path[][] = Array.from({ length: q.length + 1 }, () => [])
  dp[0] = [{ segs: [], score: 0 }]

  for (let i = 0; i < q.length; i++) {
    dp[i].sort((a, b) => b.score - a.score)
    dp[i] = dp[i].slice(0, BEAM)
    if (dp[i].length === 0) continue
    const lenMap = posMap.get(i)
    if (!lenMap) continue
    for (const [len, segEntries] of lenMap) {
      const j = i + len
      if (j > q.length) continue
      const seg: Segment = { text: q.slice(i, j), entries: segEntries }
      for (const path of dp[i]) {
        dp[j].push({ segs: [...path.segs, seg], score: path.score + len * len })
      }
    }
  }

  dp[q.length].sort((a, b) => b.score - a.score)

  return {
    query: q,
    segmentations: dp[q.length].slice(0, topN).map((p) => ({ segments: p.segs, score: p.score })),
  }
}
