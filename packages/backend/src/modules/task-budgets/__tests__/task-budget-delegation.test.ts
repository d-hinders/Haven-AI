/**
 * Unit tests for the pure task-budget child builder (#3329). Pins the
 * invariant the module header states in prose: the child is ALWAYS
 * self-delegated to the agent's own delegate account, never
 * `ANY_BENEFICIARY` (review finding B9) — the mutant that flips `to` to a
 * bearer constant is what this test exists to catch.
 */
import { describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import type { Delegation } from '@metamask/smart-accounts-kit'
import {
  buildTaskBudgetDelegation,
  taskBudgetSalt,
  type TaskBudgetDelegationRequest,
} from '../task-budget-delegation.js'
import { buildBudgetDelegation, type HavenBudgetPolicy } from '../../../rails/delegation-policy.js'

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address
const DELEGATE_ACCT = ('0x' + 'dd'.repeat(20)) as Address
const TREASURY = ('0x' + 'aa'.repeat(20)) as Address
const RECIPIENT = ('0x' + 'cc'.repeat(20)) as Address
const NOW = Math.floor(Date.now() / 1000)

function budgetPolicy(): HavenBudgetPolicy {
  return {
    agentId: 'agent-1', chainId: 84532, treasuryAddress: TREASURY,
    delegateAccountAddress: DELEGATE_ACCT, tokenAddress: USDC,
    budgetAtomic: 5_000_000n, periodSeconds: 86_400, startDate: NOW - 60,
    expiresAt: NOW + 86_400, version: 1,
  }
}
const signedBudget = {
  ...buildBudgetDelegation(budgetPolicy()),
  signature: ('0x' + 'ab'.repeat(65)) as Hex,
} as unknown as Delegation

function req(overrides: Record<string, unknown> = {}): TaskBudgetDelegationRequest {
  return {
    chainId: 84532,
    taskBudgetId: '00000000-0000-4000-8000-000000003329',
    delegateAccountAddress: DELEGATE_ACCT,
    budgetDelegation: signedBudget,
    token: USDC,
    maxAtomic: 100_000n,
    ttlSeconds: 3600,
    ...overrides,
  } as TaskBudgetDelegationRequest
}

describe('buildTaskBudgetDelegation (#3329)', () => {
  it('#3329 review finding B9: the child delegate is the agent\'s OWN account — never ANY_BENEFICIARY', () => {
    const built = buildTaskBudgetDelegation(req())
    expect(built.child.delegate.toLowerCase()).toBe(DELEGATE_ACCT.toLowerCase())
    // The ANY_BENEFICIARY bearer constant x402-delegation.ts uses on purpose
    // for a settlement child — a task child must never carry it.
    expect(built.child.delegate.toLowerCase()).not.toBe('0x0000000000000000000000000000000000000a11')
  })

  it('the child is self-delegated: delegate === delegator, both the agent\'s own account', () => {
    const built = buildTaskBudgetDelegation(req())
    expect(built.child.delegate.toLowerCase()).toBe(built.child.delegator.toLowerCase())
    expect(built.child.delegator.toLowerCase()).toBe(DELEGATE_ACCT.toLowerCase())
  })

  it('the salt is deterministic per task budget id and distinct from another id', () => {
    const built = buildTaskBudgetDelegation(req())
    const expectedSalt = taskBudgetSalt(req().taskBudgetId).toLowerCase()
    expect(String(built.child.salt).toLowerCase()).toBe(expectedSalt)
    const other = buildTaskBudgetDelegation(req({ taskBudgetId: '00000000-0000-4000-8000-000000009999' }))
    expect(String(built.child.salt)).not.toBe(String(other.child.salt))
  })

  it('a pinned recipient adds the allowedCalldata caveat; an open task budget does not', () => {
    const pinned = buildTaskBudgetDelegation(req({ recipient: RECIPIENT }))
    const open = buildTaskBudgetDelegation(req())
    expect(pinned.child.caveats.length).toBe(open.child.caveats.length + 1)
  })
})
