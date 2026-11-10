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
import { clients, pool, slug } from '../common/workers-ai'
import { extract, type Mention, type Relation } from '../../server/lib/extraction/extract'
import { DATA_DIR, loadAppSchema, loadDouluo, loadDouluoWindows, loadLit, type Dataset, type Example } from './datasets'
import { getStrategy, STRATEGIES, type Prediction } from './strategies'
import { addPrf, scoreMentions, scoreRelations, ZERO, type PRF } from './metrics'

const RESULTS_DIR = join(process.cwd(), 'eval/extraction/results')


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
}

// ------------------------------------------------------------------ run

async function runOne(dataset: string, strategyName: string, model: string, thinking: boolean, force = false): Promise<RunFile> {
  const strategy = getStrategy(strategyName)
  const out = join(RESULTS_DIR, dataset, `${strategy.name}__${slug(model)}${thinking ? '__thinking' : ''}.json`)
  if (!force && existsSync(out)) return JSON.parse(readFileSync(out, 'utf8')) as RunFile
  const ds = loadDataset(dataset)
  const { client, rawRun } = clients()
  const t0 = Date.now()
  const examples = await pool(ds.examples, Number(process.env.EVAL_EXAMPLE_CONCURRENCY ?? 6), async (ex) => {
    try {
      const pred = await strategy.run(ex, { client, rawRun, model, thinking, schema: ds.schema })
      return { id: ex.id, chars: ex.text.length, pred }
    } catch (err) {
      const empty: Prediction = { mentions: [], relations: [], usage: { promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0, neurons: 0 }, calls: 0, errors: 1, wallMs: 0, callMs: 0, truncated: 0 }
      return { id: ex.id, chars: ex.text.length, pred: empty, error: String(err) }
    }
  })
  const file: RunFile = { dataset, strategy: strategy.name, model, thinking, examples }
  mkdirSync(join(RESULTS_DIR, dataset), { recursive: true })
  writeFileSync(out, JSON.stringify(file, null, 1))
  const s = summarize(file, ds)
  console.log(
    `${dataset.padEnd(7)} ${strategy.name.padEnd(24)} ${model.padEnd(42)} ${thinking ? 'T' : ' '}  ` +
      `NER F1 ${fmt(s.ner?.typed.f1)}  RE F1 ${fmt(s.re?.strict.f1)}  $/1Mchar ${s.usdPerMChar.toFixed(2).padStart(7)}  calls ${s.calls}  err ${s.errors}  trunc ${s.truncated}  ${((Date.now() - t0) / 1000).toFixed(0)}s`,
  )
  return file
}

const fmt = (x: number | undefined) => (x === undefined ? '  -  ' : x.toFixed(3))

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
}

export function summarize(f: RunFile, ds: Dataset): Summary {
  const strategy = getStrategy(f.strategy)
  const gold = new Map(ds.examples.map((e) => [e.id, e]))
  let nerT = ZERO, nerU = ZERO, reS = ZERO, reU = ZERO
  let neurons = 0, pt = 0, ct = 0, calls = 0, chars = 0, errors = 0, truncated = 0
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
    walls.push(ex.pred.wallMs)
  }
  walls.sort((a, b) => a - b)
  const usd = neuronsToUsd(neurons)
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
  }
}

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
  writeFileSync(join(RESULTS_DIR, 'summary.json'), JSON.stringify(all, null, 1))
  return all
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
  const { client } = clients()
  const opts = { thinking: true, maxCompletionTokens: 12000 }
  // Thinking occasionally runs away to the token cap without answering; retry those calls without thinking.
  const robust: typeof extract = async (c, t, sc, o) => {
    const r = await extract(c, t, sc, o)
    if (r.finishReason !== 'length' && !r.error) return r
    return extract(c, t, sc, { ...o, thinking: false, maxCompletionTokens: 4096 })
  }
  const examples: Example[] = await pool(windows, 4, async (w) => {
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
  if (cmd === 'run') {
    await runOne(pos[0], pos[1], pos[2], flags.has('--thinking'), flags.has('--force'))
    return
  }
  if (cmd === 'sweep') {
    const datasets = pos.length ? pos : ['douluo', 'lit']
    for (const d of datasets) {
      const only = args.find((a) => a.startsWith('--model='))?.slice('--model='.length)
      let cells = grid(d).filter(([, m]) => !only || m.includes(only))
      if (flags.has('--reverse')) cells = cells.reverse()
      await pool(cells, flags.has('--slow') ? 1 : 4, async ([s, m, t]) => {
        try {
          await runOne(d, s, m, t)
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
  console.log(`usage: cli.ts silver | run <dataset> <strategy> <model> [--thinking] [--force] | sweep [datasets] | summary\nstrategies: ${STRATEGIES.map((s) => s.name).join(', ')}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
