import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

/**
 * #4327: the agent Activity tab's Export CSV — the shared list export action
 * (#4328), so this file covers only what the TAB supplies: the request (the
 * agent ledger's own export route and the tab's filters, Refused switching
 * the population), the filename prefix, the enabled state and the empty copy.
 * The action's own states are tested once, with the action.
 */

const mocks = vi.hoisted(() => ({
  getText: vi.fn(),
  downloadCsv: vi.fn(),
  payments: { total: 3 },
  refusals: { total: 2 },
}))

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { accounts: [] } }),
}))
vi.mock('@/hooks/useContacts', () => ({
  useContacts: () => ({ resolveAddress: () => null }),
}))
vi.mock('@/hooks/useTransactionFilters', () => ({
  useTransactionFilters: () => ({
    tokens: [
      {
        key: '8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        symbol: 'USDC',
        address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        chainId: 8453,
        isNative: false,
      },
      {
        key: '8453:0x1111111111111111111111111111111111111111',
        symbol: 'WETH',
        address: '0x1111111111111111111111111111111111111111',
        chainId: 8453,
        isNative: false,
      },
    ],
    loading: false,
  }),
}))
vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(async () => ({ total: 0 })),
    getText: (...a: unknown[]) => mocks.getText(...a),
  },
}))
vi.mock('@/lib/csv-export', async () => {
  const actual = await vi.importActual<typeof import('@/lib/csv-export')>('@/lib/csv-export')
  return { ...actual, downloadCsv: (...a: unknown[]) => mocks.downloadCsv(...a) }
})
vi.mock('next/navigation', () => ({
  usePathname: () => '/agents/agent-1',
  useSearchParams: () => new URLSearchParams(window.location.search),
  useRouter: () => ({ replace: () => {}, push: () => {} }),
}))
vi.mock('@/hooks/useAgentActivity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useAgentActivity')>()
  const page = (total: number) => ({
    total,
    hasMore: false,
    loading: false,
    loadingMore: false,
    error: null,
    loadMore: () => {},
    refresh: () => {},
  })
  return {
    ...actual,
    useAgentPaymentLedger: () => ({ payments: [], ...page(mocks.payments.total) }),
    useAgentRefusalLedger: () => ({ refusals: [], ...page(mocks.refusals.total) }),
  }
})

import AgentActivityTab from '../AgentActivityTab'

function renderAt(query: string) {
  window.history.replaceState(null, '', `/agents/agent-1${query}`)
  return render(<AgentActivityTab agentId="agent-1" agentName="Atlas" walletName="Main" needsSetup={false} />)
}

/** The request the export made, as a URL to read params from. */
function exportedUrl(): URL {
  expect(mocks.getText).toHaveBeenCalledTimes(1)
  return new URL(String(mocks.getText.mock.calls[0][0]), 'https://haven.test')
}

afterEach(() => {
  mocks.getText.mockReset()
  mocks.downloadCsv.mockReset()
  mocks.payments.total = 3
  mocks.refusals.total = 2
})

describe('AgentActivityTab — Export CSV (#4327)', () => {
  it("requests the agent ledger's own export with the tab's filters, and saves it under its prefix", async () => {
    mocks.getText.mockResolvedValue('﻿date\r\n"2026-10-01"')
    renderAt('?tab=activity&status=failed&tokenKey=8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913&q=reports&period=7d')

    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))
    await waitFor(() => expect(mocks.downloadCsv).toHaveBeenCalledTimes(1))

    const url = exportedUrl()
    expect(url.pathname).toBe('/agent-activity/agent-1/activity/export.csv')
    expect(url.searchParams.get('status')).toBe('failed')
    expect(url.searchParams.get('token')).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
    expect(url.searchParams.get('q')).toBe('reports')
    // The Period facet as the route's ISO bounds — the list read's own rule.
    expect(url.searchParams.get('from')).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(url.searchParams.get('to')).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(mocks.downloadCsv).toHaveBeenCalledWith(
      '﻿date\r\n"2026-10-01"',
      expect.stringMatching(/^haven-agent-payments-\d{8}\.csv$/),
    )
  })

  it('on Refused exports the refused attempts and sends no token', async () => {
    mocks.getText.mockResolvedValue('﻿date\r\n"2026-10-01"')
    renderAt('?tab=activity&status=refused&tokenKey=8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')

    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))
    await waitFor(() => expect(mocks.downloadCsv).toHaveBeenCalledTimes(1))

    const url = exportedUrl()
    expect(url.searchParams.get('status')).toBe('refused')
    expect(url.searchParams.has('token')).toBe(false)
  })

  it('says "Nothing to export." — no outage arm — when the file has no rows', async () => {
    mocks.getText.mockResolvedValue('﻿date,status')
    renderAt('?tab=activity')

    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))

    expect(await screen.findByText('Nothing to export.')).toBeInTheDocument()
    expect(screen.getByText('No payments match these filters. Widen them and try again.')).toBeInTheDocument()
    expect(screen.queryByText(/failed to load/)).toBeNull()
    expect(mocks.downloadCsv).not.toHaveBeenCalled()
  })

  it('is disabled while the server says the population is empty', () => {
    mocks.payments.total = 0
    renderAt('?tab=activity')

    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeDisabled()
  })
})
