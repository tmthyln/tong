/**
 * Minimal in-memory D1 stand-in over node:sqlite, so the frozen legacy
 * coreference / scope-promotion code runs unmodified in the eval.
 * Only the tables and columns those code paths touch.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

export function createShimDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE knowledge_scope (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE document (id INTEGER PRIMARY KEY, knowledge_scope_id INTEGER);
    CREATE TABLE text_chunk (id INTEGER PRIMARY KEY, source_document_id INTEGER, chunk_order INTEGER, content TEXT);
    CREATE TABLE extracted_entity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_document_id INTEGER, source_chunk_id INTEGER, entity_type TEXT,
      extracted_text TEXT, label TEXT, scope TEXT, parent_id INTEGER,
      chunk_start_index INTEGER, chunk_end_index INTEGER, knowledge_scope_id INTEGER
    );
    CREATE TABLE extracted_relationship (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source_document_id INTEGER, from_entity_id INTEGER,
      to_entity_id INTEGER, edge_type TEXT, explanation TEXT, scope TEXT, knowledge_scope_id INTEGER
    );
  `)
  const d1 = {
    prepare(sql: string) {
      let params: SQLInputValue[] = []
      const stmt = {
        bind(...p: SQLInputValue[]) {
          params = p
          return stmt
        },
        async all<T>() {
          return { results: db.prepare(sql).all(...params) as T[] }
        },
        async first<T>() {
          return (db.prepare(sql).get(...params) as T | undefined) ?? null
        },
        async run() {
          const r = db.prepare(sql).run(...params)
          return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }
        },
      }
      return stmt
    },
  }
  return { db, d1: d1 as unknown as D1Database }
}
