import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `apiMock()` (e2e/fixtures/api-mock.ts) matches by a FIXED pathname table —
 * it has no precedent anywhere in the codebase for an agent-id-parametrized
 * route (`useDelegationBudget.test.tsx`'s own `/agents/:id/delegations` read
 * mocks `@/lib/api` directly for the same reason). This hook's route is
 * `/agents/:id/task-budgets`, so it follows that same precedent rather than
 * widening `apiMock`'s matcher, which is shared infra outside this hook's
 * ownership.
 */
const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { get: mockGet } }))

const { useTaskBudgets } = await import('@/hooks/useTaskBudgets')

const AGENT = 'agent-1'

beforeEach(() => {
  mockGet.mockReset()
})

describe('useTaskBudgets (#3329)', () => {
  it('loads task budgets for the agent', async () => {
    mockGet.mockResolvedValue({
      task_budgets: [{ id: 't1', agent_id: AGENT, chain_id: 84532, token_address: '0x' + 'aa'.repeat(20), recipient_address: null, parent_delegation_hash: '0x' + 'bb'.repeat(32), delegation_hash: '0x' + 'cc'.repeat(32), label: null, max_atomic: '1000000', status: 'open', expires_at: 9_999_999_999, is_expired: false, created_at: '2026-01-01T00:00:00Z', opened_at: null, closed_at: null, close_tx_hash: null }],
    })
    const { result } = renderHook(() => useTaskBudgets(AGENT))
    await waitFor(() => expect(result.current.taskBudgets).not.toBeNull())
    expect(mockGet).toHaveBeenCalledWith(`/agents/${AGENT}/task-budgets`)
    expect(result.current.taskBudgets).toHaveLength(1)
    expect(result.current.error).toBe(false)
  })

  it('an absent task_budgets key degrades to an empty list (#3093 pattern)', async () => {
    mockGet.mockResolvedValue({})
    const { result } = renderHook(() => useTaskBudgets(AGENT))
    await waitFor(() => expect(result.current.taskBudgets).not.toBeNull())
    expect(result.current.taskBudgets).toEqual([])
  })

  it('a failed fetch surfaces error without throwing', async () => {
    mockGet.mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useTaskBudgets(AGENT))
    await waitFor(() => expect(result.current.error).toBe(true))
    expect(result.current.taskBudgets).toBeNull()
  })
})
