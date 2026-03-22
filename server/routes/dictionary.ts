import { Hono } from 'hono'

const dictionaryRoutes = new Hono<{ Bindings: Env }>()

// ── Types ────────────────────────────────────────────────────────────────────

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

// ── Helpers ──────────────────────────────────────────────────────────────────

// Strip FTS5 operator characters from user input (keep * for prefix search).
function sanitizeFts5(q: string): string {
  return q.replace(/["()^]/g, '').trim()
}

// Appends * to each space-separated part that ends in an ASCII letter (a pinyin
// syllable with no explicit tone digit), so FTS5 prefix-matches the tokenised
// syllable regardless of which tone digit was stored alongside it.
// The FTS5 unicode61 tokeniser strips digits, so "si4 ma3" is indexed as
// tokens ["si", "ma"] — "si*" prefix-matches "si", "si4*" would not.
// Parts already ending in a digit, wildcard, or non-ASCII char are left alone.
//   "si ma dang"  → "si* ma* dang*"
//   "ren5"        → "ren5"
//   "ni3 hao"     → "ni3 hao*"
//   "你好"         → "你好"
function addPinyinWildcards(sanitized: string): string {
  return sanitized.split(' ').filter(p => p.length > 0).map(part => {
    if (!/[a-zA-Z]$/.test(part)) return part
    return `${part}*`
  }).join(' ')
}

// Returns true if the pattern needs LIKE semantics (underscore wildcard, or *
// not just at the end — FTS5 only supports trailing prefix wildcards).
function needsLike(pattern: string): boolean {
  return pattern.includes('_') || (pattern.includes('*') && !pattern.endsWith('*'))
}

// Convert a user wildcard pattern to a SQL LIKE pattern.
// * → %, _ stays _ (already the LIKE single-char wildcard).
function toLikePattern(pattern: string): string {
  return pattern.replace(/\*/g, '%')
}

// GET /api/dictionary/search
//
// Query params (all optional, all ANDed together):
//   q          – text search: Chinese chars, pinyin, or English; supports * (prefix) and _ (single-char) wildcards
//   tone       – 1|2|3|4|5  filter entries whose pinyin contains this tone digit
//   def        – definition keyword (full-text search on definitions)
//   strokes    – N or N-M  (no-op: stroke count not yet in schema)
//   radical    – string     (no-op: Kangxi radical not yet in schema)
//   component  – string     (no-op: structural component not yet in schema)
//   limit      – default 50, max 200

dictionaryRoutes.get('/search', async (c) => {
  const q          = c.req.query('q')?.trim() ?? ''
  const tone       = c.req.query('tone')?.trim() ?? ''
  const def_       = c.req.query('def')?.trim() ?? ''
  // headwords=1 restricts text search to simplified/traditional columns only
  // (excludes pinyin and definitions from FTS matching)
  const headwordsOnly = c.req.query('headwords') === '1'
  // no-op params — accepted for API stability, ignored until schema supports them
  // const _strokes   = c.req.query('strokes')
  // const _radical   = c.req.query('radical')
  // const _component = c.req.query('component')
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50'), 200)

  const validTone = /^[1-5]$/.test(tone) ? tone : ''

  // ── Determine search strategy ──────────────────────────────────────────────
  //
  // Three paths:
  //   fts  – FTS5 MATCH on the dictionary_fts virtual table (text/def filters)
  //   like – LIKE on entry columns (when q contains _ or non-trailing *)
  //   bare – direct table scan (tone-only, or no active filter)

  type Strategy = 'fts' | 'like' | 'bare'
  let strategy: Strategy = 'bare'
  let ftsMatchParts: string[] = []
  let likePattern = ''

  if (q) {
    if (needsLike(q)) {
      strategy = 'like'
      likePattern = toLikePattern(q)
    } else {
      strategy = 'fts'
      const sanitized = sanitizeFts5(q)
      // headwords=1: restrict FTS match to the character columns only
      // (FTS5 column filter syntax: {col1 col2}:term)
      const withWildcards = addPinyinWildcards(sanitized)
      const base = withWildcards !== sanitized
        ? withWildcards
        : /^[a-zA-Z0-9\s]+$/.test(q) && !q.endsWith('*') ? sanitized + '*' : sanitized
      // headwords=1: restrict to character + pinyin columns (exclude definitions)
      const ftsQ = headwordsOnly ? `{simplified traditional pinyin}:${base}` : base
      if (ftsQ) ftsMatchParts.push(ftsQ)
    }
  }

  if (def_) {
    // Definitions are always searched via FTS5 regardless of q strategy.
    // If q is using LIKE, we combine: LIKE for chars + LIKE for def text below.
    if (strategy !== 'like') {
      strategy = 'fts'
      const defQ = /^[a-zA-Z0-9\s]+$/.test(def_) && !def_.endsWith('*')
        ? `definitions_text:${sanitizeFts5(def_)}*`
        : `definitions_text:${sanitizeFts5(def_)}`
      ftsMatchParts.push(defQ)
    }
  }

  // ── Build and run the SQL ──────────────────────────────────────────────────

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
      const { results } = await c.env.DB
        .prepare(sql)
        .bind(matchExpr, ...extraBinds, limit)
        .all<EntryRow>()
      entryRows = results
    } catch (err) {
      // Malformed FTS5 query (e.g. bare wildcard) — return empty
      console.error('[dictionary/search] FTS query error:', err)
      return c.json({ results: [] })
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
    const { results } = await c.env.DB
      .prepare(sql)
      .bind(...binds, limit)
      .all<EntryRow>()
    entryRows = results

  } else if (strategy === 'bare' && validTone) {
    const sql = `
      SELECT e.id, e.traditional, e.simplified, e.pinyin
      FROM dictionary_entry e
      WHERE e.pinyin LIKE ?
      ORDER BY length(e.simplified), e.simplified
      LIMIT ?
    `
    const { results } = await c.env.DB
      .prepare(sql)
      .bind(`%${validTone}%`, limit)
      .all<EntryRow>()
    entryRows = results

  } else {
    return c.json({ results: [] })
  }

  if (entryRows.length === 0) return c.json({ results: [] })

  // ── Fetch definitions ──────────────────────────────────────────────────────
  //
  // Definitions are stored one row per definition in dictionary_definition.
  // Fetch them all in one query and group by entry_id.

  const ids = entryRows.map((r) => r.id)
  const placeholders = ids.map(() => '?').join(', ')

  const { results: defRows } = await c.env.DB
    .prepare(
      `SELECT entry_id, definition
       FROM dictionary_definition
       WHERE entry_id IN (${placeholders})
       ORDER BY entry_id, sort_order`
    )
    .bind(...ids)
    .all<DefinitionRow>()

  const defsByEntry = new Map<number, string[]>()
  for (const row of defRows) {
    const arr = defsByEntry.get(row.entry_id) ?? []
    arr.push(row.definition)
    defsByEntry.set(row.entry_id, arr)
  }

  const results = entryRows.map((entry) => ({
    id:          entry.id,
    traditional: entry.traditional,
    simplified:  entry.simplified,
    pinyin:      entry.pinyin,
    definitions: defsByEntry.get(entry.id) ?? [],
  }))

  return c.json({ results })
})

// GET /api/dictionary/segment
//
// Segments an input string (typically Chinese characters) into the best-ranked
// sequence(s) of dictionary entries using beam-search dynamic programming.
//
// Query params:
//   q      – input string (max 20 characters)
//   limit  – number of segmentations to return (default 5, max 10)

dictionaryRoutes.get('/segment', async (c) => {
  const raw = (c.req.query('q') ?? '').trim()
  const topN = Math.min(parseInt(c.req.query('limit') ?? '5'), 10)

  if (!raw) return c.json({ query: '', segmentations: [] })

  // Cap length to keep the candidate query and DP tractable.
  const q = raw.slice(0, 20)

  // ── Find candidates ────────────────────────────────────────────────────────
  //
  // An entry is a candidate if its simplified or traditional form appears as a
  // substring of q. instr(q, entry.simplified) > 0 means "entry.simplified is in q".

  const { results: candidateRows } = await c.env.DB
    .prepare(
      `SELECT id, traditional, simplified, pinyin
       FROM dictionary_entry
       WHERE (simplified  != '' AND instr(?, simplified)  > 0)
          OR (traditional != '' AND traditional != simplified AND instr(?, traditional) > 0)`
    )
    .bind(q, q)
    .all<EntryRow>()

  if (candidateRows.length === 0) return c.json({ query: q, segmentations: [] })

  // ── Fetch definitions (chunked to stay under D1's 100-param limit) ─────────

  const allDefRows: DefinitionRow[] = []
  const ids = candidateRows.map((r) => r.id)
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90)
    const ph = chunk.map(() => '?').join(', ')
    const { results } = await c.env.DB
      .prepare(
        `SELECT entry_id, definition
         FROM dictionary_definition
         WHERE entry_id IN (${ph})
         ORDER BY entry_id, sort_order`
      )
      .bind(...chunk)
      .all<DefinitionRow>()
    allDefRows.push(...results)
  }

  const defsByEntry = new Map<number, string[]>()
  for (const row of allDefRows) {
    const arr = defsByEntry.get(row.entry_id) ?? []
    arr.push(row.definition)
    defsByEntry.set(row.entry_id, arr)
  }

  type SegEntry = EntryRow & { definitions: string[] }

  const entries: SegEntry[] = candidateRows.map((r) => ({
    ...r,
    definitions: defsByEntry.get(r.id) ?? [],
  }))

  // ── Build position map: pos → length → SegEntry[] ─────────────────────────
  //
  // For each entry, find all positions in q where its simplified or traditional
  // form appears. Group by (position, length) so homographs (same text,
  // different pinyin) are bundled as alternative readings of one segment.

  const posMap = new Map<number, Map<number, SegEntry[]>>()

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

  // ── Beam-search DP ────────────────────────────────────────────────────────
  //
  // dp[i] = top BEAM partial segmentations that have consumed exactly i chars.
  // Score = Σ segment_length², rewarding longer (more informative) matches.
  // Only complete segmentations (those reaching q.length) are returned.

  type Segment = { text: string; entries: SegEntry[] }
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

  return c.json({
    query: q,
    segmentations: dp[q.length].slice(0, topN).map((p) => ({
      segments: p.segs,
      score: p.score,
    })),
  })
})

// POST /api/dictionary/explain
//
// Request body: { term, entries, documentId, chunkId }
// Returns: { explanation: string }
dictionaryRoutes.post('/explain', async (c) => {
  const body = await c.req.json<{
    term: string
    entries: Array<{
      traditional: string
      simplified: string
      pinyin: string
      definitions: string[]
    }>
    documentId: number
    chunkId: number
  }>()

  const { term, entries, documentId, chunkId } = body

  // Fetch the target chunk's order
  const targetChunk = await c.env.DB
    .prepare(`SELECT chunk_order FROM text_chunk WHERE id = ? AND source_document_id = ?`)
    .bind(chunkId, documentId)
    .first<{ chunk_order: number }>()

  if (!targetChunk) return c.json({ error: 'Chunk not found' }, 404)

  const order = targetChunk.chunk_order

  // Fetch context window: target ± 2 neighbors
  const { results: contextChunks } = await c.env.DB
    .prepare(
      `SELECT content FROM text_chunk
       WHERE source_document_id = ?
         AND chunk_order BETWEEN ? AND ?
       ORDER BY chunk_order`
    )
    .bind(documentId, order - 2, order + 2)
    .all<{ content: string }>()

  const contextText = contextChunks.map((r) => r.content).join('\n\n')

  // Format entries for prompt
  const formatEntry = (e: typeof entries[0]) =>
    `${e.traditional} (${e.pinyin}): ${e.definitions.join('; ')}`

  const topEntry = entries[0]
  const otherEntries = entries.slice(1, 5)

  const topEntryText = topEntry ? formatEntry(topEntry) : term
  const otherEntriesText = otherEntries.length > 0
    ? otherEntries.map(formatEntry).join('\n')
    : '(none)'

  const messages = [
    {
      role: 'system' as const,
      content: 'You are a Chinese language tutor. Give direct, compact explanations. Never use filler phrases like "In this passage", "The context suggests", "Here,", or "This word". Start immediately with the meaning or usage.',
    },
    {
      role: 'user' as const,
      content: `The learner selected: "${term}"

Dictionary entry shown:
${topEntryText}

Other returned entries (not shown to learner):
${otherEntriesText}

Text:
${contextText}

In 1–2 sentences, explain how "${term}" is used here. Skip anything obvious from the dictionary gloss.`,
    },
  ]

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await c.env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast' as any, {
    messages,
    temperature: 0.3,
    max_tokens: 250,
  })

  const explanation = (result as { response?: string }).response ?? ''

  return c.json({ explanation })
})

// POST /api/dictionary/disambiguate
//
// Request body: { term, entries, documentId, chunkId }
// Returns: { explanation: string, entryId: number }
dictionaryRoutes.post('/disambiguate', async (c) => {
  const body = await c.req.json<{
    term: string
    entries: Array<{
      id: number
      traditional: string
      simplified: string
      pinyin: string
      definitions: string[]
    }>
    documentId: number
    chunkId: number
  }>()

  const { term, entries, documentId, chunkId } = body

  // Fetch the target chunk's order
  const targetChunk = await c.env.DB
    .prepare(`SELECT chunk_order FROM text_chunk WHERE id = ? AND source_document_id = ?`)
    .bind(chunkId, documentId)
    .first<{ chunk_order: number }>()

  if (!targetChunk) return c.json({ error: 'Chunk not found' }, 404)

  const order = targetChunk.chunk_order

  // Fetch context window: target ± 2 neighbors
  const { results: contextChunks } = await c.env.DB
    .prepare(
      `SELECT content FROM text_chunk
       WHERE source_document_id = ?
         AND chunk_order BETWEEN ? AND ?
       ORDER BY chunk_order`
    )
    .bind(documentId, order - 2, order + 2)
    .all<{ content: string }>()

  const contextText = contextChunks.map((r) => r.content).join('\n\n')

  // Format entries as numbered list with IDs
  const entriesList = entries.map((e, i) =>
    `${i + 1}. [id=${e.id}] ${e.traditional} (${e.pinyin}): ${e.definitions.join('; ')}`
  ).join('\n')

  const messages = [
    {
      role: 'system' as const,
      content: 'You are a Chinese language tutor. Give direct, compact explanations. Never use filler phrases like "In this passage", "The context suggests", "Here,", or "This word". Start immediately with the meaning or usage.',
    },
    {
      role: 'user' as const,
      content: `The learner selected: "${term}"

Dictionary entries (numbered):
${entriesList}

Surrounding text:
${contextText}

Which entry best matches how "${term}" is used here?
Reply with JSON: { "entryId": <number>, "explanation": "<1–2 sentences>" }
The explanation should say which meaning applies and why, without filler phrases.`,
    },
  ]

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await c.env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast' as any, {
    messages,
    temperature: 0.3,
    max_tokens: 250,
    response_format: { type: 'json_object' },
  })

  const raw = (result as { response?: string }).response ?? '{}'
  let parsed: { entryId?: unknown; explanation?: unknown } = {}
  try { parsed = JSON.parse(raw) } catch { /* fall through */ }

  const validIds = new Set(entries.map((e) => e.id))
  const entryId = typeof parsed.entryId === 'number' && validIds.has(parsed.entryId)
    ? parsed.entryId
    : entries[0]?.id
  const explanation = typeof parsed.explanation === 'string' ? parsed.explanation : ''

  return c.json({ explanation, entryId })
})

// POST /api/dictionary/refresh
// Starts a CEDICT refresh workflow. Returns immediately with the job ID.
dictionaryRoutes.post('/refresh', async (c) => {
  const jobId = `cedict-refresh-${Date.now()}`

  await c.env.DB.prepare(
    `INSERT INTO dictionary_refresh_job (id) VALUES (?)`
  )
    .bind(jobId)
    .run()

  await c.env.REFRESH_CEDICT_WORKFLOW.create({ id: jobId, params: { jobId } })

  return c.json({ jobId })
})

// GET /api/dictionary/refresh/:jobId
// Returns the current status and progress of a refresh job.
dictionaryRoutes.get('/refresh/:jobId', async (c) => {
  const { jobId } = c.req.param()

  const job = await c.env.DB.prepare(
    `SELECT id, status, total_entries, processed_entries, epoch, started_at, completed_at, error
     FROM dictionary_refresh_job WHERE id = ?`
  )
    .bind(jobId)
    .first<{
      id: string
      status: string
      total_entries: number | null
      processed_entries: number
      epoch: number | null
      started_at: string
      completed_at: string | null
      error: string | null
    }>()

  if (!job) return c.json({ error: 'Job not found' }, 404)

  const percent =
    job.total_entries && job.total_entries > 0
      ? Math.round((job.processed_entries / job.total_entries) * 100)
      : null

  return c.json({
    jobId: job.id,
    status: job.status,
    totalEntries: job.total_entries,
    processedEntries: job.processed_entries,
    percent,
    epoch: job.epoch,
    startedAt: job.started_at,
    completedAt: job.completed_at,
    error: job.error,
  })
})

export default dictionaryRoutes
