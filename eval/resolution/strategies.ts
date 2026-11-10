/**
 * Resolution strategies under evaluation.
 *
 * Coreference (within a document): input is a document's chunk mentions;
 * output is entities (clusters of mention ids) with canonical labels.
 *
 * Linking (document entities → knowledge scope): documents are processed in
 * order; each gold document entity of document k is resolved against a KB of
 * the entities seen in documents 1..k-1 (gold clusters, so this isolates the
 * linking decision from coreference errors), or NIL.
 */
import { normalizeCompletion, addUsage, EMPTY_USAGE, type ChatUsage, type LlmClient } from '../../server/lib/extraction/llm'
import { resolveDocumentCoreference } from './legacy/coreference'
import { promoteDocumentToScope } from './legacy/scope-promotion'
import { createShimDb } from './d1-shim'
import { createSqliteD1, fixtures } from '../../server/lib/testing/sqlite-d1'
import { resolveDocumentCoreference as appCoref } from '../../server/lib/coreference'
import { promoteDocumentToScope as appPromote } from '../../server/lib/scope-promotion'
import { goldKey, mentionContext, surfaceForms, type Corpus, type Doc, type Gold } from './datasets'
import * as res from '../../server/lib/extraction/resolve'

export interface Ctx {
  client: LlmClient
  rawRun: (model: string, args: Record<string, unknown>) => Promise<unknown>
  model: string
}

export interface Cost {
  neurons: number
  calls: number
  errors: number
  truncated: number
  promptTokens: number
  completionTokens: number
  /** Sum of per-document wall time (calls within a document run in parallel where the strategy allows). */
  wallMs: number
}

export interface CorefOutput {
  docs: Array<{ docId: string; entities: Array<{ label: string; mentionIds: string[] }> }>
  cost: Cost
}

export interface LinkOutput {
  links: Array<{ queryId: string; pred: string | null }>
  cost: Cost
}

export interface CorefStrategy {
  name: string
  description: string
  llm: boolean
  models?: string[]
  run(corpus: Corpus, ctx: Ctx): Promise<CorefOutput>
}

export interface LinkStrategy {
  name: string
  description: string
  llm: boolean
  models?: string[]
  run(corpus: Corpus, gold: Gold, ctx: Ctx): Promise<LinkOutput>
}

const LEGACY_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'

// ------------------------------------------------------------------ cost recording

class Meter {
  usage: ChatUsage = EMPTY_USAGE
  calls = 0
  errors = 0
  truncated = 0
  wallMs = 0
  add(r: { usage: ChatUsage; finishReason?: string | null; error?: string | null }) {
    this.usage = addUsage(this.usage, r.usage)
    this.calls++
    if (r.error) this.errors++
    if (r.finishReason === 'length') this.truncated++
  }
  async time<T>(fn: () => Promise<T>): Promise<T> {
    const t = Date.now()
    try {
      return await fn()
    } finally {
      this.wallMs += Date.now() - t
    }
  }
  cost(): Cost {
    return {
      neurons: this.usage.neurons,
      calls: this.calls,
      errors: this.errors,
      truncated: this.truncated,
      promptTokens: this.usage.promptTokens,
      completionTokens: this.usage.completionTokens,
      wallMs: this.wallMs,
    }
  }
  /** A client that records every call (and its failures) on this meter. */
  wrap(client: LlmClient): LlmClient {
    return {
      chat: async (req) => {
        try {
          const r = await client.chat(req)
          this.add(r)
          return r
        } catch (err) {
          this.calls++
          this.errors++
          throw err
        }
      },
    }
  }
  /** An `env` whose AI.run records usage — for the frozen legacy code. */
  env(ctx: Ctx, DB: D1Database): Env {
    return {
      DB,
      AI: {
        run: async (model: string, args: Record<string, unknown>) => {
          const t = Date.now()
          try {
            const raw = await ctx.rawRun(model, args)
            this.add(normalizeCompletion(model, raw as Parameters<typeof normalizeCompletion>[1], Date.now() - t))
            return raw
          } catch (err) {
            this.calls++
            this.errors++
            throw err
          }
        },
      },
    } as unknown as Env
  }
}

// ------------------------------------------------------------------ coreference

const exactText: CorefStrategy = {
  name: 'exact-text',
  description: 'No LLM: mentions with identical text are one entity',
  llm: false,
  async run(corpus) {
    return {
      docs: corpus.docs.map((d) => {
        const by = new Map<string, string[]>()
        for (const m of d.mentions) by.set(m.text, [...(by.get(m.text) ?? []), m.id])
        return { docId: d.id, entities: [...by].map(([label, mentionIds]) => ({ label, mentionIds })) }
      }),
      cost: new Meter().cost(),
    }
  },
}

/** Load a document's mentions into a shim DB as chunk-scope entities; returns row id → mention id. */
function loadDocIntoShim(db: ReturnType<typeof createShimDb>['db'], doc: Doc, docNum: number) {
  db.prepare('INSERT OR IGNORE INTO document (id, knowledge_scope_id) VALUES (?, 1)').run(docNum)
  const chunkIds = doc.chunks.map((c) => Number(db.prepare('INSERT INTO text_chunk (source_document_id, chunk_order, content) VALUES (?, ?, ?)').run(docNum, c.order, c.content).lastInsertRowid))
  const rowToMention = new Map<number, string>()
  for (const m of doc.mentions) {
    const id = db
      .prepare(`INSERT INTO extracted_entity (source_document_id, source_chunk_id, entity_type, extracted_text, scope, chunk_start_index, chunk_end_index) VALUES (?, ?, ?, ?, 'chunk', ?, ?)`)
      .run(docNum, chunkIds[m.chunk], m.type, m.text, m.start, m.end).lastInsertRowid
    rowToMention.set(Number(id), m.id)
  }
  return rowToMention
}

const legacyCoref: CorefStrategy = {
  name: 'legacy',
  description: 'Current app: exact/edit-distance candidates, one llama-3.3-70b call per component over every mention with context, plus a label call per merged group',
  llm: true,
  models: [LEGACY_MODEL],
  async run(corpus, ctx) {
    const meter = new Meter()
    const docs: CorefOutput['docs'] = []
    for (const [i, doc] of corpus.docs.entries()) {
      const { db, d1 } = createShimDb()
      const rowToMention = loadDocIntoShim(db, doc, i + 1)
      await meter.time(() => resolveDocumentCoreference(i + 1, meter.env(ctx, d1)))
      const rows = db.prepare(`SELECT c.id, c.parent_id, p.label FROM extracted_entity c LEFT JOIN extracted_entity p ON p.id = c.parent_id WHERE c.scope = 'chunk'`).all() as Array<{ id: number; parent_id: number | null; label: string | null }>
      const byParent = new Map<number, { label: string; mentionIds: string[] }>()
      const entities: Array<{ label: string; mentionIds: string[] }> = []
      for (const r of rows) {
        const mid = rowToMention.get(r.id)!
        if (r.parent_id === null) {
          // Unmerged chunk entities each become their own document entity in the app.
          entities.push({ label: doc.mentions.find((m) => m.id === mid)!.text, mentionIds: [mid] })
          continue
        }
        let e = byParent.get(r.parent_id)
        if (!e) byParent.set(r.parent_id, (e = { label: r.label ?? '', mentionIds: [] }))
        e.mentionIds.push(mid)
      }
      docs.push({ docId: doc.id, entities: [...entities, ...byParent.values()] })
    }
    return { docs, cost: meter.cost() }
  },
}

function formsCoref(name: string, description: string, opts: res.CorefOptions): CorefStrategy {
  return {
    name,
    description,
    llm: true,
    async run(corpus, ctx) {
      const meter = new Meter()
      const client = meter.wrap(ctx.client)
      const docs: CorefOutput['docs'] = []
      for (const doc of corpus.docs) {
        const forms = surfaceForms(doc).map((f) => ({
          text: f.text,
          type: f.type,
          count: f.mentions.length,
          context: mentionContext(doc, f.mentions[0], 30).replace(/\s+/g, ' '),
        }))
        const result = await meter.time(() => res.resolveCoreference(client, forms, { ...opts, model: ctx.model }))
        const idsOf = (i: number) => surfaceForms(doc)[i].mentions.map((m) => m.id)
        docs.push({ docId: doc.id, entities: result.entities.map((e) => ({ label: e.label, mentionIds: e.forms.flatMap(idsOf) })) })
      }
      return { docs, cost: meter.cost() }
    },
  }
}

export const COREF_STRATEGIES: CorefStrategy[] = [
  exactText,
  legacyCoref,
  formsCoref('forms', 'One call per document over distinct surface forms, each with count and one context', { context: true }),
  formsCoref('forms-noctx', 'As forms, without contexts (names, types and counts only)', { context: false }),
  formsCoref('forms-per-type', 'As forms, one call per entity type (no cross-type merges)', { context: true, perType: true }),
]

// ------------------------------------------------------------------ linking

export interface DocEntity {
  id: string
  docId: string
  key: string
  type: string
  label: string
  aliases: string[]
  context: string
}

export interface LinkingTask {
  /** Gold document entities of every document, in document order. */
  docEntities: DocEntity[][]
  steps: Array<{ docIndex: number; queries: res.LinkQuery[]; kb: res.KbEntity[] }>
  answer: Map<string, string | null>
}

/** Gold document entities: a document's surface forms grouped by gold key. */
export function goldDocEntities(doc: Doc, gold: Gold): DocEntity[] {
  const groups = new Map<string, ReturnType<typeof surfaceForms>>()
  for (const f of surfaceForms(doc)) {
    const k = goldKey(gold, doc.id, f.text)
    groups.set(k, [...(groups.get(k) ?? []), f])
  }
  return [...groups].map(([key, fs], i) => {
    const top = [...fs].sort((a, b) => b.mentions.length - a.mentions.length)[0]
    const typeCount = new Map<string, number>()
    for (const f of fs) typeCount.set(f.type, (typeCount.get(f.type) ?? 0) + f.mentions.length)
    return {
      id: `${doc.id}#${i}`,
      docId: doc.id,
      key,
      type: [...typeCount].sort((a, b) => b[1] - a[1])[0][0],
      label: top.text,
      aliases: [...new Set(fs.map((f) => f.text))],
      context: mentionContext(doc, top.mentions[0], 30).replace(/\s+/g, ' '),
    }
  })
}

export function buildLinkingTask(corpus: Corpus, gold: Gold): LinkingTask {
  const docEntities = corpus.docs.map((d) => goldDocEntities(d, gold))
  const steps: LinkingTask['steps'] = []
  const answer = new Map<string, string | null>()
  const kb = new Map<string, res.KbEntity & { counts: Map<string, number> }>()
  docEntities.forEach((ents, k) => {
    if (k > 0) {
      const snapshot = [...kb.values()].map(({ counts: _c, ...e }) => ({ ...e, aliases: [...e.aliases], contexts: [...e.contexts] }))
      steps.push({
        docIndex: k,
        queries: ents.map((e) => ({ id: e.id, type: e.type, label: e.label, aliases: e.aliases, context: e.context })),
        kb: snapshot,
      })
      for (const e of ents) answer.set(e.id, kb.has(e.key) ? e.key : null)
    }
    for (const e of ents) {
      let entry = kb.get(e.key)
      if (!entry) kb.set(e.key, (entry = { id: e.key, type: e.type, label: e.label, aliases: [], contexts: [], counts: new Map() }))
      for (const a of e.aliases) if (!entry.aliases.includes(a)) entry.aliases.push(a)
      if (entry.contexts.length < 2) entry.contexts.push(e.context)
    }
  })
  return { docEntities, steps, answer }
}

const exactAlias: LinkStrategy = {
  name: 'exact-alias',
  description: 'No LLM: link when a query name equals a KB alias (prefer same type)',
  llm: false,
  async run(corpus, gold) {
    const task = buildLinkingTask(corpus, gold)
    const links = task.steps.flatMap((s) => s.queries.map((q) => ({ queryId: q.id, pred: res.exactAliasMatch(q, s.kb)?.id ?? null })))
    return { links, cost: new Meter().cost() }
  },
}

const legacyLink: LinkStrategy = {
  name: 'legacy',
  description: 'Current app: exact/edit-distance label candidates, llama-3.3-70b groups ids by label only (no context); scope entity minted when ≥2 documents agree',
  llm: true,
  models: [LEGACY_MODEL],
  async run(corpus, gold, ctx) {
    const task = buildLinkingTask(corpus, gold)
    const meter = new Meter()
    const { db, d1 } = createShimDb()
    db.exec(`INSERT INTO knowledge_scope (id, name) VALUES (1, 'eval')`)
    const rowOf = new Map<number, DocEntity>()
    const links: LinkOutput['links'] = []
    for (const [k, ents] of task.docEntities.entries()) {
      db.prepare('INSERT INTO document (id, knowledge_scope_id) VALUES (?, 1)').run(k + 1)
      for (const e of ents) {
        const id = db.prepare(`INSERT INTO extracted_entity (source_document_id, entity_type, label, scope) VALUES (?, ?, ?, 'document')`).run(k + 1, e.type, e.label).lastInsertRowid
        rowOf.set(Number(id), e)
      }
      await meter.time(() => promoteDocumentToScope(k + 1, 1, meter.env(ctx, d1)))
      if (k === 0) continue
      // A query's prediction: the gold key held by most earlier-document members of its scope entity.
      const rows = db.prepare(`SELECT id, parent_id FROM extracted_entity WHERE scope = 'document'`).all() as Array<{ id: number; parent_id: number | null }>
      const members = new Map<number, DocEntity[]>()
      for (const r of rows) if (r.parent_id !== null) members.set(r.parent_id, [...(members.get(r.parent_id) ?? []), rowOf.get(r.id)!])
      for (const r of rows) {
        const e = rowOf.get(r.id)!
        if (e.docId !== corpus.docs[k].id) continue
        const earlier = r.parent_id === null ? [] : (members.get(r.parent_id) ?? []).filter((m) => corpus.docs.findIndex((d) => d.id === m.docId) < k)
        const votes = new Map<string, number>()
        for (const m of earlier) votes.set(m.key, (votes.get(m.key) ?? 0) + 1)
        links.push({ queryId: e.id, pred: [...votes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null })
      }
    }
    return { links, cost: meter.cost() }
  },
}

function llmLink(name: string, description: string, opts: Omit<res.LinkOptions, 'model'>): LinkStrategy {
  return {
    name,
    description,
    llm: true,
    async run(corpus, gold, ctx) {
      const task = buildLinkingTask(corpus, gold)
      const meter = new Meter()
      const client = meter.wrap(ctx.client)
      const links: LinkOutput['links'] = []
      for (const step of task.steps) {
        const r = await meter.time(() => res.linkEntities(client, step.queries, step.kb, { ...opts, model: ctx.model }))
        for (const q of step.queries) links.push({ queryId: q.id, pred: r.links.get(q.id) ?? null })
      }
      return { links, cost: meter.cost() }
    },
  }
}

export const LINK_STRATEGIES: LinkStrategy[] = [
  exactAlias,
  legacyLink,
  llmLink('kb-in-prompt', 'One call per document: every KB entity (type + aliases) in the prompt, queries with context', { retrieval: 'all' }),
  llmLink('retrieve-llm', 'Char-overlap retrieval of top-8 KB candidates per query (with context); one call per document', { retrieval: 'topk', k: 8 }),
  llmLink('retrieve-llm-auto', 'As retrieve-llm, but unambiguous exact alias matches link without the LLM', { retrieval: 'topk', k: 8, autoLinkExact: true }),
]

// ------------------------------------------------------------------ end to end


/** Final knowledge-graph cluster of every mention: scope entity, else document entity, else itself. */
export interface E2EOutput {
  clusters: Record<string, string>
  cost: Cost
}

export interface E2EStrategy {
  name: string
  description: string
  models?: string[]
  run(corpus: Corpus, ctx: Ctx): Promise<E2EOutput>
}

function e2e(name: string, description: string, impl: 'legacy' | 'app', models?: string[]): E2EStrategy {
  return {
    name,
    description,
    models,
    async run(corpus, ctx) {
      const meter = new Meter()
      const { db, d1 } = createSqliteD1()
      const env = meter.env(ctx, d1)
      const scope = fixtures.scope(db)
      const rowToMention = new Map<number, string>()
      for (const doc of corpus.docs) {
        const docId = fixtures.document(db, scope)
        const chunkIds = doc.chunks.map((c) => fixtures.chunk(db, docId, c.order, c.content))
        for (const m of doc.mentions) {
          const id = db
            .prepare(`INSERT INTO extracted_entity (source_document_id, source_chunk_id, entity_type, extracted_text, chunk_start_index, chunk_end_index, scope) VALUES (?, ?, ?, ?, ?, ?, 'chunk')`)
            .run(docId, chunkIds[m.chunk], m.type, m.text, m.start, m.end).lastInsertRowid
          rowToMention.set(Number(id), m.id)
        }
        await meter.time(async () => {
          if (impl === 'legacy') {
            await resolveDocumentCoreference(docId, env)
            await promoteDocumentToScope(docId, scope, env)
          } else {
            await appCoref(docId, env, { model: ctx.model })
            await appPromote(docId, scope, env, { model: ctx.model })
          }
        })
      }
      const rows = db
        .prepare(`SELECT c.id, c.parent_id AS d, p.parent_id AS s FROM extracted_entity c LEFT JOIN extracted_entity p ON p.id = c.parent_id WHERE c.scope = 'chunk'`)
        .all() as Array<{ id: number; d: number | null; s: number | null }>
      const clusters: Record<string, string> = {}
      for (const r of rows) clusters[rowToMention.get(r.id)!] = r.s !== null ? `s${r.s}` : r.d !== null ? `d${r.d}` : `m${r.id}`
      return { clusters, cost: meter.cost() }
    },
  }
}

export const E2E_STRATEGIES: E2EStrategy[] = [
  e2e('legacy', 'Current app: legacy coreference + legacy scope promotion (llama-3.3-70b)', 'legacy', [LEGACY_MODEL]),
  e2e('app', 'New: surface-form coreference with the given model (no contexts) + exact-alias scope linking (no LLM)', 'app'),
]
