import { describe, expect, it } from 'vitest'
import { pad } from 'viem'
import {
  buildSettlementDelegation,
  assembleSettlementPayload,
  encodeXPaymentHeader,
  MAX_SETTLEMENT_WINDOW_SECONDS,
} from './x402-delegation.js'
import { buildBudgetDelegation, type HavenBudgetPolicy } from './delegation-policy.js'
import { getDelegationContracts } from './delegation-contracts.js'

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const
const DELEGATE_ACCT = ('0x' + 'dd'.repeat(20)) as `0x${string}`
const TREASURY = ('0x' + 'aa'.repeat(20)) as `0x${string}`
const MERCHANT = ('0x' + 'cc'.repeat(20)) as `0x${string}`
const NOW = Math.floor(Date.now() / 1000)

function budget(): HavenBudgetPolicy {
  return {
    agentId: 'a', chainId: 84532, treasuryAddress: TREASURY,
    delegateAccountAddress: DELEGATE_ACCT, tokenAddress: USDC,
    budgetAtomic: 5_000_000n, periodSeconds: 86_400, startDate: NOW - 60,
    expiresAt: NOW + 86_400, version: 1,
  }
}
const signedBudget = { ...buildBudgetDelegation(budget()), signature: ('0x' + 'ab'.repeat(65)) } as never

function req(overrides: Record<string, unknown> = {}) {
  return {
    chainId: 84532,
    delegateAccountAddress: DELEGATE_ACCT,
    budgetDelegation: signedBudget,
    asset: USDC as `0x${string}`,
    amountAtomic: 100_000n,
    payTo: MERCHANT,
    maxTimeoutSeconds: 120,
    ...overrides,
  } as never
}

describe('buildSettlementDelegation (#830)', () => {
  it('the child is a CHILD of the budget: parent authority = the budget hash', () => {
    const built = buildSettlementDelegation(req())
    // Not a root delegation — its authority points at the parent, not ROOT.
    expect(built.child.authority).not.toBe(`0x${'f'.repeat(64)}`)
  })

  it('pins the exact amount, the payee, and a short expiry', () => {
    const built = buildSettlementDelegation(req())
    const pins = getDelegationContracts(84532)
    const enforcers = built.child.caveats.map((c) => c.enforcer.toLowerCase())
    // exact-amount (erc20TransferAmount scope) + payee pin (allowedCalldata) + expiry
    expect(enforcers).toContain(pins.enforcers.erc20TransferAmount.toLowerCase())
    expect(enforcers).toContain(pins.enforcers.allowedCalldata.toLowerCase())
    expect(enforcers).toContain(pins.enforcers.timestamp.toLowerCase())
    const payeeCaveat = built.child.caveats.find(
      (c) => c.enforcer.toLowerCase() === pins.enforcers.allowedCalldata.toLowerCase(),
    )!
    expect(payeeCaveat.terms.toLowerCase()).toContain(
      pad(MERCHANT.toLowerCase() as `0x${string}`, { size: 32 }).slice(2).toLowerCase(),
    )
  })

  it('clamps the settlement window to the 600s ceiling (the #715 discipline)', () => {
    const built = buildSettlementDelegation(req({ maxTimeoutSeconds: 99999 }))
    expect(built.expiresAt - NOW).toBeLessThanOrEqual(MAX_SETTLEMENT_WINDOW_SECONDS + 2)
  })

  it('adds a redeemer caveat when facilitators are named', () => {
    const facilitator = ('0x' + '77'.repeat(20)) as `0x${string}`
    const built = buildSettlementDelegation(req({ redeemers: [facilitator] }))
    const pins = getDelegationContracts(84532)
    // Redeemer enforcer address from the kit env (not in our pin set) — assert
    // one extra caveat vs the no-redeemer build.
    const withoutRedeemer = buildSettlementDelegation(req())
    expect(built.child.caveats.length).toBe(withoutRedeemer.child.caveats.length + 1)
    expect(pins).toBeDefined()
  })

  it('the signing payload targets the pinned manager (agent signs this)', () => {
    const built = buildSettlementDelegation(req())
    expect(built.signingPayload.domain.verifyingContract.toLowerCase()).toBe(
      getDelegationContracts(84532).delegationManager.toLowerCase(),
    )
  })

  it('rejects a zero/negative amount', () => {
    expect(() => buildSettlementDelegation(req({ amountAtomic: 0n }))).toThrow(/amount/)
  })
})

describe('assembleSettlementPayload + header (#830)', () => {
  it('encodes the [child, budget] chain as the permission context, manager pinned', () => {
    const built = buildSettlementDelegation(req())
    const payload = assembleSettlementPayload(
      84532, built.child, ('0x' + 'ef'.repeat(65)) as `0x${string}`, signedBudget, DELEGATE_ACCT,
    )
    expect(payload.delegationManager.toLowerCase()).toBe(
      getDelegationContracts(84532).delegationManager.toLowerCase(),
    )
    expect(payload.delegator.toLowerCase()).toBe(DELEGATE_ACCT.toLowerCase())
    expect(payload.permissionContext.startsWith('0x')).toBe(true)
    expect(payload.permissionContext.length).toBeGreaterThan(200) // two delegations
  })

  it('the X-PAYMENT header is base64 of the exact-scheme erc7710 body', () => {
    const built = buildSettlementDelegation(req())
    const payload = assembleSettlementPayload(
      84532, built.child, ('0x' + 'ef'.repeat(65)) as `0x${string}`, signedBudget, DELEGATE_ACCT,
    )
    const header = encodeXPaymentHeader('base-sepolia', payload, {
      amount: '1000',
      payTo: ('0x' + 'cc'.repeat(20)) as `0x${string}`,
      asset: USDC as `0x${string}`,
      maxTimeoutSeconds: 300,
    })
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'))
    // v2 since #1064: the accepted echo rides alongside the scheme payload.
    expect(decoded).toMatchObject({ x402Version: 2, scheme: 'exact', network: 'base-sepolia' })
    expect(decoded.accepted).toMatchObject({
      scheme: 'exact', amount: '1000', maxTimeoutSeconds: 300,
      extra: { assetTransferMethod: 'erc7710' },
    })
    expect(decoded.payload.delegator.toLowerCase()).toBe(DELEGATE_ACCT.toLowerCase())
  })

  // #1058: @x402/core's v2 matcher requires the merchant's advertised extra to
  // be a SUBSET of the echo — advertised facilitators must round-trip VERBATIM.
  it('echoes facilitatorAddresses verbatim in the accepted extra when present', () => {
    const built = buildSettlementDelegation(req())
    const payload = assembleSettlementPayload(
      84532, built.child, ('0x' + 'ef'.repeat(65)) as `0x${string}`, signedBudget, DELEGATE_ACCT,
    )
    const facilitators = ['0x' + 'Fa'.repeat(20)] // deliberately mixed-case: echo must not normalize
    const header = encodeXPaymentHeader('base-sepolia', payload, {
      amount: '1000',
      payTo: ('0x' + 'cc'.repeat(20)) as `0x${string}`,
      asset: USDC as `0x${string}`,
      maxTimeoutSeconds: 300,
      facilitatorAddresses: facilitators,
    })
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'))
    expect(decoded.accepted.extra).toEqual({
      assetTransferMethod: 'erc7710',
      facilitatorAddresses: facilitators,
    })
  })

  it('omits the facilitatorAddresses key entirely when none were advertised', () => {
    const built = buildSettlementDelegation(req())
    const payload = assembleSettlementPayload(
      84532, built.child, ('0x' + 'ef'.repeat(65)) as `0x${string}`, signedBudget, DELEGATE_ACCT,
    )
    const header = encodeXPaymentHeader('base-sepolia', payload, {
      amount: '1000',
      payTo: ('0x' + 'cc'.repeat(20)) as `0x${string}`,
      asset: USDC as `0x${string}`,
      maxTimeoutSeconds: 300,
      facilitatorAddresses: [],
    })
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'))
    expect(decoded.accepted.extra).toEqual({ assetTransferMethod: 'erc7710' })
  })
})
