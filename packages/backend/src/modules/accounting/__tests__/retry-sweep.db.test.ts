/**
 * The retry sweep on the REAL database (#2866, epic #2858).
 *
 * The acceptance claims that only real rows, the real due-rows query and the
 * real orchestrator can make — the clock is injected (`now`), so no backoff
 * is ever waited for, and the pacer's `sleep` is a recorder:
 *
 *   1. a `failed` row with attempts 1 is retried after its backoff and NOT
 *      before (mutation target: the backoff predicate in
 *      `LIST_DUE_RETRY_SYNCS_SQL`);
 *   2. a row at the attempt cap is not retried; a row that reaches the cap
 *      through the sweep stays `failed` with the `exhausted:` reason
 *      (mutation targets: `attempts < $2` in the query, the cap branch in
 *      `runRetrySweep`);
 *   3. a provider 429 defers the remaining rows of that connection without
 *      incrementing their attempts (mutation target: the `break` on a
 *      rate-limited outcome);
 *   4. rows for a `needs_reauthorisation` connection are not touched
 *      (mutation target: `c.status = 'connected'` in the query);
 *   5. a stale `pending` claim is released and re-fed.
 *
 * Only the entitlement gate and the entry builder are stubbed, with
 * `mockImplementation` — never the one-shot form `lint:db-mocks` counts.
 */
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: { accountingFeedAvailable: vi.fn(async () => true), buildAccountingEntryForPayment: vi.fn() },
}))
vi.mock('../../agents/index.js', () => ({ accountingFeedAvailable: mocks.accountingFeedAvailable }))
vi.mock('../entry.js', () => ({ buildAccountingEntryForPayment: mocks.buildAccountingEntryForPayment }))
vi.mock('../../../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../config.js')>()
  return { ...actual, config: { ...actual.config, accountingEnabled: true } }
})

import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { setStatus, upsertConnection } from '../../../infra/repositories/accounting-connections.js'
import {
  getSyncState,
  markExhausted, countSyncsForUser,
  retryBackoffMs,
  RETRY_MAX_ATTEMPTS,
  STALE_PENDING_CLAIM_MS,
} from '../../../infra/repositories/accounting-feed-syncs.js'
import { InMemoryConnector, clearConnectors, registerConnector } from '../connector.js'
import type { FeedTransaction } from '../feed-transaction.js'
import { ProviderError } from '../provider.js'
import { EXHAUSTED_PREFIX, resetRetrySweepState, runRetrySweep } from '../retry-sweep.js'
import { accountingEntry } from './connector-conformance.js'

// Anchored to the wall clock: the orchestrator stamps `updated_at = NOW()`
// with Postgres's clock, so a fixed date would put the sweep's injected
// clock behind every row it touched.
const NOW = new Date()
const at = (offsetMs: number) => () => new Date(NOW.getTime() + offsetMs)

/** The in-memory connector with two knobs: payment ids that answer 429, and ids that answer 500. */
class RateLimitingConnector extends InMemoryConnector {
  readonly rateLimited = new Set<string>()
  readonly failing = new Set<string>()
  readonly attempted: string[] = []
  override async pushTransaction(userId: string, tx: FeedTransaction) {
    this.attempted.push(tx.paymentId)
    if (this.rateLimited.has(tx.paymentId)) {
      throw new ProviderError('memory request failed (HTTP 429)', 429, 'memory')
    }
    if (this.failing.has(tx.paymentId)) {
      throw new ProviderError('memory request failed (HTTP 500)', 500, 'memory')
    }
    return super.pushTransaction(userId, tx)
  }
}

let seq = 0

async function seedUser(): Promise<string> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`sweep-${++seq}-${Date.now()}@test.example`],
  )
  return user.rows[0].id
}

/** A connected, active `memory` destination row for the user. */
async function seedConnection(userId: string): Promise<void> {
  await upsertConnection(userId, {
    provider: 'memory', authKind: 'api_key', secretsCiphertext: Buffer.from('{}'), secretsKeyVersion: 0,
    grantedScope: null, tokenExpiresAt: null,
  })
}

async function seedSync(
  userId: string, paymentId: string, status: 'failed' | 'skipped' | 'pending' | 'pushed', attempts: number, agoMs: number,
): Promise<void> {
  await db.query(
    `INSERT INTO accounting_feed_syncs (user_id, provider, payment_id, status, attempts, error, updated_at)
     VALUES ($1, 'memory', $2, $3, $4, 'push_failed', $5::timestamptz - ($6::float8 * interval '1 millisecond'))`,
    [userId, paymentId, status, attempts, NOW, agoMs],
  )
}

async function row(userId: string, paymentId: string) {
  return (await getSyncState(userId, 'memory', paymentId))!
}

describeDb('accounting retry sweep on the real ledger (#2866)', () => {
  let connector: RateLimitingConnector
  const sleeps: number[] = []

  beforeAll(initDbHarness)
  beforeEach(async () => {
    await resetDb()
    resetRetrySweepState()
    clearConnectors()
    sleeps.length = 0
    connector = new RateLimitingConnector()
    registerConnector(connector)
    mocks.accountingFeedAvailable.mockReset().mockResolvedValue(true)
    mocks.buildAccountingEntryForPayment.mockReset().mockImplementation(async (_u: string, paymentId: string) => accountingEntry(paymentId))
  })
  afterEach(() => {
    clearConnectors()
  })

  const sweep = (now: () => Date) => runRetrySweep({ now, sleep: async (ms) => { sleeps.push(ms) } })

  it('a failed row with attempts 1 is retried after its backoff and not before', async () => {
    const userId = await seedUser()
    await seedConnection(userId)
    connector.connect(userId)
    // Failed 30 s ago: the first step is 60 s.
    await seedSync(userId, 'pay-1', 'failed', 1, 30_000)

    const early = await sweep(at(0))
    expect(early).toMatchObject({ considered: 0, pushed: 0 })
    expect(connector.attempted).toEqual([])
    expect(await row(userId, 'pay-1')).toMatchObject({ status: 'failed', attempts: 1 })

    const later = await sweep(at(30_000))
    expect(later).toMatchObject({ considered: 1, pushed: 1, connections: 1 })
    expect(connector.attempted).toEqual(['pay-1'])
    expect(await row(userId, 'pay-1')).toMatchObject({ status: 'pushed', attempts: 2, external_ref: 'memory:invoice:1' })
    // Pushed is final: a further sweep finds nothing.
    expect(await sweep(at(24 * 60 * 60_000))).toMatchObject({ considered: 0 })
  })

  it('a row at the attempt cap is not retried; the attempt that reaches the cap leaves the terminal exhausted: reason', async () => {
    const userId = await seedUser()
    await seedConnection(userId)
    connector.connect(userId)
    // The provider keeps failing (a 500 — NOT a 429, which is the deferral
    // path): each retry is a real, re-claimable attempt.
    connector.failing.add('pay-capped').add('pay-last')
    await seedSync(userId, 'pay-capped', 'failed', RETRY_MAX_ATTEMPTS, 7 * 24 * 60 * 60_000)
    await seedSync(userId, 'pay-last', 'failed', RETRY_MAX_ATTEMPTS - 1, 7 * 24 * 60 * 60_000)

    const result = await sweep(at(0))
    expect(result).toMatchObject({ considered: 1, exhausted: 1, pushed: 0, failed: 0 })
    expect(connector.attempted).toEqual(['pay-last'])

    const capped = await row(userId, 'pay-capped')
    expect(capped).toMatchObject({ status: 'failed', attempts: RETRY_MAX_ATTEMPTS, error: 'push_failed' })

    const last = await row(userId, 'pay-last')
    expect(last.status).toBe('failed')
    expect(last.attempts).toBe(RETRY_MAX_ATTEMPTS)
    expect(last.error).toBe(`${EXHAUSTED_PREFIX} memory request failed (HTTP 500)`)
    expect(last.error!.startsWith(EXHAUSTED_PREFIX)).toBe(true)

    // Terminal for the sweep: neither is due again, ever.
    expect(await sweep(at(365 * 24 * 60 * 60_000))).toMatchObject({ considered: 0 })
    expect(await countSyncsForUser(userId)).toEqual({ pending: 0, failed: 0, exhausted: 2 })
  })

  it('the terminal write is guarded: a row a manual sync re-claimed (pending) or pushed meanwhile is left alone (review on #2899)', async () => {
    const userId = await seedUser()
    await seedConnection(userId)
    // A row that LOOKS exhausted to the sweep's bookkeeping but has since
    // been re-claimed by "Sync now" (pending) — and one that was pushed.
    await seedSync(userId, 'pay-pending', 'pending', RETRY_MAX_ATTEMPTS, 60_000)
    await seedSync(userId, 'pay-pushed', 'pushed', RETRY_MAX_ATTEMPTS, 60_000)
    // MUTATION TARGET: the unguarded MARK_SYNC_FAILED_SQL would flip both to failed.
    expect(await markExhausted(userId, 'memory', 'pay-pending', `${EXHAUSTED_PREFIX} x`)).toBe(false)
    expect(await markExhausted(userId, 'memory', 'pay-pushed', `${EXHAUSTED_PREFIX} x`)).toBe(false)
    expect((await row(userId, 'pay-pending')).status).toBe('pending')
    expect((await row(userId, 'pay-pushed')).status).toBe('pushed')
    // And a failed row below the cap is not "exhausted" either.
    await seedSync(userId, 'pay-low', 'failed', 2, 60_000)
    expect(await markExhausted(userId, 'memory', 'pay-low', `${EXHAUSTED_PREFIX} x`)).toBe(false)
    expect((await row(userId, 'pay-low')).error).not.toContain(EXHAUSTED_PREFIX)
  })

  it('a 429 defers the remaining rows of that connection without incrementing their attempts; the next tick retries them', async () => {
    const userId = await seedUser()
    await seedConnection(userId)
    connector.connect(userId)
    // Oldest first: pay-a is retried, hits the limit; pay-b and pay-c must
    // be left exactly as they are.
    await seedSync(userId, 'pay-a', 'failed', 2, 10 * 60_000)
    await seedSync(userId, 'pay-b', 'failed', 3, 9 * 60_000)
    await seedSync(userId, 'pay-c', 'skipped', 1, 8 * 60_000)
    connector.rateLimited.add('pay-a')

    // A second tenant behind the same tick is NOT deferred by the first's 429.
    const other = await seedUser()
    await seedConnection(other)
    connector.connect(other)
    await seedSync(other, 'pay-o', 'failed', 1, 5 * 60_000)

    const result = await sweep(at(0))
    expect(result).toMatchObject({ considered: 4, connections: 2, rateLimited: 1, deferred: 2, failed: 1, pushed: 1 })
    // Tenant order is by user id (random uuids) — what matters is that only
    // the first row of the limited tenant and the other tenant's row ran.
    expect([...connector.attempted].sort()).toEqual(['pay-a', 'pay-o'])

    expect(await row(userId, 'pay-a')).toMatchObject({ status: 'failed', attempts: 3 })
    expect((await row(userId, 'pay-a')).error).toMatch(/HTTP 429/)
    // MUTATION TARGET: untouched — same status, same attempts, same reason.
    expect(await row(userId, 'pay-b')).toMatchObject({ status: 'failed', attempts: 3, error: 'push_failed' })
    expect(await row(userId, 'pay-c')).toMatchObject({ status: 'skipped', attempts: 1, error: 'push_failed' })
    expect(await row(other, 'pay-o')).toMatchObject({ status: 'pushed' })

    // Next tick, limit gone: the deferred rows go through (and pay-a, past
    // its own 4 min backoff from the failure the orchestrator stamped).
    connector.rateLimited.clear()
    const next = await sweep(at(10 * 60_000))
    expect(next).toMatchObject({ considered: 3, pushed: 3, deferred: 0 })
    expect(await row(userId, 'pay-b')).toMatchObject({ status: 'pushed', attempts: 4 })
    expect(await row(userId, 'pay-c')).toMatchObject({ status: 'pushed', attempts: 2 })
  })

  it('rows for a needs_reauthorisation connection are not touched', async () => {
    const userId = await seedUser()
    await seedConnection(userId)
    connector.connect(userId)
    await setStatus(userId, 'memory', 'needs_reauthorisation', 'refresh refused: invalid_grant')
    await seedSync(userId, 'pay-dead', 'skipped', 1, 24 * 60 * 60_000)

    expect(await sweep(at(0))).toMatchObject({ considered: 0 })
    expect(connector.attempted).toEqual([])
    expect(await row(userId, 'pay-dead')).toMatchObject({ status: 'skipped', attempts: 1, error: 'push_failed' })

    // The user re-consents: the row is `connected` again and the sweep feeds it.
    await seedConnection(userId)
    expect(await sweep(at(0))).toMatchObject({ considered: 1, pushed: 1 })
    expect(await row(userId, 'pay-dead')).toMatchObject({ status: 'pushed', attempts: 2 })
  })

  it('a stale pending claim is released (attempts untouched by the release) and re-fed', async () => {
    const userId = await seedUser()
    await seedConnection(userId)
    connector.connect(userId)
    await seedSync(userId, 'pay-stuck', 'pending', 2, STALE_PENDING_CLAIM_MS + 1_000)
    await seedSync(userId, 'pay-live', 'pending', 2, 1_000)

    const result = await sweep(at(0))
    expect(result).toMatchObject({ considered: 1, pushed: 1 })
    expect(connector.attempted).toEqual(['pay-stuck'])
    // Release did not count; the re-claim did: 2 → 3.
    expect(await row(userId, 'pay-stuck')).toMatchObject({ status: 'pushed', attempts: 3 })
    expect(await row(userId, 'pay-live')).toMatchObject({ status: 'pending', attempts: 2 })
  })

  it('a row whose FX is not ready is considered and no-ops without consuming an attempt', async () => {
    const userId = await seedUser()
    await seedConnection(userId)
    connector.connect(userId)
    mocks.buildAccountingEntryForPayment.mockImplementation(async (_u: string, paymentId: string) => ({
      ...accountingEntry(paymentId), amountSek: null,
    }))
    await seedSync(userId, 'pay-fx', 'failed', 1, retryBackoffMs(1))

    expect(await sweep(at(0))).toMatchObject({ considered: 1, skipped: 1, pushed: 0 })
    expect(connector.attempted).toEqual([])
    expect(await row(userId, 'pay-fx')).toMatchObject({ status: 'failed', attempts: 1 })
  })
})
