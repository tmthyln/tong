# Resolution eval (coreference + cross-document linking)

Local harness for the two entity-resolution steps that run after extraction:

- **coref** — within-document coreference (`server/lib/coreference.ts`): group a
  document's chunk mentions into document-scope entities.
- **link** — cross-document resolution against the knowledge scope
  (`server/lib/scope-promotion.ts`): link a document's entities to scope
  entities / other documents' entities, or NIL.
- **e2e** — both, run by the actual app code on an in-memory D1 with the real
  migrations (`server/lib/testing/sqlite-d1.ts`), document by document, scored
  on the final graph.

Both steps are built on `server/lib/extraction/resolve.ts`. The pre-refactor
code is frozen in `legacy/` as the baseline (run unmodified through a tiny D1 shim).

```bash
curl -sL -o eval/resolution/data/download/sanguo.txt https://www.gutenberg.org/cache/epub/23950/pg23950.txt
npm run eval:resolution -- build douluo        # chunks from the local D1 + production NER
npm run eval:resolution -- build sanguo        # 三國演義 ch. 1–8, chunked like the app
npm run eval:resolution -- forms sanguo        # surface forms + contexts, for annotation
npm run eval:resolution -- run sanguo coref forms @cf/google/gemma-4-26b-a4b-it
npm run eval:resolution -- sweep               # coref + link grid, resumable
npm run eval:resolution -- run douluo e2e app @cf/google/gemma-4-26b-a4b-it
npm run eval:resolution -- rescore             # after changing metrics or gold
npm run eval:resolution -- report              # results/report.html (uses report-notes.json)
```

## Data and gold

`data/` and `results/` are gitignored (the novel text is copyrighted; keep it local).

Mentions come from the production NER (`extractEntitiesBatch`), so resolution is
measured on realistic, noisy input. The unit of annotation is a **surface form**
(distinct text + type in a document). Gold keys (`data/<corpus>-gold.json`) default
to the form's text, type-agnostic and corpus-wide; only exceptions are annotated:
`aliases` (玄德 → 劉備, 小三 → 唐三) and `docOverrides` for one-document meanings
(in 三國演義 ch. 5–6 「關」 is mostly the pass, not 關羽). Homonyms within one
document are not modelled.

## Metrics

- coref: MUC link P/R/F1 over surface forms (headline); B³ over mentions and the
  split rate (forms whose mentions landed in more than one entity) as diagnostics.
- link: queries are the gold document entities of documents 2..n; the gold answer
  is the entity key if it occurred in an earlier document, else NIL; KB entries carry
  all aliases seen so far. P = correct / predicted links, R = correct / gold links.
- e2e: pairwise P/R/F1 over cross-document pairs of named-entity surface forms
  (PERSON, LOCATION, GPE, ORGANIZATION) — same final graph entity iff same gold key.
- cost: billed neurons at $0.011 / 1,000, per 1M characters of source text.

## Response cache

Every model call goes through `eval/common/cache.ts`, keyed by model, the exact
Workers AI arguments production sends, and a replicate index, and stored under
`data/cache/`. A stored call keeps its usage and latency, so a replayed run
reports the same cost. `--force` recomputes a run (re-parsing, re-scoring) from
the cache for free; `--fresh` bypasses cache reads for real calls (timing runs).
A run file's `cacheHits` says how many calls were replayed: its wall-clock times
mean nothing unless that is 0.
