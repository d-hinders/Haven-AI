/**
 * `/ops/search` key detection and its time budget (#3512). The SQL itself is
 * proven on a real Postgres in `infra/repositories/__tests__/ops-reads.test.ts`;
 * here a fake executor stands in so slow and cancelled statements can be
 * staged exactly.
 */
import { describe, expect, it } from 'vitest'
import type { Executor, QueryRow } from '../../../infra/transaction.js'
import { detectOpsSearchKey, runOpsSearch } from '../search.js'

const UUID = '3f2b8c1e-1a2b-4c3d-8e9f-0123456789ab'
const ADDRESS = `0x${'Ab'.repeat(20)}`
const TX = `0x${'cd'.repeat(32)}`

describe('detectOpsSearchKey', () => {
  it('detects a UUID, an address and a tx hash, lowercased', () => {
    expect(detectOpsSearchKey(` ${UUID.toUpperCase()} `)).toEqual({ keyType: 'uuid', value: UUID })
    expect(detectOpsSearchKey(ADDRESS)).toEqual({ keyType: 'address', value: ADDRESS.toLowerCase() })
    expect(detectOpsSearchKey(TX)).toEqual({ keyType: 'tx_hash', value: TX })
  })

  it('treats anything else as an email prefix of at least 3 characters', () => {
    expect(detectOpsSearchKey('ada')).toEqual({ keyType: 'email', value: 'ada' })
    expect(detectOpsSearchKey('ada@customer.example')).toEqual({ keyType: 'email', value: 'ada@customer.example' })
    expect(detectOpsSearchKey(' ad ')).toEqual({ error: 'An email search needs at least 3 characters' })
    expect(detectOpsSearchKey('0x12')).toEqual({ keyType: 'email', value: '0x12' })
  })
})

/** A fake executor: each SQL fragment maps to a behaviour; every call is recorded. */
function fakeDb(behaviour: (sql: string) => Promise<QueryRow[]>): { db: Executor; calls: string[] } {
  const calls: string[] = []
  const db: Executor = {
    async query<R extends QueryRow = QueryRow>(sql: string) {
      calls.push(sql)
      return { rows: (await behaviour(sql)) as R[], rowCount: 0 }
    },
  }
  return { db, calls }
}

const userRow = { id: UUID, email: 'ada@customer.example', created_at: new Date('2026-01-01T00:00:00Z') }

describe('runOpsSearch', () => {
  it('runs the lookups one at a time and masks emails', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const { db, calls } = fakeDb(async (sql) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return /FROM users/.test(sql) ? [userRow] : []
    })
    const result = await runOpsSearch(db, { keyType: 'uuid', value: UUID })
    expect(calls).toHaveLength(3)
    expect(maxInFlight).toBe(1)
    expect(result).toEqual({
      key_type: 'uuid',
      hits: [{ kind: 'user', id: UUID, email: 'ad•••@customer.example', created_at: '2026-01-01T00:00:00.000Z' }],
      timed_out: [],
    })
  })

  it('returns the partial hits and the unfinished lookups when the budget runs out, and starts nothing after', async () => {
    const { db, calls } = fakeDb(async (sql) => {
      if (/FROM users/.test(sql)) return [userRow]
      return new Promise(() => {}) // the agents lookup never answers
    })
    const result = await runOpsSearch(db, { keyType: 'uuid', value: UUID }, { budgetMs: 30 })
    expect(result.hits).toHaveLength(1)
    expect(result.timed_out).toEqual(['agents', 'payment_intents'])
    expect(calls).toHaveLength(2) // payment_intents never started
  })

  it('treats a Postgres statement timeout (57014) as timed out, and rethrows anything else', async () => {
    const cancelled = fakeDb(async (sql) => {
      if (/FROM smart_accounts/.test(sql)) throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
      return []
    })
    const result = await runOpsSearch(cancelled.db, { keyType: 'address', value: ADDRESS.toLowerCase() })
    expect(result.timed_out).toEqual(['smart_accounts', 'agents'])

    const broken = fakeDb(async () => {
      throw Object.assign(new Error('permission denied'), { code: '42501' })
    })
    await expect(runOpsSearch(broken.db, { keyType: 'tx_hash', value: TX })).rejects.toThrow('permission denied')
  })

  it('a budget already spent runs no lookup at all', async () => {
    let t = 0
    const { db, calls } = fakeDb(async () => [])
    const result = await runOpsSearch(db, { keyType: 'tx_hash', value: TX }, { budgetMs: 10, now: () => (t += 20) })
    expect(calls).toEqual([])
    expect(result.timed_out).toEqual(['payment_intents', 'system_txs'])
  })
})
