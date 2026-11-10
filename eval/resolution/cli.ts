/**
 * Local eval for entity resolution: within-document coreference and
 * cross-document resolution against the knowledge scope (scope promotion).
 *
 *   npm run eval:resolution -- build <douluo|sanguo>          # chunk + production NER (once)
 *   npm run eval:resolution -- forms <corpus>                 # dump surface forms for annotation
 *   npm run eval:resolution -- run <corpus> <task> <strategy> <model> [--force]
 *   npm run eval:resolution -- sweep [corpus...] [--model=substr]
 *   npm run eval:resolution -- report [out]
 *
 * See eval/resolution/README.md.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { neuronsToUsd } from '../../server/lib/extraction/llm'
import { extractEntitiesBatch, removeOverlaps, ENTITY_BATCH_CHUNKS, type NodeTypeInput } from '../../server/lib/entity-extraction'
import { clients, pool, slug } from '../common/workers-ai'
import { DATA_DIR, douluoRawDocs, loadCorpus, loadGold, sanguoRawDocs, surfaceForms, mentionContext, type Corpus, type Doc } from './datasets'
import { COREF_STRATEGIES, LINK_STRATEGIES, E2E_STRATEGIES, type CorefOutput, type LinkOutput, type E2EOutput, type Cost } from './strategies'
import { scoreCoref, scoreLinking, scoreE2E, type CorefScore, type LinkScore, type E2EScore } from './metrics'

const RESULTS_DIR = join(process.cwd(), 'eval/resolution/results')

function appNodeTypes(): NodeTypeInput[] {
  const f = readdirSync('.wrangler/state/v3/d1/miniflare-D1DatabaseObject').find((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite')!
  const db = new DatabaseSync(join('.wrangler/state/v3/d1/miniflare-D1DatabaseObject', f), { readOnly: true })
  const rows = db.prepare('SELECT name, definition, examples_json FROM node_type WHERE is_current = 1 ORDER BY name').all() as Array<{ name: string; definition: string; examples_json: string }>
  db.close()
  return rows.map((r) => ({ name: r.name, definition: r.definition, examples: JSON.parse(r.examples_json || '[]') as string[] }))
}

// ------------------------------------------------------------------ build

async function build(name: string) {
  const raw = name === 'douluo' ? douluoRawDocs() : name === 'sanguo' ? sanguoRawDocs() : null
  if (!raw) throw new Error(`unknown corpus ${name}`)
  const { client } = clients()
  const nodeTypes = appNodeTypes()
  const env = {} as Env
  const docs: Doc[] = []
  for (const d of raw) {
    const batches: number[][] = []
    for (let i = 0; i < d.chunks.length; i += ENTITY_BATCH_CHUNKS) batches.push(d.chunks.slice(i, i + ENTITY_BATCH_CHUNKS).map((c) => c.order))
    const perBatch = await pool(batches, 4, (orders) =>
      extractEntitiesBatch(orders.map((o) => d.chunks[o].content), nodeTypes, env, { client }),
    )
    const mentions = batches.flatMap((orders, bi) =>
      orders.flatMap((o, k) =>
        removeOverlaps(perBatch[bi][k]).map((e) => ({ id: `${d.id}:${o}:${e.startIndex}`, chunk: o, start: e.startIndex, end: e.endIndex, text: e.text, type: e.nodeType })),
      ),
    )
    docs.push({ id: d.id, title: d.title, chunks: d.chunks, mentions })
    console.log(`${d.id}: ${d.chunks.length} chunks, ${mentions.length} mentions, ${new Set(mentions.map((m) => m.text + m.type)).size} surface forms`)
  }
  writeFileSync(join(DATA_DIR, `${name}-mentions.json`), JSON.stringify({ name, docs } satisfies Corpus, null, 1))
}

/** Annotation aid: every surface form with count and two contexts. */
function dumpForms(name: string) {
  const corpus = loadCorpus(name)
  const lines: string[] = []
  for (const doc of corpus.docs) {
    lines.push(`## ${doc.id} ${doc.title}`)
    for (const f of surfaceForms(doc)) {
      const ctx = f.mentions.slice(0, 2).map((m) => mentionContext(doc, m, 25).replace(/\s+/g, ' '))
      lines.push(`${f.text}\t${f.type}\t×${f.mentions.length}\t${ctx.join(' ‖ ')}`)
    }
  }
  const out = join(DATA_DIR, `${name}-forms.txt`)
  writeFileSync(out, lines.join('\n'))
  console.log(`→ ${out}`)
}

// ------------------------------------------------------------------ runs

export interface RunFile {
  corpus: string
  task: Task
  strategy: string
  model: string
  chars: number
  cost: Cost
  score: CorefScore | LinkScore | E2EScore
  output: CorefOutput | LinkOutput | E2EOutput
}

type Task = 'coref' | 'link' | 'e2e'

const corpusChars = (c: Corpus) => c.docs.reduce((n, d) => n + d.chunks.reduce((k, ch) => k + ch.content.length, 0), 0)

async function runOne(corpusName: string, task: Task, strategyName: string, model: string, force = false): Promise<RunFile> {
  const out = join(RESULTS_DIR, corpusName, `${task}__${strategyName}__${slug(model)}.json`)
  if (!force && existsSync(out)) return JSON.parse(readFileSync(out, 'utf8')) as RunFile
  const corpus = loadCorpus(corpusName)
  const gold = loadGold(corpusName)
  const { client, rawRun } = clients()
  const t0 = Date.now()
  let file: RunFile
  if (task === 'coref') {
    const s = COREF_STRATEGIES.find((s) => s.name === strategyName)
    if (!s) throw new Error(`unknown coref strategy ${strategyName}`)
    const output = await s.run(corpus, { client, rawRun, model })
    file = { corpus: corpusName, task, strategy: s.name, model, chars: corpusChars(corpus), cost: output.cost, score: scoreCoref(corpus, gold, output), output }
  } else if (task === 'e2e') {
    const s = E2E_STRATEGIES.find((s) => s.name === strategyName)
    if (!s) throw new Error(`unknown e2e strategy ${strategyName}`)
    const output = await s.run(corpus, { client, rawRun, model })
    file = { corpus: corpusName, task, strategy: s.name, model, chars: corpusChars(corpus), cost: output.cost, score: scoreE2E(corpus, gold, output.clusters), output }
  } else {
    const s = LINK_STRATEGIES.find((s) => s.name === strategyName)
    if (!s) throw new Error(`unknown link strategy ${strategyName}`)
    const output = await s.run(corpus, gold, { client, rawRun, model })
    file = { corpus: corpusName, task, strategy: s.name, model, chars: corpusChars(corpus), cost: output.cost, score: scoreLinking(corpus, gold, output), output }
  }
  mkdirSync(join(RESULTS_DIR, corpusName), { recursive: true })
  writeFileSync(out, JSON.stringify(file, null, 1))
  const sc = file.score as { f1: number; p: number; r: number }
  console.log(
    `${corpusName.padEnd(7)} ${task.padEnd(5)} ${strategyName.padEnd(22)} ${model.padEnd(42)} F1 ${sc.f1.toFixed(3)} P ${sc.p.toFixed(3)} R ${sc.r.toFixed(3)}  ` +
      `$/1Mchar ${((neuronsToUsd(file.cost.neurons) / file.chars) * 1e6).toFixed(3).padStart(7)}  calls ${file.cost.calls} err ${file.cost.errors}  ${((Date.now() - t0) / 1000).toFixed(0)}s`,
  )
  return file
}

// ------------------------------------------------------------------ grid

export const MODELS = [
  '@cf/google/gemma-4-26b-a4b-it',
  '@cf/openai/gpt-oss-120b',
  '@cf/openai/gpt-oss-20b',
  '@cf/zai-org/glm-5.3-flash',
  '@cf/zai-org/glm-4.7-flash',
  '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
  '@cf/moonshotai/kimi-k2.6',
  '@cf/qwen/qwen3.8-27b',
  '@cf/qwen/qwen3-30b-a3b-fp8',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
  '@cf/nvidia/nemotron-3-120b-a12b',
]

function grid(): Array<[Task, string, string]> {
  const cells: Array<[Task, string, string]> = []
  for (const s of COREF_STRATEGIES) for (const m of s.llm ? (s.models ?? MODELS) : ['none']) cells.push(['coref', s.name, m])
  for (const s of LINK_STRATEGIES) for (const m of s.llm ? (s.models ?? MODELS) : ['none']) cells.push(['link', s.name, m])
  return cells
}

function summarize(): RunFile[] {
  const all: RunFile[] = []
  for (const c of ['douluo', 'sanguo']) {
    const dir = join(RESULTS_DIR, c)
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) all.push(JSON.parse(readFileSync(join(dir, f), 'utf8')) as RunFile)
  }
  return all
}

// ------------------------------------------------------------------ main

async function main() {
  const [cmd, ...args] = process.argv.slice(2)
  const flags = new Set(args.filter((a) => a.startsWith('--')))
  const pos = args.filter((a) => !a.startsWith('--'))
  if (cmd === 'build') return build(pos[0])
  if (cmd === 'forms') return dumpForms(pos[0])
  if (cmd === 'run') {
    await runOne(pos[0], pos[1] as Task, pos[2], pos[3] ?? 'none', flags.has('--force'))
    return
  }
  if (cmd === 'sweep') {
    const corpora = pos.length ? pos : ['douluo', 'sanguo']
    const only = args.find((a) => a.startsWith('--model='))?.slice('--model='.length)
    const strat = args.find((a) => a.startsWith('--strategy='))?.slice('--strategy='.length)
    for (const c of corpora) {
      const cells = grid().filter(([, s, m]) => (!only || m.includes(only)) && (!strat || s === strat))
      // Spread models across workers so one model's rate limit doesn't stall the rest.
      await pool(cells, Number(process.env.EVAL_CELL_CONCURRENCY ?? 4), async ([t, s, m]) => {
        try {
          await runOne(c, t, s, m, flags.has('--force'))
        } catch (err) {
          console.error(`FAILED ${c} ${t} ${s} ${m}: ${err}`)
        }
      })
    }
    return
  }
  if (cmd === 'report') {
    const runs = summarize().map(({ output: _o, ...r }) => r)
    const notesPath = join(process.cwd(), 'eval/resolution/report-notes.json')
    const notes = existsSync(notesPath) ? (JSON.parse(readFileSync(notesPath, 'utf8')) as Record<string, unknown>) : {}
    const template = readFileSync(join(process.cwd(), 'eval/resolution/report-template.html'), 'utf8')
    const docs = Object.fromEntries(['douluo', 'sanguo'].filter((c) => existsSync(join(DATA_DIR, `${c}-mentions.json`))).map((c) => [c, loadCorpus(c).docs.length]))
    const strategies = [
      ...COREF_STRATEGIES.map((s) => ({ task: 'coref', name: s.name, description: s.description })),
      ...LINK_STRATEGIES.map((s) => ({ task: 'link', name: s.name, description: s.description })),
      ...E2E_STRATEGIES.map((s) => ({ task: 'e2e', name: s.name, description: s.description })),
    ]
    const data = { generatedAt: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC', runs, docs, strategies, ...notes }
    const out = pos[0] ?? join(RESULTS_DIR, 'report.html')
    writeFileSync(out, template.replace('/*DATA*/null', JSON.stringify(data).replace(/</g, '\\u003c')))
    console.log(`report → ${out}`)
    return
  }
  if (cmd === 'rescore') {
    // Recompute scores from stored outputs (after a metrics or gold change).
    for (const c of ['douluo', 'sanguo']) {
      const dir = join(RESULTS_DIR, c)
      if (!existsSync(dir)) continue
      const corpus = loadCorpus(c)
      const gold = loadGold(c)
      for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
        const r = JSON.parse(readFileSync(join(dir, f), 'utf8')) as RunFile
        r.score =
          r.task === 'coref'
            ? scoreCoref(corpus, gold, r.output as CorefOutput)
            : r.task === 'link'
              ? scoreLinking(corpus, gold, r.output as LinkOutput)
              : scoreE2E(corpus, gold, (r.output as E2EOutput).clusters)
        writeFileSync(join(dir, f), JSON.stringify(r, null, 1))
      }
    }
    console.log('rescored')
    return
  }
  if (cmd === 'table') {
    const rows = summarize().map((r) => {
      const s = r.score as { f1: number; p: number; r: number }
      return [r.corpus, r.task, r.strategy, r.model.replace('@cf/', ''), s.f1.toFixed(3), s.p.toFixed(3), s.r.toFixed(3), ((neuronsToUsd(r.cost.neurons) / r.chars) * 1e6).toFixed(3), r.cost.calls, r.cost.errors].join('\t')
    })
    console.log(rows.sort().join('\n'))
    return
  }
  console.log('usage: cli.ts build|forms <corpus> | run <corpus> <coref|link> <strategy> <model> | sweep | report | table')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
