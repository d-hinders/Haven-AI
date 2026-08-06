import { describe, expect, it, vi } from 'vitest'
import { withTransaction, type Executor } from '../db.js'

// #985: the promoted transaction primitive — commit, rollback-on-throw, and
// the pass-through for callers already inside a transaction.
describe('withTransaction', () => {
  function connectablePool() {
    const calls: string[] = []
    const client = {
      query: vi.fn(async (sql: string) => {
        calls.push(sql)
        return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] }
      }),
      release: vi.fn(),
    }
    const pool = {
      query: vi.fn(),
      connect: async () => client,
    } as unknown as Executor
    return { pool, client, calls }
  }

  it('BEGIN/COMMIT run on ONE dedicated client, and it is released', async () => {
    const { pool, client, calls } = connectablePool()
    const result = await withTransaction(pool, async (tx) => {
      await tx.query('INSERT 1')
      return 'done'
    })
    expect(result).toBe('done')
    expect(calls).toEqual(['BEGIN', 'INSERT 1', 'COMMIT'])
    expect(client.release).toHaveBeenCalledOnce()
  })

  it('a throw ROLLS BACK, releases, and rethrows — no partial state', async () => {
    const { pool, client, calls } = connectablePool()
    await expect(
      withTransaction(pool, async (tx) => {
        await tx.query('INSERT 1')
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(calls).toEqual(['BEGIN', 'INSERT 1', 'ROLLBACK'])
    expect(client.release).toHaveBeenCalledOnce()
  })

  it('an executor without connect() (already a tx client) runs fn inline', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] }))
    const txClient = { query } as unknown as Executor
    const result = await withTransaction(txClient, async (tx) => {
      await tx.query('INSERT 1')
      return 42
    })
    expect(result).toBe(42)
    // No BEGIN/COMMIT issued — the outer owner controls the transaction.
    expect(query).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledWith('INSERT 1')
  })
})
