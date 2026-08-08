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

describe('allowance-nonce coordinator (#692)', () => {
  beforeEach(() => __resetAllowanceNonceCoordinator())

  it('returns the initial nonce with no extra read when nothing is recorded', async () => {
    const read = vi.fn().mockResolvedValue(99)
    expect(await waitForFreshAllowanceNonce(C, SAFE, DELEGATE, TOKEN, 7, read)).toBe(7)
    expect(read).not.toHaveBeenCalled()
  })

  it('returns the initial nonce when it already meets the recorded one', async () => {
    recordAllowanceNonce(C, SAFE, DELEGATE, TOKEN, 5)
    const read = vi.fn().mockResolvedValue(99)
    expect(await waitForFreshAllowanceNonce(C, SAFE, DELEGATE, TOKEN, 5, read)).toBe(5)
    expect(read).not.toHaveBeenCalled()
  })

  it('waits until the recorded post-transfer nonce is visible', async () => {
    recordAllowanceNonce(C, SAFE, DELEGATE, TOKEN, 5) // a prior transfer left nonce 5
    // initial read is stale (4); RPC catches up to 5.
    const read = vi.fn().mockResolvedValueOnce(4).mockResolvedValue(5)
    const nonce = await waitForFreshAllowanceNonce(C, SAFE, DELEGATE, TOKEN, 4, read, {
      intervalMs: 1,
      timeoutMs: 1000,
    })
    expect(nonce).toBe(5)
    expect(read).toHaveBeenCalled()
  })

  it('falls back to the latest read on timeout (never blocks a payment)', async () => {
    recordAllowanceNonce(C, SAFE, DELEGATE, TOKEN, 9)
    const read = vi.fn().mockResolvedValue(4) // never catches up
    const nonce = await waitForFreshAllowanceNonce(C, SAFE, DELEGATE, TOKEN, 4, read, {
      intervalMs: 1,
      timeoutMs: 10,
    })
    expect(nonce).toBe(4)
  })

  it('keeps the highest recorded nonce and is per-delegate', async () => {
    recordAllowanceNonce(C, SAFE, DELEGATE, TOKEN, 5)
    recordAllowanceNonce(C, SAFE, DELEGATE, TOKEN, 3) // lower — ignored
    const read = vi.fn().mockResolvedValue(5)
    expect(
      await waitForFreshAllowanceNonce(C, SAFE, DELEGATE, TOKEN, 4, read, { intervalMs: 1 }),
    ).toBe(5)

    // A different delegate is unaffected — returns its initial immediately.
    const otherRead = vi.fn().mockResolvedValue(99)
    expect(await waitForFreshAllowanceNonce(C, SAFE, '0xOther', TOKEN, 1, otherRead)).toBe(1)
    expect(otherRead).not.toHaveBeenCalled()
  })
})

// ── The shared tier (#718) ───────────────────────────────────────────────────
//
// The tests above exercise the local map and pass a real store, which fails
// open to null — that is the single-replica path, unchanged by #718. These
// drive the shared tier explicitly, because the whole point is behaviour that
// one process cannot observe on its own.

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

  it('records to BOTH tiers, lower-casing the address triple', async () => {
    const store = fakeStore()
    recordAllowanceNonce(C, '0xSAFE', '0xDELEGATE', '0xTOKEN', 7, store)
    await new Promise((r) => setTimeout(r, 0)) // the write is fire-and-forget

    expect(store.raise).toHaveBeenCalledWith(C, '0xsafe', '0xdelegate', '0xtoken', 7)
    // Casing must not split the key: the chain sees one triple, and two rows
    // would each hold half the truth.
    expect(store.rows.get('84532:0xsafe:0xdelegate:0xtoken')).toBe(7)
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
})
