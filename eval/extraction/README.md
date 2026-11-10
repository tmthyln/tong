# Extraction eval

Local harness for the schema-driven extractor in `server/lib/extraction/`
(entities, relations, classifications — GLiNER-style, one prompt per schema).
It runs the exact production code against Cloudflare-hosted Workers AI models
through the REST API, and measures quality against cost.

```bash
npm run eval:extraction -- silver            # once: build in-domain silver labels from local D1
npm run eval:extraction -- sweep lit douluo  # model × strategy grid (resumable; cached per cell)
npm run eval:extraction -- run lit joint-ner-re @cf/google/gemma-4-26b-a4b-it [--thinking] [--force]
npm run eval:extraction -- report            # results/report.html — efficiency frontier
```

Auth: `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`, or an existing
`npx wrangler login` (the harness reads/refreshes wrangler's OAuth token).

## Datasets (not committed — `data/` and `results/` are gitignored)

- **lit** — *A Discourse-Level Named Entity Recognition and Relation Extraction
  Dataset for Chinese Literature Text* (Xu et al., 2017;
  github.com/lancopku/Chinese-Literature-NER-RE-Dataset). Fetch the
  `relation_extraction/{Testing,Validation}` brat files into `data/lit/`.
  Passages of ~350 chars containing at least one relation; 40 sampled from
  Testing (seeded). Its scheme annotates named *and* nominal mentions (7 coarse
  types, pronouns dropped) and 9 relation types — a deliberately different
  schema from the app's, to exercise the generic extractor.
- **douluo** — 12 windows × 4 consecutive chunks of the novel in local D1, with
  the app's live `node_type` / `edge_type` ontology. Labels are *silver*: a
  per-chunk NER and closed-world RE majority vote (≥2 of 3) of kimi-k2.6,
  deepseek-v4-pro and glm-5.3 with thinking enabled.

## Scoring

String level per passage: a mention is correct if (text, type) matches exactly;
a relation if (head, type, tail) matches ("undirected" also reported). RE
strategies other than `joint-ner-re` receive the gold entities (closed world),
isolating relation quality from NER errors. Cost is the `neurons` Workers AI
reports per call × $0.011/1000; latency is wall-clock per window with calls
inside a window issued in parallel.

## Strategies

| name | calls per window | notes |
|---|---|---|
| `legacy-ner` | chunks × node types + chunks | frozen copy of the pre-refactor pipeline (`legacy/`) |
| `legacy-re` | edge types | frozen pre-refactor pipeline |
| `ner-per-label` / `re-per-label` | × labels | legacy structure with the new prompt |
| `ner-all-labels` | chunks | all node types in one prompt (production) |
| `ner-all-labels-window` | 1 | all chunks of the window in one prompt |
| `re-all-labels[-evidence]` | 1 | all edge types in one prompt (production uses evidence) |
| `joint-ner-re` | 1 | entities and relations in one prompt |
