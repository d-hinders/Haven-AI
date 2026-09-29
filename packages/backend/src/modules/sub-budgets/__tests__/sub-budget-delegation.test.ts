/**
 * #3330 money-path gates on the sub-budget builder + service (#3330 card):
 *
 * - `checkNarrowingRefusal` refuses a child WIDER than the parent in amount,
 *   expiry or recipient BEFORE signing (decoded from the parent budget
 *   delegation itself, never a request field).
 * - `buildSubBudgetChildren` builds the two-row tree whose period scopes
 *   NARROW (never widen) the parent, and the recipient pin lives on the
 *   parent-child so the whole subtree inherits it.
 *
 * Pure functions — no DB, no chain. The parent fixture compiles its scope
 * with the KIT's `createDelegation`, so the decoders are exercised against
 * the kit's REAL packed terms layout — exactly what the production budget
 * builder emits.
 */
import { describe, expect, it } from 'vitest'
import { createDelegation, type Delegation } from '@metamask/smart-accounts-kit'
import {
  buildSubBudgetGrant,
  readParentExpiry,
  readParentPeriodScope,
  subBudgetSalt,
} from '../sub-budget-delegation.js'
import { buildSubBudgetChildren, checkNarrowingRefusal } from '../sub-budget-service.js'
import { getDelegationEnvironment } from '../../../rails/delegation-policy.js'

const CHAIN_ID = 84532
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const
const NOW = Math.floor(Date.now() / 1000)
const A_OWNER = ('0x' + 'a1'.repeat(20)) as `0x${string}`
const B_OWNER = ('0x' + 'b2'.repeat(20)) as `0x${string}`
const RECIPIENT = ('0x' + 'cc'.repeat(20)) as `0x${string}`
const A_ACCOUNT = ('0x' + 'd1'.repeat(20)) as `0x${string}`
const USER = ('0x' + 'aa'.repeat(20)) as `0x${string}`
const ROOT = `0x${'ff'.repeat(32)}`

/**
 * A SIGNED parent budget delegation — its `erc20PeriodTransfer` scope is
 * compiled by the KIT's `createDelegation`, so the caveat terms are the
 * kit's real packed bytes (what the production `buildBudgetDelegation`
 * emits), never hand-rolled.
 */
function budgetDelegation(over: {
  periodAmount?: bigint
  periodDuration?: number
  startDate?: number
  expiresAt?: number | null
  recipient?: `0x${string}` | null
}): Delegation {
  const caveats: Array<Record<string, unknown>> = []
  if (over.expiresAt !== null) {
    caveats.push({ type: 'timestamp', afterThreshold: 0, beforeThreshold: over.expiresAt ?? NOW + 86_400 })
  }
  if (over.recipient) {
    caveats.push({ type: 'allowedCalldata', startIndex: 4, value: over.recipient })
  }
  const compiled = createDelegation({
    environment: getDelegationEnvironment(CHAIN_ID),
    from: A_ACCOUNT,
    to: A_ACCOUNT,
    parentDelegation: {
      delegate: A_ACCOUNT,
      delegator: USER,
      authority: ROOT,
      caveats: [],
      salt: 1n,
      signature: `0x${'ab'.repeat(65)}`,
    } as unknown as Delegation,
    scope: {
      type: 'erc20PeriodTransfer',
      tokenAddress: USDC as `0x${string}`,
      periodAmount: over.periodAmount ?? 5_000_000n,
      periodDuration: over.periodDuration ?? 86_400,
      startDate: over.startDate ?? NOW - 60,
    },
    caveats: caveats as never,
    salt: subBudgetSalt('parent-budget-fixture'),
  })
  return { ...compiled, signature: `0x${'ab'.repeat(65)}` } as unknown as Delegation
}

describe('checkNarrowingRefusal (#3330 money-path gate)', () => {
  const parent = budgetDelegation({})

  it('accepts an equal-or-narrower child (amount, expiry, no pin)', () => {
    const ok = checkNarrowingRefusal({
      budgetDelegation: parent,
      parentBudgetToken: USDC,
      parentRecipientAddress: null,
      requested: { periodAmountAtomic: 5_000_000n, expiresAt: NOW + 86_400 },
    })
    expect(ok.ok).toBe(true)
  })

  it('refuses a wider AMOUNT before signing', () => {
    const wider = checkNarrowingRefusal({
      budgetDelegation: parent,
      parentBudgetToken: USDC,
      parentRecipientAddress: null,
      requested: { periodAmountAtomic: 5_000_001n, expiresAt: NOW + 3600 },
    })
    expect(wider).toEqual({ ok: false, reason: 'amount' })
  })

  it('refuses a child that OUTLIVES the parent\u2019s timestamp caveat', () => {
    const outlives = checkNarrowingRefusal({
      budgetDelegation: parent,
      parentBudgetToken: USDC,
      parentRecipientAddress: null,
      requested: { periodAmountAtomic: 1000n, expiresAt: NOW + 86_401 },
    })
    expect(outlives).toEqual({ ok: false, reason: 'expiry' })
  })

  it('refuses a child that UNPINS a pinned parent\u2019s recipient', () => {
    const pinnedParent = budgetDelegation({ recipient: RECIPIENT })
    const unpinned = checkNarrowingRefusal({
      budgetDelegation: pinnedParent,
      parentBudgetToken: USDC,
      parentRecipientAddress: RECIPIENT,
      requested: { periodAmountAtomic: 1000n, expiresAt: NOW + 3600 },
    })
    expect(unpinned).toEqual({ ok: false, reason: 'recipient' })

    const repinned = checkNarrowingRefusal({
      budgetDelegation: pinnedParent,
      parentBudgetToken: USDC,
      parentRecipientAddress: RECIPIENT,
      requested: { periodAmountAtomic: 1000n, recipient: RECIPIENT, expiresAt: NOW + 3600 },
    })
    expect(repinned.ok).toBe(true)
  })

  it('refuses a child pinned to a DIFFERENT recipient than the parent\u2019s pin', () => {
    const pinnedParent = budgetDelegation({ recipient: RECIPIENT })
    const elsewhere = checkNarrowingRefusal({
      budgetDelegation: pinnedParent,
      parentBudgetToken: USDC,
      parentRecipientAddress: RECIPIENT,
      requested: {
        periodAmountAtomic: 1000n,
        recipient: ('0x' + 'dd'.repeat(20)) as `0x${string}`,
        expiresAt: NOW + 3600,
      },
    })
    expect(elsewhere).toEqual({ ok: false, reason: 'recipient' })
  })

  it('refuses a parent that is not period-scoped (multi-token functionCall parents are v1-out-of-scope)', () => {
    const PERIOD = (getDelegationEnvironment(CHAIN_ID).caveatEnforcers as Record<string, string>)
      .ERC20PeriodTransferEnforcer
    const notPeriod = {
      ...parent,
      caveats: (parent.caveats as Array<{ enforcer: string }>).filter(
        (c) => c.enforcer.toLowerCase() !== PERIOD.toLowerCase(),
      ),
    } as unknown as Delegation
    const refused = checkNarrowingRefusal({
      budgetDelegation: notPeriod,
      parentBudgetToken: USDC,
      parentRecipientAddress: null,
      requested: { periodAmountAtomic: 1000n, expiresAt: NOW + 3600 },
    })
    expect(refused).toEqual({ ok: false, reason: 'parent_not_period_scoped' })
  })

  it('a parent with NO timestamp caveat does not bound the child\u2019s expiry (null expiry never refuses)', () => {
    const openEnded = budgetDelegation({ expiresAt: null })
    const ok = checkNarrowingRefusal({
      budgetDelegation: openEnded,
      parentBudgetToken: USDC,
      parentRecipientAddress: null,
      requested: { periodAmountAtomic: 1000n, expiresAt: NOW + 10_000_000 },
    })
    expect(ok.ok).toBe(true)
  })
})

describe('buildSubBudgetChildren (#3330 chain shape)', () => {
  it('builds BOTH rows: A\u2019s self-delegated parent-child + B\u2019s grant chained under it', async () => {
    const built = await buildSubBudgetChildren({
      chainId: CHAIN_ID,
      subBudgetId: '11111111-1111-4111-8111-111111111111',
      delegatingOwnerAddress: A_OWNER,
      subAgentOwnerAddress: B_OWNER,
      budgetDelegation: budgetDelegation({}),
      narrowing: {
        token: USDC,
        periodAmountAtomic: 1_000_000n,
        periodDurationSeconds: 86_400,
        startDate: NOW - 60,
        expiresAt: NOW + 3600,
      },
    })
    const { parentChild, grant } = built

    // A's parent-child: SELF-delegated (delegate === delegator), derived
    // from A's owner address.
    expect(parentChild.child.delegate.toLowerCase()).toBe(parentChild.child.delegator.toLowerCase())
    expect(parentChild.child.delegate.toLowerCase()).toBe(parentChild.delegateAccountAddress.toLowerCase())

    // B's grant: delegated BY A's account TO B's account — a real grant
    // between two accounts, never self.
    expect(grant.child.delegator.toLowerCase()).toBe(parentChild.delegateAccountAddress.toLowerCase())
    expect(grant.child.delegate.toLowerCase()).toBe(grant.subAgentAccountAddress.toLowerCase())
    expect(grant.child.delegator.toLowerCase()).not.toBe(grant.child.delegate.toLowerCase())

    // Neither child is a ROOT delegation: each names its parent.
    expect(grant.child.authority.toLowerCase()).not.toBe(ROOT.toLowerCase())

    // The salt is domain-separated and id-derived.
    expect(subBudgetSalt('x')).toBe(subBudgetSalt('x'))
    expect(subBudgetSalt('x')).not.toBe(subBudgetSalt('y'))
  })

  it('both children carry the recipient pin when the parent pins (the subtree inherits it)', async () => {
    const built = await buildSubBudgetChildren({
      chainId: CHAIN_ID,
      subBudgetId: '22222222-2222-4222-8222-222222222222',
      delegatingOwnerAddress: A_OWNER,
      subAgentOwnerAddress: B_OWNER,
      budgetDelegation: budgetDelegation({ recipient: RECIPIENT }),
      narrowing: {
        token: USDC,
        periodAmountAtomic: 1_000_000n,
        periodDurationSeconds: 86_400,
        startDate: NOW - 60,
        recipient: RECIPIENT,
        expiresAt: NOW + 3600,
      },
    })
    for (const row of [built.parentChild, built.grant]) {
      const ALLOWED = (getDelegationEnvironment(CHAIN_ID).caveatEnforcers as Record<string, string>)
        .AllowedCalldataEnforcer
      const allowed = (row.child.caveats as Array<{ enforcer: string }>).find(
        (c) => c.enforcer.toLowerCase() === ALLOWED.toLowerCase(),
      )
      expect(allowed).toBeDefined()
    }
  })

  it('refuses a grant to the delegating agent itself (that is a task budget, #3329)', async () => {
    await expect(
      buildSubBudgetChildren({
        chainId: CHAIN_ID,
        subBudgetId: '33333333-3333-4333-8333-333333333333',
        delegatingOwnerAddress: A_OWNER,
        subAgentOwnerAddress: A_OWNER,
        budgetDelegation: budgetDelegation({}),
        narrowing: {
          token: USDC,
          periodAmountAtomic: 1000n,
          periodDurationSeconds: 86_400,
          startDate: NOW - 60,
          expiresAt: NOW + 3600,
        },
      }),
    ).rejects.toThrow(/task budget/)
  })

  it('readParentPeriodScope / readParentExpiry decode the KIT\u2019S OWN packed terms', () => {
    const parent = budgetDelegation({ periodAmount: 7_000_000n, expiresAt: NOW + 555 })
    const scope = readParentPeriodScope(parent)
    expect(scope?.token.toLowerCase()).toBe(USDC.toLowerCase())
    expect(scope?.periodAmount).toBe(7_000_000n)
    expect(scope?.periodDuration).toBe(86_400)
    expect(readParentExpiry(parent)).toBe(NOW + 555)
  })
})

describe('buildSubBudgetGrant standalone (#3330)', () => {
  it('throws when asked to delegate A to itself (task-budget shape, not a sub-budget)', () => {
    expect(() =>
      buildSubBudgetGrant({
        chainId: CHAIN_ID,
        subBudgetId: '44444444-4444-4444-8444-444444444444',
        delegatingAccountAddress: A_ACCOUNT,
        subAgentAccountAddress: A_ACCOUNT,
        parentChildDelegation: budgetDelegation({}),
        narrowing: {
          token: USDC,
          periodAmountAtomic: 1000n,
          periodDurationSeconds: 86_400,
          startDate: NOW - 60,
          expiresAt: NOW + 3600,
        },
      }),
    ).toThrow(/task budget/)
  })
})

describe('#3330 on-chain enforcement shape (the chain IS the enforcement)', () => {
  /**
   * The DelegationManager enforces a redemption chain by matching each
   * link's `authority` to the hash of the delegation it hangs from — the
   * EIP-7710 DELEGATION_TYPEHASH struct hash (delegate, delegator,
   * authority, caveats, salt; the signature is verified per-link, not
   * hashed). These tests prove, against the KIT's own hash + encoder, that
   * the built tree forms one closed chain and that the exact bytes B's
   * redemption submits (`encodeDelegations` leaf-first, the same call
   * `x402-delegation.ts` makes) round-trip with the parent's period meter
   * inside the SAME payload — the parent cap binds because its caveat
   * ANDs into every redemption of this chain.
   */
  it('each hop\u2019s authority equals the KIT\u2019s hash of its parent (closed chain)', async () => {
    const budget = budgetDelegation({})
    const built = await buildSubBudgetChildren({
      chainId: CHAIN_ID,
      subBudgetId: '55555555-5555-4555-8555-555555555555',
      delegatingOwnerAddress: A_OWNER,
      subAgentOwnerAddress: B_OWNER,
      budgetDelegation: budget,
      narrowing: {
        token: USDC,
        periodAmountAtomic: 1_000_000n,
        periodDurationSeconds: 86_400,
        startDate: NOW - 60,
        expiresAt: NOW + 3600,
      },
    })
    const { hashDelegation } = await import('@metamask/smart-accounts-kit/utils')
    // B's grant hangs from A's parent-child (the kit's hash excludes the
    // signature, so the unsigned children hash with a placeholder).
    expect(built.grant.child.authority.toLowerCase()).toBe(
      hashDelegation({ ...built.parentChild.child, signature: '0x' } as never).toLowerCase(),
    )
    // A's parent-child hangs from the budget delegation itself.
    expect(built.parentChild.child.authority.toLowerCase()).toBe(
      hashDelegation(budget).toLowerCase(),
    )
  })

  it('the redemption payload encodeDelegations([grant, parentChild, budget]) emits round-trips and carries the parent period meter', async () => {
    const budget = budgetDelegation({ periodAmount: 5_000_000n })
    const built = await buildSubBudgetChildren({
      chainId: CHAIN_ID,
      subBudgetId: '66666666-6666-4666-8666-666666666666',
      delegatingOwnerAddress: A_OWNER,
      subAgentOwnerAddress: B_OWNER,
      budgetDelegation: budget,
      narrowing: {
        token: USDC,
        periodAmountAtomic: 1_000_000n,
        periodDurationSeconds: 86_400,
        startDate: NOW - 60,
        expiresAt: NOW + 3600,
      },
    })
    const { encodeDelegations, decodeDelegations, hashDelegation } = await import(
      '@metamask/smart-accounts-kit/utils'
    )
    // Leaf-first, signatures attached — exactly what the payment rail hands
    // the kit (`x402-delegation.ts` assembleSettlementPayload /
    // prepareDelegationPayment's permissionContext).
    const chain = [
      { ...built.grant.child, signature: `0x${'cd'.repeat(65)}` },
      { ...built.parentChild.child, signature: `0x${'ef'.repeat(65)}` },
      budget,
    ] as unknown as Parameters<typeof encodeDelegations>[0]
    const permissionContext = encodeDelegations(chain)
    const decoded = decodeDelegations(permissionContext)
    expect(decoded).toHaveLength(3)
    // Leaf: B's grant — delegated BY A's account TO B's account.
    expect(decoded[0].delegator.toLowerCase()).toBe(built.parentChild.delegateAccountAddress.toLowerCase())
    expect(decoded[0].delegate.toLowerCase()).toBe(built.grant.subAgentAccountAddress.toLowerCase())
    // Middle: A's self-delegated parent-child, chained to the budget.
    expect(decoded[1].delegate.toLowerCase()).toBe(decoded[1].delegator.toLowerCase())
    expect(decoded[1].authority.toLowerCase()).toBe(hashDelegation(budget).toLowerCase())
    // Root: the budget — used VERBATIM: every field including its own
    // authority is preserved byte-for-byte in the redemption payload (the
    // fixture budget hangs from the fixture's pseudo-parent, mirroring the
    // owner grant; production's budget delegation carries ROOT there).
    expect(decoded[2].delegate.toLowerCase()).toBe(budget.delegate.toLowerCase())
    expect(decoded[2].authority.toLowerCase()).toBe(budget.authority.toLowerCase())
    // Leaf↔middle linkage survives the encode/decode round-trip.
    expect(decoded[0].authority.toLowerCase()).toBe(
      hashDelegation({ ...decoded[1], signature: '0x' } as never).toLowerCase(),
    )
    // THE PARENT CAP BINDS: the same redemption payload carries the parent
    // budget's own period meter (5_000_000n) alongside the leaf's narrower
    // one (1_000_000n) — the DelegationManager ANDs both enforcers, so a
    // payment beyond the parent's remaining period budget reverts even
    // though B's own allowance would allow it.
    const PERIOD = (getDelegationEnvironment(CHAIN_ID).caveatEnforcers as Record<string, string>)
      .ERC20PeriodTransferEnforcer
    const periodAmounts = decoded.map((d) => {
      const caveat = (d.caveats as Array<{ enforcer: string; terms: string }>).find(
        (c) => c.enforcer.toLowerCase() === PERIOD.toLowerCase(),
      )
      expect(caveat).toBeDefined()
      const body = (caveat!.terms as string).slice(2)
      return { token: `0x${body.slice(0, 40)}`, amount: BigInt(`0x${body.slice(40, 104)}`) }
    })
    for (const p of periodAmounts) expect(p.token.toLowerCase()).toBe(USDC.toLowerCase())
    expect(periodAmounts[0].amount).toBe(1_000_000n) // B's slice
    expect(periodAmounts[1].amount).toBe(1_000_000n) // A's parent-child
    expect(periodAmounts[2].amount).toBe(5_000_000n) // the parent meter that still binds
  })
})
