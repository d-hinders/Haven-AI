/**
 * Unit tests for the task-budget-service orchestration (#3329) — the network
 * seams (`readRemainingBudget`, `sumOpenReservedAtomic`) are mocked so the
 * arithmetic can be pinned without a chain or a database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockReadRemaining, mockSumReserved } = vi.hoisted(() => ({
  mockReadRemaining: vi.fn(),
  mockSumReserved: vi.fn(),
}))
vi.mock('../../../infra/chain/delegation-budget-reader.js', () => ({
  readRemainingBudget: (...a: unknown[]) => mockReadRemaining(...a),
}))
vi.mock('../../../infra/repositories/task-budgets.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/repositories/task-budgets.js')>()
  return { ...actual, sumOpenReservedAtomic: (...a: unknown[]) => mockSumReserved(...a) }
})

const { checkRemainderForNewTaskBudget } = await import('../task-budget-service.js')

const PARENT = {
  delegation_hash: `0x${'ab'.repeat(32)}`,
  delegation_json: JSON.stringify({}),
  recipient_address: null,
  budget_atomic: '5000000',
}

describe('checkRemainderForNewTaskBudget (#3329 review finding B7)', () => {
  beforeEach(() => {
    mockReadRemaining.mockReset()
    mockSumReserved.mockReset()
  })

  it('subtracts the open-children reservation from the on-chain remainder before comparing', async () => {
    // remaining=1,000,000 on-chain; 600,000 already reserved by other open
    // task budgets under the SAME parent; requesting 500,000.
    mockReadRemaining.mockResolvedValue({ remainingAtomic: '1000000', fromChain: true })
    mockSumReserved.mockResolvedValue(600_000n)

    const result = await checkRemainderForNewTaskBudget(
      'agent-1', 84532, PARENT, 500_000n, PARENT.budget_atomic, 1_700_000_000,
    )

    // available = 1,000,000 - 600,000 = 400,000 < 500,000 requested → refused.
    expect(result.ok).toBe(false)
    expect(result.availableAtomic).toBe('400000')
    expect(result.reservedAtomic).toBe('600000')
  })

  it('the SAME request would NOT be refused by remaining alone (proves the subtraction is load-bearing)', async () => {
    mockReadRemaining.mockResolvedValue({ remainingAtomic: '1000000', fromChain: true })
    mockSumReserved.mockResolvedValue(0n) // nothing else reserved

    const result = await checkRemainderForNewTaskBudget(
      'agent-1', 84532, PARENT, 500_000n, PARENT.budget_atomic, 1_700_000_000,
    )

    // Same remaining (1,000,000), same request (500,000) — ok now that
    // nothing else is reserved. The only variable that changed is the
    // open-children sum, which is exactly what a mutant deleting the
    // subtraction would make invisible.
    expect(result.ok).toBe(true)
    expect(result.availableAtomic).toBe('1000000')
  })

  it('an exact-boundary request (requested == available) is accepted, not refused', async () => {
    mockReadRemaining.mockResolvedValue({ remainingAtomic: '1000000', fromChain: true })
    mockSumReserved.mockResolvedValue(600_000n)

    const result = await checkRemainderForNewTaskBudget(
      'agent-1', 84532, PARENT, 400_000n, PARENT.budget_atomic, 1_700_000_000,
    )
    expect(result.ok).toBe(true)
  })
})
