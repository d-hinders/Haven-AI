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
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import {
  claimSync,
  markPushed,
  markFailed,
  markSkipped,
  reopenMissingPushed,
  getSyncState,
} from '../reporting-feed-syncs.js'

let seq = 0

async function seedUser(): Promise<string> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`feed-${++seq}-${Date.now()}@test.example`],
  )
  return user.rows[0].id
}

describeDb('reporting-feed-syncs repository (#1365)', () => {
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
})
