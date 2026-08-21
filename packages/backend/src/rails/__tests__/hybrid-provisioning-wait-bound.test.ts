/**
 * #1722 — what the hybrid deploy does when its transaction never mines.
 *
 * The wait is bounded (`tx.wait(1, HYBRID_DEPLOY_CONFIRM_TIMEOUT_MS)`), and
 * the interesting half is the DISPOSITION on expiry: a timeout cancels
 * nothing, so the transaction may still mine and its durable outbound record
 * must be left `broadcast` for the bump worker (#1558) to adopt — never
 * marked failed, which would strand it between two owners and make a
 * later-mined deploy look wrong.
 *
 * Separate file from `hybrid-provisioning-outbound.test.ts` for one concrete
 * reason: these tests stall a transaction under fake timers, and the #1673
 * advisory lock is a REAL Postgres lock when a database is reachable — a
 * stalled holder would park every later caller and hold a session across a
 * clock that is not moving. Here the lock is stubbed to a pass-through, so
 * the deploy runs unserialised. That is the right trade for this file:
 * serialisation is proven next door and in the lock's own real-Postgres
 * tests, and what is under test is the wait, not the lock.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const TX_HASH = '0x' + 'ee'.repeat(32)
const FACTORY = '0x' + '77'.repeat(20)
const FACTORY_DATA = '0x' + '88'.repeat(40)

/** Reverting instead of stalling, to prove the two branches stay distinct. */
let waitReverts = false
let waitCalls: Array<[confirms: number | undefined, timeoutMs: number | undefined]> = []

const minedSpy = vi.fn(async () => {})
const failedSpy = vi.fn(async () => {})
const openSpy = vi.fn(async (params: { submitter: string; to: string; data: string }) => {
  void params
  return { id: 'rec-1', broadcast: vi.fn(async () => {}), mined: minedSpy, failed: failedSpy }
})
const submitSpy = vi.fn(async (params: { recordId: string | null }) => {
  void params
  return {
    hash: TX_HASH,
    nonce: 9,
    // Mirrors ethers v6 verbatim (`providers/provider.js` → `wait`): a tx
    // that never mines settles ONLY through the caller's timeout argument,
    // and never at all without one. So a regression to a bare `wait()` makes
    // these tests hang rather than quietly pass — which is the point.
    wait: async (confirms?: number, timeoutMs?: number) => {
      waitCalls.push([confirms, timeoutMs])
      if (waitReverts) {
        const err = new Error('transaction execution reverted') as Error & { code: string }
        err.code = 'CALL_EXCEPTION'
        throw err
      }
      if (timeoutMs == null) return await new Promise<never>(() => {})
      await new Promise((resolve) => setTimeout(resolve, timeoutMs))
      const err = new Error('wait for transaction timeout') as Error & { code: string }
      err.code = 'TIMEOUT'
      throw err
    },
  }
})
vi.mock('../../infra/outbound-queue.js', () => ({
  openOutboundRecord: openSpy,
  submitRecorded: submitSpy,
}))

const finishSpy = vi.fn(
  async (spendId: string, stamp: { txHash: string; gasUsed: bigint | null }) => {
    void spendId
    void stamp
  },
)
vi.mock('../../infra/relayer-spend-guard.js', () => ({
  assertRelayerBudget: vi.fn(async () => undefined),
  recordRelayerSpend: vi.fn(async () => 'spend-1'),
  finishRelayerSpend: finishSpy,
}))

vi.mock('../../infra/relayer.js', async () => {
  const actual = await vi.importActual<typeof import('../../infra/relayer.js')>('../../infra/relayer.js')
  return {
    ...actual,
    getRelayerFeeOverrides: async () => ({ maxFeePerGas: 3n }),
    getRelayer: () => ({ provider: {} }),
  }
})

// The lock itself is a COLLABORATOR here, not the subject (see the file
// header): run the critical section straight through, so no Postgres session
// is held while these tests stall a transaction under fake timers. What the
// lock does is proven — against real Postgres — in
// `platform/__tests__/keyed-advisory-lock.test.ts` and next door in
// `hybrid-provisioning-outbound.test.ts`. Note this is NOT a database mock:
// no query behaviour is faked, the call simply does not reach a database.
vi.mock('../../platform/leader-lock.js', async () => {
  const actual = await vi.importActual<typeof import('../../platform/leader-lock.js')>(
    '../../platform/leader-lock.js',
  )
  return {
    ...actual,
    withKeyedAdvisoryLock: async <T>(
      _namespace: number,
      _subject: string,
      fn: () => Promise<T>,
    ): Promise<T> => fn(),
  }
})

vi.mock('viem', async () => {
  const actual = await vi.importActual<typeof import('viem')>('viem')
  return {
    ...actual,
    createPublicClient: () => ({ getBytecode: async () => '0x' }),
  }
})
vi.mock('@metamask/smart-accounts-kit', async () => {
  const actual = await vi.importActual<typeof import('@metamask/smart-accounts-kit')>('@metamask/smart-accounts-kit')
  return {
    ...actual,
    toMetaMaskSmartAccount: async () => ({
      address: '0x' + '99'.repeat(20),
      getFactoryArgs: async () => ({ factory: FACTORY, factoryData: FACTORY_DATA }),
    }),
  }
})

const { REBROADCAST_SAFE_SUBMITTERS, STALE_BROADCAST_SECONDS } = await import(
  '../../infra/outbound-bump-worker.js'
)
const { ensureHybridDeployed, HYBRID_DEPLOY_CONFIRM_TIMEOUT_MS, HybridDeployUnconfirmedError } =
  await import('../hybrid-provisioning.js')

const OWNER = { ownerAddress: ('0x' + 'aa'.repeat(20)) as `0x${string}` }

// Warm the deploy path's LAZY imports (`relayer-spend-guard`, `relayer`,
// `outbound-queue` are imported inside the function) on real timers. Module
// loading under fake timers would otherwise stall the first test that
// installs them — a harness artefact, not a behaviour.
beforeAll(async () => {
  waitReverts = true
  await ensureHybridDeployed(84532, OWNER).catch(() => undefined)
  waitReverts = false
})

beforeEach(() => {
  waitReverts = false
  waitCalls = []
  vi.clearAllMocks()
})

describe('an unmined hybrid deploy (#1722)', () => {
  it('returns by the deadline instead of waiting forever', async () => {
    vi.useFakeTimers()
    try {
      const settled = ensureHybridDeployed(84532, OWNER).catch((err: unknown) => err)

      // One tick short of the deadline it is still waiting, as it should be —
      // the deadline is what ends the wait, not some earlier give-up.
      await vi.advanceTimersByTimeAsync(HYBRID_DEPLOY_CONFIRM_TIMEOUT_MS - 1)
      expect(await Promise.race([settled, Promise.resolve('pending')])).toBe('pending')

      await vi.advanceTimersByTimeAsync(1)
      const err = await settled
      expect(err).toBeInstanceOf(HybridDeployUnconfirmedError)
      expect((err as InstanceType<typeof HybridDeployUnconfirmedError>).txHash).toBe(TX_HASH)
      expect(waitCalls).toEqual([[1, HYBRID_DEPLOY_CONFIRM_TIMEOUT_MS]])
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves the record BROADCAST for the bump worker — never failed', async () => {
    vi.useFakeTimers()
    try {
      const settled = ensureHybridDeployed(84532, OWNER).catch((err: unknown) => err)
      await vi.advanceTimersByTimeAsync(HYBRID_DEPLOY_CONFIRM_TIMEOUT_MS)
      await settled

      // Neither close is called, so the row keeps the status `submitRecorded`
      // stamped: `broadcast`. That is the state the bump worker's unmined
      // scan adopts — proven against real Postgres for this submitter in
      // `infra/repositories/__tests__/outbound-txs.test.ts` (#1722).
      expect(failedSpy).not.toHaveBeenCalled()
      expect(minedSpy).not.toHaveBeenCalled()

      // And adoption is only safe because a second hybrid deploy is
      // idempotent on-chain, which the worker's own list records.
      const submitter = openSpy.mock.calls[0][0].submitter
      expect(submitter).toBe('hybrid_deploy')
      expect(REBROADCAST_SAFE_SUBMITTERS.has(submitter)).toBe(true)

      // The deadline must expire BEFORE the worker adopts the row, or the
      // caller and the worker own the same transaction at once.
      expect(HYBRID_DEPLOY_CONFIRM_TIMEOUT_MS).toBeLessThan(STALE_BROADCAST_SECONDS * 1_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('still stamps the #717 gas spend — a stuck deploy burned gas too', async () => {
    vi.useFakeTimers()
    try {
      const settled = ensureHybridDeployed(84532, OWNER).catch((err: unknown) => err)
      await vi.advanceTimersByTimeAsync(HYBRID_DEPLOY_CONFIRM_TIMEOUT_MS)
      await settled

      expect(finishSpy).toHaveBeenCalledTimes(1)
      expect(finishSpy.mock.calls[0][1]).toMatchObject({ txHash: TX_HASH, gasUsed: null })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a REVERT is still a revert — the hand-off branch does not swallow it', async () => {
    waitReverts = true

    const err = await ensureHybridDeployed(84532, OWNER).catch((e: unknown) => e)

    expect(err).not.toBeInstanceOf(HybridDeployUnconfirmedError)
    expect((err as Error).message).toMatch(/reverted/)
    // A mined-and-reverted deploy IS finished: the record closes failed, and
    // handing it to the bump worker would re-broadcast a known-bad tx.
    expect(failedSpy).toHaveBeenCalledTimes(1)
  })
})
