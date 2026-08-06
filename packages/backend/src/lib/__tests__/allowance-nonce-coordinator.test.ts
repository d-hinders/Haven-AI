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
