/**
 * Real-DB tests for the reporting-feed dedup ledger (#1365, epic #1219).
 *
 * The #1365 recovery semantics proven against Postgres on the #1220 harness,
 * zero mocks: a connector skip is a real `skipped` row with its reason, a
 * skipped row is re-claimable exactly like a failed one, and the
 * verification-gated reopen's row-state half flips ONLY a `pushed` row —
 * every other state refuses with nothing written (the double-post guard).
 * Each transition is exercised on both sides: the row that must move and
 * the row that must not.
 */
import { beforeAll, beforeEach, expect, it, vi } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import {
  claimSync,
  markPushed,
  markFailed,
  markSkipped,
  reopenMissingPushed,
  getSyncState,
  listSyncsForPaymentIds,
  listDueRetrySyncs,
  releaseStalePending,
  countSyncsForUser,
  retryBackoffMs,
  RETRY_MAX_ATTEMPTS,
  RETRY_BACKOFF_BASE_MS,
  RETRY_BACKOFF_CAP_MS,
  STALE_PENDING_CLAIM_MS,
} from '../accounting-feed-syncs.js'
import { upsertConnection, setStatus } from '../accounting-connections.js'

let seq = 0

async function seedUser(): Promise<string> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`feed-${++seq}-${Date.now()}@test.example`],
  )
  return user.rows[0].id
}

describeDb('accounting-feed-syncs repository (#1365)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  it('markSkipped writes a REAL skipped row with the reason preserved', async () => {
    const userId = await seedUser()
    await claimSync(userId, 'fortnox', 'pay-1')
    await markSkipped(userId, 'fortnox', 'pay-1', 'not_connected')

    const row = await getSyncState(userId, 'fortnox', 'pay-1')
    expect(row?.status).toBe('skipped')
    expect(row?.error).toBe('not_connected')
  })

  it('a skipped row is re-claimable exactly like a failed one; a pushed row is not', async () => {
    const userId = await seedUser()
    await claimSync(userId, 'fortnox', 'pay-1')
    await markSkipped(userId, 'fortnox', 'pay-1', 'not_connected')

    const reclaim = await claimSync(userId, 'fortnox', 'pay-1')
    expect(reclaim).toEqual({ owned: true, status: 'pending' })
    expect((await getSyncState(userId, 'fortnox', 'pay-1'))?.attempts).toBe(2)

    // The other side: a pushed row never re-claims.
    await markPushed(userId, 'fortnox', 'pay-1', 'fortnox:supplierinvoice:11')
    const afterPush = await claimSync(userId, 'fortnox', 'pay-1')
    expect(afterPush).toEqual({ owned: false, status: 'pushed' })
  })

  it('reopenMissingPushed flips pushed → failed (retryable) and records the reason', async () => {
    const userId = await seedUser()
    await claimSync(userId, 'fortnox', 'pay-1')
    await markPushed(userId, 'fortnox', 'pay-1', 'fortnox:supplierinvoice:11')

    expect(await reopenMissingPushed(userId, 'fortnox', 'pay-1', 'invoice 11 gone')).toBe(true)
    const row = await getSyncState(userId, 'fortnox', 'pay-1')
    expect(row?.status).toBe('failed')
    expect(row?.error).toBe('invoice 11 gone')

    // The reopened row is back in the normal retry path.
    const reclaim = await claimSync(userId, 'fortnox', 'pay-1')
    expect(reclaim).toEqual({ owned: true, status: 'pending' })
  })

  it('MUTATION PROOF: reopen refuses every non-pushed state — nothing written', async () => {
    // Dropping the status='pushed' predicate from REOPEN_PUSHED_SQL makes
    // these flips succeed — the double-post guard this test pins.
    const userId = await seedUser()
    await claimSync(userId, 'fortnox', 'pay-1') // pending
    expect(await reopenMissingPushed(userId, 'fortnox', 'pay-1', 'x')).toBe(false)
    expect((await getSyncState(userId, 'fortnox', 'pay-1'))?.status).toBe('pending')

    await markFailed(userId, 'fortnox', 'pay-1', 'boom') // failed
    expect(await reopenMissingPushed(userId, 'fortnox', 'pay-1', 'x')).toBe(false)
    expect((await getSyncState(userId, 'fortnox', 'pay-1'))?.error).toBe('boom')

    await markSkipped(userId, 'fortnox', 'pay-1', 'not_connected') // skipped
    expect(await reopenMissingPushed(userId, 'fortnox', 'pay-1', 'x')).toBe(false)

    // And it never crosses tenants or providers.
    const otherUser = await seedUser()
    await claimSync(userId, 'fortnox', 'pay-2')
    await markPushed(userId, 'fortnox', 'pay-2', 'fortnox:supplierinvoice:12')
    expect(await reopenMissingPushed(otherUser, 'fortnox', 'pay-2', 'x')).toBe(false)
    expect(await reopenMissingPushed(userId, 'other-provider', 'pay-2', 'x')).toBe(false)
    expect((await getSyncState(userId, 'fortnox', 'pay-2'))?.status).toBe('pushed')
  })

  // ── #2870: the per-page join behind the Transactions badge ──────────────

  it('listSyncsForPaymentIds returns one row per fed payment on the page, in ONE query', async () => {
    const userId = await seedUser()
    await claimSync(userId, 'fortnox', 'pay-1')
    await markPushed(userId, 'fortnox', 'pay-1', 'fortnox:supplierinvoice:11')
    await claimSync(userId, 'fortnox', 'pay-2')
    await markFailed(userId, 'fortnox', 'pay-2', 'timeout')
    // A third fed payment that is NOT on the page must not come back.
    await claimSync(userId, 'fortnox', 'pay-3')

    const querySpy = vi.spyOn(db, 'query')
    const rows = await listSyncsForPaymentIds(userId, ['pay-1', 'pay-2', 'pay-unfed'])
    expect(querySpy).toHaveBeenCalledTimes(1)
    querySpy.mockRestore()

    expect(rows.map((r) => r.payment_id).sort()).toEqual(['pay-1', 'pay-2'])
    expect(rows.find((r) => r.payment_id === 'pay-1')).toEqual({
      provider: 'fortnox',
      payment_id: 'pay-1',
      status: 'pushed',
      external_ref: 'fortnox:supplierinvoice:11',
      error: null,
    })
    expect(rows.find((r) => r.payment_id === 'pay-2')).toMatchObject({
      status: 'failed',
      external_ref: null,
      error: 'timeout',
    })
  })

  it('MUTATION PROOF: listSyncsForPaymentIds never crosses tenants', async () => {
    // Dropping the `user_id = $1` predicate from LIST_SYNCS_FOR_PAYMENT_IDS_SQL
    // makes the other tenant's row for the SAME payment id come back here.
    const userId = await seedUser()
    const otherUser = await seedUser()
    await claimSync(otherUser, 'fortnox', 'pay-shared')
    await markPushed(otherUser, 'fortnox', 'pay-shared', 'fortnox:supplierinvoice:99')

    expect(await listSyncsForPaymentIds(userId, ['pay-shared'])).toEqual([])

    // The other side: the owner still sees it.
    const own = await listSyncsForPaymentIds(otherUser, ['pay-shared'])
    expect(own.map((r) => r.payment_id)).toEqual(['pay-shared'])
  })

  it('listSyncsForPaymentIds with no payment ids never touches the pool', async () => {
    const userId = await seedUser()
    const querySpy = vi.spyOn(db, 'query')
    expect(await listSyncsForPaymentIds(userId, [])).toEqual([])
    expect(querySpy).not.toHaveBeenCalled()
    querySpy.mockRestore()
  })

  // ── #2866: the retry sweep's due-rows selection ─────────────────────────
  //
  // The clock is INJECTED (`now`) and the rows' `updated_at` is set directly,
  // so every backoff edge is exercised without a sleep. `attempts` is set
  // directly too — the curve is a function of the column, not of how the
  // row got there.

  async function seedConnected(userId: string, provider = 'fortnox'): Promise<void> {
    await upsertConnection(userId, {
      provider, authKind: 'oauth2', secretsCiphertext: Buffer.from('{}'), secretsKeyVersion: 0,
      grantedScope: null, tokenExpiresAt: null,
    })
  }

  /** A sync row in `status` with `attempts`, last touched `agoMs` before `now`. */
  async function seedSync(
    userId: string, paymentId: string, status: 'failed' | 'skipped' | 'pending' | 'pushed', attempts: number, agoMs: number, now: Date, provider = 'fortnox',
  ): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO accounting_feed_syncs (user_id, provider, payment_id, status, attempts, error, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'boom', $6::timestamptz - ($7::float8 * interval '1 millisecond')) RETURNING id`,
      [userId, provider, paymentId, status, attempts, now, agoMs],
    )
    return r.rows[0].id
  }

  const NOW = new Date('2026-09-11T12:00:00.000Z')

  it('retryBackoffMs is the documented curve: 1 min doubling to the 1 h cap', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(retryBackoffMs)).toEqual([
      60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, RETRY_BACKOFF_CAP_MS, RETRY_BACKOFF_CAP_MS,
    ])
    expect(retryBackoffMs(0)).toBe(RETRY_BACKOFF_BASE_MS)
    expect(RETRY_MAX_ATTEMPTS).toBe(8)
  })

  it('a failed row with attempts 1 is due after its backoff and NOT before (mutation target: the backoff predicate)', async () => {
    const userId = await seedUser()
    await seedConnected(userId)
    // 1 s short of the first step: not due.
    await seedSync(userId, 'pay-early', 'failed', 1, retryBackoffMs(1) - 1_000, NOW)
    expect((await listDueRetrySyncs(NOW, 100)).map((r) => r.payment_id)).toEqual([])
    // Exactly the step later: due.
    expect((await listDueRetrySyncs(new Date(NOW.getTime() + 1_000), 100)).map((r) => r.payment_id)).toEqual(['pay-early'])
  })

  it('the curve is read off attempts: a row at attempts 4 waits 8 min, one at 7 waits the 1 h cap', async () => {
    const userId = await seedUser()
    await seedConnected(userId)
    await seedSync(userId, 'pay-4-early', 'failed', 4, 7 * 60_000, NOW)
    await seedSync(userId, 'pay-4-due', 'failed', 4, 8 * 60_000, NOW)
    await seedSync(userId, 'pay-7-early', 'skipped', 7, 59 * 60_000, NOW)
    await seedSync(userId, 'pay-7-due', 'skipped', 7, 60 * 60_000, NOW)
    expect((await listDueRetrySyncs(NOW, 100)).map((r) => r.payment_id).sort()).toEqual(['pay-4-due', 'pay-7-due'])
  })

  it('a row at the attempt cap is never due, however old (mutation target: attempts < cap)', async () => {
    const userId = await seedUser()
    await seedConnected(userId)
    await seedSync(userId, 'pay-capped', 'failed', RETRY_MAX_ATTEMPTS, 30 * 24 * 60 * 60_000, NOW)
    await seedSync(userId, 'pay-over', 'failed', RETRY_MAX_ATTEMPTS + 3, 30 * 24 * 60 * 60_000, NOW)
    // Positive control on the same clock: one under the cap IS due.
    await seedSync(userId, 'pay-under', 'failed', RETRY_MAX_ATTEMPTS - 1, 30 * 24 * 60 * 60_000, NOW)
    expect((await listDueRetrySyncs(NOW, 100)).map((r) => r.payment_id)).toEqual(['pay-under'])
  })

  it("rows for a needs_reauthorisation connection are not due, and become due once it is connected again (mutation target: c.status = 'connected')", async () => {
    const userId = await seedUser()
    await seedConnected(userId)
    await setStatus(userId, 'fortnox', 'needs_reauthorisation', 'refresh refused: invalid_grant')
    await seedSync(userId, 'pay-dead', 'skipped', 2, 24 * 60 * 60_000, NOW)
    expect(await listDueRetrySyncs(NOW, 100)).toEqual([])

    // The cause is gone: the user re-consented (upsert flips the row back).
    await seedConnected(userId)
    expect((await listDueRetrySyncs(NOW, 100)).map((r) => r.payment_id)).toEqual(['pay-dead'])

    // scope_missing / disconnected hold the row back the same way.
    await setStatus(userId, 'fortnox', 'scope_missing', 'attachments')
    expect(await listDueRetrySyncs(NOW, 100)).toEqual([])
  })

  it('a row whose provider is not the active destination is not due; a pushed row never is', async () => {
    const userId = await seedUser()
    await seedConnected(userId, 'fortnox') // active
    await seedConnected(userId, 'memory') // second row, NOT active
    await seedSync(userId, 'pay-other', 'failed', 1, 24 * 60 * 60_000, NOW, 'memory')
    await seedSync(userId, 'pay-pushed', 'pushed', 1, 24 * 60 * 60_000, NOW)
    await seedSync(userId, 'pay-noconn', 'failed', 1, 24 * 60 * 60_000, NOW, 'ghost')
    expect(await listDueRetrySyncs(NOW, 100)).toEqual([])
  })

  it('a stale pending claim is due after the claim timeout, not before, and releaseStalePending flips it without touching attempts', async () => {
    const userId = await seedUser()
    await seedConnected(userId)
    const fresh = await seedSync(userId, 'pay-inflight', 'pending', 3, STALE_PENDING_CLAIM_MS - 1_000, NOW)
    const stale = await seedSync(userId, 'pay-stale', 'pending', 3, STALE_PENDING_CLAIM_MS, NOW)
    const due = await listDueRetrySyncs(NOW, 100)
    expect(due.map((r) => r.payment_id)).toEqual(['pay-stale'])
    expect(due[0]).toMatchObject({ id: stale, status: 'pending', attempts: 3 })

    // The in-flight one is refused by the guarded release; the stale one flips.
    expect(await releaseStalePending(fresh, NOW, 'released')).toBe(false)
    expect(await releaseStalePending(stale, NOW, 'released')).toBe(true)
    const row = await getSyncState(userId, 'fortnox', 'pay-stale')
    expect(row).toMatchObject({ status: 'failed', attempts: 3, error: 'released' })
    // Idempotent: a second release finds nothing pending.
    expect(await releaseStalePending(stale, NOW, 'released')).toBe(false)
  })

  it('due rows come back grouped by connection, oldest first, and the limit bounds the batch', async () => {
    const userA = await seedUser()
    const userB = await seedUser()
    await seedConnected(userA)
    await seedConnected(userB)
    await seedSync(userA, 'a-newer', 'failed', 1, 2 * 60_000, NOW)
    await seedSync(userA, 'a-older', 'failed', 1, 3 * 60_000, NOW)
    await seedSync(userB, 'b-1', 'failed', 1, 2 * 60_000, NOW)
    const due = await listDueRetrySyncs(NOW, 100)
    const byUser = new Map<string, string[]>()
    for (const r of due) byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r.payment_id])
    expect(byUser.get(userA)).toEqual(['a-older', 'a-newer'])
    expect(byUser.get(userB)).toEqual(['b-1'])
    // Contiguous per user.
    const order = due.map((r) => r.user_id)
    expect(order.indexOf(userA) === order.lastIndexOf(userA) - 1).toBe(true)
    expect(await listDueRetrySyncs(NOW, 2)).toHaveLength(2)
  })

  it('countSyncsForUser: pending / retryable failed / exhausted, keyed on the same cap as the sweep, per tenant', async () => {
    const userId = await seedUser()
    const other = await seedUser()
    await seedSync(userId, 'p1', 'pending', 1, 0, NOW)
    await seedSync(userId, 'f1', 'failed', 1, 0, NOW)
    await seedSync(userId, 'f2', 'failed', RETRY_MAX_ATTEMPTS - 1, 0, NOW)
    await seedSync(userId, 'x1', 'failed', RETRY_MAX_ATTEMPTS, 0, NOW)
    await seedSync(userId, 'x2', 'failed', RETRY_MAX_ATTEMPTS + 5, 0, NOW)
    await seedSync(userId, 's1', 'skipped', 2, 0, NOW)
    await seedSync(userId, 'ok', 'pushed', 1, 0, NOW)
    await seedSync(other, 'f-other', 'failed', 1, 0, NOW)
    expect(await countSyncsForUser(userId)).toEqual({ pending: 1, failed: 2, exhausted: 2 })
    expect(await countSyncsForUser(other)).toEqual({ pending: 0, failed: 1, exhausted: 0 })
    expect(await countSyncsForUser(await seedUser())).toEqual({ pending: 0, failed: 0, exhausted: 0 })
  })
})
