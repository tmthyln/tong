# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Tong is a single-user web-based Chinese (Mandarin) language learning system. Users read Chinese documents with side-by-side translation drafts, look up words in an embedded CEDICT dictionary, track vocabulary in a lexicon, and explore a knowledge graph of named entities and their relationships.

## Commands

```bash
npm run dev       # Vite dev server (frontend only, no Worker)
npm run preview   # Full-stack preview with Wrangler
npm run build     # Production build with type-check
npm run deploy    # Build and deploy to Cloudflare
npm run cf-typegen # Generate Cloudflare Worker types
```

## Architecture

**Frontend**: Vue 3 + Vuetify SPA in `src/`
- Entry: `src/main.ts` → `src/App.vue`
- Views in `src/views/`: Home, Document, Dictionary, Lexicon, KnowledgeGraph, Library, Settings
- Composables in `src/composables/`, shared types in `src/types/`
- Theme persisted to localStorage, defaults to system preference

**Backend**: Hono on Cloudflare Workers in `server/`
- Entry: `server/index.ts` mounts sub-apps from `server/routes/`
- API routes pattern: create Hono sub-app, export default, mount at `/api/<resource>`
- Shared logic in `server/lib/`; long-running pipelines in `server/workflows/`

**Cloudflare bindings**:
| Binding | Type | Purpose |
|---------|------|---------|
| `DB` | D1 Database | All relational data (documents, entities, relationships, dictionary) |
| `DOCUMENTS` | R2 Bucket | Original uploaded files |
| `CHUNK_VECTORS` | Vectorize | Chunk embeddings |
| `AI` | AI | LLM calls |
| `LEXICON` | Durable Object | Per-user vocabulary + preferences |
| `INGEST_DOCUMENT_WORKFLOW` | Workflow | Multi-step document ingestion pipeline |
| `REFRESH_CEDICT_WORKFLOW` | Workflow | CEDICT dictionary refresh |

**Durable Objects**: `Lexicon` class in `server/lexicon.ts` — user vocabulary and preferences. Schema uses snake_case columns; `LexiconEntry` interface uses camelCase. Access: `env.LEXICON.idFromName('default').get()`.

## Key Features & Components

**Document Reader** (`DocumentView.vue`): The central view. Three modes:
- `reading` — raw Chinese text, click words to look up in dictionary
- `translation` — side-by-side Chinese and translation draft editor with autosave
- `reader` — entity-annotated view showing known entities highlighted

**Selection Toolbar**: Popup toolbar that appears on text selection or entity click. Supports dictionary lookup, explain/disambiguate (LLM), add to lexicon, create entity, set preferred translation.

**Translation Draft System**: Each chunk can have multiple numbered drafts. Draft number increments when the previous translator is AI or MT; user edits overwrite the current draft. Translator field records userId or an `'ai:*'`/`'mt:*'` prefix.

**Entity & Knowledge Graph System**: Named entities are extracted per-chunk by LLM and resolved to document-scoped parent entities via coreference. Relationships between entities are extracted with typed edges. The KnowledgeGraph view visualizes this. Entity types and edge types are fully user-configurable via the Settings view.

**Dictionary**: Embedded CEDICT with FTS5 search, beam-search segmentation, and LLM-powered explain/disambiguate per document context.

**Lexicon**: Durable Object–backed vocabulary tracker with learn/fail counts and tags.

**Library**: Document upload (PDF/DOCX → Markdown → chunks), folder organization, collection tree.

**Authentication**: Three user types: `public` (read-only), `authenticated` (`user:*`), `test` (24-hour expiry via DO alarm). Session in httpOnly cookie.

## Data Model

Content hierarchy: chunk < document < collection/book < global scope.

D1 tables use snake_case columns. Key tables: `document_group`, `document`, `text_chunk`, `translation_chunk` (drafts), `extracted_entity`, `extracted_relationship`, `node_type`/`edge_type` (configurable taxonomy), and CEDICT tables with FTS5.

## Key Patterns

**Async background work**: Use `c.executionCtx.waitUntil()` for fire-and-forget tasks (coreference resolution, relationship extraction, translation retrigger). Requests return immediately.

**Entity scopes**: Entities are either chunk-scoped (with position indices) or document-scoped (aggregating chunk entities via parent reference). Overlapping chunk entities are removed post-query.

**LLM usage**: All LLM calls go through `env.AI`. Use helpers in `server/lib/llm-utils.ts` for JSON extraction and prompt construction.
