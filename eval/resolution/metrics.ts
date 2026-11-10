/**
 * Scoring for the resolution eval.
 *
 * Coreference: MUC link F1 over surface forms (did the right forms get merged,
 * and nothing else?) is the headline; B³ over mentions and the split rate
 * (forms whose mentions ended up in more than one entity) are diagnostics.
 *
 * Linking: each gold document entity in documents 2..n is a query whose gold
 * answer is its key if that key occurs in an earlier document, else NIL.
 * P = correct links / predicted links, R = correct links / gold links.
 */
import { goldKey, type Corpus, type Gold } from './datasets'
import type { CorefOutput, LinkOutput } from './strategies'
import { buildLinkingTask } from './strategies'

export interface PRF {
  p: number
  r: number
  f1: number
}

const prf = (p: number, r: number): PRF => ({ p, r, f1: p + r ? (2 * p * r) / (p + r) : 0 })

export interface CorefScore extends PRF {
  b3: PRF
  splitRate: number
  predEntities: number
  goldEntities: number
}

export interface LinkScore extends PRF {
  /** Accuracy on queries whose gold answer is NIL (new entities). */
  nilAccuracy: number
  queries: number
  goldLinks: number
}

/** MUC numerator/denominator for one direction: key partition vs response partition. */
function mucPart(key: Map<string, string[]>, respOf: (item: string) => string): [number, number] {
  let num = 0
  let den = 0
  for (const items of key.values()) {
    if (items.length < 2) continue
    num += items.length - new Set(items.map(respOf)).size
    den += items.length - 1
  }
  return [num, den]
}

function groupBy<T>(xs: T[], k: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const x of xs) m.set(k(x), [...(m.get(k(x)) ?? []), x])
  return m
}

export function scoreCoref(corpus: Corpus, gold: Gold, out: CorefOutput): CorefScore {
  let rn = 0, rd = 0, pn = 0, pd = 0
  let b3p = 0, b3r = 0, nMentions = 0
  let split = 0, multi = 0, predEntities = 0, goldEntities = 0
  for (const doc of corpus.docs) {
    const pred = out.docs.find((d) => d.docId === doc.id)
    const entOf = new Map<string, string>()
    pred?.entities.forEach((e, i) => e.mentionIds.forEach((id) => entOf.has(id) || entOf.set(id, `e${i}`)))
    const predOf = (mid: string) => entOf.get(mid) ?? `m:${mid}`
    const goldOf = (text: string) => goldKey(gold, doc.id, text)

    // Surface-form partition induced by the prediction (forms sharing an entity are joined).
    const forms = groupBy(doc.mentions, (m) => `${m.text}\t${m.type}`)
    const parent = new Map<string, string>()
    const find = (x: string): string => (parent.get(x) ?? x) === x ? x : find(parent.get(x)!)
    const byEntity = new Map<string, string>()
    for (const [form, ms] of forms) {
      parent.set(form, form)
      const ents = new Set(ms.map((m) => predOf(m.id)))
      if (ms.length >= 2) {
        multi++
        if (ents.size > 1) split++
      }
      for (const e of ents) {
        const other = byEntity.get(e)
        if (other) parent.set(find(form), find(other))
        else byEntity.set(e, form)
      }
    }
    const formNames = [...forms.keys()]
    const goldForms = groupBy(formNames, (f) => goldOf(f.split('\t')[0]))
    const predForms = groupBy(formNames, find)
    const [a, b] = mucPart(goldForms, find)
    const [c, d] = mucPart(predForms, (f) => goldOf(f.split('\t')[0]))
    rn += a; rd += b; pn += c; pd += d
    goldEntities += goldForms.size
    predEntities += new Set(doc.mentions.map((m) => predOf(m.id))).size

    // B³ over mentions.
    const goldCl = groupBy(doc.mentions, (m) => goldOf(m.text))
    const predCl = groupBy(doc.mentions, (m) => predOf(m.id))
    for (const m of doc.mentions) {
      const g = goldCl.get(goldOf(m.text))!
      const p = predCl.get(predOf(m.id))!
      const inter = p.filter((x) => goldOf(x.text) === goldOf(m.text)).length
      b3p += inter / p.length
      b3r += inter / g.length
      nMentions++
    }
  }
  const muc = prf(pd ? pn / pd : 1, rd ? rn / rd : 1)
  return {
    ...muc,
    b3: prf(nMentions ? b3p / nMentions : 1, nMentions ? b3r / nMentions : 1),
    splitRate: multi ? split / multi : 0,
    predEntities,
    goldEntities,
  }
}

export function scoreLinking(corpus: Corpus, gold: Gold, out: LinkOutput): LinkScore {
  const task = buildLinkingTask(corpus, gold)
  const predOf = new Map(out.links.map((l) => [l.queryId, l.pred]))
  let tp = 0, predLinks = 0, goldLinks = 0, nil = 0, nilOk = 0
  for (const step of task.steps) {
    for (const q of step.queries) {
      const g = task.answer.get(q.id) ?? null
      const p = predOf.get(q.id) ?? null
      if (p !== null) predLinks++
      if (g !== null) goldLinks++
      if (p !== null && p === g) tp++
      if (g === null) {
        nil++
        if (p === null) nilOk++
      }
    }
  }
  return {
    ...prf(predLinks ? tp / predLinks : 1, goldLinks ? tp / goldLinks : 1),
    nilAccuracy: nil ? nilOk / nil : 1,
    queries: task.steps.reduce((n, s) => n + s.queries.length, 0),
    goldLinks,
  }
}

export interface E2EScore extends PRF {
  goldPairs: number
  predPairs: number
  /** Same, over every surface form (states, times, generic objects included). */
  all?: E2EScore
}

/** Named-entity types: the headline e2e score is over these (generic words recur across documents by text alone). */
export const NAMED_TYPES = new Set(['PERSON', 'LOCATION', 'GPE', 'ORGANIZATION'])

/**
 * End to end: pairwise P/R/F1 over cross-document surface-form pairs — do two
 * forms from different documents end up in the same knowledge-graph entity
 * exactly when their gold keys match? A form's entity is the majority cluster
 * of its mentions.
 */
export function scoreE2E(corpus: Corpus, gold: Gold, clusters: Record<string, string>, onlyNamed = true): E2EScore {
  const formsOf: Array<{ doc: string; gold: string; pred: string }> = []
  for (const doc of corpus.docs) {
    const byForm = groupBy(doc.mentions, (m) => `${m.text}\t${m.type}`)
    for (const [form, ms] of byForm) {
      if (onlyNamed && !NAMED_TYPES.has(form.split('\t')[1])) continue
      const votes = new Map<string, number>()
      for (const m of ms) votes.set(clusters[m.id] ?? `m:${m.id}`, (votes.get(clusters[m.id] ?? `m:${m.id}`) ?? 0) + 1)
      formsOf.push({ doc: doc.id, gold: goldKey(gold, doc.id, form.split('\t')[0]), pred: [...votes].sort((a, b) => b[1] - a[1])[0][0] })
    }
  }
  const crossPairs = (key: (f: (typeof formsOf)[number]) => string) => {
    let total = 0
    for (const group of groupBy(formsOf, key).values()) {
      const perDoc = [...groupBy(group, (f) => f.doc).values()].map((g) => g.length)
      const n = group.length
      total += (n * n - perDoc.reduce((s, k) => s + k * k, 0)) / 2
    }
    return total
  }
  const goldPairs = crossPairs((f) => f.gold)
  const predPairs = crossPairs((f) => f.pred)
  const both = crossPairs((f) => `${f.gold}\u0000${f.pred}`)
  const score: E2EScore = { ...prf(predPairs ? both / predPairs : 1, goldPairs ? both / goldPairs : 1), goldPairs, predPairs }
  if (onlyNamed) score.all = scoreE2E(corpus, gold, clusters, false)
  return score
}
