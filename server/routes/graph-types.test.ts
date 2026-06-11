import { describe, it, expect, vi } from 'vitest'
import graphTypeRoutes, { parseExamples, serializeExamples } from './graph-types'

describe('parseExamples', () => {
  it('parses a JSON array of strings', () => {
    expect(parseExamples('["a","b","c"]')).toEqual(['a', 'b', 'c'])
  })

  it('returns an empty array for malformed JSON', () => {
    expect(parseExamples('not json')).toEqual([])
  })

  it('filters non-string entries', () => {
    expect(parseExamples('["a",1,null,"b"]')).toEqual(['a', 'b'])
  })

  it('returns an empty array when the value is not an array', () => {
    expect(parseExamples('{"foo":"bar"}')).toEqual([])
  })
})

describe('serializeExamples', () => {
  it('round-trips with parseExamples', () => {
    const input = ['北京', '上海', '广州']
    expect(parseExamples(serializeExamples(input))).toEqual(input)
  })
})

// ── Mock D1 helpers for route tests ──────────────────────────

interface FakeStatement {
  bind: (...args: unknown[]) => FakeStatement
  first: <T>() => Promise<T | null>
  all: <T>() => Promise<{ results: T[] }>
  run: () => Promise<void>
}

function makeDb(handlers: {
  first?: (sql: string, args: unknown[]) => unknown
  all?: (sql: string, args: unknown[]) => unknown[]
  run?: (sql: string, args: unknown[]) => void
}): D1Database {
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
        return { results: (handlers.all?.(sql, bound) ?? []) as T[] }
      },
      run: async () => {
        calls.push({ sql, args: bound })
        handlers.run?.(sql, bound)
      },
    }
    return stmt
  }
  // expose calls for assertions
  ;(prepare as unknown as { calls: typeof calls }).calls = calls
  return { prepare } as unknown as D1Database
}

function getCalls(db: D1Database): { sql: string; args: unknown[] }[] {
  return ((db as unknown as { prepare: { calls: { sql: string; args: unknown[] }[] } }).prepare
    .calls)
}

async function request(
  db: D1Database,
  method: string,
  path: string,
  body?: unknown
): Promise<Response> {
  return graphTypeRoutes.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }),
    { DB: db } as Env
  )
}

describe('node-type routes', () => {
  it('POST creates a v1 row with examples_json', async () => {
    const db = makeDb({
      first: (sql) => {
        if (sql.startsWith('SELECT id FROM node_type WHERE name')) return null
        if (sql.startsWith('INSERT INTO node_type')) return { id: 42 }
        return null
      },
    })

    const res = await request(db, 'POST', '/node-type', {
      name: 'Person',
      definition: 'A human',
      examples: ['Confucius', 'Laozi'],
    })

    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json).toEqual({ id: 42, version: 1 })

    const insert = getCalls(db).find((c) => c.sql.includes('INSERT INTO node_type'))!
    expect(insert.args[0]).toBe('Person')
    expect(insert.args[1]).toBe('A human')
    expect(insert.args[2]).toBe('["Confucius","Laozi"]')
  })

  it('POST rejects duplicate names', async () => {
    const db = makeDb({
      first: (sql) => {
        if (sql.startsWith('SELECT id FROM node_type WHERE name')) return { id: 1 }
        return null
      },
    })
    const res = await request(db, 'POST', '/node-type', {
      name: 'Person',
      definition: 'A human',
    })
    expect(res.status).toBe(409)
  })

  it('PUT inserts a new version and marks the old one not current', async () => {
    const db = makeDb({
      first: (sql) => {
        if (sql.includes('WHERE id = ? AND is_current = 1')) {
          return {
            id: 5,
            name: 'Person',
            definition: 'old def',
            examples_json: '["a"]',
            version: 3,
          }
        }
        if (sql.startsWith('INSERT INTO node_type')) return { id: 99 }
        return null
      },
    })
    const res = await request(db, 'PUT', '/node-type/5', { definition: 'new def' })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ id: 99, version: 4 })

    const calls = getCalls(db)
    const insert = calls.find((c) => c.sql.startsWith('INSERT INTO node_type'))!
    expect(insert.args[1]).toBe('new def')
    expect(insert.args[2]).toBe('["a"]') // examples preserved
    expect(insert.args[3]).toBe(4) // bumped version

    const update = calls.find((c) => c.sql.startsWith('UPDATE node_type SET is_current = 0'))!
    expect(update.args).toEqual([5])
  })

  it('PUT rejects name changes', async () => {
    const db = makeDb({
      first: (sql) => {
        if (sql.includes('WHERE id = ? AND is_current = 1')) {
          return {
            id: 5,
            name: 'Person',
            definition: 'old',
            examples_json: '[]',
            version: 1,
          }
        }
        return null
      },
    })
    const res = await request(db, 'PUT', '/node-type/5', {
      name: 'Human',
      definition: 'new',
    })
    expect(res.status).toBe(400)
    const json = await res.json() as { error: string }
    expect(json.error).toMatch(/immutable/i)
  })

  it('PUT accepts identical name (idempotent rename to same)', async () => {
    const db = makeDb({
      first: (sql) => {
        if (sql.includes('WHERE id = ? AND is_current = 1')) {
          return { id: 5, name: 'Person', definition: 'old', examples_json: '[]', version: 1 }
        }
        if (sql.startsWith('INSERT INTO node_type')) return { id: 6 }
        return null
      },
    })
    const res = await request(db, 'PUT', '/node-type/5', {
      name: 'Person',
      definition: 'new',
    })
    expect(res.status).toBe(200)
  })

  it('DELETE soft-deletes by setting is_current = 0', async () => {
    let runSql = ''
    let runArgs: unknown[] = []
    const db = makeDb({
      run: (sql, args) => {
        runSql = sql
        runArgs = args
      },
    })
    const res = await request(db, 'DELETE', '/node-type/7')
    expect(res.status).toBe(200)
    expect(runSql).toContain('UPDATE node_type SET is_current = 0')
    expect(runArgs).toEqual([7])
  })

  it('POST example bumps version and appends to examples_json', async () => {
    const db = makeDb({
      first: (sql) => {
        if (sql.includes('WHERE id = ? AND is_current = 1')) {
          return {
            id: 5,
            name: 'Person',
            definition: 'A human',
            examples_json: '["Confucius"]',
            version: 2,
          }
        }
        if (sql.startsWith('INSERT INTO node_type')) return { id: 10 }
        return null
      },
    })
    const res = await request(db, 'POST', '/node-type/5/example', { example: 'Laozi' })
    expect(res.status).toBe(201)
    const insert = getCalls(db).find((c) => c.sql.startsWith('INSERT INTO node_type'))!
    expect(insert.args[2]).toBe('["Confucius","Laozi"]')
    expect(insert.args[3]).toBe(3)
  })

  it('DELETE example bumps version and removes from examples_json', async () => {
    const db = makeDb({
      first: (sql) => {
        if (sql.includes('WHERE id = ? AND is_current = 1')) {
          return {
            id: 5,
            name: 'Person',
            definition: 'A human',
            examples_json: '["Confucius","Laozi"]',
            version: 2,
          }
        }
        if (sql.startsWith('INSERT INTO node_type')) return { id: 10 }
        return null
      },
    })
    const res = await request(db, 'DELETE', '/node-type/5/example', { example: 'Confucius' })
    expect(res.status).toBe(200)
    const insert = getCalls(db).find((c) => c.sql.startsWith('INSERT INTO node_type'))!
    expect(insert.args[2]).toBe('["Laozi"]')
  })

  it('GET filters to current rows and parses examples', async () => {
    const db = makeDb({
      all: (sql) => {
        if (sql.includes('WHERE is_current = 1')) {
          return [
            { id: 1, name: 'Person', definition: 'A human', examples_json: '["a","b"]', version: 2 },
          ]
        }
        return []
      },
    })
    const res = await request(db, 'GET', '/node-type')
    expect(res.status).toBe(200)
    const json = await res.json() as Array<{ examples: string[]; version: number }>
    expect(json).toHaveLength(1)
    expect(json[0].examples).toEqual(['a', 'b'])
    expect(json[0].version).toBe(2)
  })

  it('GET versions returns history newest-first', async () => {
    const db = makeDb({
      all: (sql) => {
        if (sql.includes('ORDER BY version DESC')) {
          return [
            {
              id: 3,
              name: 'Person',
              definition: 'v3',
              examples_json: '[]',
              version: 3,
              is_current: 1,
              date_created: '2026-06-10',
            },
            {
              id: 1,
              name: 'Person',
              definition: 'v1',
              examples_json: '[]',
              version: 1,
              is_current: 0,
              date_created: '2026-06-09',
            },
          ]
        }
        return []
      },
    })
    const res = await request(db, 'GET', '/node-type/Person/versions')
    const json = await res.json() as Array<{ version: number; isCurrent: boolean }>
    expect(json.map((r) => r.version)).toEqual([3, 1])
    expect(json[0].isCurrent).toBe(true)
    expect(json[1].isCurrent).toBe(false)
  })
})

describe('edge-type routes', () => {
  it('POST creates a v1 row with reverse_name and examples', async () => {
    const db = makeDb({
      first: (sql) => {
        if (sql.startsWith('SELECT id FROM edge_type WHERE name')) return null
        if (sql.startsWith('INSERT INTO edge_type')) return { id: 7 }
        return null
      },
    })
    const res = await request(db, 'POST', '/edge-type', {
      name: 'defeated',
      reverseName: 'defeated by',
      definition: 'X overcame Y',
      examples: ['Sun Wukong defeated Red Boy'],
    })
    expect(res.status).toBe(201)
    const insert = getCalls(db).find((c) => c.sql.includes('INSERT INTO edge_type'))!
    expect(insert.args[0]).toBe('defeated')
    expect(insert.args[1]).toBe('defeated by')
    expect(insert.args[3]).toBe('["Sun Wukong defeated Red Boy"]')
  })

  it('PUT bumps version and preserves examples_json by default', async () => {
    const db = makeDb({
      first: (sql) => {
        if (sql.includes('WHERE id = ? AND is_current = 1')) {
          return {
            id: 8,
            name: 'defeated',
            reverse_name: 'defeated by',
            definition: 'old',
            examples_json: '["a"]',
            version: 1,
          }
        }
        if (sql.startsWith('INSERT INTO edge_type')) return { id: 9 }
        return null
      },
    })
    const res = await request(db, 'PUT', '/edge-type/8', { definition: 'new' })
    expect(res.status).toBe(200)
    const insert = getCalls(db).find((c) => c.sql.startsWith('INSERT INTO edge_type'))!
    expect(insert.args[2]).toBe('new')
    expect(insert.args[3]).toBe('["a"]')
    expect(insert.args[4]).toBe(2)
  })

  it('PUT rejects name changes', async () => {
    const db = makeDb({
      first: (sql) => {
        if (sql.includes('WHERE id = ? AND is_current = 1')) {
          return {
            id: 8,
            name: 'defeated',
            reverse_name: null,
            definition: 'x',
            examples_json: '[]',
            version: 1,
          }
        }
        return null
      },
    })
    const res = await request(db, 'PUT', '/edge-type/8', {
      name: 'beat',
      definition: 'y',
    })
    expect(res.status).toBe(400)
  })
})

// Silence the "vi not used" warning if no spies present
void vi
