/// <reference types="node" />
/**
 * In-memory D1 stand-in over node:sqlite with the real migrations applied —
 * for unit tests that should exercise actual SQL rather than string-matched
 * mocks, and for local eval scripts that run app code outside the Worker.
 * Implements the subset of the D1 API the app uses (prepare/bind/all/first/run, batch).
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS = join(process.cwd(), 'migrations')

export function createSqliteD1(opts: { migrate?: boolean } = {}) {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  if (opts.migrate ?? true) {
    for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
      db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'))
    }
  }
  const prepare = (sql: string) => {
    let params: SQLInputValue[] = []
    const stmt = {
      bind(...p: unknown[]) {
        params = p.map((x) => (x === undefined ? null : x)) as SQLInputValue[]
        return stmt
      },
      async all<T>() {
        return { results: db.prepare(sql).all(...params) as T[], success: true, meta: {} }
      },
      async first<T>() {
        return (db.prepare(sql).get(...params) as T | undefined) ?? null
      },
      async run() {
        const r = db.prepare(sql).run(...params)
        return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }
      },
      /** For batch(): RETURNING statements yield rows, others an empty result. */
      async _exec() {
        const s = db.prepare(sql)
        return /\breturning\b/i.test(sql) ? { results: s.all(...params), success: true, meta: {} } : await stmt.run()
      },
    }
    return stmt
  }
  const d1 = {
    prepare,
    async batch(stmts: Array<ReturnType<typeof prepare>>) {
      db.exec('BEGIN')
      try {
        const out = []
        for (const s of stmts) out.push(await s._exec())
        db.exec('COMMIT')
        return out
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    },
  }
  return { db, d1: d1 as unknown as D1Database }
}

type Db = ReturnType<typeof createSqliteD1>['db']

/** Fixture helpers over a migrated createSqliteD1() database. */
export const fixtures = {
  scope(db: Db, name = 'scope'): number {
    return Number(db.prepare('INSERT INTO knowledge_scope (name) VALUES (?)').run(name).lastInsertRowid)
  },
  document(db: Db, knowledgeScopeId: number | null = null): number {
    return Number(
      db
        .prepare(
          `INSERT INTO document (original_doc_location, original_doc_filename, original_doc_mimetype, original_doc_content_hash,
             date_uploaded, extracted_doc_location, extracted_doc_char_count, extracted_doc_unique_char_count, knowledge_scope_id)
           VALUES ('r2://x', 'x.md', 'text/markdown', 'h', '2026-01-01', 'r2://y', 0, 0, ?)`,
        )
        .run(knowledgeScopeId).lastInsertRowid,
    )
  },
  chunk(db: Db, documentId: number, order: number, content: string): number {
    return Number(
      db
        .prepare(
          `INSERT INTO text_chunk (source_document_id, chunk_order, extracted_doc_start_index, extracted_doc_end_index, content, char_count, unique_char_count)
           VALUES (?, ?, 0, ?, ?, ?, 0)`,
        )
        .run(documentId, order, content.length, content, content.length).lastInsertRowid,
    )
  },
  /** Chunk-scope entities for every occurrence of `text` in the chunk. */
  mentions(db: Db, documentId: number, chunkId: number, text: string, type: string): number[] {
    const content = (db.prepare('SELECT content FROM text_chunk WHERE id = ?').get(chunkId) as { content: string }).content
    const ids: number[] = []
    for (let i = content.indexOf(text); i >= 0; i = content.indexOf(text, i + text.length)) {
      ids.push(
        Number(
          db
            .prepare(
              `INSERT INTO extracted_entity (source_document_id, source_chunk_id, entity_type, extracted_text, chunk_start_index, chunk_end_index, scope)
               VALUES (?, ?, ?, ?, ?, ?, 'chunk')`,
            )
            .run(documentId, chunkId, type, text, i, i + text.length).lastInsertRowid,
        ),
      )
    }
    return ids
  },
}
