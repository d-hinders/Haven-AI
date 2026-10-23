/**
 * #4023 — the deploy path carries the STORED deploy salt, and a derivation
 * that does not land on the caller's known address refuses BEFORE any
 * relayer interaction. Mock stack mirrors
 * `hybrid-provisioning-outbound.test.ts` (#1556); the kit is faked to a
 * salt-keyed derivation so the tests can see WHICH account would be brought
 * up. The real kit's salt behavior is pinned offline by the characterization
 * fixture (`hybrid-provisioning-salt.characterization.test.ts`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const FACTORY = '0x' + '77'.repeat(20)
const FACTORY_DATA = '0x' + '88'.repeat(40)

/** The salt-0 and counter-1 derivations of the test owner (offline-pinned). */
const SALT0_ADDRESS = ('0x' + '11'.repeat(20)) as `0x${string}`
const SALT1_ADDRESS = ('0x' + '22'.repeat(20)) as `0x${string}`
const SALT_ONE = ('0x' + '00'.repeat(31) + '01') as `0x${string}`
const ZERO_SALT = ('0x' + '00'.repeat(32)) as `0x${string}`

const recordRelayerSpend = vi.fn(async () => 'spend-1')
vi.mock('../../infra/relayer-spend-guard.js', () => ({
  assertRelayerBudget: vi.fn(async () => undefined),
  recordRelayerSpend: (...a: unknown[]) => recordRelayerSpend(...(a as [])),
  finishRelayerSpend: vi.fn(async () => undefined),
}))

const openOutboundRecord = vi.fn(async () => ({
  id: 'rec-1',
  broadcast: vi.fn(async () => undefined),
  mined: vi.fn(async () => undefined),
  failed: vi.fn(async () => undefined),
}))
const submitRecorded = vi.fn(async () => ({
  hash: '0x' + 'ee'.repeat(32),
  nonce: 9,
  wait: async () => ({ status: 1, gasUsed: 100n, gasPrice: 5n }),
}))
vi.mock('../../infra/outbound-queue.js', () => ({ openOutboundRecord, submitRecorded }))

vi.mock('../../infra/relayer.js', async () => {
  const actual = await vi.importActual<typeof import('../../infra/relayer.js')>('../../infra/relayer.js')
  return {
    ...actual,
    getRelayerFeeOverrides: async () => ({ maxFeePerGas: 3n }),
    getRelayer: () => ({ provider: {} }),
  }
})

// No code anywhere: every ensure call takes the deploy branch.
vi.mock('viem', async () => {
  const actual = await vi.importActual<typeof import('viem')>('viem')
  return {
    ...actual,
    createPublicClient: () => ({ getBytecode: async () => '0x' }),
  }
})

// The kit, faked to a SALT-KEYED counterfactual derivation: the deploy salt
// the config carries decides which account comes up.
vi.mock('@metamask/smart-accounts-kit', async () => {
  const actual = await vi.importActual<typeof import('@metamask/smart-accounts-kit')>('@metamask/smart-accounts-kit')
  return {
    ...actual,
    toMetaMaskSmartAccount: async (opts: { deploySalt?: string }) => ({
      address: (!opts.deploySalt || opts.deploySalt === ZERO_SALT ? SALT0_ADDRESS : SALT1_ADDRESS) as `0x${string}`,
      getFactoryArgs: async () => ({ factory: FACTORY, factoryData: FACTORY_DATA }),
    }),
  }
})

const { ensureHybridDeployed, ensureDelegateHybridDeployed, HybridDerivationMismatchError } = await import(
  '../hybrid-provisioning.js'
)

const OWNER = { ownerAddress: ('0x' + 'aa'.repeat(20)) as `0x${string}` }
const SALTED_OWNER = { ...OWNER, deploySalt: SALT_ONE }

beforeEach(() => {
  recordRelayerSpend.mockClear()
  openOutboundRecord.mockClear()
  submitRecorded.mockClear()
})

describe('salted deploy (#4023)', () => {
  it('deploys the SALTED derivation for a salted account', async () => {
    const result = await ensureHybridDeployed(84532, SALTED_OWNER, SALT1_ADDRESS, {
      agentId: 'agent-1',
      userId: 'user-1',
    })
    // The salted address is the one deployed — not the salt-0 account.
    expect(result.address).toBe(SALT1_ADDRESS)
    expect(result.alreadyDeployed).toBe(false)
    expect(recordRelayerSpend).toHaveBeenCalledTimes(1)
    expect(openOutboundRecord).toHaveBeenCalledTimes(1)
  })

  it('REFUSES BEFORE ANY RELAYER SPEND when the derivation misses the known address', async () => {
    // A config whose salt is missing derives the salt-0 account; the caller
    // knows the salted one. Pre-#4023 this broadcast a spurious deploy and
    // let the caller 500 afterwards — relayer gas on an account nobody owns.
    await expect(
      ensureHybridDeployed(84532, { ...OWNER, deploySalt: '0x' }, SALT1_ADDRESS, { userId: 'user-1' }),
    ).rejects.toBeInstanceOf(HybridDerivationMismatchError)
    expect(recordRelayerSpend).not.toHaveBeenCalled()
    expect(openOutboundRecord).not.toHaveBeenCalled()
    expect(submitRecorded).not.toHaveBeenCalled()
  })

  it('keeps the DELEGATE deploy at the literal salt 0x, whatever the user path does', async () => {
    const result = await ensureDelegateHybridDeployed(84532, OWNER, SALT0_ADDRESS)
    expect(result.address).toBe(SALT0_ADDRESS)
    expect(result.alreadyDeployed).toBe(false)
    expect(recordRelayerSpend).toHaveBeenCalledTimes(1)
  })
})
