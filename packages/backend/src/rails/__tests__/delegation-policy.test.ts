import { describe, expect, it } from 'vitest'
import { pad } from 'viem'
import {
  buildBudgetDelegation,
  buildMultiTokenBudgetDelegation,
  buildRevocation,
  delegationIdentity,
  delegationSigningPayload,
  getDelegationEnvironment,
  type HavenBudgetPolicy,
} from '../delegation-policy.js'
import { getDelegationContracts } from '../delegation-contracts.js'

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const
const EURE = ('0x' + '99'.repeat(20)) as `0x${string}`
const TREASURY = ('0x' + 'aa'.repeat(20)) as `0x${string}`
const DELEGATE = ('0x' + 'bb'.repeat(20)) as `0x${string}`
const RECIPIENT = ('0x' + 'cc'.repeat(20)) as `0x${string}`
const NOW = 1_900_000_000

function policy(overrides: Partial<HavenBudgetPolicy> = {}): HavenBudgetPolicy {
  return {
    agentId: '11111111-1111-1111-1111-111111111111',
    chainId: 84532,
    treasuryAddress: TREASURY,
    delegateAccountAddress: DELEGATE,
    tokenAddress: USDC,
    budgetAtomic: 5_000_000n,
    periodSeconds: 86_400,
    startDate: NOW - 60,
    recipient: RECIPIENT,
    expiresAt: NOW + 90 * 86_400,
    version: 1,
    ...overrides,
  }
}

describe('getDelegationEnvironment — anti-drift cross-check (#825 promise)', () => {
  it('kit environment matches every pinned address', () => {
    expect(() => getDelegationEnvironment(84532)).not.toThrow()
  })
  it('fails loudly on a chain without pins', () => {
    expect(() => getDelegationEnvironment(1)).toThrow(/no pinned contracts/)
  })
})

describe('identity (#813 encoded as regression tests)', () => {
  it('is deterministic: same policy → bit-identical delegation and hash', () => {
    const a = buildBudgetDelegation(policy())
    const b = buildBudgetDelegation(policy())
    expect(delegationIdentity(a)).toBe(delegationIdentity(b))
    expect(a).toEqual(b)
  })

  it('two recipients NEVER share an identity (the #813 collision class)', () => {
    const a = buildBudgetDelegation(policy())
    const b = buildBudgetDelegation(policy({ recipient: ('0x' + 'dd'.repeat(20)) as `0x${string}` }))
    expect(delegationIdentity(a)).not.toBe(delegationIdentity(b))
  })

  it('open and pinned budgets differ; two open budgets for different tokens differ', () => {
    const open = buildBudgetDelegation(policy({ recipient: undefined }))
    const pinned = buildBudgetDelegation(policy())
    const openEure = buildBudgetDelegation(policy({ recipient: undefined, tokenAddress: EURE }))
    expect(delegationIdentity(open)).not.toBe(delegationIdentity(pinned))
    expect(delegationIdentity(open)).not.toBe(delegationIdentity(openEure))
  })

  it('a replacement (version bump) is a fresh identity', () => {
    const v1 = buildBudgetDelegation(policy())
    const v2 = buildBudgetDelegation(policy({ version: 2 }))
    expect(delegationIdentity(v1)).not.toBe(delegationIdentity(v2))
  })

  it('identity never depends on address casing', () => {
    const lower = buildBudgetDelegation(policy({ recipient: RECIPIENT.toLowerCase() as `0x${string}` }))
    const upper = buildBudgetDelegation(
      policy({ recipient: RECIPIENT.toUpperCase().replace('0X', '0x') as `0x${string}` }),
    )
    expect(delegationIdentity(lower)).toBe(delegationIdentity(upper))
  })
})

describe('caveat stack contents', () => {
  it('pins the delegate — never an any-beneficiary delegation', () => {
    const open = buildBudgetDelegation(policy({ recipient: undefined }))
    expect(open.delegate.toLowerCase()).toBe(DELEGATE.toLowerCase())
  })

  it('recipient pin is the padded transfer `to` word at byte 4, via the pinned enforcer', () => {
    const d = buildBudgetDelegation(policy())
    const pins = getDelegationContracts(84532)
    const calldataCaveat = d.caveats.find(
      (c) => c.enforcer.toLowerCase() === pins.enforcers.allowedCalldata.toLowerCase(),
    )
    expect(calldataCaveat).toBeDefined()
    expect(calldataCaveat!.terms.toLowerCase()).toContain(
      pad(RECIPIENT.toLowerCase() as `0x${string}`, { size: 32 }).slice(2).toLowerCase(),
    )
  })

  it('the open variant carries NO calldata pin', () => {
    const d = buildBudgetDelegation(policy({ recipient: undefined }))
    const pins = getDelegationContracts(84532)
    expect(
      d.caveats.some((c) => c.enforcer.toLowerCase() === pins.enforcers.allowedCalldata.toLowerCase()),
    ).toBe(false)
  })

  it('period budget + expiry ride the pinned period/timestamp enforcers', () => {
    const d = buildBudgetDelegation(policy())
    const pins = getDelegationContracts(84532)
    const enforcers = d.caveats.map((c) => c.enforcer.toLowerCase())
    expect(enforcers).toContain(pins.enforcers.erc20PeriodTransfer.toLowerCase())
    expect(enforcers).toContain(pins.enforcers.timestamp.toLowerCase())
  })

  it('optional lifetime cap adds the cumulative enforcer — and rejects a cap below one period', () => {
    const d = buildBudgetDelegation(policy({ lifetimeCapAtomic: 100_000_000n }))
    const pins = getDelegationContracts(84532)
    expect(d.caveats.map((c) => c.enforcer.toLowerCase())).toContain(
      pins.enforcers.erc20TransferAmount.toLowerCase(),
    )
    expect(() => buildBudgetDelegation(policy({ lifetimeCapAtomic: 1n }))).toThrow(/lifetime cap/)
  })

  it('validates inputs (budget, period, expiry ordering)', () => {
    expect(() => buildBudgetDelegation(policy({ budgetAtomic: 0n }))).toThrow(/budget/)
    expect(() => buildBudgetDelegation(policy({ periodSeconds: 0 }))).toThrow(/period/)
    expect(() => buildBudgetDelegation(policy({ expiresAt: NOW - 120 }))).toThrow(/expiry/)
  })
})

describe('multi-token budget (one delegation, #804 concept)', () => {
  it('carries per-token period budgets via the pinned MultiTokenPeriodEnforcer', () => {
    const d = buildMultiTokenBudgetDelegation(
      {
        agentId: 'a', chainId: 84532, treasuryAddress: TREASURY,
        delegateAccountAddress: DELEGATE, expiresAt: NOW + 86_400, version: 1,
        lifetimeCapAtomic: undefined,
      },
      [
        { tokenAddress: USDC, budgetAtomic: 5_000_000n, periodSeconds: 86_400, startDate: NOW - 60 },
        { tokenAddress: EURE, budgetAtomic: 2_000_000n, periodSeconds: 86_400, startDate: NOW - 60 },
      ],
    )
    const pins = getDelegationContracts(84532)
    expect(d.caveats.map((c) => c.enforcer.toLowerCase())).toContain(
      pins.enforcers.multiTokenPeriod.toLowerCase(),
    )
    expect(d.delegate.toLowerCase()).toBe(DELEGATE.toLowerCase())
  })
})

describe('signing payload + revocation', () => {
  it('typed data targets the PINNED manager with its own domain constants', () => {
    const d = buildBudgetDelegation(policy())
    const payload = delegationSigningPayload(d, 84532)
    expect(payload.domain.verifyingContract.toLowerCase()).toBe(
      getDelegationContracts(84532).delegationManager.toLowerCase(),
    )
    expect(payload.domain.name).toBe('DelegationManager')
    expect(payload.primaryType).toBe('Delegation')
    expect(payload.message).toEqual(d)
  })

  it('revocation targets the pinned manager with disableDelegation calldata', () => {
    const d = buildBudgetDelegation(policy())
    const revocation = buildRevocation({ ...d, signature: '0x' } as never, 84532)
    expect(revocation.to.toLowerCase()).toBe(
      getDelegationContracts(84532).delegationManager.toLowerCase(),
    )
    expect(revocation.data.startsWith('0x')).toBe(true)
    expect(revocation.data.length).toBeGreaterThan(10)
  })
})
