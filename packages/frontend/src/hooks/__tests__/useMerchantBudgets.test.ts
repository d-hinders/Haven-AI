import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiRequestError } from '@/lib/api'

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, api: { get: mockGet } }
})

const { useMerchantBudgets } = await import('@/hooks/useMerchantBudgets')

const SLUG = 'ampersend-demo-api'

function row(overrides: Record<string, unknown> = {}) {
  return {
    agent_id: 'agent-1',
    agent_name: 'Research Agent',
    chain_id: 84532,
    token_address: '0x' + 'aa'.repeat(20),
    recipient_address: '0x' + 'f0'.repeat(20),
    delegation_hash: '0x' + 'bb'.repeat(32),
    budget_atomic: '10000000',
    period_seconds: 2_592_000,
    expires_at: '4102444800',
    remaining_atomic: '9000000',
    remaining_is_from_chain: true,
    pin_status: 'current',
    ...overrides,
  }
}

beforeEach(() => {
  mockGet.mockReset()
})

describe('useMerchantBudgets (#3331)', () => {
  it('loads budgets for the merchant', async () => {
    mockGet.mockResolvedValue({ budgets: [row()] })
    const { result } = renderHook(() => useMerchantBudgets(SLUG))
    await waitFor(() => expect(result.current.budgets).not.toBeNull())
    expect(mockGet).toHaveBeenCalledWith(`/merchants/${SLUG}/budgets`)
    expect(result.current.budgets).toEqual([row()])
    expect(result.current.error).toBeNull()
    expect(result.current.forbidden).toBe(false)
  })

  it('degrades an absent `budgets` key to an empty array rather than crashing (#3093)', async () => {
    mockGet.mockResolvedValue({})
    const { result } = renderHook(() => useMerchantBudgets(SLUG))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.budgets).toEqual([])
  })

  it('a 403 (agent-key caller) is absorbed as "nothing to show", not an error banner', async () => {
    mockGet.mockRejectedValue(new ApiRequestError('Forbidden', 403))
    const { result } = renderHook(() => useMerchantBudgets(SLUG))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.forbidden).toBe(true)
    expect(result.current.budgets).toEqual([])
    expect(result.current.error).toBeNull()
  })

  it('any other failure is a retryable error, not a crash', async () => {
    mockGet.mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useMerchantBudgets(SLUG))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe('boom')
    expect(result.current.budgets).toBeNull()
    expect(result.current.forbidden).toBe(false)
  })

  it('does not fetch while disabled', async () => {
    renderHook(() => useMerchantBudgets(SLUG, { enabled: false }))
    await Promise.resolve()
    expect(mockGet).not.toHaveBeenCalled()
  })

  it('refetch reloads', async () => {
    mockGet.mockResolvedValue({ budgets: [row()] })
    const { result } = renderHook(() => useMerchantBudgets(SLUG))
    await waitFor(() => expect(result.current.budgets).not.toBeNull())
    mockGet.mockResolvedValue({ budgets: [row(), row({ agent_id: 'agent-2' })] })
    await act(async () => {
      await result.current.refetch()
    })
    await waitFor(() => expect(result.current.budgets).toHaveLength(2))
  })
})
