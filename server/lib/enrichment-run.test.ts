import { describe, it, expect } from 'vitest'
import {
  startEnrichmentRun,
  completeEnrichmentRun,
  failEnrichmentRun,
  withEnrichmentRun,
} from './enrichment-run'

interface FakeStatement {
  bind: (...args: unknown[]) => FakeStatement
  first: <T>() => Promise<T | null>
  all: <T>() => Promise<{ results: T[] }>
  run: () => Promise<void>
}

function makeDb(handlers: {
  first?: (sql: string, args: unknown[]) => unknown
  run?: (sql: string, args: unknown[]) => void
}): { db: D1Database; calls: { sql: string; args: unknown[] }[] } {
  const calls: { sql: string; args: unknown[] }[] = []
  const prepare = (sql: string): FakeStatement => {
    let bound: unknown[] = []
    const stmt: FakeStatement = {
      bind: (...args) => {
        bound = args
        return stmt
      },
      first: async <T>() => {
        calls.push({ sql, args: bound })
        return (handlers.first?.(sql, bound) ?? null) as T | null
      },
      all: async <T>() => {
        calls.push({ sql, args: bound })
        return { results: [] as T[] }
      },
      run: async () => {
        calls.push({ sql, args: bound })
        handlers.run?.(sql, bound)
      },
    }
    return stmt
  }
  return { db: { prepare } as unknown as D1Database, calls }
}

describe('startEnrichmentRun', () => {
  it('inserts an in_progress row with serialized JSON columns and returns the id', async () => {
    const { db, calls } = makeDb({
      first: (sql) => (sql.startsWith('INSERT') ? { id: 42 } : null),
    })

    const id = await startEnrichmentRun(db, {
      documentId: 7,
      kind: 'entity_extraction',
      model: '@cf/test/model',
      params: { temperature: 0, foo: 'bar' },
      ontology: [{ kind: 'node', name: 'Person', version: 2 }],
    })

    expect(id).toBe(42)
    const insert = calls.find((c) => c.sql.startsWith('INSERT'))!
    expect(insert.args[0]).toBe(7)
    expect(insert.args[1]).toBe('entity_extraction')
    expect(insert.args[2]).toBe('@cf/test/model')
    expect(JSON.parse(insert.args[3] as string)).toEqual({ temperature: 0, foo: 'bar' })
    expect(JSON.parse(insert.args[4] as string)).toEqual([
      { kind: 'node', name: 'Person', version: 2 },
    ])
    // started_at is a timestamp string
    expect(typeof insert.args[5]).toBe('string')
  })

  it('throws if INSERT returns null', async () => {
    const { db } = makeDb({ first: () => null })
    await expect(
      startEnrichmentRun(db, {
        documentId: 1,
        kind: 'entity_extraction',
        model: null,
        params: {},
        ontology: [],
      })
    ).rejects.toThrow(/Failed to insert/)
  })
})

describe('completeEnrichmentRun', () => {
  it('updates status to completed with summary and completed_at', async () => {
    const { db, calls } = makeDb({})
    await completeEnrichmentRun(db, 99, { entities_inserted: 12 })
    const update = calls.find((c) => c.sql.includes("SET status = 'completed'"))!
    expect(update.args[0]).toBe('{"entities_inserted":12}')
    expect(typeof update.args[1]).toBe('string')
    expect(update.args[2]).toBe(99)
  })
})

describe('failEnrichmentRun', () => {
  it('updates status to failed with error message', async () => {
    const { db, calls } = makeDb({})
    await failEnrichmentRun(db, 5, 'boom')
    const update = calls.find((c) => c.sql.includes("SET status = 'failed'"))!
    expect(update.args[0]).toBe('boom')
    expect(update.args[2]).toBe(5)
  })
})

describe('withEnrichmentRun', () => {
  it('wraps a successful function with start + complete', async () => {
    const { db, calls } = makeDb({
      first: (sql) => (sql.startsWith('INSERT') ? { id: 17 } : null),
    })

    const result = await withEnrichmentRun(
      db,
      {
        documentId: 1,
        kind: 'document_coreference',
        model: '@cf/x',
        params: {},
        ontology: [],
      },
      async (runId) => {
        expect(runId).toBe(17)
        return { result: 'ok', summary: { merged: 3 } }
      }
    )

    expect(result).toBe('ok')
    const complete = calls.find((c) => c.sql.includes("SET status = 'completed'"))
    const fail = calls.find((c) => c.sql.includes("SET status = 'failed'"))
    expect(complete).toBeDefined()
    expect(fail).toBeUndefined()
    expect(complete!.args[0]).toBe('{"merged":3}')
  })

  it('marks the run failed if the inner function throws, and re-throws', async () => {
    const { db, calls } = makeDb({
      first: (sql) => (sql.startsWith('INSERT') ? { id: 18 } : null),
    })

    await expect(
      withEnrichmentRun(
        db,
        {
          documentId: 1,
          kind: 'document_coreference',
          model: null,
          params: {},
          ontology: [],
        },
        async () => {
          throw new Error('LLM down')
        }
      )
    ).rejects.toThrow('LLM down')

    const fail = calls.find((c) => c.sql.includes("SET status = 'failed'"))
    expect(fail).toBeDefined()
    expect(fail!.args[0]).toBe('LLM down')
  })
})
