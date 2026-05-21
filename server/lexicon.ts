import { DurableObject } from 'cloudflare:workers'

export interface LexiconEntry {
  term: string
  learnCount: number
  failCount: number
  firstLearned: string | null
  lastLearned: string | null
  lastFailed: string | null
  firstSeen: string | null
  lastSeen: string | null
  firstFailed: string | null
  tags: string[]
}

interface LexiconRow extends Record<string, SqlStorageValue> {
  term: string
  learn_count: number
  fail_count: number
  first_learned: string | null
  last_learned: string | null
  last_failed: string | null
  first_seen: string | null
  last_seen: string | null
  first_failed: string | null
  tags: string
}

export class Lexicon extends DurableObject<Env> {
  private sql: SqlStorage

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql

    ctx.blockConcurrencyWhile(async () => {
      const version = (await ctx.storage.get<number>('schemaVersion')) ?? 0

      if (version < 1) {
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
        await ctx.storage.put('schemaVersion', 1)
      }

      if (version < 2) {
        this.sql.exec(`
          CREATE TABLE lexicon_v2 (
            term TEXT PRIMARY KEY,
            learn_count INTEGER NOT NULL DEFAULT 0,
            fail_count INTEGER NOT NULL DEFAULT 0,
            first_learned TEXT,
            last_learned TEXT,
            last_failed TEXT,
            first_seen TEXT,
            last_seen TEXT,
            first_failed TEXT,
            tags TEXT NOT NULL DEFAULT ''
          )
        `)
        this.sql.exec(`
          INSERT INTO lexicon_v2 (term, learn_count, fail_count, first_learned, last_learned, last_failed, tags)
          SELECT term, learn_count, fail_count, first_learned, last_learned, last_failed, tags
          FROM lexicon
        `)
        this.sql.exec('DROP TABLE lexicon')
        this.sql.exec('ALTER TABLE lexicon_v2 RENAME TO lexicon')
        this.sql.exec('CREATE INDEX idx_seen ON lexicon(last_seen) WHERE first_seen IS NOT NULL')
        this.sql.exec('CREATE INDEX idx_learned ON lexicon(last_learned) WHERE learn_count > 0')
        this.sql.exec('CREATE INDEX idx_failed ON lexicon(last_failed) WHERE fail_count > 0')
        await ctx.storage.put('schemaVersion', 2)
      }
    })
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
        `UPDATE lexicon SET
           learn_count = learn_count + 1,
           last_learned = ?,
           first_learned = COALESCE(first_learned, ?),
           last_seen = ?,
           first_seen = COALESCE(first_seen, ?)
         WHERE term = ?`,
        now,
        now,
        now,
        now,
        term
      )
      const updated = await this.getTerm(term)
      return { entry: updated!, relearned: true }
    } else {
      const tagsStr = tags.join(';')
      this.sql.exec(
        `INSERT INTO lexicon (term, learn_count, fail_count, first_learned, last_learned, last_failed, first_seen, last_seen, tags)
         VALUES (?, 1, 0, ?, ?, NULL, ?, ?, ?)`,
        term,
        now,
        now,
        now,
        now,
        tagsStr
      )
      const entry = await this.getTerm(term)
      return { entry: entry!, relearned: false }
    }
  }

  async markFailed(term: string): Promise<LexiconEntry> {
    const now = new Date().toISOString()
    this.sql.exec(
      `INSERT INTO lexicon (term, learn_count, fail_count, first_failed, last_failed, tags)
       VALUES (?, 0, 1, ?, ?, '')
       ON CONFLICT(term) DO UPDATE SET
         fail_count = fail_count + 1,
         last_failed = excluded.last_failed,
         first_failed = COALESCE(first_failed, excluded.first_failed)`,
      term,
      now,
      now
    )
    return (await this.getTerm(term))!
  }

  async markSeenBulk(terms: string[]): Promise<void> {
    if (terms.length === 0) return
    const now = new Date().toISOString()
    for (const term of terms) {
      this.sql.exec(
        `INSERT INTO lexicon (term, learn_count, fail_count, first_seen, last_seen, tags)
         VALUES (?, 0, 0, ?, ?, '')
         ON CONFLICT(term) DO UPDATE SET
           last_seen = excluded.last_seen,
           first_seen = COALESCE(first_seen, excluded.first_seen)`,
        term,
        now,
        now
      )
    }
  }

  async markLearnedBulk(terms: string[]): Promise<void> {
    if (terms.length === 0) return
    const now = new Date().toISOString()
    for (const term of terms) {
      this.sql.exec(
        `INSERT INTO lexicon (term, learn_count, fail_count, first_learned, last_learned, first_seen, last_seen, tags)
         VALUES (?, 1, 0, ?, ?, ?, ?, '')
         ON CONFLICT(term) DO UPDATE SET
           learn_count = learn_count + 1,
           last_learned = excluded.last_learned,
           first_learned = COALESCE(first_learned, excluded.first_learned),
           last_seen = excluded.last_seen,
           first_seen = COALESCE(first_seen, excluded.first_seen)`,
        term,
        now,
        now,
        now,
        now
      )
    }
  }

  async updateTags(term: string, tags: string[]): Promise<LexiconEntry | null> {
    const existing = await this.getTerm(term)
    if (!existing) return null

    const tagsStr = tags.join(';')
    this.sql.exec('UPDATE lexicon SET tags = ? WHERE term = ?', tagsStr, term)
    return await this.getTerm(term)
  }

  async getPreferences(): Promise<{ script: string; pronunciationPrimary: string; pronunciationSecondaries: string[]; theme: string }> {
    const stored = await this.ctx.storage.get<Record<string, unknown>>('preferences')
    if (!stored) {
      return { script: 'traditional', pronunciationPrimary: 'pinyin', pronunciationSecondaries: [], theme: 'light' }
    }
    // Migration: old format had `pronunciation` as a string
    if (typeof stored.pronunciation === 'string') {
      return {
        script: (stored.script as string) ?? 'traditional',
        pronunciationPrimary: stored.pronunciation,
        pronunciationSecondaries: [],
        theme: 'light',
      }
    }
    return {
      script: (stored.script as string) ?? 'traditional',
      pronunciationPrimary: (stored.pronunciationPrimary as string) ?? 'pinyin',
      pronunciationSecondaries: (stored.pronunciationSecondaries as string[]) ?? [],
      theme: (stored.theme as string) ?? 'light',
    }
  }

  async setPreferences(prefs: { script?: string; pronunciationPrimary?: string; pronunciationSecondaries?: string[]; theme?: string }): Promise<{ script: string; pronunciationPrimary: string; pronunciationSecondaries: string[]; theme: string }> {
    const current = await this.getPreferences()
    const updated = { ...current, ...prefs }
    await this.ctx.storage.put('preferences', updated)
    return updated
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
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      firstFailed: row.first_failed,
      tags: row.tags ? row.tags.split(';').filter(Boolean) : [],
    }
  }
}
