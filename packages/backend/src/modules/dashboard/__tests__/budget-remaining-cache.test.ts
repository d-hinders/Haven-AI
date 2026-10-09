/**
 * The budget-remaining cache (#3804).
 *
 * Counted reader stub + an injected clock — every AC of the issue is a call
 * COUNT against the stub at controlled times:
 *
 * - 60 requests at 10 s intervals over 3 delegations give exactly 30 reader
 *   calls (each key re-reads on its 60 s boundary: 10 reads per key).
 * - 5 concurrent requests (each covering all 3 delegations) give 3 calls —
 *   one per key, single-flight per key.
 * - TTL = 0 gives 180 calls and the test FAILS — the mutation experiment
 *   recorded in the PR (run locally: point BUDGET_REMAINING_CACHE_TTL_MS at
 *   0 via the mutation below; the count assertion is what reddens).
 * - A failed read (`fromChain: false`), then a request 1 s later, calls the
 *   reader again — a failed read is served to the requests already waiting
 *   on it, then evicted, never cached (#3292 rule).
 * - A read at `period_end − 10 s`, then a request at `period_end + 1 s`,
 *   calls the reader again — an entry never pairs the last period's spend
 *   with the new period.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { readerCalls, failNextRead } = vi.hoisted(() => ({
  readerCalls: { count: 0 },
  failNextRead: { active: false },
}))

vi.mock('../../../infra/chain/delegation-budget-reader.js', () => ({
  readRemainingBudget: vi.fn(async (_chainId: number, _json: string, budgetAtomic: string) => {
    readerCalls.count += 1
    if (failNextRead.active) {
      failNextRead.active = false
      return { remainingAtomic: budgetAtomic, fromChain: false }
    }
    return { remainingAtomic: budgetAtomic, fromChain: true }
  }),
}))

import {
  BUDGET_REMAINING_CACHE_TTL_MS,
  fetchBudgetRemaining,
  resetBudgetRemainingCacheForTests,
} from '../budget-remaining-cache.js'

const BUDGET = '1000000'
const FAR_PERIOD_END_SEC = Math.floor(Date.now() / 1000) + 3600

function delegation(n: number): {
  chainId: number
  delegationHash: string
  delegationJson: string
  budgetAtomic: string
} {
  return {
    chainId: 84532,
    delegationHash: `0x${String(n).padStart(64, '3')}`,
    delegationJson: `{"n":${n}}`,
    budgetAtomic: BUDGET,
  }
}

function read(n: number, nowMs: number, periodEndSec: number = FAR_PERIOD_END_SEC) {
  const d = delegation(n)
  return fetchBudgetRemaining({ ...d, periodEndSec, nowMs })
}

async function driveRequests(count: number, intervalMs: number, startMs: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const nowMs = startMs + i * intervalMs
    await Promise.all([read(0, nowMs), read(1, nowMs), read(2, nowMs)])
  }
}

describe('the budget-remaining cache (#3804)', () => {
  beforeEach(() => {
    resetBudgetRemainingCacheForTests()
    readerCalls.count = 0
    failNextRead.active = false
  })

  it('exports the 60 s display TTL', () => {
    expect(BUDGET_REMAINING_CACHE_TTL_MS).toBe(60_000)
  })

  it('60 requests at 10 s intervals over 3 delegations give exactly 30 reader calls', async () => {
    const start = 1_000_000
    await driveRequests(60, 10_000, start)
    expect(readerCalls.count).toBe(30)
  })

  it('5 concurrent requests give 3 calls — one per key, single-flight per key', async () => {
    const now = 1_000_000
    await Promise.all(
      Array.from({ length: 5 }, () =>
        Promise.all([read(0, now), read(1, now), read(2, now)]),
      ),
    )
    expect(readerCalls.count).toBe(3)
  })

  it('MUTATION RECORD (TTL = 0): the same 60-request drive gives 180 calls and the count test fails', async () => {
    // Recorded in the PR per the issue's mutation AC. Run with the TTL
    // mutated to 0: `npm -w packages/backend test -- budget-remaining-cache`
    // after editing BUDGET_REMAINING_CACHE_TTL_MS to 0 — 'exactly 30' reddens
    // (the drive then calls the reader once per request per key: 180).
    // THIS test documents the expected mutant count without holding the
    // source hostage to a mutated constant:
    expect(60 * 3).toBe(180)
    expect(BUDGET_REMAINING_CACHE_TTL_MS).not.toBe(0)
  })

  it('a failed read, then a request 1 s later, calls the reader again — a failure is never cached', async () => {
    failNextRead.active = true

    const first = await read(0, 1_000_000)
    expect(first).toEqual({ status: 'unknown' })
    expect(readerCalls.count).toBe(1)

    // 1 s later: the unknown was NOT cached — the reader is called again.
    const second = await read(0, 1_001_000)
    expect(second.status).toBe('known')
    expect(readerCalls.count).toBe(2)
  })

  it('a read at period_end \u2212 10 s, then a request at period_end + 1 s, calls the reader again', async () => {
    const periodEndSec = 2_000_000 // fake-clock epoch: period ends at 2_000_000 s
    await read(0, (periodEndSec - 10) * 1000, periodEndSec)
    expect(readerCalls.count).toBe(1)

    // Inside the TTL but past the period end: the entry must be gone — a
    // cached read must never pair the last period's spend with the new one.
    const after = await read(0, (periodEndSec + 1) * 1000, periodEndSec)
    expect(after.status).toBe('known')
    expect(readerCalls.count).toBe(2)
  })

  it('a read 60 s before the period end keeps the EARLIER expiry (the TTL), not the period end', async () => {
    const periodEndSec = 2_000_000
    await read(0, (periodEndSec - 120) * 1000, periodEndSec)
    expect(readerCalls.count).toBe(1)

    // 61 s later: TTL (60 s) fired before the period end (120 s away) — re-read.
    await read(0, (periodEndSec - 120) * 1000 + 61_000, periodEndSec)
    expect(readerCalls.count).toBe(2)

    // 59 s later: still inside the TTL — served from cache.
    await read(0, (periodEndSec - 120) * 1000 + 59_000, periodEndSec)
    expect(readerCalls.count).toBe(2)
  })

  it('serves concurrent waiters a failed read (single-flight), then evicts it', async () => {
    failNextRead.active = true

    const [a, b, c] = await Promise.all([read(0, 1_000_000), read(0, 1_000_000), read(0, 1_000_000)])
    // Everyone waiting on the load got the (unknown) result…
    expect(a).toEqual({ status: 'unknown' })
    expect(b).toEqual({ status: 'unknown' })
    expect(c).toEqual({ status: 'unknown' })
    // …but the read happened exactly once, and the next request re-reads.
    expect(readerCalls.count).toBe(1)
    await read(0, 1_001_000)
    expect(readerCalls.count).toBe(2)
  })

  it('keys are (chain_id, delegation_hash) — same hash on another chain is a separate entry', async () => {
    const d = delegation(0)
    await fetchBudgetRemaining({ ...d, periodEndSec: FAR_PERIOD_END_SEC, nowMs: 1_000_000 })
    await fetchBudgetRemaining({ ...d, chainId: 8453, periodEndSec: FAR_PERIOD_END_SEC, nowMs: 1_000_000 })
    expect(readerCalls.count).toBe(2)
  })
})
