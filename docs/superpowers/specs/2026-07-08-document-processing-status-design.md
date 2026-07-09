# Document Processing Status Tracking (issue #21)

Track which enrichments have been computed for each document, surface a
3-state processing status in the library's all-documents table, and warn in
translate mode when initial translations aren't done yet.

## Background

The `document_enrichment_run` table (migration 0018) and the helpers in
`server/lib/enrichment-run.ts` already record runs for entity extraction,
coreference, relationship extraction, and scope promotion. Storage/chunking,
embedding, and all four translation phases of the ingest workflow are not
tracked. The document row is created mid-workflow (phase 3), so an uploading
document is invisible until extraction succeeds, and a failed extraction
leaves no trace.

## 1. Enrichment kinds & renames

`document_enrichment_run` remains the single source of truth. The
`EnrichmentKind` union becomes:

| Kind | Covers | Status |
|---|---|---|
| `document_stored` | R2 original + markdown extraction + chunk generation (workflow phases 1–5) | new |
| `chunk_embedding` | per-chunk Vectorize embedding (phase 6) | new |
| `entity_extraction` | per-chunk entity extraction + dedup (phase 8) | exists |
| `coreference_resolution` | document coreference (phase 9) | renamed from `document_coreference` |
| `relationship_extraction` | sliding-window relationships (phase 10) | exists |
| `entity_resolution` / `entity_resolution_retroactive` | knowledge-scope promotion (phase 11) | renamed from `scope_promotion` / `scope_promotion_retroactive` |
| `initial_translation` | MT baseline (draft -1) + LLM+MT baseline (draft 0) + initial draft (phases 12–13) | new |
| `initial_translation_refinement` | revision draft (phase 14) | new |

Renames are applied in code (`server/lib/enrichment-run.ts`,
`server/workflows/ingest-document.ts`, `server/routes/library.ts`,
`server/routes/knowledge-scope.ts`, tests) and to existing rows via `UPDATE`
in the migration.

**Preprocessing kinds** (gate the Ready state; everything except
`entity_resolution`, which only runs when a knowledge scope is assigned):
`document_stored`, `chunk_embedding`, `entity_extraction`,
`coreference_resolution`, `relationship_extraction`, `initial_translation`,
`initial_translation_refinement`.

## 2. Migration (0019)

- Rebuild the `document` table so `extracted_doc_location`,
  `extracted_doc_char_count`, `extracted_doc_unique_char_count` are nullable
  (SQLite create-copy-drop-rename; recreate indexes).
- Rename existing enrichment kind rows per the table above.
- **Backfill**: for every existing document, insert synthetic `completed`
  runs (params `{"backfilled": true}`) for any of the 7 preprocessing kinds
  it is missing, so pre-existing documents don't show Pending/Processing
  forever.

## 3. Upload & workflow restructuring

- `POST /api/library/document` inserts the document row immediately
  (extraction fields null) and passes `documentId` in the workflow params.
  Uploads appear instantly as Pending; failed extractions stay visible.
- Workflow phase 3 becomes an `UPDATE` (title, extracted location, char
  counts) instead of `INSERT`.
- `document_stored` run: started as the workflow's first step, completed
  after chunk persistence (covers phases 1–5).
- `chunk_embedding` run brackets phase 6; failed if any chunk's embedding
  step rejects (same start/complete step pattern as entity extraction).
- Remove the early return when no node types are configured — it currently
  skips translations entirely. Entity/coref/relationship phases are instead
  skipped with `completed` runs recording `{skipped: ...}`, and translation
  always runs. Relationship extraction likewise records a skipped run when
  no edge types exist.
- `initial_translation` run brackets phases 12–13;
  `initial_translation_refinement` brackets phase 14; each fails if any
  chunk step rejects.

## 4. Status derivation

New pure function in `server/lib/enrichment-run.ts`:

```ts
computeProcessingStatus(runs: { kind: string; status: string; startedAt: string }[])
  → 'pending' | 'processing' | 'ready'
```

- Considers only the latest run per kind (by `started_at`, then id).
- `pending`: no completed `document_stored` run.
- `ready`: latest run of every preprocessing kind is `completed`.
- otherwise `processing` (includes failed runs; failure detail stays
  inspectable via the existing `GET /document/:id/enrichments` endpoint).

`GET /api/library/document` gains a `processing_status` field per row: one
extra query fetching runs for the page's document IDs, grouped in JS through
the pure function.

## 5. UI

- **LibraryView**: new "Status" column in the all-documents table — Vuetify
  chip: Pending (grey), Processing (blue), Ready (green).
- **DocumentView**: when translation mode is active, fetch
  `/api/library/document/:id/enrichments` (once per document) and show a
  `v-alert` warning above the chunks if `initial_translation` and
  `initial_translation_refinement` are not both complete.

## 6. Testing

- Unit tests for `computeProcessingStatus` (all three states, failed runs,
  missing kinds, latest-run-wins).
- Route test for the list endpoint including `processing_status` (existing
  fake-D1 pattern in `library.test.ts`).
- Migration exercised via `wrangler d1 migrations apply --local`; all
  verification through vitest.

## Implementation phasing

Three separately tested and committed phases:

1. Migration + enrichment-run lib changes (renames, new kinds,
   `computeProcessingStatus`).
2. Upload handler + ingest workflow restructuring.
3. List-endpoint `processing_status` + LibraryView column + DocumentView
   translate-mode warning.
