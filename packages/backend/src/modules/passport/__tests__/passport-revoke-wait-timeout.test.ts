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
  /** Resolves a null receipt — a lagging RPC for a tx that may have mined (#690). */
  | 'null-receipt'
  /** Resolves a status-0 receipt without throwing — see the test that uses it. */
  | 'status-zero'

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
      if (waitMode === 'null-receipt') return null
      if (waitMode === 'status-zero') return { status: 0 }
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

const { REBROADCAST_SAFE_SUBMITTERS, STALE_BROADCAST_SECONDS } = await import(
  '../../../infra/outbound-bump-worker.js'
)
const { revokeOnChain, PASSPORT_REVOKE_CONFIRM_TIMEOUT_MS, PassportRevokeUnconfirmedError } =
  await import('../attestation.js')

beforeEach(() => {
  process.env.AGENT_PASSPORT_SCHEMA_UID_84532 = UID
  trace.length = 0
  waitCalls = []
  waitMode = 'success'
  vi.clearAllMocks()
})

describe('an unconfirmed passport revoke (#1742)', () => {
  it('bounds the wait — one confirmation, an explicit deadline', async () => {
    await revokeOnChain(84532, UID)

    // Was `[[undefined, undefined]]` before #1742, which ethers v6 reads as
    // "however long it takes".
    expect(waitCalls).toEqual([[1, PASSPORT_REVOKE_CONFIRM_TIMEOUT_MS]])
  })

  it('returns by the deadline instead of waiting forever', async () => {
    waitMode = 'stall'
    vi.useFakeTimers()
    try {
      const settled = revokeOnChain(84532, UID).catch((err: unknown) => err)

      // One tick short of the deadline it is still waiting, as it should be —
      // the deadline is what ends the wait, not some earlier give-up.
      await vi.advanceTimersByTimeAsync(PASSPORT_REVOKE_CONFIRM_TIMEOUT_MS - 1)
      expect(await Promise.race([settled, Promise.resolve('pending')])).toBe('pending')

      await vi.advanceTimersByTimeAsync(1)
      const err = await settled
      expect(err).toBeInstanceOf(PassportRevokeUnconfirmedError)
      expect((err as InstanceType<typeof PassportRevokeUnconfirmedError>).txHash).toBe(TX_HASH)
      // The message must not claim a revert — an operator reading it is
      // deciding whether an agent's credential is still live on-chain.
      expect((err as Error).message).not.toMatch(/revert/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves the record BROADCAST for the bump worker — never failed', async () => {
    waitMode = 'stall'
    vi.useFakeTimers()
    try {
      const settled = revokeOnChain(84532, UID).catch((err: unknown) => err)
      await vi.advanceTimersByTimeAsync(PASSPORT_REVOKE_CONFIRM_TIMEOUT_MS)
      await settled

      // Neither close is called, so the row keeps the status `submitRecorded`
      // stamped: `broadcast` — the state the bump worker's unmined scan adopts.
      expect(failedSpy).not.toHaveBeenCalled()
      expect(minedSpy).not.toHaveBeenCalled()

      // Adoption is only safe because a second revoke of the same UID reverts
      // on-chain, which the worker's own list records.
      const submitter = openSpy.mock.calls[0][0].submitter
      expect(submitter).toBe('passport_revoke')
      expect(REBROADCAST_SAFE_SUBMITTERS.has(submitter)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('expires before either other owner can take the transaction', async () => {
    // Two owners can take this revoke over: the bump worker at
    // STALE_BROADCAST_SECONDS (180s), and another caller when the revocation
    // lease expires (`claimRevocation`'s leaseSeconds, 300s). 180 < 300, so
    // asserting the tighter one is what actually binds — and it is the one
    // available as an imported constant rather than a literal that can drift.
    expect(PASSPORT_REVOKE_CONFIRM_TIMEOUT_MS).toBeLessThan(STALE_BROADCAST_SECONDS * 1_000)
  })

  it('a NULL receipt takes the hand-off branch too (#690)', async () => {
    waitMode = 'null-receipt'

    const err = await revokeOnChain(84532, UID).catch((e: unknown) => e)

    // A lagging RPC returns null for transactions that did confirm, so "no
    // receipt" is not "reverted" here either.
    expect(err).toBeInstanceOf(PassportRevokeUnconfirmedError)
    expect(failedSpy).not.toHaveBeenCalled()
  })

  it('a REVERT is still a revert — the hand-off branch does not swallow it', async () => {
    waitMode = 'revert'

    const err = await revokeOnChain(84532, UID).catch((e: unknown) => e)

    expect(err).not.toBeInstanceOf(PassportRevokeUnconfirmedError)
    expect((err as Error).message).toMatch(/reverted/)
    // A mined-and-reverted revoke IS finished: handing it to the bump worker
    // would re-broadcast a known-bad transaction.
    expect(failedSpy).toHaveBeenCalledTimes(1)
    expect(minedSpy).not.toHaveBeenCalled()
  })

  it('a non-timeout wait error still closes the record failed', async () => {
    // Only a TIMEOUT (and a null receipt) take the hand-off. Any other
    // rejection keeps the pre-#1742 disposition — this is the guard that
    // stops `isWaitTimeout` being widened into "never fail anything".
    waitMode = 'stall'
    const boom = new Error('provider exploded') as Error & { code: string }
    boom.code = 'NETWORK_ERROR'
    submitSpy.mockImplementationOnce(async () => ({
      hash: TX_HASH,
      nonce: 77,
      wait: async () => {
        throw boom
      },
    }))

    await expect(revokeOnChain(84532, UID)).rejects.toThrow('provider exploded')
    expect(failedSpy).toHaveBeenCalledTimes(1)
  })

  it('a status-0 receipt that RESOLVES still closes the record failed', async () => {
    // Believed unreachable: ethers v6 throws CALL_EXCEPTION on a
    // mined-and-reverted tx rather than resolving `{ status: 0 }`, which is
    // why the surrounding code treats the throw as the real revert path
    // (#1556 review). But "believed dead" is not "proven dead", and without
    // this test the `receipt.status !== 1` guard is VACUOUS — deleting it
    // outright passes every other test in this file. Found by the #1742
    // review pass; kept so the branch cannot rot into a silent success if a
    // future ethers version, or a non-ethers provider shim, ever resolves it.
    waitMode = 'status-zero'

    const err = await revokeOnChain(84532, UID).catch((e: unknown) => e)

    expect(err).not.toBeInstanceOf(PassportRevokeUnconfirmedError)
    expect((err as Error).message).toMatch(/revocation reverted/)
    expect(failedSpy).toHaveBeenCalledTimes(1)
    expect(minedSpy).not.toHaveBeenCalled()
  })

  it('a mined revoke still closes the record mined', async () => {
    const result = await revokeOnChain(84532, UID)

    expect(result.txHash).toBe(TX_HASH)
    expect(trace).toEqual(['record:open', 'broadcast', 'record:mined'])
  })
})
