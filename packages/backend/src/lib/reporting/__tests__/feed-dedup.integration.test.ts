import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Integrated "never double-post" guard for the reporting feed (#491/#497/#499).
 *
 * The sibling unit tests mock the seam they care about — `feed-orchestrator`
 * mocks `feed-sync`, and `feed-sync` pre-scripts the DB's conflict outcomes — so
 * neither exercises the real dedup mechanism reacting to its OWN prior write.
 * This test runs the real `claimSync` / `markPushed` / `markFailed` and the real
 * orchestrator against an in-memory oracle of the `reporting_feed_syncs` unique
 * constraint, then feeds the same payment repeatedly.
 *
 * What it guards (that the boundary-mocked unit tests can't): the end-to-end
 * lifecycle wiring — that re-syncs/backfills/retries of one payment produce
 * exactly one connector push, that ownership short-circuits before the push, and
 * that the row converges to `pushed`. This catches control-flow regressions
 * (push before/without a claim, ignoring `claim.owned`, never recording the
 * push) and argument-order drift between the real functions.
 *
 * What it does NOT guard: the oracle models the *intended* dedup key
 * (provider, payment_id, user_id), so a SQL-text-only change to the ON CONFLICT
 * columns or the unique index would not be caught here — that is the unit test's
 * job (`feed-sync.test.ts` asserts the claim SQL) and ultimately the migration's.
 */

// ── Oracle: in-memory model of the reporting_feed_syncs table ────────────────
// Enforces uniqueness on (provider, payment_id, user_id) — the same key as the
// migration and the ON CONFLICT target — by interpreting the exact SQL that
// feed-sync.ts issues. Reads the real query shapes; it is not a generic SQL
// engine, so an unrecognised statement fails loudly rather than silently.
const { ledger } = vi.hoisted(() => {
  interface Row {
    id: string
    user_id: string
    provider: string
    payment_id: string
    status: string
    external_ref: string | null
    error: string | null
    attempts: number
  }
  const rows = new Map<string, Row>()
  const key = (provider: string, paymentId: string, userId: string) =>
    `${provider}::${paymentId}::${userId}`

  async function query(sql: unknown, params: unknown[] = []) {
    const s = String(sql)
    if (s.includes('INSERT INTO reporting_feed_syncs')) {
      const [userId, provider, paymentId] = params as string[]
      const k = key(provider, paymentId, userId)
      if (rows.has(k)) return { rows: [] } // ON CONFLICT DO NOTHING — first writer won
      rows.set(k, {
        id: k, user_id: userId, provider, payment_id: paymentId,
        status: 'pending', external_ref: null, error: null, attempts: 1,
      })
      return { rows: [{ id: k }] }
    }
    if (s.includes("SET status = 'pending'")) { // re-claim a previously failed row
      const [userId, provider, paymentId] = params as string[]
      const row = rows.get(key(provider, paymentId, userId))
      if (row && row.status === 'failed') {
        row.status = 'pending'; row.attempts += 1; row.error = null
        return { rows: [{ id: row.id }] }
      }
      return { rows: [] }
    }
    if (s.includes("SET status = 'pushed'")) {
      const [userId, provider, paymentId, externalRef] = params as (string | null)[]
      const row = rows.get(key(provider as string, paymentId as string, userId as string))
      if (row) { row.status = 'pushed'; row.external_ref = (externalRef ?? null) as string | null; row.error = null }
      return { rows: [] }
    }
    if (s.includes("SET status = 'failed'")) {
      const [userId, provider, paymentId, error] = params as string[]
      const row = rows.get(key(provider, paymentId, userId))
      if (row) { row.status = 'failed'; row.error = error }
      return { rows: [] }
    }
    if (s.includes('ORDER BY updated_at')) { // listSyncs
      const [userId] = params as string[]
      return { rows: [...rows.values()].filter((r) => r.user_id === userId) }
    }
    if (s.includes('SELECT * FROM reporting_feed_syncs')) { // getSyncState
      const [userId, provider, paymentId] = params as string[]
      const row = rows.get(key(provider, paymentId, userId))
      return { rows: row ? [row] : [] }
    }
    throw new Error(`feed-dedup oracle: unexpected SQL: ${s.slice(0, 80)}`)
  }

  return { ledger: { query, rows } }
})

vi.mock('../../../db.js', () => ({ default: { query: ledger.query } }))

const { mocks } = vi.hoisted(() => ({
  mocks: {
    reportingFeedAvailable: vi.fn(),
    buildAccountingEntryForPayment: vi.fn(),
  },
}))
vi.mock('../../entitlements.js', () => ({ reportingFeedAvailable: mocks.reportingFeedAvailable }))
vi.mock('../../accounting-entry.js', () => ({ buildAccountingEntryForPayment: mocks.buildAccountingEntryForPayment }))

import { feedSettledPayment } from '../feed-orchestrator.js'
import { claimSync, markFailed, getSyncState } from '../feed-sync.js'
import { registerConnector, clearConnectors, InMemoryConnector } from '../connector.js'

const USER = 'u1'
const PID = 'pi1'
const PROVIDER = 'memory' // InMemoryConnector.provider

function entry(amountSek: string | null = '132.50') {
  return {
    paymentId: PID, settledAt: '2026-06-20', direction: 'out',
    counterparty: { address: '0xm', name: 'M' }, resourceUrl: 'r', token: 'USDC',
    amountAtomic: '1', amountSek, fxRate: '10', fxSource: 's', fxAt: 't',
    receiptRef: 'ev', account: null,
  }
}

function connectInMemory(): InMemoryConnector {
  const c = new InMemoryConnector()
  c.connect(USER)
  registerConnector(c)
  return c
}

describe('reporting feed — integrated never-double-post guard', () => {
  beforeEach(() => {
    ledger.rows.clear()
    clearConnectors()
    mocks.reportingFeedAvailable.mockReset().mockResolvedValue(true)
    mocks.buildAccountingEntryForPayment.mockReset().mockResolvedValue(entry())
  })

  it('feeds the same settled payment twice but pushes exactly once', async () => {
    const c = connectInMemory()

    await feedSettledPayment(USER, PID)
    await feedSettledPayment(USER, PID) // re-sync / backfill of the same payment

    expect(c.pushed).toHaveLength(1)
    expect((await getSyncState(USER, PROVIDER, PID))?.status).toBe('pushed')
  })

  it('lets exactly one of two racing claims own the push', async () => {
    const a = await claimSync(USER, PROVIDER, PID)
    const b = await claimSync(USER, PROVIDER, PID) // concurrent caller, before any push

    expect([a.owned, b.owned].filter(Boolean)).toHaveLength(1)
    expect(a.owned).toBe(true)
    expect(b).toEqual({ owned: false, status: 'pending' })
  })

  it('retries a previously failed payment and still pushes exactly once (resumable)', async () => {
    // A prior attempt claimed then failed (e.g. the connector was down).
    await claimSync(USER, PROVIDER, PID)
    await markFailed(USER, PROVIDER, PID, 'connector down')

    const c = connectInMemory()
    await feedSettledPayment(USER, PID) // recovery sync
    await feedSettledPayment(USER, PID) // and a redundant re-sync after recovery

    expect(c.pushed).toHaveLength(1)
    const state = await getSyncState(USER, PROVIDER, PID)
    expect(state?.status).toBe('pushed')
    expect(state?.attempts).toBe(2) // original claim + one retry, never re-claimed after push
  })
})
