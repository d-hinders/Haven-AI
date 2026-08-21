/**
 * #1742 — what `revokeOnChain` does when its transaction does not mine.
 *
 * Sibling of `rails/__tests__/hybrid-provisioning-wait-bound.test.ts` (#1722)
 * and the third instance of one defect shape: a bare `tx.wait()` that waits
 * forever, and a `catch` that calls every rejection a revert.
 *
 * Revocation is the SAFETY-CRITICAL half of the passport. `revocation.ts`
 * treats Haven's DB as authoritative and this is the on-chain anchor catching
 * up, so a revoke that never resolves means an agent Haven considers revoked
 * still holds a live, merchant-readable attestation — and, because the whole
 * passport sweep runs sequentially under ONE leader lock (`index.ts`
 * `runPassportSweep` → `runIfLeader`), a single stalled revoke also parks the
 * `alarm` phase that exists to report exactly that condition.
 *
 * The mocked `wait` mirrors ethers v6 verbatim: a tx that never mines settles
 * ONLY through the caller's `timeout` argument, and never at all without one.
 * So a regression to a bare `wait()` HANGS these tests rather than quietly
 * passing them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const TX_HASH = '0x' + 'cd'.repeat(32)
const UID = '0x' + 'ab'.repeat(32)

/** How the mocked transaction behaves while being waited on. */
type WaitMode =
  /** Mines successfully. */
  | 'success'
  /** Mined and reverted — ethers v6 THROWS CALL_EXCEPTION out of wait(). */
  | 'revert'
  /** Never mines: settles only via the caller's timeout argument (faithful). */
  | 'stall'
  /** Rejects TIMEOUT immediately, whatever the caller passed. */
  | 'timeout'
  /** Resolves a null receipt — a lagging RPC for a tx that may have mined (#690). */
  | 'null-receipt'

let waitMode: WaitMode = 'success'
let waitCalls: Array<[confirms: number | undefined, timeoutMs: number | undefined]> = []

const timeoutError = () => {
  const err = new Error('wait for transaction timeout') as Error & { code: string }
  err.code = 'TIMEOUT'
  return err
}

const trace: string[] = []
const minedSpy = vi.fn(async () => {
  trace.push('record:mined')
})
const failedSpy = vi.fn(async (reason: string) => {
  trace.push(`record:failed(${reason})`)
})
const openSpy = vi.fn(async (params: { chainId: number; submitter: string; to: string; data: string }) => {
  trace.push('record:open')
  void params
  return { id: 'rec-1', broadcast: vi.fn(async () => {}), mined: minedSpy, failed: failedSpy }
})
const submitSpy = vi.fn(async (params: { recordId: string | null }) => {
  trace.push('broadcast')
  void params
  return {
    hash: TX_HASH,
    nonce: 77,
    wait: async (confirms?: number, timeoutMs?: number) => {
      waitCalls.push([confirms, timeoutMs])
      if (waitMode === 'revert') {
        const err = new Error('transaction execution reverted') as Error & { code: string }
        err.code = 'CALL_EXCEPTION'
        throw err
      }
      if (waitMode === 'timeout') throw timeoutError()
      if (waitMode === 'null-receipt') return null
      if (waitMode === 'stall') {
        // Faithful to ethers v6 (`providers/provider.js` → `wait`): with no
        // timeout argument there is NO deadline, so this never settles.
        if (timeoutMs == null) return await new Promise<never>(() => {})
        await new Promise((resolve) => setTimeout(resolve, timeoutMs))
        throw timeoutError()
      }
      return { status: 1 }
    },
  }
})
vi.mock('../../../infra/outbound-queue.js', () => ({
  openOutboundRecord: openSpy,
  submitRecorded: submitSpy,
}))

vi.mock('../../../infra/relayer.js', async () => {
  const actual = await vi.importActual<typeof import('../../../infra/relayer.js')>(
    '../../../infra/relayer.js',
  )
  return { ...actual, getRelayer: () => ({ address: '0x' + '11'.repeat(20) }) }
})

vi.mock('ethers', async () => {
  const actual = await vi.importActual<typeof import('ethers')>('ethers')
  class FakeContract {
    revoke = async () => {
      throw new Error('direct contract broadcast — must go through submitRecorded (#1559)')
    }
  }
  return { ...actual, Contract: FakeContract }
})

const { revokeOnChain } = await import('../attestation.js')

beforeEach(() => {
  process.env.AGENT_PASSPORT_SCHEMA_UID_84532 = UID
  trace.length = 0
  waitCalls = []
  waitMode = 'success'
  vi.clearAllMocks()
})

/**
 * CHARACTERIZATION (#1742) — today's behaviour, pinned before it changes.
 * Money-path playbook §2. Every expectation in this block records a defect,
 * not a desired property; the fix commit inverts them.
 */
describe('CHARACTERIZATION: revokeOnChain today (#1742)', () => {
  it('calls wait() BARE — no confirmations, no timeout, so it can wait forever', async () => {
    await revokeOnChain(84532, UID)

    // The whole defect in one assertion: ethers v6 reads these two arguments
    // as "however long it takes".
    expect(waitCalls).toEqual([[undefined, undefined]])
  })

  it('never returns for a transaction that does not mine', async () => {
    waitMode = 'stall'
    vi.useFakeTimers()
    try {
      const settled = revokeOnChain(84532, UID).then(
        () => 'resolved',
        () => 'rejected',
      )

      // An hour of chain time — well past the bump worker's 180s adoption age
      // and past `listStuckRevocations`' 3600s alarm threshold — and the call
      // is still parked. In production this is holding the passport sweep's
      // leader lock and its pooled Postgres connection the entire time.
      await vi.advanceTimersByTimeAsync(3_600_000)
      expect(await Promise.race([settled, Promise.resolve('pending')])).toBe('pending')

      // Neither terminal state was reached: the durable record is stuck open.
      expect(minedSpy).not.toHaveBeenCalled()
      expect(failedSpy).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('calls a TIMEOUT a revert: closes the record failed and says "reverted"', async () => {
    waitMode = 'timeout'

    await expect(revokeOnChain(84532, UID)).rejects.toThrow(/timeout/)

    // The transaction may still mine, but the record is closed failed — so it
    // leaves the bump worker's unmined scan and has no owner at all. And the
    // reason string blames a revert that never happened.
    expect(failedSpy).toHaveBeenCalledTimes(1)
    expect(failedSpy.mock.calls[0][0]).toMatch(/revocation reverted/)
  })

  it('calls a NULL receipt a revert too (#690: a lagging RPC is not a revert)', async () => {
    waitMode = 'null-receipt'

    await expect(revokeOnChain(84532, UID)).rejects.toThrow(/revocation reverted/)
    expect(failedSpy).toHaveBeenCalledTimes(1)
  })

  it('a genuine revert closes the record failed — the branch worth preserving', async () => {
    waitMode = 'revert'

    await expect(revokeOnChain(84532, UID)).rejects.toThrow(/reverted/)
    expect(failedSpy).toHaveBeenCalledTimes(1)
    expect(minedSpy).not.toHaveBeenCalled()
  })

  it('a mined revoke still closes the record mined', async () => {
    const result = await revokeOnChain(84532, UID)

    expect(result.txHash).toBe(TX_HASH)
    expect(trace).toEqual(['record:open', 'broadcast', 'record:mined'])
  })
})
