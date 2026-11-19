/**
 * results/report.html: cost vs label quality per naming model, from
 * results/runs + results/scores + results/usage.jsonl, with prose from
 * report-notes.json.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { neuronsToUsd } from '../../server/lib/extraction/llm'
import { RESULTS_DIR } from './bridge'
import { DATA_DIR, type CorpusChunk } from './corpus'
import { JUDGES, loadScores, slug, summarize, type LabelScore } from './judge'

const HERE = join(process.cwd(), 'eval/topics')

interface UsageRow { t: number; kind: string; tag?: string; model?: string; neurons?: number; ms?: number; completion?: number }

/** Namer cost of a run: the billed calls of its model during the run. */
function runCost(run: { model: string; started: number; ended: number }, usage: UsageRow[]) {
  const model = run.model.split('#')[0]
  const rows = usage.filter((u) => u.kind === 'chat' && u.tag === 'namer' && u.model === model && u.t >= run.started && u.t <= run.ended)
  return {
    usd: neuronsToUsd(rows.reduce((n, r) => n + (r.neurons ?? 0), 0)),
    llmSeconds: rows.reduce((n, r) => n + (r.ms ?? 0), 0) / 1000,
    completionTokens: rows.reduce((n, r) => n + (r.completion ?? 0), 0),
  }
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN
}

function judgeAgreement(all: LabelScore[]) {
  // Mean absolute gap between the two judges' descriptive scores, and match agreement.
  const both = all.filter((l) => l.descriptive.length === 2)
  const matches = all.filter((l) => l.match.length === 2)
  return {
    descGap: both.length ? both.reduce((n, l) => n + Math.abs(l.descriptive[0] - l.descriptive[1]), 0) / both.length : NaN,
    matchAgree: matches.length ? matches.filter((l) => l.match[0] === l.match[1]).length / matches.length : NaN,
  }
}

export async function buildReport() {
  const usage = (existsSync(join(RESULTS_DIR, 'usage.jsonl')) ? readFileSync(join(RESULTS_DIR, 'usage.jsonl'), 'utf8').trim().split('\n') : []).map((l) => JSON.parse(l) as UsageRow)
  const chunks = JSON.parse(readFileSync(join(DATA_DIR, 'corpus.json'), 'utf8')) as CorpusChunk[]
  const notes = JSON.parse(readFileSync(join(HERE, 'report-notes.json'), 'utf8'))
  const rows = []
  const examples: Record<string, { layers: string[][]; unsupported: Array<{ label: string; claims: string[] }> }> = {}
  for (const { model, labels } of loadScores()) {
    const run = JSON.parse(readFileSync(join(RESULTS_DIR, 'runs', `${slug(model)}.json`), 'utf8')) as { model: string; started: number; ended: number; seconds: number; calls: number; layers: Array<Array<{ label_zh: string; label_en: string }>> }
    const s = summarize(labels)
    const coarse = summarize(labels.filter((l) => l.layer <= 1))
    const fine = summarize(labels.filter((l) => l.layer >= 2))
    const cost = runCost(run, usage)
    rows.push({
      model,
      ...s,
      coarse,
      fine,
      ...judgeAgreement(labels),
      ...cost,
      usdPer1k: (cost.usd / chunks.length) * 1000,
      runSeconds: run.seconds,
      calls: run.calls,
      layerSizes: run.layers.map((l) => l.length),
      medianLen: median(labels.map((l) => [...l.label].length)),
      dupRate: labels.length ? 1 - run.layers.reduce((n, l) => n + new Set(l.map((e) => e.label_zh)).size, 0) / labels.length : 0,
    })
    examples[model] = {
      layers: run.layers.slice(0, 2).map((l) => l.map((e) => `${e.label_zh}\u0001${e.label_en}`)),
      unsupported: labels.filter((l) => l.unsupported.length).slice(0, 6).map((l) => ({ label: l.label, claims: l.unsupported })),
    }
  }
  const data = {
    generated: new Date().toISOString().slice(0, 16).replace('T', ' '),
    corpus: {
      chunks: chunks.length,
      chars: chunks.reduce((n, c) => n + c.text.length, 0),
      docs: new Set(chunks.map((c) => c.doc)).size,
      groups: [...new Set(chunks.map((c) => c.group))].length,
    },
    judges: JUDGES,
    production: '@cf/moonshotai/kimi-k2.6',
    rows,
    examples,
    notes,
  }
  const html = readFileSync(join(HERE, 'report-template.html'), 'utf8').replace('/*DATA*/null', JSON.stringify(data))
  writeFileSync(join(RESULTS_DIR, 'report.html'), html)
  console.log(`wrote ${join(RESULTS_DIR, 'report.html')} (${rows.length} models)`)
  for (const r of [...rows].sort((a, b) => b.descriptive - a.descriptive))
    console.log([r.model.replace('@cf/', '').padEnd(40), r.descriptive.toFixed(2), r.faithful.toFixed(3), r.fullyFaithful.toFixed(2), r.match.toFixed(3), r.embed.toFixed(3), r.generic.toFixed(2), `$${r.usd.toFixed(3)}`, `${r.llmSeconds.toFixed(0)}s`, r.medianLen, r.labels, r.descGap.toFixed(2), r.matchAgree.toFixed(2)].join('\t'))
}
