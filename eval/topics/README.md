# Topic-label eval (document map, issue #4)

Local harness for the naming model behind the document map's hierarchical topic
labels. The production Python pipeline (`container/topics.py`, toponymy) runs
unmodified. A local stand-in for the Worker's Workers AI bridge (`bridge.ts`)
serves its `/chat` and `/embed` calls through the REST API for whichever model is
under test.

```bash
npm run eval:topics -- build                     # corpus + document embeddings (cached)
npm run eval:topics -- bridge 8790 &             # local bridge for the Python side
container/.venv/bin/python eval/topics/run.py @cf/moonshotai/kimi-k2.6
npm run eval:topics -- judge                     # score every run (rerun to fill rate-limited gaps)
npm run eval:topics -- report                    # results/report.html (prose: report-notes.json)
```

## Corpus

A mixed library of about 1,000 chunks from 60 documents, chunked with the app's chunker:

- zh Wikipedia, Simplified: 30 articles across science, technology, food, sports,
  economics and history/geography.
- zh Wikisource, Traditional: 西遊記 ch. 1–6, 紅樓夢 ch. 1–5, 論語 篇 1–7, 孫子兵法.
- The 斗罗大陆 and 三國演義 chapters from `eval/resolution`.

`run.py` flags: `--max-features N` sets the keyphrase cap (default: production's
`KEYPHRASE_MAX_FEATURES`; runs made before the cap existed are uncapped);
`--fresh` bypasses the bridge's response cache, for timing runs and for repeat
runs of a configuration (naming samples at temperature 0.4, so repeats measure
run-to-run noise); `--tag` suffixes the run name.

`data/` and `results/` are gitignored. UMAP runs once with the container's
parameters and is cached (`data/coords.npy`), so every model names the same
clusters.

## Metrics

Each label is judged by two models outside the candidate set (deepseek-v4-pro and
glm-5.3) on a seeded sample of its cluster's passages.

- **descriptive** (1–5): from the label alone, would a reader correctly predict what
  the passages are about, at a useful level of specificity? Also records **generic**:
  whether the label would fit almost any part of a mixed library.
- **faithful**: the label is split into its content claims (entities, events,
  subjects, qualifiers). Each claim must be supported by a sampled passage, or be a
  fair generalisation of several. The score is the share of supported claims;
  *fully faithful* is the share of labels with no unsupported claim.
- **discriminative**:
  - *match*: the judge sees 4 passages and every label of that layer, shuffled, and
    picks one. The score is accuracy. Duplicate labels are separate options, so
    duplicates cost accuracy.
  - *embed*: judge-free. The share of a cluster's chunks whose nearest label in that
    layer (embeddinggemma-2) is the cluster's own.
- **cost**: billed neurons at $0.011 / 1,000 for the naming calls of one full run.
  LLM time is the sum of call latencies. Wall time is bounded by the model's rate
  limit: paid-plan models (glm-5.3-flash, kimi) allow 20 requests/min per account,
  and a run makes ~110 naming calls.
