import { describe, expect, it } from 'vitest'
import type { Agent } from '@/hooks/useAgents'
import { canFinishRevoking, isHalfRevoked } from '../half-revoked'

function agent(overrides: Partial<Agent>): Agent {
  return {
    id: 'a1',
    name: 'Agent',
    status: 'active',
    account_id: 'acct-1',
    archived_at: null,
    ...overrides,
  } as Agent
}

/**
 * #3542: one predicate every surface reads, so the list card, the detail page,
 * the account page and the Removed toggle cannot disagree about which agents
 * are half-revoked.
 */
describe('isHalfRevoked', () => {
  it('is true for a revoked agent with a live delegation', () => {
    expect(isHalfRevoked(agent({ status: 'revoked', live_delegation_count: 1 }))).toBe(true)
  })

  it('is true for an archived agent with a live delegation, whatever its status', () => {
    expect(
      isHalfRevoked(
        agent({ status: 'active', archived_at: '2026-06-01T00:00:00Z', live_delegation_count: 1 }),
      ),
    ).toBe(true)
  })

  it('is false when no delegation is live: zero, or absent', () => {
    expect(isHalfRevoked(agent({ status: 'revoked', live_delegation_count: 0 }))).toBe(false)
    expect(isHalfRevoked(agent({ status: 'revoked' }))).toBe(false)
  })

  it('is false for an agent that has not been revoked or archived, however many budgets it holds', () => {
    for (const status of ['active', 'paused', 'pending_approval'] as const) {
      expect(isHalfRevoked(agent({ status, live_delegation_count: 3 }))).toBe(false)
    }
  })

  it('ignores `allowances`: they are a view of ACTIVE rows, and a replaced row is still live', () => {
    expect(
      isHalfRevoked(agent({ status: 'revoked', allowances: [], live_delegation_count: 1 })),
    ).toBe(true)
  })
})

describe('canFinishRevoking', () => {
  it('needs a linked account: revoke-all refuses an unlinked agent', () => {
    expect(canFinishRevoking(agent({ status: 'revoked', live_delegation_count: 1 }))).toBe(true)
    expect(
      canFinishRevoking(agent({ status: 'revoked', live_delegation_count: 1, account_id: null })),
    ).toBe(false)
  })

  it('is false whenever the agent is not half-revoked', () => {
    expect(canFinishRevoking(agent({ status: 'revoked', live_delegation_count: 0 }))).toBe(false)
    expect(canFinishRevoking(agent({ status: 'active', live_delegation_count: 1 }))).toBe(false)
  })
})
