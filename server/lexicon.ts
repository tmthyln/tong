import { DurableObject } from 'cloudflare:workers'

export interface LexiconEntry {
  term: string
  learnCount: number
  failCount: number
  firstLearned: string
  lastLearned: string
  lastFailed: string | null
  tags: string[]
}

interface LexiconRow extends Record<string, SqlStorageValue> {
  term: string
  learn_count: number
  fail_count: number
  first_learned: string
  last_learned: string
  last_failed: string | null
  tags: string
}

export class Lexicon extends DurableObject<Env> {
  private sql: SqlStorage

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS lexicon (
        term TEXT PRIMARY KEY,
        learn_count INTEGER NOT NULL DEFAULT 1,
        fail_count INTEGER NOT NULL DEFAULT 0,
        first_learned TEXT NOT NULL,
        last_learned TEXT NOT NULL,
        last_failed TEXT,
        tags TEXT NOT NULL DEFAULT ''
      )
    `)
  }

  async getAll(): Promise<LexiconEntry[]> {
    const rows = this.sql.exec<LexiconRow>('SELECT * FROM lexicon ORDER BY last_learned DESC')
    return [...rows].map(this.rowToEntry)
  }

  async getTerm(term: string): Promise<LexiconEntry | null> {
    const rows = this.sql.exec<LexiconRow>('SELECT * FROM lexicon WHERE term = ?', term)
    const row = [...rows][0]
    return row ? this.rowToEntry(row) : null
  }

  async addOrRelearn(term: string, tags: string[] = []): Promise<{ entry: LexiconEntry; relearned: boolean }> {
    const now = new Date().toISOString()
    const existing = await this.getTerm(term)

    if (existing) {
      this.sql.exec(
        'UPDATE lexicon SET learn_count = learn_count + 1, last_learned = ? WHERE term = ?',
        now,
        term
      )
      const updated = await this.getTerm(term)
      return { entry: updated!, relearned: true }
    } else {
      const tagsStr = tags.join(';')
      this.sql.exec(
        'INSERT INTO lexicon (term, learn_count, fail_count, first_learned, last_learned, last_failed, tags) VALUES (?, 1, 0, ?, ?, NULL, ?)',
        term,
        now,
        now,
        tagsStr
      )
      const entry = await this.getTerm(term)
      return { entry: entry!, relearned: false }
    }
  }

  async markFailed(term: string): Promise<LexiconEntry | null> {
    const now = new Date().toISOString()
    const existing = await this.getTerm(term)
    if (!existing) return null

    this.sql.exec(
      'UPDATE lexicon SET fail_count = fail_count + 1, last_failed = ? WHERE term = ?',
      now,
      term
    )
    return await this.getTerm(term)
  }

  async updateTags(term: string, tags: string[]): Promise<LexiconEntry | null> {
    const existing = await this.getTerm(term)
    if (!existing) return null

    const tagsStr = tags.join(';')
    this.sql.exec('UPDATE lexicon SET tags = ? WHERE term = ?', tagsStr, term)
    return await this.getTerm(term)
  }

  async setAlarm(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000)
  }

  async destroy(): Promise<void> {
    await this.ctx.storage.deleteAll()
  }

  async alarm(): Promise<void> {
    await this.destroy()
  }

  private rowToEntry(row: LexiconRow): LexiconEntry {
    return {
      term: row.term,
      learnCount: row.learn_count,
      failCount: row.fail_count,
      firstLearned: row.first_learned,
      lastLearned: row.last_learned,
      lastFailed: row.last_failed,
      tags: row.tags ? row.tags.split(';').filter(Boolean) : [],
    }
  }
}