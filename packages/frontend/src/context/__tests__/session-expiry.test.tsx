import React, { useEffect, useState } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'

/**
 * #4827, the two vehicles the acceptance criteria name.
 *
 * `fetch` is stubbed and `@/lib/api` is NOT mocked, so the real API client, the
 * real `AuthProvider` and the real `ProtectedRoute` are all in the path. That is
 * the point: the 401 reaction lives in the client, so a test that stubs the
 * client would prove nothing about it.
 */

const mockReplace = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: mockReplace,
    push: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
}))

import { AuthProvider } from '@/context/AuthContext'
import ProtectedRoute from '@/components/ProtectedRoute'
import { useDashboardOverview } from '@/hooks/useDashboardOverview'
import { api } from '@/lib/api'

const ACCOUNT_ADDRESS = `0x${'ab'.repeat(20)}`

const USER = {
  id: 'user-1',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  wallet_address: null,
  account_address: ACCOUNT_ADDRESS,
  accounts: [
    {
      id: 'acct-1',
      account_address: ACCOUNT_ADDRESS,
      chain_id: 8453,
      name: 'Main',
      is_default: true,
      created_at: '2026-05-04T00:00:00.000Z',
    },
  ],
}

const OVERVIEW = {
  totals: { usd: 1234.5, eur: 1100 },
  change: { available: false, usdAmount: 0, eurAmount: 0, usdPercent: 0, eurPercent: 0 },
  actionableApprovals: 0,
  pendingApprovals: 0,
  onboardingProgress: { hasFirstAgentPayment: false },
  agents: [],
  agentCount: { active: 0, paused: 0, pending_approval: 0 },
  accounts: [],
  spend: {
    scope: 'mainnet',
    d7: { gross: { usd: 0, eur: 0, sek: 0 }, net: { usd: 0, eur: 0, sek: 0 }, approx: false, payments: 0, distinctMerchants: 0, budgetStops: 0 },
    d30: { gross: { usd: 0, eur: 0, sek: 0 }, net: { usd: 0, eur: 0, sek: 0 }, approx: false, payments: 0, distinctMerchants: 0, budgetStops: 0 },
    topMerchant7d: null,
    failedIntents7d: 0,
    balance_by_day: [],
  },
  spotRates: {},
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  }
}

/** The session is live until `expired` flips; then every authenticated read 401s. */
let expired = false

function installFetchStub() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input).replace(/^\/api/, '')
    if (path.startsWith('/auth/me')) return jsonResponse(USER)
    if (path.startsWith('/passkeys')) return jsonResponse({ passkeys: [] })
    if (path.startsWith('/accounts/hybrid/')) return jsonResponse({})
    if (path.startsWith('/dashboard/overview')) {
      return expired ? jsonResponse({ error: 'Unauthorized' }, 401) : jsonResponse(OVERVIEW)
    }
    if (path.startsWith('/agents')) {
      return expired ? jsonResponse({ error: 'Unauthorized' }, 401) : jsonResponse({ agents: [] })
    }
    return jsonResponse({ error: 'not found' }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <ProtectedRoute>{children}</ProtectedRoute>
    </AuthProvider>
  )
}

/**
 * Fake timers are on for the poll, and RTL's `waitFor` cannot see vitest's
 * fake timers (it looks for a `jest` global), so it would wait on a real
 * interval that never fires. Flush the promise chain by hand instead.
 */
async function flush(rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

/** Vehicle (a): the overview poll. */
function OverviewConsumer() {
  const { data } = useDashboardOverview()
  return <div data-testid="total">{data ? String(data.totals.usd) : 'none'}</div>
}

/** Vehicle (b): a call that is neither a poll nor `useDashboardOverview`. */
function AgentsConsumer() {
  const [state, setState] = useState('idle')
  useEffect(() => {
    if (state !== 'requested') return
    void api
      .get('/agents')
      .then(() => setState('loaded'))
      .catch(() => setState('failed'))
  }, [state])
  return (
    <div>
      <button type="button" onClick={() => setState('requested')}>
        Load agents
      </button>
      <div data-testid="agents">{state}</div>
    </div>
  )
}

describe('a 401 from an authenticated call ends the session (#4827)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockReplace.mockReset()
    expired = false
    localStorage.setItem('haven_token', 'token-a')
    installFetchStub()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('the overview poll signs out within one poll and the rendered total is gone', async () => {
    render(
      <Shell>
        <OverviewConsumer />
      </Shell>,
    )

    await flush()
    expect(screen.getByTestId('total').textContent).toBe('1234.5')
    expect(mockReplace).not.toHaveBeenCalled()

    expired = true
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    await flush()

    expect(localStorage.getItem('haven_token')).toBeNull()
    expect(mockReplace).toHaveBeenCalledTimes(1)
    expect(mockReplace).toHaveBeenCalledWith('/login')
    expect(screen.queryByTestId('total')).toBeNull()
  })

  it('a call that is neither a poll nor useDashboardOverview signs out the same way', async () => {
    render(
      <Shell>
        <AgentsConsumer />
      </Shell>,
    )

    await flush()
    expect(screen.getByTestId('agents').textContent).toBe('idle')
    expect(mockReplace).not.toHaveBeenCalled()

    expired = true
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Load agents' }))
    })
    await flush()

    expect(localStorage.getItem('haven_token')).toBeNull()
    expect(mockReplace).toHaveBeenCalledTimes(1)
    expect(mockReplace).toHaveBeenCalledWith('/login')
    expect(screen.queryByTestId('agents')).toBeNull()
  })

  /**
   * One sign-out per ended session: two in-flight authenticated calls that both
   * answer 401 produce exactly one redirect, because the first sign-out removes
   * the token the second answer would have to match.
   */
  it('two in-flight 401s produce exactly one sign-out', async () => {
    render(
      <Shell>
        <AgentsConsumer />
      </Shell>,
    )

    await flush()
    expect(screen.getByTestId('agents').textContent).toBe('idle')

    expired = true
    await act(async () => {
      void api.get('/agents').catch(() => {})
      void api.get('/dashboard/overview').catch(() => {})
    })
    await flush()

    expect(localStorage.getItem('haven_token')).toBeNull()
    expect(mockReplace).toHaveBeenCalledTimes(1)
  })
})
