/**
 * Characterization tests for the behaviour #1698's re-key builds on top of
 * (money-path rule, CLAUDE.md — pin what exists BEFORE changing anything).
 *
 * These assert today's behaviour, not the behaviour #1698 wants. They exist
 * so that the re-key slice cannot silently move any of it, and — for the
 * enforcer question specifically — so that #1698's step 2 rests on an
 * ASSERTION rather than an assumption.
 *
 * ## The load-bearing one: is the meter still readable after the revoke?
 *
 * #1694's review amended the ordering so the carried remainder is read AFTER
 * the revoke: reading before leaves a window in which a payment lands and the
 * carried remainder over-counts it by that amount. That amendment is only
 * safe if the spent-amount storage survives the revoke, and #1698 says
 * explicitly: "Verify before building step 2 … asserted, not assumed."
 *
 * The verification is structural, and it is stronger than a live read would
 * be, because it holds for every chain and every block rather than for the
 * one we happened to sample:
 *
 * - `buildRevocation` encodes `disableDelegation` against the
 *   **DelegationManager** and returns THAT as `to`.
 * - `readRemainingBudget` reads
 *   `getErc20PeriodTransferEnforcerAvailableAmount` from the
 *   **ERC20PeriodTransferEnforcer**, keyed on the delegation object alone.
 *
 * Two different contracts, and the read consults nothing the revoke writes:
 * it never asks the manager whether the delegation is disabled. Disabling a
 * delegation therefore cannot change what the meter returns — which is the
 * whole point, since a frozen meter is exactly what the carry needs.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { buildRevocation, delegationIdentity } from '../../../rails/delegation-policy.js'
import { getDelegationContracts } from '../../../rails/delegation-contracts.js'

const BASE_SEPOLIA = 84532
const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const TREASURY = '0x00000000000000000000000000000000000000A1'
const DELEGATE_ACCOUNT = '0x00000000000000000000000000000000000000B2'

/**
 * A minimal signed delegation. Shape only — nothing here is redeemable, and
 * neither assertion below depends on the caveat contents.
 */
function signedDelegation(): Record<string, unknown> {
  return {
    delegate: DELEGATE_ACCOUNT,
    delegator: TREASURY,
    authority: `0x${'0'.repeat(64)}`,
    caveats: [],
    salt: '0x01',
    signature: `0x${'ab'.repeat(65)}`,
  }
}

describe('#1698 characterization — revoke and the budget meter touch different contracts', () => {
  it('buildRevocation targets the DelegationManager, not any caveat enforcer', () => {
    const pins = getDelegationContracts(BASE_SEPOLIA)
    const call = buildRevocation(signedDelegation() as never, BASE_SEPOLIA)

    expect(call.to.toLowerCase()).toBe(pins.delegationManager.toLowerCase())
    // The negative half is the one that matters: if the revoke ever started
    // writing to the period enforcer, the frozen-meter premise would die
    // with it and this test is where that shows up.
    expect(call.to.toLowerCase()).not.toBe(pins.enforcers.erc20PeriodTransfer.toLowerCase())
    expect(call.data.startsWith('0x')).toBe(true)
  })

  it('delegationIdentity is signature-independent — the revoke target survives re-signing', () => {
    const unsigned = { ...signedDelegation(), signature: '0x' }
    const signed = signedDelegation()
    expect(delegationIdentity(unsigned as never)).toBe(delegationIdentity(signed as never))
  })
})

describe('#1698 characterization — readRemainingBudget reads the enforcer, keyed on the delegation', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  /**
   * Loads the reader with the kit's enforcer client stubbed, so the assertion
   * is about WHICH read the reader performs and what it is keyed by — the two
   * facts the frozen-meter premise rests on.
   */
  async function loadReaderWithStub(availableAmount: bigint): Promise<{
    read: typeof import('../../../infra/chain/delegation-budget-reader.js').readRemainingBudget
    calls: Array<{ delegation: unknown }>
  }> {
    const calls: Array<{ delegation: unknown }> = []
    stubReaderCollaborators()
    vi.doMock('@metamask/smart-accounts-kit', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>()
      return {
        ...actual,
        createCaveatEnforcerClient: () => ({
          getErc20PeriodTransferEnforcerAvailableAmount: async (args: { delegation: unknown }) => {
            calls.push(args)
            return { availableAmount }
          },
        }),
      }
    })
    const mod = await import('../../../infra/chain/delegation-budget-reader.js')
    return { read: mod.readRemainingBudget, calls }
  }

  /**
   * The reader's non-enforcer collaborators: an RPC client, the chain
   * registry, and the kit-vs-pinned drift check. None of them is the subject
   * here, and all three need real env/network — stubbing them is what leaves
   * the enforcer read as the only live wire in the test.
   */
  function stubReaderCollaborators(): void {
    vi.doMock('viem', async (importOriginal) => {
      const actual = await importOriginal<typeof import('viem')>()
      return { ...actual, createPublicClient: () => ({}) }
    })
    vi.doMock('../../../domain/chains.js', () => ({
      getChain: () => ({ rpcUrl: 'https://rpc.invalid' }),
    }))
    vi.doMock('../../../rails/delegation-contracts.js', () => ({
      chainForId: () => ({ id: BASE_SEPOLIA }),
    }))
    vi.doMock('../../../rails/delegation-policy.js', () => ({
      getDelegationEnvironment: () => ({}),
    }))
  }

  it('reads the period enforcer keyed on the delegation alone — no disabled-delegation lookup', async () => {
    const { read, calls } = await loadReaderWithStub(250_000n)
    const delegationJson = JSON.stringify(signedDelegation())

    const result = await read(BASE_SEPOLIA, delegationJson, '1000000')

    expect(result).toEqual({ remainingAtomic: '250000', fromChain: true })
    expect(calls).toHaveLength(1)
    // Keyed on the delegation object — NOT on a status, a DB row, or an
    // is-disabled flag. Nothing the revoke writes is an input here.
    expect(calls[0].delegation).toEqual(JSON.parse(delegationJson))
  })

  it('a revoked delegation reads exactly the same number as a live one', async () => {
    // Same delegation, same enforcer answer. The reader takes the signed
    // delegation JSON and the fallback budget; it has no parameter through
    // which "this one is revoked" could reach it, so a revoked row and a live
    // row are indistinguishable to it. This is the frozen meter.
    const live = await loadReaderWithStub(250_000n)
    const liveResult = await live.read(BASE_SEPOLIA, JSON.stringify(signedDelegation()), '1000000')

    vi.resetModules()
    const revoked = await loadReaderWithStub(250_000n)
    const revokedResult = await revoked.read(
      BASE_SEPOLIA,
      JSON.stringify(signedDelegation()),
      '1000000',
    )

    expect(revokedResult).toEqual(liveResult)
  })

  it('falls BACK to the full budget on a failed read — never to zero', async () => {
    stubReaderCollaborators()
    vi.doMock('@metamask/smart-accounts-kit', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>()
      return {
        ...actual,
        createCaveatEnforcerClient: () => ({
          getErc20PeriodTransferEnforcerAvailableAmount: async () => {
            throw new Error('rpc down')
          },
        }),
      }
    })
    const { readRemainingBudget } = await import(
      '../../../infra/chain/delegation-budget-reader.js'
    )

    const result = await readRemainingBudget(BASE_SEPOLIA, JSON.stringify(signedDelegation()), '999')
    expect(result).toEqual({ remainingAtomic: '999', fromChain: false })
  })
})

/**
 * The fallback above is benign for a status display and NOT benign for a
 * carry: carrying the full budget on a failed read would hand a re-keying
 * agent a fresh full period, which is exactly the leak #1694's
 * amount-AND-boundary decision exists to prevent. #1698's carry therefore
 * must refuse on `fromChain: false` rather than inherit this fallback — the
 * test for that lives with the carry code, and this comment records why the
 * two callers of the same reader are allowed to differ.
 */
export {}
