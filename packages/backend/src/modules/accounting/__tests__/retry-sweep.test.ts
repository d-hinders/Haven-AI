/**
 * The retry sweep's in-process rules (#2866): the flag gate, the boot
 * registration (`.unref()`, skipped when off), one connection at a time
 * under the 25 / 5 s floor, the Retry-After courtesy, the overlapping-tick
 * guard and the one log line per run. The ledger is mocked here — the real
 * rows, the due-rows query and the orchestrator are proven in
 * `retry-sweep.db.test.ts` and the repository's real-DB suite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { configMock } = vi.hoisted(() => ({
  configMock: { accountingEnabled: true, accountingRetrySweepIntervalMs: 300_000 },
}))
vi.mock('../../../config.js', () => ({ config: configMock }))

const repo = vi.hoisted(() => ({
  listDueRetrySyncs: vi.fn(),
  releaseStalePending: vi.fn(),
  markFailed: vi.fn(),
}))
vi.mock('../../../infra/repositories/accounting-feed-syncs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/repositories/accounting-feed-syncs.js')>()
  return { ...actual, ...repo }
})

import { ProviderError } from '../provider.js'
import {
  PROVIDER_RATE_LIMIT,
  REQUESTS_PER_PUSH,
  RequestPacer,
  resetRetrySweepState,
  runRetrySweep,
  startRetrySweep,
  type RetrySweepLogger,
} from '../retry-sweep.js'
import type { DueRetryRow } from '../../../infra/repositories/accounting-feed-syncs.js'

function due(user: string, payment: string, attempts = 1, status: DueRetryRow['status'] = 'failed'): DueRetryRow {
  return { id: `${user}-${payment}`, user_id: user, provider: 'fortnox', payment_id: payment, status, attempts }
}

function logger(): RetrySweepLogger & { lines: Array<{ level: string; obj: Record<string, unknown>; msg: string }> } {
  const lines: Array<{ level: string; obj: Record<string, unknown>; msg: string }> = []
  return {
    lines,
    info: (obj, msg) => lines.push({ level: 'info', obj, msg }),
    debug: (obj, msg) => lines.push({ level: 'debug', obj, msg }),
    warn: (obj, msg) => lines.push({ level: 'warn', obj, msg }),
  }
}

describe('accounting retry sweep (#2866)', () => {
  let clock: number
  const now = () => new Date(clock)
  const sleeps: number[] = []
  /** The recorder advances the clock, as a real sleep would. */
  const sleep = async (ms: number) => {
    sleeps.push(ms)
    clock += ms
  }

  beforeEach(() => {
    clock = Date.UTC(2026, 8, 11, 12, 0, 0)
    sleeps.length = 0
    resetRetrySweepState()
    configMock.accountingEnabled = true
    for (const m of Object.values(repo)) m.mockReset()
    repo.listDueRetrySyncs.mockResolvedValue([])
    repo.releaseStalePending.mockResolvedValue(true)
    repo.markFailed.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('the flag', () => {
    it('is inert when accountingEnabled is false — it never even queries', async () => {
      configMock.accountingEnabled = false
      const log = logger()
      const result = await runRetrySweep({ now, sleep, log })
      expect(result).toMatchObject({ considered: 0, pushed: 0, deferred: 0, exhausted: 0, skipped: 0 })
      expect(repo.listDueRetrySyncs).not.toHaveBeenCalled()
      expect(log.lines).toEqual([])
    })

    it('positive control: with the flag on the query runs', async () => {
      await runRetrySweep({ now, sleep })
      expect(repo.listDueRetrySyncs).toHaveBeenCalledTimes(1)
    })
  })

  describe('boot registration (startRetrySweep)', () => {
    it('registers an interval that is unref()ed, ticks immediately, and ticks again on the configured interval', async () => {
      vi.useFakeTimers({ now: clock })
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
      const log = logger()
      const leader = vi.fn(async (fn: () => Promise<void>) => {
        await fn()
        return true
      })
      const timer = startRetrySweep({ log, leader })
      expect(timer).not.toBeNull()
      expect(timer!.hasRef()).toBe(false)
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), configMock.accountingRetrySweepIntervalMs)

      await vi.advanceTimersByTimeAsync(0)
      expect(leader).toHaveBeenCalledTimes(1)
      expect(repo.listDueRetrySyncs).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(configMock.accountingRetrySweepIntervalMs)
      expect(leader).toHaveBeenCalledTimes(2)
      clearInterval(timer!)
    })

    it('registers NOTHING when the flag is off', () => {
      configMock.accountingEnabled = false
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
      const leader = vi.fn(async () => true)
      expect(startRetrySweep({ log: logger(), leader })).toBeNull()
      expect(setIntervalSpy).not.toHaveBeenCalled()
      expect(leader).not.toHaveBeenCalled()
    })

    it('a tick that is still running when the next fires is skipped, and a failing tick is logged, not thrown', async () => {
      vi.useFakeTimers({ now: clock })
      const log = logger()
      let release!: () => void
      const gate = new Promise<void>((r) => { release = r })
      const leader = vi.fn(async (fn: () => Promise<void>) => {
        await gate
        await fn()
        return true
      })
      const timer = startRetrySweep({ log, leader, intervalMs: 1_000 })
      await vi.advanceTimersByTimeAsync(2_500) // two more ticks arrive while the first is blocked
      expect(leader).toHaveBeenCalledTimes(1)
      release()
      await vi.advanceTimersByTimeAsync(0)
      expect(repo.listDueRetrySyncs).toHaveBeenCalledTimes(1)

      leader.mockImplementation(async () => { throw new Error('lock down') })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(log.lines.some((l) => l.level === 'warn' && l.msg === 'Accounting retry sweep failed')).toBe(true)
      clearInterval(timer!)
    })
  })

  describe('one connection at a time under the floor', () => {
    it('walks connections serially, in the order the ledger returned them, never interleaving tenants', async () => {
      repo.listDueRetrySyncs.mockResolvedValue([due('u1', 'a'), due('u1', 'b'), due('u2', 'c'), due('u2', 'd')])
      const order: string[] = []
      let inFlight = 0
      let maxInFlight = 0
      const feed = vi.fn(async (userId: string, paymentId: string) => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        order.push(`${userId}:${paymentId}`)
        await Promise.resolve()
        inFlight -= 1
        return { outcome: 'pushed' as const }
      })
      const result = await runRetrySweep({ now, sleep, feed })
      expect(order).toEqual(['u1:a', 'u1:b', 'u2:c', 'u2:d'])
      expect(maxInFlight).toBe(1)
      expect(result).toMatchObject({ considered: 4, pushed: 4, connections: 2 })
    })

    it('spends at most 25 requests per 5 s per tenant: the pacer sleeps for the rest of the window once the budget is gone', async () => {
      const perWindow = Math.floor(PROVIDER_RATE_LIMIT.requests / REQUESTS_PER_PUSH)
      expect(perWindow).toBe(3)
      const rows = Array.from({ length: perWindow * 2 + 1 }, (_, i) => due('u1', `p${i}`))
      repo.listDueRetrySyncs.mockResolvedValue(rows)
      const feed = vi.fn(async () => ({ outcome: 'pushed' as const }))
      const result = await runRetrySweep({ now, sleep, feed })
      expect(result.pushed).toBe(rows.length)
      // 7 pushes = 3 + 3 + 1: two window rollovers, each a full window (the
      // clock does not move between pushes here).
      expect(sleeps).toEqual([PROVIDER_RATE_LIMIT.windowMs, PROVIDER_RATE_LIMIT.windowMs])
    })

    it('the budget is per tenant: a second connection starts with a fresh window', async () => {
      const rows = [due('u1', 'a'), due('u1', 'b'), due('u1', 'c'), due('u2', 'd'), due('u2', 'e'), due('u2', 'f')]
      repo.listDueRetrySyncs.mockResolvedValue(rows)
      const feed = vi.fn(async () => ({ outcome: 'pushed' as const }))
      await runRetrySweep({ now, sleep, feed })
      expect(sleeps).toEqual([])
    })

    it('RequestPacer: a window that already elapsed costs no sleep; a partially spent one waits only the remainder', async () => {
      const pacer = new RequestPacer(() => clock, sleep, { requests: 25, windowMs: 5_000 }, 8)
      await pacer.acquire()
      await pacer.acquire()
      await pacer.acquire()
      clock += 2_000
      await pacer.acquire() // budget gone: waits the remaining 3 s
      expect(sleeps).toEqual([3_000])
      clock += 6_000 // a whole window passes with nothing sent
      await pacer.acquire()
      await pacer.acquire()
      await pacer.acquire()
      expect(sleeps).toEqual([3_000])
    })
  })

  describe('429 handling', () => {
    const limited = () => new ProviderError('fortnox request failed (HTTP 429)', 429, 'fortnox')

    it('defers the remaining rows of that connection, moves on to the next tenant, and counts it', async () => {
      repo.listDueRetrySyncs.mockResolvedValue([due('u1', 'a'), due('u1', 'b'), due('u1', 'c'), due('u2', 'd')])
      const feed = vi.fn(async (_u: string, paymentId: string) =>
        paymentId === 'a'
          ? { outcome: 'failed' as const, reason: 'HTTP 429', error: limited() }
          : { outcome: 'pushed' as const },
      )
      const result = await runRetrySweep({ now, sleep, feed })
      expect(feed.mock.calls.map((c) => c[1])).toEqual(['a', 'd'])
      expect(result).toMatchObject({ considered: 4, pushed: 1, failed: 1, deferred: 2, rateLimited: 1, connections: 2 })
      // Nothing was written for b and c by the sweep itself.
      expect(repo.markFailed).not.toHaveBeenCalled()
    })

    it('a non-429 failure does NOT defer the rest of the connection', async () => {
      repo.listDueRetrySyncs.mockResolvedValue([due('u1', 'a'), due('u1', 'b')])
      const feed = vi.fn(async (_u: string, paymentId: string) =>
        paymentId === 'a'
          ? { outcome: 'failed' as const, reason: 'HTTP 500', error: new ProviderError('boom', 500, 'fortnox') }
          : { outcome: 'pushed' as const },
      )
      const result = await runRetrySweep({ now, sleep, feed })
      expect(feed.mock.calls.map((c) => c[1])).toEqual(['a', 'b'])
      expect(result).toMatchObject({ pushed: 1, failed: 1, deferred: 0, rateLimited: 0 })
    })

    it('honours a Retry-After as a courtesy: the connection stays deferred until it elapses, then is swept again', async () => {
      const err = Object.assign(limited(), { retryAfterMs: 20 * 60_000 })
      repo.listDueRetrySyncs.mockResolvedValue([due('u1', 'a'), due('u1', 'b')])
      const feed = vi.fn(async (_u: string, paymentId: string) =>
        paymentId === 'a' ? { outcome: 'failed' as const, reason: '429', error: err } : { outcome: 'pushed' as const },
      )
      expect(await runRetrySweep({ now, sleep, feed })).toMatchObject({ deferred: 1, rateLimited: 1 })

      // Next tick, 5 min later: still inside the courtesy window — untouched.
      clock += 5 * 60_000
      feed.mockImplementation(async () => ({ outcome: 'pushed' as const }))
      expect(await runRetrySweep({ now, sleep, feed })).toMatchObject({ considered: 2, deferred: 2, pushed: 0 })
      expect(feed).toHaveBeenCalledTimes(1)

      // Past it: swept.
      clock += 16 * 60_000
      expect(await runRetrySweep({ now, sleep, feed })).toMatchObject({ considered: 2, deferred: 0, pushed: 2 })
    })

    it('without a Retry-After (Fortnox), the connection is simply retried on the next tick', async () => {
      repo.listDueRetrySyncs.mockResolvedValue([due('u1', 'a'), due('u1', 'b')])
      const feed = vi.fn(async (_u: string, paymentId: string) =>
        paymentId === 'a' ? { outcome: 'failed' as const, reason: '429', error: limited() } : { outcome: 'pushed' as const },
      )
      await runRetrySweep({ now, sleep, feed })
      feed.mockImplementation(async () => ({ outcome: 'pushed' as const }))
      expect(await runRetrySweep({ now, sleep, feed })).toMatchObject({ pushed: 2, deferred: 0 })
    })
  })

  describe('the cap and the terminal reason', () => {
    it('the attempt that reaches 8 writes the exhausted: reason; one short of it does not', async () => {
      repo.listDueRetrySyncs.mockResolvedValue([due('u1', 'last', 7), due('u1', 'notyet', 6), due('u1', 'skip', 7, 'skipped')])
      const feed = vi.fn(async (_u: string, paymentId: string) =>
        paymentId === 'skip'
          ? { outcome: 'skipped' as const, reason: 'not_outbound' }
          : { outcome: 'failed' as const, reason: 'fortnox request failed (HTTP 500)' },
      )
      const result = await runRetrySweep({ now, sleep, feed })
      expect(result).toMatchObject({ exhausted: 2, failed: 1, skipped: 0 })
      expect(repo.markFailed.mock.calls.map((c) => [c[2], c[3]])).toEqual([
        ['last', 'exhausted: fortnox request failed (HTTP 500)'],
        ['skip', 'exhausted: skipped: not_outbound'],
      ])
    })
  })

  describe('stale pending', () => {
    it('releases a stale pending row first, then feeds it; a row that is no longer pending is left alone', async () => {
      repo.listDueRetrySyncs.mockResolvedValue([due('u1', 'stuck', 2, 'pending'), due('u1', 'done', 2, 'pending')])
      repo.releaseStalePending.mockImplementation(async (id: string) => id === 'u1-stuck')
      const feed = vi.fn(async (_u: string, _paymentId: string) => ({ outcome: 'pushed' as const }))
      const result = await runRetrySweep({ now, sleep, feed })
      expect(repo.releaseStalePending).toHaveBeenCalledTimes(2)
      expect(feed.mock.calls.map((c) => c[1])).toEqual(['stuck'])
      expect(result).toMatchObject({ pushed: 1, skipped: 1 })
    })
  })

  describe('the log line', () => {
    it('emits exactly one structured line per run, at info when something was considered and debug when idle', async () => {
      const log = logger()
      await runRetrySweep({ now, sleep, log })
      expect(log.lines).toHaveLength(1)
      expect(log.lines[0]).toMatchObject({ level: 'debug', msg: 'Accounting retry sweep', obj: { considered: 0 } })

      repo.listDueRetrySyncs.mockResolvedValue([due('u1', 'a'), due('u1', 'b', 7)])
      const feed = vi.fn(async (_u: string, paymentId: string) =>
        paymentId === 'a' ? { outcome: 'pushed' as const } : { outcome: 'failed' as const, reason: 'x' },
      )
      log.lines.length = 0
      await runRetrySweep({ now, sleep, log, feed })
      expect(log.lines).toHaveLength(1)
      expect(log.lines[0]).toMatchObject({
        level: 'info',
        msg: 'Accounting retry sweep',
        obj: { considered: 2, pushed: 1, exhausted: 1, deferred: 0, failed: 0, skipped: 0, connections: 1, rateLimited: 0 },
      })
    })
  })
})
