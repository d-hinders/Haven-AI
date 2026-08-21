/**
 * Real-DB tests for the rate-limit counter repository (#1680, epic #1219's rule).
 *
 * Every claim here is a claim about POSTGRES, which is exactly why they cannot
 * be mocked: that one statement both starts and rolls a window, that
 * CONCURRENT increments of one key do not lose counts, and that the returned
 * ttl tracks the row's own expiry. A positional mock would assert only that
 * the code called `query` in the order the test already assumed — and the
 * whole defect being fixed (#1680) was a counter that looked right locally and
 * did not converge in a real deployment.
 */
import { beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import {
  deleteExpiredRateLimits,
  incrementRateLimit,
  readRateLimit,
} from '../rate-limit-counters.js'

const WINDOW_MS = 60_000

let counter = 0
const freshKey = () => `ip:test-${Date.now()}-${counter++}`

describeDb('rate_limit_counters (#1680)', () => {
  beforeEach(async () => {
    await initDbHarness()
    await resetDb()
    await db.query('DELETE FROM rate_limit_counters')
  })

  it('counts up within one window and reports a shrinking ttl', async () => {
    const key = freshKey()

    const first = await incrementRateLimit(key, WINDOW_MS)
    const second = await incrementRateLimit(key, WINDOW_MS)
    const third = await incrementRateLimit(key, WINDOW_MS)

    expect(first?.current).toBe(1)
    expect(second?.current).toBe(2)
    expect(third?.current).toBe(3)
    // The window does not restart on each hit: ttl counts down from the FIRST.
    expect(first!.ttl).toBeLessThanOrEqual(WINDOW_MS)
    expect(third!.ttl).toBeLessThanOrEqual(first!.ttl)
    expect(third!.ttl).toBeGreaterThan(WINDOW_MS - 10_000)
  })

  it('MUTATION PROOF: an expired window starts over rather than accumulating', async () => {
    // The window roll is a CASE inside the upsert. Remove it and a bucket
    // counts forever, so a client is banned permanently after one burst —
    // which no test that only counts upward would notice.
    const key = freshKey()
    await incrementRateLimit(key, WINDOW_MS)
    await incrementRateLimit(key, WINDOW_MS)

    // Age the row past its expiry rather than sleeping a minute.
    await db.query("UPDATE rate_limit_counters SET expires_at = NOW() - INTERVAL '1 second' WHERE key = $1", [key])

    const afterExpiry = await incrementRateLimit(key, WINDOW_MS)
    expect(afterExpiry?.current).toBe(1)
    expect(afterExpiry!.ttl).toBeGreaterThan(WINDOW_MS - 5_000)
  })

  it('CONCURRENT increments of one key lose nothing — the property replicas need', async () => {
    // This is the whole point of the shared store: two replicas hitting the
    // same key at the same moment must produce 2, not 1. The upsert takes a
    // row lock, so the concurrency is serialised by Postgres rather than by
    // hope. A read-then-write implementation passes every sequential test
    // above and fails this one.
    const key = freshKey()

    const results = await Promise.all(
      Array.from({ length: 20 }, () => incrementRateLimit(key, WINDOW_MS)),
    )

    const counts = results.map((r) => r?.current).sort((a, b) => (a ?? 0) - (b ?? 0))
    expect(counts).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
  })

  it('CONCURRENT increments on an EXPIRED row do not both restart the window', async () => {
    // The case the sequential expiry test above cannot reach, and the one
    // pure reasoning is easiest to get wrong: when several requests race on a
    // row whose window has just ended, only ONE may take the restart branch.
    // ON CONFLICT DO UPDATE re-evaluates the CASE against the winner's
    // COMMITTED row, so the losers increment the fresh window instead of each
    // resetting it to 1 — a read-then-write would let every racer reset.
    const key = freshKey()
    await incrementRateLimit(key, WINDOW_MS)
    await db.query("UPDATE rate_limit_counters SET expires_at = NOW() - INTERVAL '1 second' WHERE key = $1", [key])

    const results = await Promise.all(
      Array.from({ length: 10 }, () => incrementRateLimit(key, WINDOW_MS)),
    )

    const counts = results.map((r) => r?.current).sort((a, b) => (a ?? 0) - (b ?? 0))
    // Exactly one 1 (the restart), then 2..10 — not ten 1s.
    expect(counts).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    // And the restarted window is a FULL one, not the expired remnant.
    expect(Math.max(...results.map((r) => r!.ttl))).toBeGreaterThan(WINDOW_MS - 5_000)
  })

  it('separate keys never contend', async () => {
    const a = freshKey()
    const b = freshKey()
    await incrementRateLimit(a, WINDOW_MS)
    await incrementRateLimit(a, WINDOW_MS)
    const onB = await incrementRateLimit(b, WINDOW_MS)
    expect(onB?.current).toBe(1)
  })

  it('read peeks without counting, and an unseen key is a clean slate', async () => {
    const key = freshKey()
    await incrementRateLimit(key, WINDOW_MS)

    const peek = await readRateLimit(key)
    expect(peek).toEqual({ current: 1, ttl: expect.any(Number) })

    // Peeking must not have advanced anything.
    const next = await incrementRateLimit(key, WINDOW_MS)
    expect(next?.current).toBe(2)

    // Distinct from the `null` an ERROR returns: never seen is 0, not unknown.
    expect(await readRateLimit(freshKey())).toEqual({ current: 0, ttl: 0 })
  })

  it('read ignores an expired row — a stale count never blocks anyone', async () => {
    const key = freshKey()
    await incrementRateLimit(key, WINDOW_MS)
    await db.query("UPDATE rate_limit_counters SET expires_at = NOW() - INTERVAL '1 second' WHERE key = $1", [key])

    expect(await readRateLimit(key)).toEqual({ current: 0, ttl: 0 })
  })

  it('the sweep deletes only expired rows', async () => {
    const live = freshKey()
    const dead = freshKey()
    await incrementRateLimit(live, WINDOW_MS)
    await incrementRateLimit(dead, WINDOW_MS)
    await db.query("UPDATE rate_limit_counters SET expires_at = NOW() - INTERVAL '1 second' WHERE key = $1", [dead])

    const deleted = await deleteExpiredRateLimits()
    expect(deleted).toBe(1)

    const remaining = await db.query<{ key: string }>('SELECT key FROM rate_limit_counters')
    expect(remaining.rows.map((r) => r.key)).toEqual([live])
  })

  it('a failing executor returns null rather than throwing — the fail-open contract', async () => {
    // The caller degrades to per-replica counting on null. If this threw
    // instead, a database hiccup would 500 the signup and login routes: an
    // outage on the front door in exchange for a hiccup.
    const broken = {
      query: async () => {
        throw new Error('connection terminated')
      },
    }

    expect(await incrementRateLimit('ip:x', WINDOW_MS, broken as never)).toBeNull()
    expect(await readRateLimit('ip:x', broken as never)).toBeNull()
  })
})
