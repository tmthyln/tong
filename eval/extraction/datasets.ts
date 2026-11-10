/**
 * Eval datasets for the generic extractor.
 *
 *  - lit:    Chinese Literature NER/RE benchmark (Xu et al. 2017, lancopku).
 *            Brat files under eval/extraction/data/lit/{Testing,Validation}.
 *  - douluo: in-domain novel chunks from the local D1 database with the app's
 *            own ontology (node_type / edge_type). Gold is "silver" — see silver.ts.
 *
 * Every example is a passage with unique (text,label) gold mentions and
 * (head,label,tail) gold relations, scored at string level per passage.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ExtractionSchema, KnownEntity } from '../../server/lib/extraction/schema'
import type { Mention, Relation } from '../../server/lib/extraction/extract'

export interface Example {
  id: string
  text: string
  /** For in-domain data: the chunk texts making up `text` (joined by \n). */
  parts: string[]
  gold: { mentions: Mention[]; relations: Relation[] }
}

export interface Dataset {
  name: string
  schema: ExtractionSchema
  examples: Example[]
}

export const DATA_DIR = join(process.cwd(), 'eval/extraction/data')

/** Deterministic PRNG (mulberry32) so samples are reproducible. */
export function rng(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle<T>(xs: T[], rand: () => number): T[] {
  const a = [...xs]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// ---------------------------------------------------------------- lit

export const LIT_SCHEMA: ExtractionSchema = {
  entities: [
    { name: 'Person', description: 'A person or group of people, named or described by a noun phrase (e.g. 毛泽东, 青年老师, 同学们, 父亲).' },
    { name: 'Location', description: 'A place, named or described (e.g. 北京, 院子, 山上, 湛家大街的街口).' },
    { name: 'Organization', description: 'An organization or institution, named or described (e.g. 中国共产党, 学校, 商行).' },
    { name: 'Thing', description: 'A concrete object, artifact, plant, animal, body part, or work (e.g. 花瓣, 勒勒车, 《富春山居图》, 手).' },
    { name: 'Time', description: 'An explicit or implicit time expression (e.g. 1949年, 上世纪50年代中期, 那天, 清晨).' },
    { name: 'Metric', description: 'A measurement or quantity with a unit (e.g. 10公里, 三百余户, 两米高).' },
    { name: 'Abstract', description: 'An abstract concept treated as an entity (e.g. 精神, 文化, 理想).' },
  ],
  relations: [
    { name: 'Located', description: 'head (person/thing) is located in or at tail (location).', examples: ['月季 → 花坛', '炮弹 → 大海'] },
    { name: 'Part-Whole', description: 'head is a part or component of tail.', examples: ['树冠 → 古皂角树', '背 → 我'] },
    { name: 'Family', description: 'head and tail are family members.', examples: ['我 → 舅舅'] },
    { name: 'Social', description: 'head and tail have a social (non-family) relationship: friends, teacher-student, colleagues.', examples: ['我 → 我的学生'] },
    { name: 'General-Special', description: 'head is a general category of which tail is a specific instance or subtype.', examples: ['商行 → 皮草商行'] },
    { name: 'Ownership', description: 'head owns or possesses tail.', examples: ['我们 → 我们的汽车'] },
    { name: 'Use', description: 'head (person) uses tail (thing).', examples: ['蒙族家庭 → 勒勒车'] },
    { name: 'Create', description: 'head creates or produces tail.', examples: ['黄公望 → 《富春山居图》'] },
    { name: 'Near', description: 'head location is near tail location.', examples: ['酉水岸边 → 酉水'] },
  ],
  instructions: 'The text is Chinese literary prose. Extract named AND nominal mentions (descriptive noun phrases), but not pronouns (我, 他, 它们, 这里, ...).',
}

const LIT_TYPE_MAP: Record<string, string> = {
  'Person-Name': 'Person', 'Person-Nominal': 'Person',
  'Location-Name': 'Location', 'Location-Nominal': 'Location',
  'Organization-Name': 'Organization', 'Organization-Nominal': 'Organization',
  'Thing-Name': 'Thing', 'Thing-Nominal': 'Thing',
  'Time-Explicit': 'Time', 'Time-Implicit': 'Time',
  Metric: 'Metric', Abstract: 'Abstract',
  // *-Pronoun and Physical are dropped.
}

interface BratEntity { id: string; label: string; start: number; end: number; text: string }

function parseBrat(txt: string, ann: string) {
  const ents = new Map<string, BratEntity>()
  const rels: Array<{ label: string; a1: string; a2: string }> = []
  for (const line of ann.split('\n')) {
    const p = line.split('\t')
    if (p[0].startsWith('T')) {
      const [type, range] = [p[1].split(' ')[0], p[1].slice(p[1].indexOf(' ') + 1)]
      if (range.includes(';')) continue // discontinuous
      const [s, e] = range.split(' ').map(Number)
      if (txt.slice(s, e) !== p[2]) continue
      const label = LIT_TYPE_MAP[type]
      if (label) ents.set(p[0], { id: p[0], label, start: s, end: e, text: p[2] })
    } else if (p[0].startsWith('R')) {
      const [label, a1, a2] = p[1].split(' ')
      rels.push({ label, a1: a1.split(':')[1], a2: a2.split(':')[1] })
    }
  }
  return { ents, rels }
}

/** Split text into passages of roughly `target` chars at sentence boundaries. */
function passages(txt: string, target: number): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = []
  let start = 0
  const re = /[。！？!?\n]+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(txt))) {
    const end = m.index + m[0].length
    if (end - start >= target) {
      out.push({ start, end })
      start = end
    }
  }
  if (txt.length - start > target / 3) out.push({ start, end: txt.length })
  return out
}

export function loadLit(opts: { split?: 'Testing' | 'Validation'; n?: number; seed?: number; passageChars?: number } = {}): Dataset {
  const dir = join(DATA_DIR, 'lit', opts.split ?? 'Testing')
  const all: Example[] = []
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.ann')).sort()) {
    const docId = f.replace('.ann', '')
    const txt = readFileSync(join(dir, `${docId}.txt`), 'utf8')
    const { ents, rels } = parseBrat(txt, readFileSync(join(dir, f), 'utf8'))
    for (const [pi, p] of passages(txt, opts.passageChars ?? 350).entries()) {
      const inside = (e: BratEntity) => e.start >= p.start && e.end <= p.end
      const text = txt.slice(p.start, p.end).trim()
      const mentions = new Map<string, Mention>()
      for (const e of ents.values()) if (inside(e)) mentions.set(`${e.text}|${e.label}`, { text: e.text.trim(), label: e.label })
      const relations = new Map<string, Relation>()
      for (const r of rels) {
        const h = ents.get(r.a1)
        const t = ents.get(r.a2)
        if (h && t && inside(h) && inside(t) && h.text !== t.text) {
          relations.set(`${h.text}|${r.label}|${t.text}`, { head: h.text.trim(), label: r.label, tail: t.text.trim(), evidence: '' })
        }
      }
      all.push({ id: `lit-${docId}-${pi}`, text, parts: [text], gold: { mentions: [...mentions.values()], relations: [...relations.values()] } })
    }
  }
  // Only passages that have at least one relation, so RE is measurable everywhere.
  const withRels = all.filter((e) => e.gold.relations.length > 0)
  const examples = shuffle(withRels, rng(opts.seed ?? 7)).slice(0, opts.n ?? 40)
  return { name: 'lit', schema: LIT_SCHEMA, examples }
}

// ---------------------------------------------------------------- douluo (in-domain)

export const LOCAL_D1 = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject'

function localDbPath(): string {
  const f = readdirSync(LOCAL_D1).find((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite')
  if (!f) throw new Error('local D1 sqlite not found; run npm run dev once')
  return join(LOCAL_D1, f)
}

function parseExamples(json: string): string[] {
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []
  } catch {
    return []
  }
}

/** The app's current ontology, read from the local D1 database. */
export function loadAppSchema(): ExtractionSchema {
  const db = new DatabaseSync(localDbPath(), { readOnly: true })
  const nodes = db.prepare('SELECT name, definition, examples_json FROM node_type WHERE is_current = 1 ORDER BY name').all() as Array<{ name: string; definition: string; examples_json: string }>
  const edges = db.prepare('SELECT name, definition, examples_json FROM edge_type WHERE is_current = 1 ORDER BY name').all() as Array<{ name: string; definition: string; examples_json: string }>
  db.close()
  return {
    entities: nodes.map((n) => ({ name: n.name, description: n.definition, examples: parseExamples(n.examples_json) })),
    relations: edges.map((e) => ({ name: e.name, description: e.definition, examples: parseExamples(e.examples_json) })),
    instructions: 'The text is Chinese (Mandarin) prose.',
  }
}

/** Windows of `windowChunks` consecutive chunks, sampled across documents. */
export function loadDouluoWindows(opts: { windows?: number; windowChunks?: number; seed?: number } = {}): Array<{ id: string; parts: string[] }> {
  const db = new DatabaseSync(localDbPath(), { readOnly: true })
  const rows = db.prepare('SELECT id, source_document_id AS doc, chunk_order, content FROM text_chunk ORDER BY source_document_id, chunk_order').all() as Array<{ id: number; doc: number; chunk_order: number; content: string }>
  db.close()
  const k = opts.windowChunks ?? 4
  const byDoc = new Map<number, typeof rows>()
  for (const r of rows) byDoc.set(r.doc, [...(byDoc.get(r.doc) ?? []), r])
  const candidates: Array<{ id: string; parts: string[] }> = []
  for (const [doc, chunks] of byDoc) {
    for (let i = 0; i + k <= chunks.length; i += k) {
      candidates.push({ id: `douluo-${doc}-${chunks[i].id}`, parts: chunks.slice(i, i + k).map((c) => c.content) })
    }
  }
  return shuffle(candidates, rng(opts.seed ?? 11)).slice(0, opts.windows ?? 12)
}

export function loadDouluo(): Dataset {
  const path = join(DATA_DIR, 'douluo-silver.json')
  if (!existsSync(path)) throw new Error('douluo silver labels missing — run: npm run eval:extraction -- silver')
  return JSON.parse(readFileSync(path, 'utf8')) as Dataset
}
