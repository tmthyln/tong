/**
 * Local extraction eval against Cloudflare-hosted Workers AI models.
 *
 *   npm run eval:extraction -- silver                         # build douluo silver labels (once)
 *   npm run eval:extraction -- run <dataset> <strategy> <model> [--thinking]
 *   npm run eval:extraction -- sweep [dataset...]              # the configured grid, resumable
 *   npm run eval:extraction -- summary                         # writes results/summary.json
 *
 * Auth: CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID, or falls back to the
 * wrangler OAuth login (~/.config/.wrangler/config/default.toml).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { neuronsToUsd } from '../../server/lib/extraction/llm'
import { cachedClients, slug } from '../common/workers-ai'
import { mapLimit } from '../../server/lib/map-limit'
import { extract, type Mention, type Relation } from '../../server/lib/extraction/extract'
import { DATA_DIR, loadAppSchema, loadDouluo, loadDouluoWindows, loadLit, type Dataset, type Example } from './datasets'
import { getStrategy, STRATEGIES, type Prediction } from './strategies'
import { addPrf, bootstrapF1, meanSd, pairedBootstrap, scoreMentions, scoreRelations, ZERO, type Interval, type PRF } from './metrics'

const RESULTS_DIR = join(process.cwd(), 'eval/extraction/results')
const CACHE_DIR = join(DATA_DIR, 'cache')


function loadDataset(name: string): Dataset {
  if (name === 'lit') return loadLit()
  if (name === 'douluo') return loadDouluo()
  throw new Error(`unknown dataset ${name}`)
}

export interface RunFile {
  dataset: string
  strategy: string
  model: string
  thinking: boolean
  examples: Array<{ id: string; chars: number; pred: Prediction; error?: string }>
  /** Calls replayed from the response cache; wall-clock latency is only meaningful when 0. */
  cacheHits?: number
  /** Replicate index (0 = the base run); replicates are independent samples of the same cell. */
  rep?: number
}

interface RunOpts {
  rep?: number
  /** Recompute even if the run file exists (calls replay from the cache). */
  force?: boolean
  /** Bypass cache reads: real calls, for timing. */
  fresh?: boolean
}

// ------------------------------------------------------------------ run

const runPath = (dataset: string, strategy: string, model: string, thinking: boolean, rep = 0) =>
  join(RESULTS_DIR, dataset, `${strategy}__${slug(model)}${thinking ? '__thinking' : ''}${rep ? `__r${rep}` : ''}.json`)

async function runOne(dataset: string, strategyName: string, model: string, thinking: boolean, opts: RunOpts = {}): Promise<RunFile> {
  const strategy = getStrategy(strategyName)
  const out = runPath(dataset, strategy.name, model, thinking, opts.rep)
  if (!opts.force && !opts.fresh && existsSync(out)) return JSON.parse(readFileSync(out, 'utf8')) as RunFile
  const ds = loadDataset(dataset)
  const { client, rawRun, stats } = cachedClients({ dir: CACHE_DIR, fresh: opts.fresh, rep: opts.rep })
  const t0 = Date.now()
  const examples = await mapLimit(ds.examples, Number(process.env.EVAL_EXAMPLE_CONCURRENCY ?? 6), async (ex) => {
    try {
      const pred = await strategy.run(ex, { client, rawRun, model, thinking, schema: ds.schema })
      return { id: ex.id, chars: ex.text.length, pred }
    } catch (err) {
      const empty: Prediction = { mentions: [], relations: [], usage: { promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0, neurons: 0 }, calls: 0, errors: 1, wallMs: 0, callMs: 0, truncated: 0 }
      return { id: ex.id, chars: ex.text.length, pred: empty, error: String(err) }
    }
  })
  const file: RunFile = { dataset, strategy: strategy.name, model, thinking, examples, cacheHits: stats.hits, rep: opts.rep ?? 0 }
  mkdirSync(join(RESULTS_DIR, dataset), { recursive: true })
  writeFileSync(out, JSON.stringify(file, null, 1))
  const s = summarize(file, ds)
  console.log(
    `${dataset.padEnd(7)} ${strategy.name.padEnd(24)} ${model.padEnd(42)} ${thinking ? 'T' : ' '}${opts.rep ? ` r${opts.rep}` : ''}  ` +
      `NER F1 ${fmt(s.ner?.typed.f1)}${ci(s.ci.ner)}  RE F1 ${fmt(s.re?.strict.f1)}${ci(s.ci.re)}  $/1Mchar ${s.usdPerMChar.toFixed(2).padStart(7)}  calls ${s.calls}  err ${s.errors}  trunc ${s.truncated}${s.anchorDropped ? `  unanchored ${s.anchorDropped}` : ''}  ${((Date.now() - t0) / 1000).toFixed(0)}s${stats.hits ? `  (cached ${stats.hits}/${stats.hits + stats.misses})` : ''}`,
  )
  return file
}

const fmt = (x: number | undefined) => (x === undefined ? '  -  ' : x.toFixed(3))
const ci = (i: Interval | undefined) => (i ? ` [${i.lo.toFixed(2)}–${i.hi.toFixed(2)}]` : '')

// ------------------------------------------------------------------ summary

export interface Summary {
  dataset: string
  strategy: string
  model: string
  thinking: boolean
  tasks: string[]
  n: number
  ner?: { typed: PRF; untyped: PRF }
  re?: { strict: PRF; undirected: PRF }
  usd: number
  usdPerMChar: number
  neurons: number
  promptTokens: number
  completionTokens: number
  calls: number
  callsPerKChar: number
  meanWallMs: number
  p95WallMs: number
  errors: number
  truncated: number
  /** app-pipeline: model relations that anchoring could not place. */
  anchorDropped: number
  rep: number
  /** 95% bootstrap interval of the headline F1s over examples (passage-sampling noise). */
  ci: { ner?: Interval; re?: Interval }
  /** Run-to-run spread of the headline F1s across replicates of this cell (rep-0 rows only). */
  replicates?: { n: number; ner?: { mean: number; sd: number }; re?: { mean: number; sd: number } }
}

/** Per-example headline scores (typed NER, strict RE), in dataset order. */
export function perExample(f: RunFile, ds: Dataset): { ids: string[]; ner: PRF[]; re: PRF[] } {
  const byId = new Map(f.examples.map((e) => [e.id, e]))
  const strategy = getStrategy(f.strategy)
  const out = { ids: [] as string[], ner: [] as PRF[], re: [] as PRF[] }
  for (const g of ds.examples) {
    const ex = byId.get(g.id)
    if (!ex) continue
    out.ids.push(g.id)
    if (strategy.tasks.includes('ner')) out.ner.push(scoreMentions(ex.pred.mentions, g.gold.mentions).typed)
    if (strategy.tasks.includes('re')) out.re.push(scoreRelations(ex.pred.relations, g.gold.relations).strict)
  }
  return out
}

export function summarize(f: RunFile, ds: Dataset): Summary {
  const strategy = getStrategy(f.strategy)
  const gold = new Map(ds.examples.map((e) => [e.id, e]))
  let nerT = ZERO, nerU = ZERO, reS = ZERO, reU = ZERO
  let neurons = 0, pt = 0, ct = 0, calls = 0, chars = 0, errors = 0, truncated = 0, anchorDropped = 0
  const walls: number[] = []
  for (const ex of f.examples) {
    const g = gold.get(ex.id)
    if (!g) continue
    if (strategy.tasks.includes('ner')) {
      const s = scoreMentions(ex.pred.mentions, g.gold.mentions)
      nerT = addPrf(nerT, s.typed)
      nerU = addPrf(nerU, s.untyped)
    }
    if (strategy.tasks.includes('re')) {
      const s = scoreRelations(ex.pred.relations, g.gold.relations)
      reS = addPrf(reS, s.strict)
      reU = addPrf(reU, s.undirected)
    }
    neurons += ex.pred.usage.neurons
    pt += ex.pred.usage.promptTokens
    ct += ex.pred.usage.completionTokens
    calls += ex.pred.calls
    chars += ex.chars
    errors += ex.pred.errors + (ex.error ? 1 : 0)
    truncated += ex.pred.truncated
    anchorDropped += ex.pred.anchorDropped ?? 0
    walls.push(ex.pred.wallMs)
  }
  walls.sort((a, b) => a - b)
  const usd = neuronsToUsd(neurons)
  const pe = perExample(f, ds)
  return {
    dataset: f.dataset,
    strategy: f.strategy,
    model: f.model,
    thinking: f.thinking,
    tasks: strategy.tasks,
    n: f.examples.length,
    ner: strategy.tasks.includes('ner') ? { typed: nerT, untyped: nerU } : undefined,
    re: strategy.tasks.includes('re') ? { strict: reS, undirected: reU } : undefined,
    usd,
    usdPerMChar: chars ? (usd / chars) * 1e6 : 0,
    neurons,
    promptTokens: pt,
    completionTokens: ct,
    calls,
    callsPerKChar: chars ? (calls / chars) * 1000 : 0,
    meanWallMs: walls.reduce((a, b) => a + b, 0) / Math.max(1, walls.length),
    p95WallMs: walls[Math.floor(walls.length * 0.95)] ?? 0,
    errors,
    truncated,
    anchorDropped,
    rep: f.rep ?? 0,
    ci: { ner: pe.ner.length ? bootstrapF1(pe.ner) : undefined, re: pe.re.length ? bootstrapF1(pe.re) : undefined },
  }
}

const cellKey = (r: { dataset: string; strategy: string; model: string; thinking: boolean }) => `${r.dataset}|${r.strategy}|${r.model}|${r.thinking}`

/** One row per cell (its rep-0 run), with replicate spread folded in when replicates exist. */
function writeSummary(): Summary[] {
  const all: Summary[] = []
  for (const dataset of existsSync(RESULTS_DIR) ? readdirSync(RESULTS_DIR) : []) {
    const dir = join(RESULTS_DIR, dataset)
    if (!['lit', 'douluo'].includes(dataset) || !existsSync(dir)) continue
    const ds = loadDataset(dataset)
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      all.push(summarize(JSON.parse(readFileSync(join(dir, f), 'utf8')) as RunFile, ds))
    }
  }
  const byCell = new Map<string, Summary[]>()
  for (const r of all) byCell.set(cellKey(r), [...(byCell.get(cellKey(r)) ?? []), r])
  const rows: Summary[] = []
  for (const reps of byCell.values()) {
    const base = reps.find((r) => r.rep === 0)
    if (!base) continue
    if (reps.length > 1) {
      const spread = (xs: Array<number | undefined>) => (xs.every((x) => x !== undefined) ? meanSd(xs as number[]) : undefined)
      base.replicates = { n: reps.length, ner: spread(reps.map((r) => r.ner?.typed.f1)), re: spread(reps.map((r) => r.re?.strict.f1)) }
    }
    rows.push(base)
  }
  writeFileSync(join(RESULTS_DIR, 'summary.json'), JSON.stringify(rows, null, 1))
  return rows
}

/** Every replicate file of a cell present on disk, rep 0 first. */
function replicateFiles(dataset: string, strategy: string, model: string, thinking: boolean): RunFile[] {
  const out: RunFile[] = []
  for (let rep = 0; existsSync(runPath(dataset, strategy, model, thinking, rep)); rep++) out.push(JSON.parse(readFileSync(runPath(dataset, strategy, model, thinking, rep), 'utf8')) as RunFile)
  return out
}

/**
 * Paired comparison of two cells (`strategy@model`) on the same examples: F1
 * delta with a paired-bootstrap interval. Replicates present for both cells are
 * pooled as extra (rep, example) pairs, so run-to-run noise is included.
 */
function compare(dataset: string, a: string, b: string, thinking: boolean) {
  const ds = loadDataset(dataset)
  const parse = (cell: string) => {
    const at = cell.indexOf('@')
    if (at < 0) throw new Error(`expected strategy@model, got ${cell}`)
    return { strategy: cell.slice(0, at), model: cell.slice(at + 1) }
  }
  const [ca, cb] = [parse(a), parse(b)]
  const fa = replicateFiles(dataset, ca.strategy, ca.model, thinking)
  const fb = replicateFiles(dataset, cb.strategy, cb.model, thinking)
  const reps = Math.min(fa.length, fb.length)
  if (!reps) throw new Error('both cells need a run file (run them first)')
  for (const task of ['ner', 're'] as const) {
    const xa: PRF[] = [], xb: PRF[] = []
    for (let r = 0; r < reps; r++) {
      const [pa, pb] = [perExample(fa[r], ds), perExample(fb[r], ds)]
      if (!pa[task].length || !pb[task].length) continue
      // Align on the examples both runs scored.
      const ib = new Map(pb.ids.map((id, i) => [id, i]))
      pa.ids.forEach((id, i) => {
        const j = ib.get(id)
        if (j !== undefined) (xa.push(pa[task][i]), xb.push(pb[task][j]))
      })
    }
    if (!xa.length) continue
    const d = pairedBootstrap(xa, xb)
    console.log(`${task.toUpperCase().padEnd(3)} Δ F1 ${d.delta >= 0 ? '+' : ''}${d.delta.toFixed(3)}  95% [${d.lo.toFixed(3)}, ${d.hi.toFixed(3)}]  P(a > b) ${d.pBetter.toFixed(2)}  (${xa.length} pairs, ${reps} rep${reps > 1 ? 's' : ''})`)
  }
}

// ------------------------------------------------------------------ silver labels (douluo)

const SILVER_ANNOTATORS = ['@cf/moonshotai/kimi-k2.6', '@cf/deepseek-ai/deepseek-v4-pro-0813', '@cf/zai-org/glm-5.3']

function vote<T>(lists: T[][], key: (t: T) => string, min: number): T[] {
  const counts = new Map<string, { item: T; n: number }>()
  for (const list of lists) {
    const seen = new Set<string>()
    for (const t of list) {
      const k = key(t)
      if (seen.has(k)) continue
      seen.add(k)
      const c = counts.get(k)
      if (c) c.n++
      else counts.set(k, { item: t, n: 1 })
    }
  }
  return [...counts.values()].filter((c) => c.n >= min).map((c) => c.item)
}

async function buildSilver() {
  const schema = loadAppSchema()
  const windows = loadDouluoWindows({ windows: 12, windowChunks: 4 })
  const { client } = cachedClients({ dir: CACHE_DIR })
  const opts = { thinking: true, maxCompletionTokens: 12000 }
  // Thinking occasionally runs away to the token cap without answering; retry those calls without thinking.
  const robust: typeof extract = async (c, t, sc, o) => {
    const r = await extract(c, t, sc, o)
    if (r.finishReason !== 'length' && !r.error) return r
    return extract(c, t, sc, { ...o, thinking: false, maxCompletionTokens: 4096 })
  }
  const examples: Example[] = await mapLimit(windows, 4, async (w) => {
    const text = w.parts.join('\n')
    // Stage 1: NER, every annotator, per chunk (finest granularity).
    const nerRuns = await Promise.all(
      SILVER_ANNOTATORS.map(async (model) => {
        const runs = await Promise.all(w.parts.map((p) => robust(client, p, { entities: schema.entities, instructions: schema.instructions }, { model, ...opts })))
        return runs.flatMap((r) => r.mentions)
      }),
    )
    // Majority vote on the string first, then on its label.
    const texts = vote(nerRuns.map((ms) => ms.map((m) => m.text)), (t) => t, 2)
    const mentions: Mention[] = []
    for (const t of texts) {
      const labels = nerRuns.flatMap((ms) => ms.filter((m) => m.text === t).map((m) => m.label))
      const counts = new Map<string, number>()
      for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1)
      const [best, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
      if (n >= 2) mentions.push({ text: t, label: best })
    }
    // Stage 2: closed-world RE on the voted entities.
    const reRuns = await Promise.all(
      SILVER_ANNOTATORS.map(async (model) => (await robust(client, text, { relations: schema.relations, instructions: schema.instructions }, { model, ...opts, knownEntities: mentions })).relations),
    )
    const relations: Relation[] = vote(reRuns, (r) => `${r.head}|${r.label}|${r.tail}`, 2)
    console.log(`${w.id}: ${mentions.length} mentions, ${relations.length} relations (annotator sizes: ner ${nerRuns.map((r) => r.length)}, re ${reRuns.map((r) => r.length)})`)
    return { id: w.id, text, parts: w.parts, gold: { mentions, relations } }
  })
  const ds: Dataset = { name: 'douluo', schema, examples }
  writeFileSync(join(DATA_DIR, 'douluo-silver.json'), JSON.stringify(ds, null, 1))
}

// ------------------------------------------------------------------ sweep grid

export const MODELS = [
  '@cf/moonshotai/kimi-k2.6',
  '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
  '@cf/zai-org/glm-5.3-flash',
  '@cf/zai-org/glm-4.7-flash',
  '@cf/google/gemma-4-26b-a4b-it',
  '@cf/qwen/qwen3-30b-a3b-fp8',
  '@cf/qwen/qwen3.8-27b',
  '@cf/openai/gpt-oss-120b',
  '@cf/openai/gpt-oss-20b',
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
  '@cf/nvidia/nemotron-3-120b-a12b',
]

/** Strategies × models per dataset. Per-label strategies only for a few models (they are k× the cost). */
function grid(dataset: string): Array<[string, string, boolean]> {
  const cells: Array<[string, string, boolean]> = []
  // glm-5.3-flash is excluded: it rate-limits/times out under per-label fan-out (~40% failed calls even run alone).
  const cheapPerLabel = ['@cf/moonshotai/kimi-k2.6', '@cf/google/gemma-4-26b-a4b-it']
  cells.push(['legacy-ner', '@cf/moonshotai/kimi-k2.6', false], ['legacy-re', '@cf/moonshotai/kimi-k2.6', false])
  for (const m of cheapPerLabel) cells.push(['ner-per-label', m, false], ['re-per-label', m, false])
  for (const m of MODELS) {
    cells.push(['ner-all-labels', m, false], ['re-all-labels', m, false], ['joint-ner-re', m, false])
    if (dataset === 'douluo') cells.push(['ner-all-labels-window', m, false])
  }
  for (const m of ['@cf/moonshotai/kimi-k2.6', '@cf/google/gemma-4-26b-a4b-it', '@cf/zai-org/glm-5.3-flash', '@cf/qwen/qwen3.8-27b', '@cf/deepseek-ai/deepseek-v4.1-flash-1017']) {
    cells.push(['re-all-labels-evidence', m, false], ['pipeline-ner-re', m, false])
    // Production's own code path; its schema wording is production's, so in-domain only.
    if (dataset === 'douluo') cells.push(['app-pipeline', m, false])
  }
  // Thinking mode is deliberately out of the grid: ~17–390× the cost for this task (see report-notes); `run --thinking` still works.
  return cells
}

// ------------------------------------------------------------------ main

async function main() {
  const [cmd, ...args] = process.argv.slice(2)
  const flags = new Set(args.filter((a) => a.startsWith('--')))
  const pos = args.filter((a) => !a.startsWith('--'))
  if (cmd === 'silver') return buildSilver()
  const reps = Number(args.find((a) => a.startsWith('--reps='))?.slice('--reps='.length) ?? 1)
  if (cmd === 'run') {
    const files: RunFile[] = []
    for (let rep = 0; rep < reps; rep++) files.push(await runOne(pos[0], pos[1], pos[2], flags.has('--thinking'), { force: flags.has('--force'), fresh: flags.has('--fresh'), rep }))
    if (reps > 1) {
      const ds = loadDataset(pos[0])
      const ss = files.map((f) => summarize(f, ds))
      const line = (xs: Array<number | undefined>) => (xs.every((x) => x !== undefined) ? ((m) => `${m.mean.toFixed(3)} ± ${m.sd.toFixed(3)}`)(meanSd(xs as number[])) : '-')
      console.log(`${reps} replicates: NER F1 ${line(ss.map((s) => s.ner?.typed.f1))}  RE F1 ${line(ss.map((s) => s.re?.strict.f1))}  (mean ± sd)`)
    }
    return
  }
  if (cmd === 'compare') {
    compare(pos[0], pos[1], pos[2], flags.has('--thinking'))
    return
  }
  if (cmd === 'sweep') {
    const datasets = pos.length ? pos : ['douluo', 'lit']
    for (const d of datasets) {
      const only = args.find((a) => a.startsWith('--model='))?.slice('--model='.length)
      let cells = grid(d).filter(([, m]) => !only || m.includes(only))
      if (flags.has('--reverse')) cells = cells.reverse()
      await mapLimit(cells, flags.has('--slow') ? 1 : 4, async ([s, m, t]) => {
        try {
          for (let rep = 0; rep < reps; rep++) await runOne(d, s, m, t, { force: flags.has('--force'), fresh: flags.has('--fresh'), rep })
        } catch (err) {
          console.error(`FAILED ${d} ${s} ${m}: ${err}`)
        }
      })
    }
    writeSummary()
    return
  }
  if (cmd === 'report') {
    const all = writeSummary()
    const notesPath = join(process.cwd(), 'eval/extraction/report-notes.json')
    const notes = existsSync(notesPath) ? (JSON.parse(readFileSync(notesPath, 'utf8')) as Record<string, unknown>) : { cards: [], findings: [], method: '' }
    const template = readFileSync(join(process.cwd(), 'eval/extraction/report-template.html'), 'utf8')
    // Thinking runs are excluded from the report (out of scope for this task); pass --thinking to include them.
    const runs = flags.has('--thinking') ? all : all.filter((r) => !r.thinking)
    const data = { generatedAt: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC', runs, ...notes }
    const out = pos[0] ?? join(RESULTS_DIR, 'report.html')
    writeFileSync(out, template.replace('/*DATA*/null', JSON.stringify(data).replace(/</g, '\\u003c')))
    console.log(`report → ${out}`)
    return
  }
  if (cmd === 'summary') {
    const all = writeSummary()
    console.log(`${all.length} runs summarized → ${join(RESULTS_DIR, 'summary.json')}`)
    return
  }
  console.log(`usage: cli.ts silver | run <dataset> <strategy> <model> [--thinking] [--force] [--fresh] [--reps=N] | compare <dataset> <strategy@model> <strategy@model> | sweep [datasets] [--reps=N] | summary\nstrategies: ${STRATEGIES.map((s) => s.name).join(', ')}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
