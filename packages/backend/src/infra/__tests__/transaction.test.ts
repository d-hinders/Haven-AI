import { describe, expect, it, vi } from 'vitest'
import { withTransaction, type Executor } from '../transaction.js'

/**
 * `withTransaction` is now shared by every repository (#985), so its two
 * behaviours are contract, not implementation detail: a normal return COMMITs,
 * a throw ROLLBACKs, and the connection is released either way.
 *
 * The rollback case is the one worth being strict about. A helper that
 * swallowed the error, or committed on the way out, would convert a failed
 * multi-statement write into a persisted half-write — the failure repositories
 * exist to make impossible.
 */
function poolDouble() {
  const statements: string[] = []
  const release = vi.fn()
  const client = {
    query: vi.fn(async (sql: string) => {
      statements.push(sql)
      return { rows: [], rowCount: 0 } as never
    }),
    release,
  }
  const pool = {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 }) as never),
    connect: vi.fn(async () => client),
  }
  return { pool: pool as unknown as Executor, statements, release, client }
}

describe('withTransaction', () => {
  it('commits and returns the callback result', async () => {
    const { pool, statements, release } = poolDouble()

    const result = await withTransaction(pool, async (tx) => {
      await tx.query('INSERT INTO t VALUES ($1)', [1])
      return 'done'
    })

    expect(result).toBe('done')
    expect(statements).toEqual(['BEGIN', 'INSERT INTO t VALUES ($1)', 'COMMIT'])
    expect(release).toHaveBeenCalledOnce()
  })

  it('rolls back and rethrows when the callback throws', async () => {
    const { pool, statements, release } = poolDouble()
    const boom = new Error('constraint violation')

    await expect(
      withTransaction(pool, async (tx) => {
        await tx.query('INSERT INTO t VALUES ($1)', [1])
        throw boom
      }),
    ).rejects.toBe(boom)

    expect(statements).toEqual(['BEGIN', 'INSERT INTO t VALUES ($1)', 'ROLLBACK'])
    expect(statements).not.toContain('COMMIT')
    expect(release).toHaveBeenCalledOnce()
  })

  it('still rethrows the original error when the ROLLBACK itself fails', async () => {
    const { pool, client, release } = poolDouble()
    const boom = new Error('original failure')
    client.query.mockImplementation(async (sql: string) => {
      if (sql === 'ROLLBACK') throw new Error('connection already gone')
      return { rows: [], rowCount: 0 } as never
    })

    // The caller must see what actually went wrong, not the cleanup's failure.
    await expect(withTransaction(pool, async () => { throw boom })).rejects.toBe(boom)
    expect(release).toHaveBeenCalledOnce()
  })

  it('runs inline on an executor that is already a transaction client', async () => {
    // A caller composing repository functions inside its own transaction passes
    // the client through; a nested BEGIN would be a silent no-op savepoint-less
    // bug, so the helper must not issue one.
    const statements: string[] = []
    const tx = {
      query: async (sql: string) => {
        statements.push(sql)
        return { rows: [], rowCount: 0 }
      },
    } as unknown as Executor

    const result = await withTransaction(tx, async (inner) => {
      await inner.query('UPDATE t SET x = 1')
      return 42
    })

    expect(result).toBe(42)
    expect(statements).toEqual(['UPDATE t SET x = 1'])
  })

  it('MUTATION TARGET (#3450) — runs inline on a checked-out client that ALSO exposes `connect`, the real pg.PoolClient shape', async () => {
    // A real `pg.PoolClient` has BOTH `connect` (inherited from
    // `Client.prototype`) and `release`. Checking `connect` alone — the
    // pre-#3450 rule — would treat this as poolable and try to check out a
    // SECOND client from it, which real `pg` rejects with "Client has
    // already been connected." `release`'s presence is what must decide this,
    // not `connect`'s. See `infra/repositories/__tests__/agent-rekeys.test.ts`
    // for the same proof against a REAL `pg.PoolClient`.
    const statements: string[] = []
    const nestedConnect = vi.fn()
    const release = vi.fn()
    const alreadyCheckedOut = {
      query: async (sql: string) => {
        statements.push(sql)
        return { rows: [], rowCount: 0 }
      },
      // Present, exactly like `pg.PoolClient` — and must NOT be called.
      connect: nestedConnect,
      release,
    } as unknown as Executor

    const result = await withTransaction(alreadyCheckedOut, async (inner) => {
      await inner.query('UPDATE t SET x = 1')
      return 'ok'
    })

    expect(result).toBe('ok')
    expect(statements).toEqual(['UPDATE t SET x = 1'])
    expect(nestedConnect).not.toHaveBeenCalled()
    // This executor's OWN release is the caller's job (it owns the client),
    // not `withTransaction`'s — running inline must not release out from
    // under the caller mid-composition.
    expect(release).not.toHaveBeenCalled()
  })
})
