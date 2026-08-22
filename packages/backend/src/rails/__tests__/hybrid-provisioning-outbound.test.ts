/**
 * #1556 — the hybrid deploy keeps its durable outbound record honestly:
 * opened BEFORE the broadcast, stamped with the broadcast's identifiers,
 * closed from the receipt — including the REAL ethers v6 revert shape, where
 * wait() THROWS rather than resolving `{ status: 0 }`. The interleaving with
 * the #717 spend-guard is the part worth pinning: the spend stamp lives in a
 * finally and must still run when the record closes as failed.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const TX_HASH = '0x' + 'ee'.repeat(32)
const FACTORY = '0x' + '77'.repeat(20)
const FACTORY_DATA = '0x' + '88'.repeat(40)

const trace: string[] = []
let waitReverts = false
/** #1722: the tx never mines — the wait settles only via its own timeout arg. */
let waitStalls = false
/** Exactly what the deploy passes to `wait()`, per call. */
let waitCalls: Array<[confirms: number | undefined, timeoutMs: number | undefined]> = []

type Stamp = { hash: string; nonce: number | bigint }
const broadcastSpy = vi.fn(async (stamp: Stamp) => {
  trace.push('record:broadcast')
  void stamp
})
const minedSpy = vi.fn(async () => {
  trace.push('record:mined')
})
const failedSpy = vi.fn(async () => {
  trace.push('record:failed')
})
const openSpy = vi.fn(async (params: { submitter: string; to: string; data: string }) => {
  trace.push('record:open')
  void params
  return { id: 'rec-1', broadcast: broadcastSpy, mined: minedSpy, failed: failedSpy }
})
const submitSpy = vi.fn(async (params: { recordId: string | null }) => {
  trace.push('broadcast')
  void params
  return {
    hash: TX_HASH,
    nonce: 9,
    wait: async (confirms?: number, timeoutMs?: number) => {
      waitCalls.push([confirms, timeoutMs])
      if (waitReverts) {
        const err = new Error('transaction execution reverted') as Error & { code: string }
        err.code = 'CALL_EXCEPTION'
        throw err
      }
      if (waitStalls) {
        // Mirrors ethers v6 verbatim (`providers/provider.js` → `wait`): a tx
        // that never mines settles ONLY through the caller's timeout argument,
        // and with none it never settles at all.
        if (timeoutMs == null) return await new Promise<never>(() => {})
        await new Promise((resolve) => setTimeout(resolve, timeoutMs))
        const err = new Error('wait for transaction timeout') as Error & { code: string }
        err.code = 'TIMEOUT'
        throw err
      }
      return { status: 1, gasUsed: 100n, gasPrice: 5n }
    },
  }
})
vi.mock('../../infra/outbound-queue.js', () => ({
  openOutboundRecord: openSpy,
  submitRecorded: submitSpy,
}))

const finishSpy = vi.fn(async () => {
  trace.push('spend:finish')
})
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

// The counterfactual account: derived via viem + the kit — faked to the two
// members ensureHybridDeployed actually uses.
// #1673: bytecode is a variable rather than a constant '0x', so a test can
// model the state a QUEUED caller finds after the winner's deploy mines.
let deployedBytecode = '0x'
vi.mock('viem', async () => {
  const actual = await vi.importActual<typeof import('viem')>('viem')
  return {
    ...actual,
    createPublicClient: () => ({ getBytecode: async () => deployedBytecode }),
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

const { STALE_BROADCAST_SECONDS } = await import('../../infra/outbound-bump-worker.js')
const { ensureHybridDeployed, HYBRID_DEPLOY_CONFIRM_TIMEOUT_MS } = await import(
  '../hybrid-provisioning.js'
)
const OWNER = { ownerAddress: ('0x' + 'aa'.repeat(20)) as `0x${string}` }

// Warm the deploy path's LAZY imports (`relayer-spend-guard`, `relayer` and
// `outbound-queue` are imported INSIDE the function) and the advisory lock's
// first pool connection, so the first real test is not the one paying for
// them. Both costs are harness artefacts, and on a loaded machine they were
// enough to push that test past vitest's 5 s default on their own.
beforeAll(async () => {
  deployedBytecode = '0x'
  await ensureHybridDeployed(84532, OWNER).catch(() => undefined)
})

beforeEach(() => {
  trace.length = 0
  waitReverts = false
  waitStalls = false
  waitCalls = []
  deployedBytecode = '0x'
  vi.clearAllMocks()
})

describe('hybrid deploy outbound record (#1556)', () => {
  it('opens the record BEFORE broadcasting, stamps the broadcast, closes mined', async () => {
    const result = await ensureHybridDeployed(84532, OWNER)

    expect(result.txHash).toBe(TX_HASH)
    expect(trace).toEqual(['record:open', 'broadcast', 'spend:finish', 'record:mined'])
    expect(openSpy.mock.calls[0][0]).toMatchObject({
      submitter: 'hybrid_deploy',
      to: FACTORY,
      data: FACTORY_DATA,
    })
    // Fence wiring + the deploy's fee headroom rides through the pipeline.
    expect(submitSpy.mock.calls[0][0]).toMatchObject({ recordId: 'rec-1', to: FACTORY, maxFeePerGas: 3n })
  })

  it('a REVERT (wait throws, real ethers v6) closes the record failed — and the #717 spend stamp still runs', async () => {
    waitReverts = true
    await expect(ensureHybridDeployed(84532, OWNER)).rejects.toThrow('reverted')
    expect(trace).toEqual(['record:open', 'broadcast', 'spend:finish', 'record:failed'])
    expect(minedSpy).not.toHaveBeenCalled()
    expect(finishSpy).toHaveBeenCalledTimes(1)
  })
})

/**
 * #1673 — the deploy is serialised per (chain, address).
 *
 * #1667 put `ensureHybridDeployed` on every erc7710 authorize, so a brand-new
 * agent paying two merchants at once reaches the bytecode check twice with
 * different idempotency keys — outside the #961 replay dedupe. Both used to
 * pass and both broadcast a deploy to the same CREATE2 address.
 */
describe('concurrent first payments deploy once (#1673)', () => {
  it('MUTATION PROOF: two concurrent calls broadcast ONE deploy, and the loser reports alreadyDeployed', async () => {
    // The winner's deploy makes the account real; model that by flipping the
    // bytecode when the broadcast happens, which is what the queued caller's
    // second check will see.
    submitSpy.mockImplementationOnce(async (params: { recordId: string | null }) => {
      trace.push('broadcast')
      void params
      deployedBytecode = '0x60016001'
      return {
        hash: TX_HASH,
        nonce: 9,
        wait: async () => ({ status: 1, gasUsed: 100n, gasPrice: 5n }),
      }
    })

    const [a, b] = await Promise.all([
      ensureHybridDeployed(84532, OWNER),
      ensureHybridDeployed(84532, OWNER),
    ])

    // Exactly one broadcast — remove the lock and this is 2, which is the
    // wasted relayer gas spend the issue reports.
    expect(trace.filter((t) => t === 'broadcast')).toHaveLength(1)
    expect(openSpy).toHaveBeenCalledTimes(1)

    const outcomes = [a.alreadyDeployed, b.alreadyDeployed].sort()
    expect(outcomes).toEqual([false, true])
    // Both callers still get a usable answer — the loser is not an error.
    expect(a.address).toBe(b.address)
  })

  it('a caller arriving AFTER the deploy never reaches the relayer at all', async () => {
    deployedBytecode = '0x60016001'

    const result = await ensureHybridDeployed(84532, OWNER)

    expect(result.alreadyDeployed).toBe(true)
    expect(submitSpy).not.toHaveBeenCalled()
    expect(openSpy).not.toHaveBeenCalled()
  })
})

/**
 * #1722 — the confirmation wait now carries an explicit bound.
 *
 * The characterization this replaces (previous commit) recorded the old call:
 * `tx.wait()` bare, which in ethers v6 waits indefinitely. What EXPIRY does
 * needs a stalled tx and fake timers, which do not mix with this file's live
 * advisory lock — that half lives in `hybrid-provisioning-wait-bound.test.ts`.
 */
describe('the deploy confirmation wait is bounded (#1722)', () => {
  it('passes ONE confirmation and an explicit deadline, below the bump worker s adoption age', async () => {
    await ensureHybridDeployed(84532, OWNER)
    expect(waitCalls).toEqual([[1, HYBRID_DEPLOY_CONFIRM_TIMEOUT_MS]])

    // The ceiling that makes the value defensible rather than round: the
    // caller must be gone before the bump worker adopts the row, or the two
    // own the same transaction at once.
    expect(HYBRID_DEPLOY_CONFIRM_TIMEOUT_MS).toBeLessThan(STALE_BROADCAST_SECONDS * 1_000)
  })
})
