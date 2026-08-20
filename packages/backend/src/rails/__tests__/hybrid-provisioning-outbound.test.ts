/**
 * #1556 — the hybrid deploy keeps its durable outbound record honestly:
 * opened BEFORE the broadcast, stamped with the broadcast's identifiers,
 * closed from the receipt — including the REAL ethers v6 revert shape, where
 * wait() THROWS rather than resolving `{ status: 0 }`. The interleaving with
 * the #717 spend-guard is the part worth pinning: the spend stamp lives in a
 * finally and must still run when the record closes as failed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const TX_HASH = '0x' + 'ee'.repeat(32)
const FACTORY = '0x' + '77'.repeat(20)
const FACTORY_DATA = '0x' + '88'.repeat(40)

const trace: string[] = []
let waitReverts = false

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
    wait: async () => {
      if (waitReverts) {
        const err = new Error('transaction execution reverted') as Error & { code: string }
        err.code = 'CALL_EXCEPTION'
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

const { ensureHybridDeployed } = await import('../hybrid-provisioning.js')
const OWNER = { ownerAddress: ('0x' + 'aa'.repeat(20)) as `0x${string}` }

beforeEach(() => {
  trace.length = 0
  waitReverts = false
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
