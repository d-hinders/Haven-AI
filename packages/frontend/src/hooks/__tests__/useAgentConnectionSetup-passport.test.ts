/**
 * #4719 (epic #4718): the connect flow offers the Agent Passport opt-in only
 * for a wallet whose session payload says `passport_issuable: true`, and never
 * sends `issue_passport` for a wallet that cannot issue one — even when the box
 * was ticked before the user switched wallets.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'

const { mockApiPost, mockUseAuth } = vi.hoisted(() => ({
  mockApiPost: vi.fn(),
  mockUseAuth: vi.fn(),
}))

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined, chain: undefined }),
  useSwitchChain: () => ({ switchChain: vi.fn(), isPending: false }),
}))
vi.mock('@/context/AuthContext', () => ({ useAuth: () => mockUseAuth() }))
vi.mock('@/lib/api', () => ({
  api: { post: (...args: unknown[]) => mockApiPost(...args), get: vi.fn() },
  getResolvedApiBaseUrl: () => 'https://api.haven.example',
}))

import { useAgentConnectionSetup } from '../useAgentConnectionSetup'

const ISSUABLE = {
  id: 'acct-issuable',
  account_address: '0x' + '11'.repeat(20),
  chain_id: 84532,
  name: 'Issuable',
  is_default: true,
  account_type: 'delegator_hybrid',
  passport_issuable: true,
}
const NOT_ISSUABLE = { ...ISSUABLE, id: 'acct-not', account_address: '0x' + '22'.repeat(20), name: 'Not', is_default: false, passport_issuable: false }
// An older backend omits the field entirely.
const UNKNOWN = { ...ISSUABLE, id: 'acct-unknown', account_address: '0x' + '33'.repeat(20), name: 'Unknown', is_default: false, passport_issuable: undefined }

function sentIssuePassport(): unknown {
  const call = mockApiPost.mock.calls.find(([url]) => url === '/agent-connection-setups')
  return (call?.[1] as Record<string, unknown> | undefined)?.issue_passport
}

beforeEach(() => {
  mockApiPost.mockReset().mockResolvedValue({ setup_id: 'setup-1', status: 'pending', setup_prompt: 'p', expires_at: new Date(Date.now() + 60_000).toISOString() })
  mockUseAuth.mockReturnValue({ user: { accounts: [ISSUABLE, NOT_ISSUABLE, UNKNOWN] } })
})

describe('connect flow — passport opt-in gate (#4719)', () => {
  it('offers the opt-in for an issuable wallet and sends issue_passport when ticked', async () => {
    const { result } = renderHook(() => useAgentConnectionSetup({ open: true, onClose: vi.fn(), accountId: ISSUABLE.id }))
    expect(result.current.passportIssuable).toBe(true)

    act(() => result.current.setIssuePassport(true))
    await act(async () => {
      await result.current.handleCreateSetup()
    })
    expect(sentIssuePassport()).toBe(true)
  })

  it('switching to a wallet that cannot issue clears the ticked box, and nothing is sent', async () => {
    const { result } = renderHook(() => useAgentConnectionSetup({ open: true, onClose: vi.fn(), accountId: ISSUABLE.id }))
    act(() => result.current.setIssuePassport(true))
    expect(result.current.issuePassport).toBe(true)

    act(() => result.current.setSelectedAccountId(NOT_ISSUABLE.id))
    expect(result.current.passportIssuable).toBe(false)
    expect(result.current.issuePassport).toBe(false)

    await act(async () => {
      await result.current.handleCreateSetup()
    })
    expect(mockApiPost).toHaveBeenCalled()
    expect(sentIssuePassport()).toBeUndefined()
  })

  it('a stale tick on a non-issuable wallet is still never sent (payload guard)', async () => {
    const { result } = renderHook(() => useAgentConnectionSetup({ open: true, onClose: vi.fn(), accountId: NOT_ISSUABLE.id }))
    // Force the state the effect normally clears, to prove the payload guard
    // holds on its own.
    act(() => result.current.setIssuePassport(true))
    await act(async () => {
      await result.current.handleCreateSetup()
    })
    expect(sentIssuePassport()).toBeUndefined()
  })

  it('fails closed when the backend sends no answer', () => {
    const { result } = renderHook(() => useAgentConnectionSetup({ open: true, onClose: vi.fn(), accountId: UNKNOWN.id }))
    expect(result.current.passportIssuable).toBe(false)
  })
})
