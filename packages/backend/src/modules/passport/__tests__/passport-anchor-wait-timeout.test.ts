/**
 * #1735 — what the passport anchor does when its transaction has not mined
 * by the deadline.
 *
 * `anchorOnChain` already BOUNDS its wait (`tx.wait(1, 120_000)`, #1556). The
 * half under test here is the DISPOSITION on expiry. ethers v6 rejects a
 * timed-out `wait()` with `code: 'TIMEOUT'`, and that rejection arrives in
 * the same `catch` as a genuine `CALL_EXCEPTION` revert — so a transaction
 * that merely has not mined yet, and may still mine, has its durable outbound
 * record (#1556) closed `failed` with a message that says "reverted".
 *
 * Separate file from `passport-outbound-record.test.ts` for the reason #1722
 * split its own: these tests stall a transaction under fake timers, which
 * does not mix with the ordering assertions next door.
 *
 * The `wait` mock mirrors ethers v6 verbatim (`providers/provider.js` →
 * `wait`): a transaction that never mines settles ONLY through the caller's
 * timeout argument, and never at all without one. A regression to a bare
 * `wait()` therefore HANGS these tests rather than quietly passing them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const TX_HASH = '0x' + 'cd'.repeat(32)
const UID = '0x' + 'ab'.repeat(32)

/** Which ending the stubbed transaction gets. */
let waitOutcome: 'timeout' | 'revert' | 'mined' | 'null-receipt' = 'timeout'
let waitCalls: Array<[confirms: number | undefined, timeoutMs: number | undefined]> = []

const minedSpy = vi.fn(async () => {})
const failedSpy = vi.fn(async (reason: string) => {
  void reason
})
const openSpy = vi.fn(async (params: { submitter: string; to: string; data: string }) => {
  void params
  return { id: 'rec-1', broadcast: vi.fn(async () => {}), mined: minedSpy, failed: failedSpy }
})
const submitSpy = vi.fn(async (params: { recordId: string | null }) => {
  void params
  return {
    hash: TX_HASH,
    nonce: 77,
    wait: async (confirms?: number, timeoutMs?: number) => {
      waitCalls.push([confirms, timeoutMs])
      if (waitOutcome === 'revert') {
        const err = new Error('transaction execution reverted') as Error & { code: string }
        err.code = 'CALL_EXCEPTION'
        throw err
      }
      if (waitOutcome === 'mined') return { status: 1 }
      if (waitOutcome === 'null-receipt') return null
      // 'timeout' — never mines. Without a deadline it never settles at all.
      if (timeoutMs == null) return await new Promise<never>(() => {})
      await new Promise((resolve) => setTimeout(resolve, timeoutMs))
      const err = new Error('wait for transaction timeout') as Error & { code: string }
      err.code = 'TIMEOUT'
      throw err
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
    attest = Object.assign(
      async () => {
        throw new Error('direct contract broadcast — must go through submitRecorded (#1559)')
      },
      { staticCall: async () => UID },
    )
  }
  return { ...actual, Contract: FakeContract }
})

const { anchorOnChain } = await import('../attestation.js')

const CLAIM = {
  agentEoa: '0x' + '22'.repeat(20),
  smartAccount: '0x' + '33'.repeat(20),
  treasury: '0x' + '44'.repeat(20),
  assuranceLevel: 0,
  policyUri: 'https://example.test/policy',
  issuedAt: 1_700_000_000,
  expiresAt: 1_800_000_000,
}

beforeEach(() => {
  process.env.AGENT_PASSPORT_SCHEMA_UID_84532 = UID
  waitOutcome = 'timeout'
  waitCalls = []
  vi.clearAllMocks()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

/** Drive the stalled wait past its deadline. */
async function anchorAndExpire(): Promise<unknown> {
  const pending = anchorOnChain(84532, CLAIM).catch((err: unknown) => err)
  await vi.advanceTimersByTimeAsync(200_000)
  return await pending
}

describe('passport anchor wait timeout (#1735, characterization)', () => {
  it('the wait is bounded — one confirmation, a real deadline (#1556)', async () => {
    await anchorAndExpire()
    expect(waitCalls).toHaveLength(1)
    const [confirms, timeoutMs] = waitCalls[0]
    expect(confirms).toBe(1)
    expect(timeoutMs).toBeTypeOf('number')
    expect(timeoutMs).toBeGreaterThan(0)
  })

  // CHARACTERIZATION — this is the #1735 bug, pinned before it is fixed.
  // A TIMEOUT cancels nothing: the transaction is still in the mempool and
  // may still mine. Today its durable record is closed `failed` anyway, with
  // a message asserting a revert that did not happen.
  it('TODAY: a timed-out wait closes the outbound record as failed', async () => {
    await anchorAndExpire()
    expect(failedSpy).toHaveBeenCalledTimes(1)
    expect(minedSpy).not.toHaveBeenCalled()
  })

  it('TODAY: the failure reason claims the attestation "reverted"', async () => {
    await anchorAndExpire()
    expect(failedSpy.mock.calls[0][0]).toContain('reverted')
  })

  it('TODAY: the caller sees the raw ethers TIMEOUT error, undistinguished from a revert', async () => {
    const err = (await anchorAndExpire()) as { code?: string }
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe('TIMEOUT')
  })

  // The branch that must NOT change: a genuine revert still closes failed.
  it('a genuine revert (CALL_EXCEPTION) closes the record failed', async () => {
    waitOutcome = 'revert'
    const err = (await anchorAndExpire()) as { code?: string }
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe('CALL_EXCEPTION')
    expect(failedSpy).toHaveBeenCalledTimes(1)
    expect(failedSpy.mock.calls[0][0]).toContain('reverted')
    expect(minedSpy).not.toHaveBeenCalled()
  })

  // CHARACTERIZATION — #690 records that a lagging RPC can hand back a null
  // receipt for a transaction that DID confirm. Today that is also called a
  // revert.
  it('TODAY: a null receipt closes the record as failed too', async () => {
    waitOutcome = 'null-receipt'
    await anchorAndExpire()
    expect(failedSpy).toHaveBeenCalledTimes(1)
    expect(failedSpy.mock.calls[0][0]).toContain('reverted')
  })

  it('a mined, successful attestation closes the record mined', async () => {
    waitOutcome = 'mined'
    const result = (await anchorAndExpire()) as { txHash: string; attestationUid: string }
    expect(result.txHash).toBe(TX_HASH)
    expect(result.attestationUid).toBe(UID)
    expect(minedSpy).toHaveBeenCalledTimes(1)
    expect(failedSpy).not.toHaveBeenCalled()
  })
})
