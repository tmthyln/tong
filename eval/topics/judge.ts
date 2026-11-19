/**
 * Scores topic-label runs (results/runs/*.json) on three axes:
 *
 * - descriptive  LLM judge, 1–5: from a sample of a cluster's passages, would a
 *                reader correctly predict what they are about, at a useful level
 *                of specificity?
 * - faithful     LLM judge: the label is split into its content claims (entities,
 *                events, subjects, qualifiers); each must be supported by the
 *                sampled passages. Score = share of supported claims; a label is
 *                faithful when all of its claims are.
 * - discriminative
 *                (a) LLM judge, matching: shown 4 passages from a cluster and every
 *                label of that layer (shuffled), pick the label — accuracy. Labels
 *                repeated within a layer are separate options, so duplicates cost
 *                accuracy, as they should.
 *                (b) embeddings, judge-free: share of a cluster's chunks whose
 *                nearest label (cosine, embeddinggemma-2) is its own.
 *
 * Two judges outside the candidate set (deepseek-v4-pro, glm-5.3) score every
 * label; scores are averaged and their agreement reported. Passage samples are
 * seeded by cluster membership, so models that produced the same cluster are
 * judged on the same passages.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { mapLimit } from '../../server/lib/map-limit'
import { chatCached, embedCached, RESULTS_DIR } from './bridge'
import { DATA_DIR, type CorpusChunk } from './corpus'

export const JUDGES = ['@cf/deepseek-ai/deepseek-v4-pro-0813', '@cf/zai-org/glm-5.3']
const SAMPLE = 10
const MATCH_SAMPLE = 4
const PASSAGE_CHARS = 220

interface Entry {
  label_zh: string
  label_en: string
  size: number
  members: number[]
}
interface Run {
  model: string
  seconds: number
  calls: number
  layers: Entry[][]
}

export interface LabelScore {
  layer: number
  label: string
  gloss: string
  size: number
  descriptive: number[]
  faithful: number[]
  unsupported: string[]
  generic: boolean[]
  match: boolean[]
  embedHit: number
}

// ------------------------------------------------------------------ helpers

function rng(seed: string) {
  let h = parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16)
  return () => {
    h = (h + 0x6d2b79f5) | 0
    let t = Math.imul(h ^ (h >>> 15), 1 | h)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle<T>(xs: T[], seed: string): T[] {
  const r = rng(seed)
  const a = [...xs]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

const sampleOf = (members: number[]) => shuffle(members, members.join(',')).slice(0, SAMPLE)
/** A failed judge call (rate limit, bad JSON) is skipped, not cached; rerun `judge` to fill it in. */
async function safe<T>(f: () => Promise<T>): Promise<T | null> {
  try {
    return await f()
  } catch (err) {
    console.warn(String(err).slice(0, 160))
    return null
  }
}

const clip = (t: string) => t.replace(/\s+/g, ' ').slice(0, PASSAGE_CHARS)

function parseJson<T>(raw: string): T | null {
  const m = /\{[\s\S]*\}/.exec(raw.replace(/```(?:json)?/g, ''))
  if (!m) return null
  try {
    return JSON.parse(m[0]) as T
  } catch {
    return null
  }
}

const cos = (a: number[], b: number[]) => {
  let d = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return d / Math.sqrt(na * nb)
}

// ------------------------------------------------------------------ judges

const RATE_SYSTEM = `You evaluate topic labels on a map of a Chinese-language reading library. Each label names a cluster of text passages; readers use it to decide where to look. Judge only from the passages shown. Respond with a JSON object only.`

function ratePrompt(label: string, size: number, passages: string[]): string {
  return `Label: ${label}

A random sample of ${passages.length} passages from this cluster of ${size}:
${passages.map((p, i) => `[${i + 1}] ${p}`).join('\n')}

Return {"descriptive": n, "generic": bool, "claims": [{"claim": "...", "supported": bool}]}.

descriptive (1-5) — from the label alone, would a reader correctly predict what these passages are about?
5 = accurate and specific; covers most passages.
4 = accurate, but somewhat too broad or too narrow.
3 = right general area but vague, or describes only some of the passages.
2 = mostly misleading, or so generic it says almost nothing.
1 = wrong.

generic = true if the label could fit almost any part of a mixed library (e.g. "文本段落", "百科知识", "综合内容").

claims — split the label into its distinct content claims: each named entity, event, subject, and qualifier (e.g. 历史, 规则, 起源). supported = true if at least one passage states or clearly shows it, or it is a fair generalisation of several passages; false if it is absent from every passage or contradicted.`
}

function matchPrompt(passages: string[], labels: string[]): string {
  return `These ${passages.length} passages come from one cluster on the map:
${passages.map((p, i) => `[${i + 1}] ${p}`).join('\n')}

Which of these topic labels was written for that cluster?
${labels.map((l, i) => `${i + 1}. ${l}`).join('\n')}

Return {"choice": n} with the number of the best-fitting label.`
}

async function rate(judge: string, e: Entry, texts: string[]) {
  const passages = sampleOf(e.members).map((i) => clip(texts[i]))
  const raw = await chatCached(judge, [{ role: 'system', content: RATE_SYSTEM }, { role: 'user', content: ratePrompt(e.label_zh, e.size, passages) }], 0, 800, 'judge')
  const r = parseJson<{ descriptive?: number; generic?: boolean; claims?: Array<{ claim: string; supported: boolean }> }>(raw)
  if (!r || typeof r.descriptive !== 'number') return null
  const claims = r.claims ?? []
  return {
    descriptive: Math.max(1, Math.min(5, r.descriptive)),
    generic: !!r.generic,
    faithful: claims.length ? claims.filter((c) => c.supported).length / claims.length : 1,
    unsupported: claims.filter((c) => !c.supported).map((c) => c.claim),
  }
}

async function match(judge: string, layer: Entry[], k: number, texts: string[], seed: string): Promise<boolean | null> {
  const passages = sampleOf(layer[k].members).slice(0, MATCH_SAMPLE).map((i) => clip(texts[i]))
  const order = shuffle(layer.map((_, i) => i), `${seed}:${k}`)
  const raw = await chatCached(judge, [{ role: 'system', content: RATE_SYSTEM }, { role: 'user', content: matchPrompt(passages, order.map((i) => layer[i].label_zh)) }], 0, 200, 'judge')
  const r = parseJson<{ choice?: number }>(raw)
  if (!r || typeof r.choice !== 'number') return null
  return order[r.choice - 1] === k
}

// ------------------------------------------------------------------ scoring

export async function judgeRun(run: Run, chunks: CorpusChunk[], vectors: number[][]): Promise<LabelScore[]> {
  const texts = chunks.map((c) => c.text)
  const out: LabelScore[] = []
  const labelVecs = await embedCached([...new Set(run.layers.flat().map((e) => e.label_zh))], 'query')
  const vecOf = new Map([...new Set(run.layers.flat().map((e) => e.label_zh))].map((l, i) => [l, labelVecs[i]]))

  for (const [li, layer] of run.layers.entries()) {
    const seed = layer.map((e) => e.members[0]).join(',')
    const tasks = layer.map((e, k) => ({ e, k }))
    const scored = await mapLimit(tasks, 6, async ({ e, k }) => {
      const rates = await Promise.all(JUDGES.map((j) => safe(() => rate(j, e, texts))))
      const matches = layer.length >= 3 ? await Promise.all(JUDGES.map((j) => safe(() => match(j, layer, k, texts, seed)))) : []
      // Judge-free discriminability: nearest label among this layer's labels.
      let hit = 0
      for (const m of e.members) {
        let best = -1, bestSim = -Infinity
        layer.forEach((o, oi) => {
          const s = cos(vectors[m], vecOf.get(o.label_zh)!)
          if (s > bestSim) (bestSim = s), (best = oi)
        })
        if (best === k || layer[best].label_zh === e.label_zh) hit++
      }
      const ok = rates.filter((r) => r !== null)
      return {
        layer: li,
        label: e.label_zh,
        gloss: e.label_en,
        size: e.size,
        descriptive: ok.map((r) => r.descriptive),
        faithful: ok.map((r) => r.faithful),
        unsupported: [...new Set(ok.flatMap((r) => r.unsupported))],
        generic: ok.map((r) => r.generic),
        match: matches.filter((m): m is boolean => m !== null),
        embedHit: e.members.length ? hit / e.members.length : 0,
      } satisfies LabelScore
    })
    out.push(...scored)
  }
  return out
}

export const slug = (m: string) => m.replace(/^@cf\//, '').replace(/[^a-z0-9.-]+/gi, '_')

export async function judgeAll(models: string[]) {
  const chunks = JSON.parse(readFileSync(join(DATA_DIR, 'corpus.json'), 'utf8')) as CorpusChunk[]
  const vectors = JSON.parse(readFileSync(join(DATA_DIR, 'vectors.json'), 'utf8')) as number[][]
  const runsDir = join(RESULTS_DIR, 'runs')
  const scoresDir = join(RESULTS_DIR, 'scores')
  mkdirSync(scoresDir, { recursive: true })
  const files = readdirSync(runsDir).filter((f) => f.endsWith('.json') && (!models.length || models.some((m) => f === `${slug(m)}.json`)))
  for (const f of files) {
    const run = JSON.parse(readFileSync(join(runsDir, f), 'utf8')) as Run
    if (!run.layers.length) {
      console.log(`${run.model}: no labels`)
      writeFileSync(join(scoresDir, f), JSON.stringify({ model: run.model, labels: [] }))
      continue
    }
    const t = Date.now()
    const labels = await judgeRun(run, chunks, vectors)
    writeFileSync(join(scoresDir, f), JSON.stringify({ model: run.model, labels }))
    const s = summarize(labels)
    console.log(`${run.model.padEnd(44)} desc ${s.descriptive.toFixed(2)}  faith ${s.faithful.toFixed(3)}  match ${s.match.toFixed(3)}  embed ${s.embed.toFixed(3)}  (${((Date.now() - t) / 1000).toFixed(0)}s)`)
  }
}

const mean = (xs: number[]) => {
  const ok = xs.filter((x) => !Number.isNaN(x))
  return ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : NaN
}

export function summarize(labels: LabelScore[]) {
  return {
    labels: labels.length,
    /** Judge calls still missing (rate limits); rerun `judge` to fill. */
    missing: labels.reduce((n, l) => n + (JUDGES.length - l.descriptive.length) + (l.match.length < JUDGES.length && l.layer >= 0 ? 0 : 0), 0),
    descriptive: mean(labels.map((l) => mean(l.descriptive))),
    faithful: mean(labels.map((l) => mean(l.faithful))),
    fullyFaithful: mean(labels.filter((l) => l.faithful.length).map((l) => (l.faithful.every((f) => f === 1) ? 1 : 0))),
    generic: mean(labels.map((l) => mean(l.generic.map(Number)))),
    match: mean(labels.filter((l) => l.match.length).map((l) => mean(l.match.map(Number)))),
    embed: mean(labels.map((l) => l.embedHit)),
  }
}

export async function report() {
  const mod = await import('./report')
  return mod.buildReport()
}

export function loadScores(): Array<{ model: string; labels: LabelScore[] }> {
  const dir = join(RESULTS_DIR, 'scores')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
}
