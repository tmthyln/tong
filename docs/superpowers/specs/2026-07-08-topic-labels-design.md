# Hierarchical Topic Labels for the Document Map (issue #4)

**Date:** 2026-07-08
**Issue:** #4 — Hierarchical topic labels for document topic space visualization
**Builds on:** #2 (UMAP scatterplot of chunk/document embeddings, closed)

## Goal

Generate hierarchical topic labels for the document-map scatterplot using the
[toponymy](https://github.com/TutteInstitute/toponymy) Python package, and render
them at different zoom levels. Labeling runs concurrently with (and in the same
container as) UMAP. All LLM calls go through Workers AI.

## Decisions (from brainstorming)

- **Latency model:** non-blocking. The scatterplot loads at today's speed; labels
  are computed in the background and the frontend polls for them.
- **Label language:** bilingual. Chinese shown by default on the map; English
  gloss appears on hover.
- **Caching:** container memory only, keyed by a hash of the input. Warm
  container reuses finished labels and in-flight jobs; cold container recomputes.
- **LLM access from container:** native outbound interception
  (`static outboundByHost` in `@cloudflare/containers` ≥ 0.2.0) — no API tokens.
- **Models:** `@cf/moonshotai/kimi-k2.6` for topic naming (strong Chinese),
  `@cf/google/embeddinggemma-300m` for keyphrase embedding (same model as chunks).

## Architecture

### Orchestration: container-internal background job

The Worker's visualization request includes chunk texts in addition to vectors.
The container endpoint runs UMAP, returns coords immediately, and spawns an
in-process background task (FastAPI `BackgroundTasks`) that runs toponymy on the
same data. Results land in an in-container dict keyed by input hash.

### Workers AI bridge

`UmapContainer` (`server/containers/umap.ts`) gains `static outboundByHost`
handlers. Python code calls virtual hostnames:

- `http://workers-ai.tong/chat` → `env.AI.run('@cf/moonshotai/kimi-k2.6', …)`
- `http://workers-ai.tong/embed` → `env.AI.run('@cf/google/embeddinggemma-300m', …)`

Handlers run in the Workers runtime with full `env` access. Works identically in
`wrangler dev` and production.

### Toponymy pipeline (container)

New Python module alongside `container/app.py`:

1. Cluster the 2D UMAP coords with toponymy's standard hierarchical clusterer
   (HDBSCAN-based layers).
2. Extract keyphrases from chunk texts using a Chinese-aware tokenizer (jieba) —
   toponymy's defaults assume space-delimited English.
3. Custom toponymy LLM wrapper + embedding wrapper backed by the virtual-host
   HTTP endpoints above. Topic names generated in Chinese.
4. Final batched LLM call glosses each Chinese label into English.
5. Output per hierarchy layer: `[{ label_zh, label_en, x, y, size }]`, label
   positions at cluster centroids in scatterplot coordinate space.

### Worker changes

- `server/routes/library-visualization.ts`: also SELECT `content` from
  `text_chunk`; pass texts to the container; return a `topicsKey` (input hash)
  alongside coords.
- New route `GET /api/library/visualization/topics?key=…` proxying the
  container's `/topics/{key}` → `{ status: 'pending' | 'ready' | 'error', layers: […] }`.
- `server/containers/umap.ts`: add `outboundByHost` handlers for chat + embed.

### Frontend (`src/views/DocumentsView.vue`)

- After the scatterplot renders, poll the topics endpoint (~3 s interval, capped)
  until `ready` or `error`.
- Render labels as SVG text at cluster centroids: Chinese by default, English on
  hover.
- Zoom maps to hierarchy depth (datamapplot-style): zoomed out shows the coarsest
  layer only; zooming in crossfades deeper layers in and coarser layers out.
  Labels counter-scale against the zoom transform so text stays a readable size.

## Error handling

- Too few points / no clusters found → topics response returns `ready` with an
  empty `layers` array; frontend shows no labels.
- Toponymy or LLM failure → status `error`; frontend stops polling silently (the
  map remains fully usable without labels).
- Container-side job exceptions are caught and stored as `error` status rather
  than crashing the server process.

## Testing

- **Worker:** vitest for route shape and outbound-handler logic.
- **Container:** pytest for the toponymy module with the LLM/embedding HTTP layer
  mocked; no live-instance testing.

## Known risks

- Toponymy's exact wrapper interfaces (LLM wrapper methods, clusterer layer
  ordering) are pinned against the real package during implementation; all
  toponymy-facing code is isolated in one Python module.
- Chinese keyphrase quality depends on jieba tokenization; acceptable for a
  research-prototype visualization.
