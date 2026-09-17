import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * #3093 — the class behind #1075, #2295 and #3091: `api.get` does no
 * response validation, so a hook that stores a wire key with no default
 * stores `undefined` on an absent key, and the consumer's `.map` takes the
 * whole route into the ErrorBoundary. Every array-storing hook is served its
 * key ABSENT here and must settle on `[]` with no error — the guard that a
 * fixture fix (the pattern in #1075 and #2295) never gave a deploy.
 */
const { mockApiGet } = vi.hoisted(() => ({ mockApiGet: vi.fn() }))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: { ...actual.api, get: (...args: unknown[]) => mockApiGet(...args) },
  }
})
vi.mock('@/lib/signer', () => ({
  useActiveSigner: () => ({ kind: 'none' }),
  hasPasskeyCredentialOnDevice: () => false,
  credentialIdFromKeyId: () => null,
}))
vi.mock('@/lib/delegationPasskeySigner', () => ({}))

import { useCatalog } from '@/hooks/useCatalog'
import { useContacts } from '@/hooks/useContacts'
import { useAgents } from '@/hooks/useAgents'
import { useTransactions } from '@/hooks/useTransactions'
import { useDelegationBudget } from '@/hooks/useDelegationBudget'
import { usePortfolio } from '@/hooks/usePortfolio'
import { useAccountingConnections, useAccountingProviders, useMerchantAccounts } from '@/hooks/useAccounting'

const ADDRESS = '0x1111111111111111111111111111111111111111'

describe('array wire keys default to [] when the response omits them (#3093)', () => {
  beforeEach(() => {
    mockApiGet.mockReset()
  })

  it('useCatalog: entries', async () => {
    mockApiGet.mockResolvedValue({})
    const { result } = renderHook(() => useCatalog())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.entries).toEqual([])
    expect(result.current.error).toBeNull()
  })

  it('useContacts: contacts', async () => {
    mockApiGet.mockResolvedValue({})
    const { result } = renderHook(() => useContacts())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.contacts).toEqual([])
  })

  it('useAgents: agents (and the refetch return value)', async () => {
    mockApiGet.mockResolvedValue({})
    const { result } = renderHook(() => useAgents())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.agents).toEqual([])
    expect(result.current.error).toBeNull()
  })

  it('useTransactions: transactions', async () => {
    mockApiGet.mockResolvedValue({ total: 0, page: 1, limit: 10, pages: 0 })
    const { result } = renderHook(() => useTransactions(ADDRESS, 8453))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.transactions).toEqual([])
  })

  it('useDelegationBudget: delegations', async () => {
    // The signer set is served whole (it is not in scope); only the
    // delegations key is absent.
    mockApiGet.mockImplementation((url: string) =>
      Promise.resolve(url.endsWith('/account-signers') ? { account_address: ADDRESS, passkeys: [], owners: [] } : {}),
    )
    const { result } = renderHook(() => useDelegationBudget('agent-1', 84532))
    await waitFor(() => expect(mockApiGet).toHaveBeenCalledWith('/agents/agent-1/delegations'))
    await waitFor(() => expect(result.current.budgets).toEqual([]))
  })

  it('usePortfolio: breakdown', async () => {
    mockApiGet.mockResolvedValue({ totalUsd: 0, totalEur: 0 })
    const { result } = renderHook(() => usePortfolio(ADDRESS, { chainId: 8453 }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.breakdown).toEqual([])
  })

  it('useAccounting: overrides, providers, connections', async () => {
    mockApiGet.mockResolvedValue({})
    const merchants = renderHook(() => useMerchantAccounts())
    const providers = renderHook(() => useAccountingProviders())
    const connections = renderHook(() => useAccountingConnections())
    await waitFor(() => expect(merchants.result.current.loading).toBe(false))
    await waitFor(() => expect(providers.result.current.loading).toBe(false))
    await waitFor(() => expect(connections.result.current.loading).toBe(false))
    expect(merchants.result.current.overrides).toEqual([])
    expect(providers.result.current.providers).toEqual([])
    expect(connections.result.current.connections).toEqual([])
  })
})
