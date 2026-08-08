import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  recordAllowanceNonce,
  waitForFreshAllowanceNonce,
  __resetAllowanceNonceCoordinator,
} from '../allowance-nonce-coordinator.js'

const C = 84532
const SAFE = '0xSafe'
const DELEGATE = '0xDelegate'
const TOKEN = '0xToken'

/**
 * A store that knows nothing and remembers nothing.
 *
 * The five #692 tests below predate the shared tier and pass no store, which
 * bound them to the real `postgresStore`. That looked harmless locally — no
 * Postgres reachable, so the read failed open to null — and was wrong in CI,
 * where the database IS up with migration 055 applied: they wrote and read
 * real rows, `__resetAllowanceNonceCoordinator()` cleared only the map, and a
 * watermark left by one test made the next one poll to the 15 s default until
 * vitest killed it. Flaky rather than reliably red, since the write is
 * fire-and-forget.
 *
 * A unit test for this file must not reach a pool. Every assertion below is
 * unchanged; only the store they run against is now explicit.
 */
const NO_SHARED_TIER = { raise: async () => {}, find: async () => null }

describe('allowance-nonce coordinator (#692)', () => {
  beforeEach(() => __resetAllowanceNonceCoordinator())

  it('returns the initial nonce with no extra read when nothing is recorded', async () => {
    const read = vi.fn().mockResolvedValue(99)
    expect(await waitForFreshAllowanceNonce(C, SAFE, DELEGATE, TOKEN, 7, read, {}, NO_SHARED_TIER)).toBe(7)
    expect(read).not.toHaveBeenCalled()
  })

  it('returns the initial nonce when it already meets the recorded one', async () => {
    recordAllowanceNonce(C, SAFE, DELEGATE, TOKEN, 5, NO_SHARED_TIER)
    const read = vi.fn().mockResolvedValue(99)
    expect(await waitForFreshAllowanceNonce(C, SAFE, DELEGATE, TOKEN, 5, read, {}, NO_SHARED_TIER)).toBe(5)
    expect(read).not.toHaveBeenCalled()
  })

  it('waits until the recorded post-transfer nonce is visible', async () => {
    recordAllowanceNonce(C, SAFE, DELEGATE, TOKEN, 5, NO_SHARED_TIER) // a prior transfer left nonce 5
    // initial read is stale (4); RPC catches up to 5.
    const read = vi.fn().mockResolvedValueOnce(4).mockResolvedValue(5)
    const nonce = await waitForFreshAllowanceNonce(
      C, SAFE, DELEGATE, TOKEN, 4, read, { intervalMs: 1, timeoutMs: 1000 }, NO_SHARED_TIER,
    )
    expect(nonce).toBe(5)
    expect(read).toHaveBeenCalled()
  })

  it('falls back to the latest read on timeout (never blocks a payment)', async () => {
    recordAllowanceNonce(C, SAFE, DELEGATE, TOKEN, 9, NO_SHARED_TIER)
    const read = vi.fn().mockResolvedValue(4) // never catches up
    const nonce = await waitForFreshAllowanceNonce(
      C, SAFE, DELEGATE, TOKEN, 4, read, { intervalMs: 1, timeoutMs: 10 }, NO_SHARED_TIER,
    )
    expect(nonce).toBe(4)
  })

  it('keeps the highest recorded nonce and is per-delegate', async () => {
    recordAllowanceNonce(C, SAFE, DELEGATE, TOKEN, 5, NO_SHARED_TIER)
    recordAllowanceNonce(C, SAFE, DELEGATE, TOKEN, 3, NO_SHARED_TIER) // lower — ignored
    const read = vi.fn().mockResolvedValue(5)
    expect(
      await waitForFreshAllowanceNonce(C, SAFE, DELEGATE, TOKEN, 4, read, { intervalMs: 1 }, NO_SHARED_TIER),
    ).toBe(5)

    // A different delegate is unaffected — returns its initial immediately.
    const otherRead = vi.fn().mockResolvedValue(99)
    expect(await waitForFreshAllowanceNonce(C, SAFE, '0xOther', TOKEN, 1, otherRead, {}, NO_SHARED_TIER)).toBe(1)
    expect(otherRead).not.toHaveBeenCalled()
  })
})

// ── The shared tier (#718) ───────────────────────────────────────────────────
//
// The tests above exercise the local map against an empty shared tier — the
// single-replica path, unchanged by #718. These drive the shared tier
// explicitly, because the whole point is behaviour that one process cannot
// observe on its own.

function fakeStore(initial: Record<string, number> = {}) {
  const rows = new Map(Object.entries(initial))
  const key = (c: number, s: string, d: string, t: string) =>
    `${c}:${s.toLowerCase()}:${d.toLowerCase()}:${t.toLowerCase()}`
  return {
    rows,
    raise: vi.fn(async (c: number, s: string, d: string, t: string, n: number) => {
      const k = key(c, s, d, t)
      const prev = rows.get(k)
      if (prev === undefined || n > prev) rows.set(k, n)
    }),
    find: vi.fn(async (c: number, s: string, d: string, t: string) => rows.get(key(c, s, d, t)) ?? null),
  }
}

describe('cross-replica watermark (#718)', () => {
  beforeEach(() => __resetAllowanceNonceCoordinator())

  it('waits on a nonce THIS replica never saw — the whole point', async () => {
    // Replica A confirmed a transfer leaving nonce 5 and wrote the watermark.
    // This replica's map is empty; before #718 it would have signed against
    // the stale 4 and reverted.
    const store = fakeStore({ '84532:0xsafe:0xdelegate:0xtoken': 5 })
    const read = vi.fn().mockResolvedValueOnce(4).mockResolvedValue(5)

    const nonce = await waitForFreshAllowanceNonce(
      C, SAFE, DELEGATE, TOKEN, 4, read, { intervalMs: 1, timeoutMs: 1000 }, store,
    )

    expect(nonce).toBe(5)
    expect(read).toHaveBeenCalled()
  })

  it('takes the HIGHER of local and shared, never the lower', async () => {
    // Local knows 5; another replica has since confirmed 8. Waiting for 5
    // would sign against a nonce that replica already consumed.
    recordAllowanceNonce(C, SAFE, DELEGATE, TOKEN, 5, fakeStore())
    const store = fakeStore({ '84532:0xsafe:0xdelegate:0xtoken': 8 })
    const read = vi.fn().mockResolvedValueOnce(5).mockResolvedValue(8)

    const nonce = await waitForFreshAllowanceNonce(
      C, SAFE, DELEGATE, TOKEN, 5, read, { intervalMs: 1, timeoutMs: 1000 }, store,
    )

    expect(nonce).toBe(8)
  })

  it('a local value higher than the shared one still wins', async () => {
    recordAllowanceNonce(C, SAFE, DELEGATE, TOKEN, 9, fakeStore())
    const store = fakeStore({ '84532:0xsafe:0xdelegate:0xtoken': 2 })
    const read = vi.fn().mockResolvedValue(9)

    expect(
      await waitForFreshAllowanceNonce(C, SAFE, DELEGATE, TOKEN, 4, read, { intervalMs: 1 }, store),
    ).toBe(9)
  })

  it('records to BOTH tiers, and the local key ignores casing', async () => {
    const store = fakeStore()
    recordAllowanceNonce(C, '0xSAFE', '0xDELEGATE', '0xTOKEN', 7, store)
    await new Promise((r) => setTimeout(r, 0)) // the write is fire-and-forget

    expect(store.raise).toHaveBeenCalled()
    // The local map's key is case-insensitive, so a differently-cased read
    // finds the same entry rather than starting a second one.
    const read = vi.fn().mockResolvedValue(7)
    expect(
      await waitForFreshAllowanceNonce(C, '0xsafe', '0xdelegate', '0xtoken', 6, read, { intervalMs: 1 }, fakeStore()),
    ).toBe(7)
    // Normalising the SHARED tier is the repository's job now, asserted in
    // its own test — a property of the function, not an obligation on callers.
  })

  it('a failing store degrades to the local map — it never blocks a payment', async () => {
    // The fail-open contract. A database outage must cost a retry at worst,
    // never an outage of its own.
    const broken = {
      raise: vi.fn().mockRejectedValue(new Error('db down')),
      find: vi.fn().mockRejectedValue(new Error('db down')),
    }
    recordAllowanceNonce(C, SAFE, DELEGATE, TOKEN, 5, broken)
    const read = vi.fn().mockResolvedValue(5)

    // find() rejects → the shared tier contributes nothing → the local 5 stands
    // and the payment proceeds. Written first as `.rejects.toThrow()` and it
    // PASSED, which is how the missing guard was found: fail-open lived only in
    // the repository, so any other store could take a payment down with it.
    const nonce = await waitForFreshAllowanceNonce(
      C, SAFE, DELEGATE, TOKEN, 4, read, { intervalMs: 1, timeoutMs: 50 }, broken,
    )

    expect(nonce).toBe(5)
    expect(broken.find).toHaveBeenCalled()
  })

  it('a HANGING store does not hang the payment — the harder half of fail-open', async () => {
    // The failure a `.catch()` cannot see. A rejection is easy; a query that is
    // slow and never settles is what actually takes a payment down, and nothing
    // else would stop it — the pool sets no statement_timeout and Fastify sets
    // no request timeout. Before the bound, this test hung until vitest killed
    // it.
    const hanging = {
      raise: async () => {},
      find: () => new Promise<number | null>(() => {}), // never settles
    }
    recordAllowanceNonce(C, SAFE, DELEGATE, TOKEN, 5, { raise: async () => {}, find: async () => null })
    const read = vi.fn().mockResolvedValue(5)

    const started = Date.now()
    const nonce = await waitForFreshAllowanceNonce(
      C, SAFE, DELEGATE, TOKEN, 4, read,
      { intervalMs: 1, timeoutMs: 200, sharedReadTimeoutMs: 20 },
      hanging,
    )

    // The local tier still supplies 5, and the whole call stays bounded.
    expect(nonce).toBe(5)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('the bound does not truncate a store that answers in time', async () => {
    const slowButFine = {
      raise: async () => {},
      find: async () => {
        await new Promise((r) => setTimeout(r, 5))
        return 8
      },
    }
    const read = vi.fn().mockResolvedValueOnce(5).mockResolvedValue(8)

    expect(
      await waitForFreshAllowanceNonce(
        C, SAFE, DELEGATE, TOKEN, 5, read,
        { intervalMs: 1, timeoutMs: 500, sharedReadTimeoutMs: 200 },
        slowButFine,
      ),
    ).toBe(8)
  })
})
