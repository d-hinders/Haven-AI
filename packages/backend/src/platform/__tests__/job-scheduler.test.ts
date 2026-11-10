/**
 * The generic scheduler's outer shape (#4764).
 *
 * `index.ts` used to hand-wire ten background jobs inline, and the only way to
 * test that wiring was to regex the file's source — a technique that failed
 * once on record (#4411). The scheduler is now importable, so these are
 * behavioural tests with fake timers: no source scanning, no boot.
 *
 * What is pinned here is the shape every row shares, not any particular job:
 * one run at start, one per interval, a warn-and-continue on a throw, the
 * leader gate when the row names a lock key, and NO lock call when it does
 * not (the relayer balance monitor is deliberately per-replica).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  startJob,
  startJobs,
  type BackgroundJobRow,
  type JobLogger,
} from '../job-scheduler.js'

function fakeLog() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } satisfies JobLogger
}

function row(overrides: Partial<BackgroundJobRow> = {}): BackgroundJobRow {
  return {
    name: 'test row',
    intervalMs: 1_000,
    failureMessage: 'test row failed',
    run: vi.fn(async () => {}),
    ...overrides,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('startJob', () => {
  it('runs the row once at start, then again after its interval', async () => {
    const r = row()
    startJob(r, { log: fakeLog() })

    // The first run is `void tick()`, not a timer — flush the microtask.
    await vi.advanceTimersByTimeAsync(0)
    expect(r.run).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(999)
    expect(r.run).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(r.run).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(r.run).toHaveBeenCalledTimes(3)
  })

  it('logs the row’s own warning when a tick throws, and the next tick still fires', async () => {
    const err = new Error('boom')
    const log = fakeLog()
    const r = row({ run: vi.fn(async () => { throw err }) })

    startJob(r, { log })

    await vi.advanceTimersByTimeAsync(0)
    expect(log.warn).toHaveBeenCalledWith({ err }, 'test row failed')

    // A throwing tick must not kill the interval.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(r.run).toHaveBeenCalledTimes(2)
    expect(log.warn).toHaveBeenCalledTimes(2)
  })

  it('runs a leader-gated row through the lock, and skips it when the lock is not acquired', async () => {
    const r = row({ lockKey: 811001 })
    const leader = vi.fn(async (_key: number, _fn: () => Promise<void>) => false)

    startJob(r, { log: fakeLog(), runIfLeader: leader })

    await vi.advanceTimersByTimeAsync(0)
    expect(leader).toHaveBeenCalledTimes(1)
    expect(leader.mock.calls[0]![0]).toBe(811001)
    // The lock was lost, so the row's body never ran.
    expect(r.run).not.toHaveBeenCalled()
  })

  it('runs a leader-gated row when the lock IS acquired', async () => {
    const r = row({ lockKey: 811001 })
    const leader = vi.fn(async (_key: number, fn: () => Promise<void>) => {
      await fn()
      return true
    })

    startJob(r, { log: fakeLog(), runIfLeader: leader })

    await vi.advanceTimersByTimeAsync(0)
    expect(r.run).toHaveBeenCalledTimes(1)
  })

  it('runs a per-replica row with no lock call at all', async () => {
    const r = row() // no lockKey
    const leader = vi.fn(async () => true)

    startJob(r, { log: fakeLog(), runIfLeader: leader })

    await vi.advanceTimersByTimeAsync(0)
    expect(leader).not.toHaveBeenCalled()
    expect(r.run).toHaveBeenCalledTimes(1)
  })
})

describe('startJobs', () => {
  it('starts every row in the table', async () => {
    const rows = [row({ name: 'a' }), row({ name: 'b' }), row({ name: 'c' })]
    startJobs(rows, { log: fakeLog() })

    await vi.advanceTimersByTimeAsync(0)
    for (const r of rows) expect(r.run).toHaveBeenCalledTimes(1)
  })
})
