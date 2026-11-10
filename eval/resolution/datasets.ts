/**
 * Resolution eval datasets: documents → chunks → predicted chunk mentions
 * (from the production NER), plus hand-assigned gold entity keys.
 *
 * Two corpora, both multi-document so the same annotation serves both tasks:
 *   - douluo: the six 斗罗大陆 chapters in the local library (one knowledge scope)
 *   - sanguo: chapters 1–8 of 三國志演義 (Project Gutenberg #23950, public domain,
 *     traditional script) — dense with courtesy-name aliases (劉備/玄德, 關羽/雲長)
 *
 * Unit of annotation is a surface form: a distinct (document, text, type) triple.
 * Gold assigns each surface form a corpus-wide entity key; within-document
 * coreference gold = surface forms of a document grouped by key, and
 * cross-document resolution gold = keys shared with earlier documents.
 * (Homonyms inside one document — the same string naming two referents — are
 * rare in these texts and not modelled.)
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { generateChunkIndices } from '../../server/lib/chunking'

export const DATA_DIR = join(process.cwd(), 'eval/resolution/data')
const LOCAL_D1 = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject'

export interface Chunk {
  order: number
  content: string
}

export interface ChunkMention {
  /** Stable within a corpus: `${docId}:${chunk}:${start}`. */
  id: string
  chunk: number
  start: number
  end: number
  text: string
  type: string
}

export interface Doc {
  id: string
  title: string
  chunks: Chunk[]
  mentions: ChunkMention[]
}

export interface Corpus {
  name: string
  docs: Doc[]
}

/**
 * Gold entity keys. Default: a surface form's key is its text (type-agnostic,
 * corpus-wide), so only exceptions are annotated — `aliases` maps a text to a
 * canonical key everywhere (玄德 → 劉備), `docOverrides` maps `${docId}\t${text}`
 * for homonyms or one-off references (大师 meaning a specific person in one chapter).
 */
export interface Gold {
  aliases: Record<string, string>
  docOverrides: Record<string, string>
}

export const goldKey = (gold: Gold, docId: string, text: string): string =>
  gold.docOverrides[`${docId}\t${text}`] ?? gold.aliases[text] ?? text

function localDbPath(): string {
  const f = readdirSync(LOCAL_D1).find((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite')
  if (!f) throw new Error('local D1 sqlite not found; run npm run dev once')
  return join(LOCAL_D1, f)
}

export function douluoRawDocs(): Array<{ id: string; title: string; chunks: Chunk[] }> {
  const db = new DatabaseSync(localDbPath(), { readOnly: true })
  const docs = db.prepare('SELECT id, title FROM document ORDER BY id').all() as Array<{ id: number; title: string }>
  const out = docs.map((d) => {
    const rows = db.prepare('SELECT chunk_order, content FROM text_chunk WHERE source_document_id = ? ORDER BY chunk_order').all(d.id) as Array<{ chunk_order: number; content: string }>
    return { id: `douluo-${d.id}`, title: d.title, chunks: rows.map((r) => ({ order: r.chunk_order, content: r.content })) }
  })
  db.close()
  return out
}

export function sanguoRawDocs(chapters = 8): Array<{ id: string; title: string; chunks: Chunk[] }> {
  const path = join(DATA_DIR, 'download/sanguo.txt')
  if (!existsSync(path)) throw new Error(`missing ${path}: curl -sL -o ${path} https://www.gutenberg.org/cache/epub/23950/pg23950.txt`)
  const lines = readFileSync(path, 'utf8').replace(/\r/g, '').split('\n')
  const heads = lines.map((l, i) => (/^第[一二三四五六七八九十百]+回：/.test(l) ? i : -1)).filter((i) => i >= 0)
  const out = []
  for (let c = 0; c < chapters; c++) {
    const body = lines.slice(heads[c] + 1, heads[c + 1])
    // Re-flow hard-wrapped lines: paragraphs start with an ideographic-space indent.
    const paras: string[] = []
    for (const l of body) {
      if (!l.trim()) continue
      if (/^　/.test(l) || paras.length === 0) paras.push(l.trim())
      else paras[paras.length - 1] += l.trim()
    }
    const content = paras.join('\n\n')
    const chunks = generateChunkIndices(content).map((ix, order) => ({ order, content: content.slice(ix.startIndex, ix.endIndex) }))
    out.push({ id: `sanguo-${c + 1}`, title: lines[heads[c]], chunks })
  }
  return out
}

export function loadCorpus(name: string): Corpus {
  const path = join(DATA_DIR, `${name}-mentions.json`)
  if (!existsSync(path)) throw new Error(`missing ${path}: run  npm run eval:resolution -- build ${name}`)
  return JSON.parse(readFileSync(path, 'utf8')) as Corpus
}

export function loadGold(name: string): Gold {
  const path = join(DATA_DIR, `${name}-gold.json`)
  if (!existsSync(path)) throw new Error(`missing ${path} (hand annotation)`)
  return JSON.parse(readFileSync(path, 'utf8')) as Gold
}

export interface SurfaceForm {
  docId: string
  text: string
  type: string
  mentions: ChunkMention[]
}

/** Distinct (text, type) surface forms of a document, in first-occurrence order. */
export function surfaceForms(doc: Doc): SurfaceForm[] {
  const byKey = new Map<string, SurfaceForm>()
  for (const m of doc.mentions) {
    const k = `${m.text}\t${m.type}`
    let f = byKey.get(k)
    if (!f) byKey.set(k, (f = { docId: doc.id, text: m.text, type: m.type, mentions: [] }))
    f.mentions.push(m)
  }
  return [...byKey.values()]
}

/** ±`radius` chars of chunk text around a mention, with the mention bracketed. */
export function mentionContext(doc: Doc, m: ChunkMention, radius = 60): string {
  const c = doc.chunks[m.chunk].content
  return c.slice(Math.max(0, m.start - radius), m.start) + '【' + m.text + '】' + c.slice(m.end, m.end + radius)
}
