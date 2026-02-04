# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Tong is a single-user web-based Chinese (Mandarin) language learning system. It tracks user vocabulary (lexicon), provides dictionary lookups, and builds a knowledge graph of entities and concepts.

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
- Theme persisted to localStorage, defaults to system preference

**Backend**: Hono on Cloudflare Workers in `server/`
- Entry: `server/index.ts` mounts sub-apps from `server/routes/`
- API routes pattern: create Hono sub-app, export default, mount at `/api/<resource>`

**Durable Objects**: SQLite-backed persistent storage
- `Lexicon` class in `server/lexicon.ts` - user vocabulary tracking
- Schema uses snake_case columns, `LexiconEntry` interface uses camelCase
- Access pattern: `env.LEXICON.idFromName('default').get()`

## Data Model

Content hierarchy: chunk < document < collection/book < global scope. Pre-process documents to Markdown.