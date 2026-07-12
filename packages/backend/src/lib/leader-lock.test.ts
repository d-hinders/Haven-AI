import { describe, expect, it, vi } from 'vitest'
import { runIfLeader, LEADER_LOCK_KEYS, type PoolLike } from './leader-lock.js'

function fakePool(locked: boolean) {
  const query = vi.fn((sql: string) => {
    if (/pg_try_advisory_lock/.test(sql)) {
      return Promise.resolve({ rows: [{ locked }] })
    }
    return Promise.resolve({ rows: [] })
  })
  const release = vi.fn()
  const pool: PoolLike = {
    connect: async () => ({ query, release }),
  }
  return { pool, query, release }
}

describe('runIfLeader', () => {
  it('runs the tick and unlocks when the lock is won', async () => {
    const { pool, query, release } = fakePool(true)
    const fn = vi.fn(async () => {})

    const ran = await runIfLeader(LEADER_LOCK_KEYS.catalogRefresh, fn, pool)

    expect(ran).toBe(true)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(query.mock.calls.some(([sql]) => /pg_advisory_unlock/.test(sql as string))).toBe(true)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('skips the tick when another replica holds the lock', async () => {
    const { pool, query, release } = fakePool(false)
    const fn = vi.fn(async () => {})

    const ran = await runIfLeader(LEADER_LOCK_KEYS.delegateBalanceMonitor, fn, pool)

    expect(ran).toBe(false)
    expect(fn).not.toHaveBeenCalled()
    // Never unlock a lock we did not win.
    expect(query.mock.calls.some(([sql]) => /pg_advisory_unlock/.test(sql as string))).toBe(false)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('unlocks and releases even when the tick throws', async () => {
    const { pool, query, release } = fakePool(true)

    await expect(
      runIfLeader(LEADER_LOCK_KEYS.delegateBalanceMonitor, async () => {
        throw new Error('scan failed')
      }, pool),
    ).rejects.toThrow('scan failed')

    expect(query.mock.calls.some(([sql]) => /pg_advisory_unlock/.test(sql as string))).toBe(true)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('destroys the connection when the unlock itself fails, so the lock cannot leak into the pool', async () => {
    const query = vi.fn((sql: string) => {
      if (/pg_try_advisory_lock/.test(sql)) return Promise.resolve({ rows: [{ locked: true }] })
      if (/pg_advisory_unlock/.test(sql)) return Promise.reject(new Error('statement cancelled'))
      return Promise.resolve({ rows: [] })
    })
    const release = vi.fn()
    const pool: PoolLike = { connect: async () => ({ query, release }) }

    const ran = await runIfLeader(LEADER_LOCK_KEYS.catalogRefresh, async () => {}, pool)

    expect(ran).toBe(true)
    // A truthy release argument tells pg to destroy the session — Postgres
    // then frees the advisory lock on disconnect.
    expect(release).toHaveBeenCalledWith(true)
  })

  it('uses distinct keys per monitor', () => {
    const values = Object.values(LEADER_LOCK_KEYS)
    expect(new Set(values).size).toBe(values.length)
  })
})
