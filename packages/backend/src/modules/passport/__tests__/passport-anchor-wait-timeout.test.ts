/**
 * #1735 — what the passport anchor does when its transaction has not mined
 * by the deadline.
 *
 * `anchorOnChain` already BOUNDS its wait (`tx.wait(1, 120_000)`, #1556). The
 * half under test here is the DISPOSITION on expiry. ethers v6 rejects a
 * timed-out `wait()` with `code: 'TIMEOUT'`, and that rejection arrived in
 * the same `catch` as a genuine `CALL_EXCEPTION` revert — so a transaction
 * that merely had not mined yet, and might still mine, had its durable
 * outbound record (#1556) closed `failed` with a message saying "reverted".
 *
 * Since #1735 an expiry leaves the record OPEN (`broadcast`) and raises a
 * distinct {@link PassportAnchorUnconfirmedError}. That is not the deploy's
 * hand-off (#1722): nothing may re-broadcast or replace a `passport_attest`,
 * so `broadcast` here buys chain-first RECONCILIATION, not a bump. The retry
 * owner stays #1043's receipt recovery, keyed off the persisted tx hash.
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
let waitOutcome: 'timeout' | 'revert' | 'mined' | 'null-receipt' | 'network-error' = 'timeout'
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
      if (waitOutcome === 'network-error') {
        const err = new Error('could not reach the node') as Error & { code: string }
        err.code = 'NETWORK_ERROR'
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

const { anchorOnChain, PassportAnchorUnconfirmedError, PASSPORT_ANCHOR_CONFIRM_TIMEOUT_MS } =
  await import('../attestation.js')

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

describe('passport anchor wait timeout (#1735)', () => {
  it('the wait is bounded — one confirmation, a real deadline (#1556)', async () => {
    await anchorAndExpire()
    expect(waitCalls).toHaveLength(1)
    const [confirms, timeoutMs] = waitCalls[0]
    expect(confirms).toBe(1)
    expect(timeoutMs).toBeTypeOf('number')
    expect(timeoutMs).toBeGreaterThan(0)
  })

  // #1735 — a TIMEOUT cancels nothing: the transaction is still in the
  // mempool and may still mine. The record must stay `broadcast`, which is
  // the only true state and the only one the bump worker's chain-first scan
  // will reconcile.
  it('a timed-out wait leaves the outbound record OPEN — neither failed nor mined', async () => {
    await anchorAndExpire()
    expect(failedSpy).not.toHaveBeenCalled()
    expect(minedSpy).not.toHaveBeenCalled()
  })

  it('the caller gets a distinct unconfirmed error, not a revert', async () => {
    const err = (await anchorAndExpire()) as Error
    expect(err).toBeInstanceOf(PassportAnchorUnconfirmedError)
    expect(err.message).not.toContain('reverted')
    expect(err.message).toContain('may still mine')
  })

  // The tx hash must reach the caller: #1043's recovery is keyed off the hash
  // `onBroadcast` persisted, and that is what makes leaving the record open
  // safe rather than merely optimistic.
  it('the unconfirmed error carries the tx hash the recovery path needs', async () => {
    const err = (await anchorAndExpire()) as InstanceType<typeof PassportAnchorUnconfirmedError>
    expect(err.txHash).toBe(TX_HASH)
  })

  it('the deadline is the bracketed constant, below the 600s anchoring claim window', async () => {
    await anchorAndExpire()
    expect(waitCalls[0][1]).toBe(PASSPORT_ANCHOR_CONFIRM_TIMEOUT_MS)
    expect(PASSPORT_ANCHOR_CONFIRM_TIMEOUT_MS).toBeLessThan(600_000)
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

  // #690 records that a lagging RPC can hand back a null receipt for a
  // transaction that DID confirm. "Not observed" is not "reverted", so it
  // takes the same open branch as the timeout.
  it('a null receipt is also unconfirmed, not a revert', async () => {
    waitOutcome = 'null-receipt'
    const err = (await anchorAndExpire()) as Error
    expect(err).toBeInstanceOf(PassportAnchorUnconfirmedError)
    expect(failedSpy).not.toHaveBeenCalled()
    expect(minedSpy).not.toHaveBeenCalled()
  })

  // A non-TIMEOUT wait rejection is NOT given the benefit of the doubt: only
  // the deadline (and a null receipt) mean "unobserved". Anything else keeps
  // the pre-#1735 behaviour.
  it('a non-timeout wait error still closes the record failed', async () => {
    waitOutcome = 'network-error'
    const err = (await anchorAndExpire()) as { code?: string }
    expect(err).not.toBeInstanceOf(PassportAnchorUnconfirmedError)
    expect((err as { code?: string }).code).toBe('NETWORK_ERROR')
    expect(failedSpy).toHaveBeenCalledTimes(1)
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
