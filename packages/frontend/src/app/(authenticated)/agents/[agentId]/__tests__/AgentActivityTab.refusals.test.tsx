import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { RefusalActivityItem } from '@/lib/refusal-reasons'
import { refusalRowView } from '../AgentActivityTab'
import { refusalReasonWords, refusalRowSubline } from '@/lib/refusal-reasons'

/**
 * #4323: the refusal rows of the agent Activity tab. The pure adapter
 * (`refusalRowView`) is asserted per REASON — the acceptance criterion's
 * "a test per reason" — and the rendered tab is asserted for the badge, the
 * unsigned amount, the hidden Token facet, the non-interactive rows and the
 * deep link, with the two readers mocked at their seam.
 */

function refusal(overrides: Partial<RefusalActivityItem> = {}): RefusalActivityItem {
  return {
    type: 'refusal',
    id: 'refusal-1',
    created_at: '2026-10-23T09:00:00.000Z',
    amount: '25000',
    token_symbol: 'USDC',
    chain_id: 8453,
    merchant_to: '0x0000000000000000000000000000000000000009',
    resource_url: 'https://research.example/report',
    reason: 'delegation_budget_exceeded',
    attempts: 1,
    approx_amount_usd: null,
    approx_amount_eur: null,
    approx_amount_sek: null,
    ...overrides,
  }
}

const resolveAddress = () => null
const accountNamesByAddress = new Map<string, string>()

describe('refusalReasonWords — the one map, per reason (#4323)', () => {
  it('delegation_budget_exceeded reads "Over its budget" (all the budget caps share it)', () => {
    expect(refusalReasonWords('delegation_budget_exceeded')).toBe('Over its budget')
  })

  it('delegation_expired reads "Its budget had expired"', () => {
    expect(refusalReasonWords('delegation_expired')).toBe('Its budget had expired')
  })

  it('no_delegation_for_target reads "Recipient outside its rules"', () => {
    expect(refusalReasonWords('no_delegation_for_target')).toBe('Recipient outside its rules')
  })

  it('relayer_budget reads "Haven\'s sponsorship limit"', () => {
    expect(refusalReasonWords('relayer_budget')).toBe("Haven's sponsorship limit")
  })

  it('onchain_revert reads "Refused by the network"', () => {
    expect(refusalReasonWords('onchain_revert')).toBe('Refused by the network')
  })

  it('an unknown reason (an older frontend against a newer backend) still refuses plainly', () => {
    expect(refusalReasonWords('something_new')).toBe('Refused by a guardrail')
  })
})

describe('refusalRowSubline — the "no money moved" rule', () => {
  it('every reason but relayer_budget ends "No money moved"', () => {
    for (const reason of [
      'delegation_budget_exceeded',
      'delegation_expired',
      'no_delegation_for_target',
      'onchain_revert',
    ]) {
      expect(refusalRowSubline(reason).endsWith('No money moved')).toBe(true)
    }
  })

  it('relayer_budget names the double listing instead — the payment stayed pending', () => {
    expect(refusalRowSubline('relayer_budget')).toBe(
      "Haven's sponsorship limit · The payment stayed pending and can be retried",
    )
  })
})

describe('refusalRowView — the row inputs', () => {
  it('titles the merchant host first', () => {
    expect(refusalRowView(refusal(), resolveAddress, accountNamesByAddress).title).toBe(
      'research.example',
    )
  })

  it('an addressed refusal falls through to the recipient resolution, not "Agent payment"', () => {
    const view = refusalRowView(refusal({ resource_url: null }), resolveAddress, accountNamesByAddress)
    expect(view.title).not.toBe('Agent payment')
  })

  it('the value is UNSIGNED — no money moved, so no sign and no danger tone input', () => {
    const view = refusalRowView(refusal(), resolveAddress, accountNamesByAddress)
    expect(view.value).not.toContain('-')
    expect(view.value).toBe('0.025')
  })

  it('an unknown token falls back honestly rather than fabricating a figure', () => {
    const view = refusalRowView(refusal({ token_symbol: 'NOPE' }), resolveAddress, accountNamesByAddress)
    expect(view.value).not.toContain('-')
  })

  it('carries the day-group instant from created_at', () => {
    expect(refusalRowView(refusal(), resolveAddress, accountNamesByAddress).timestamp).toBe(
      Math.floor(new Date('2026-10-23T09:00:00.000Z').getTime() / 1000),
    )
  })
})

// ── The rendered tab ─────────────────────────────────────────────────────────

/** Mutable so a test can empty the population before rendering. */
const state = vi.hoisted(() => ({ refusals: [] as RefusalActivityItem[] }))

const FIXTURE: RefusalActivityItem[] = [
  refusal({ id: 'r-budget', reason: 'delegation_budget_exceeded' }),
  refusal({ id: 'r-expired', reason: 'delegation_expired', resource_url: null }),
  refusal({ id: 'r-target', reason: 'no_delegation_for_target' }),
  refusal({ id: 'r-relayer', reason: 'relayer_budget', resource_url: null }),
  refusal({ id: 'r-revert', reason: 'onchain_revert' }),
]

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
  api: { get: vi.fn(async () => ({ total: 0 })) },
}))
vi.mock('next/navigation', () => ({
  usePathname: () => '/agents/agent-1',
  useSearchParams: () => new URLSearchParams(window.location.search),
  useRouter: () => ({ replace: () => {}, push: () => {} }),
}))
vi.mock('@/hooks/useAgentActivity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useAgentActivity')>()
  return {
    ...actual,
    useAgentPaymentLedger: () => ({
      payments: [],
      total: 0,
      hasMore: false,
      loading: false,
      loadingMore: false,
      error: null,
      loadMore: () => {},
      refresh: () => {},
    }),
    useAgentRefusalLedger: () => ({
      refusals: state.refusals,
      total: state.refusals.length,
      hasMore: false,
      loading: false,
      loadingMore: false,
      error: null,
      loadMore: () => {},
      refresh: () => {},
    }),
  }
})

import AgentActivityTab from '../AgentActivityTab'

function renderRefused() {
  return render(<AgentActivityTab agentId="agent-1" agentName="Atlas" walletName="Main" needsSetup={false} />)
}

describe('AgentActivityTab — the refused population (#4323)', () => {
  it('the deep link opens the tab filtered to refused attempts — one row per reason, badge and words shown', () => {
    state.refusals = FIXTURE
    window.history.replaceState(null, '', '/agents/agent-1?tab=activity&status=refused')
    renderRefused()

    // One row per reason, each carrying the reason in words — the acceptance
    // criterion's per-reason render, on the tab itself.
    expect(screen.getByText('Over its budget · No money moved')).toBeInTheDocument()
    expect(screen.getByText('Its budget had expired · No money moved')).toBeInTheDocument()
    expect(screen.getByText('Recipient outside its rules · No money moved')).toBeInTheDocument()
    expect(
      screen.getByText("Haven's sponsorship limit · The payment stayed pending and can be retried"),
    ).toBeInTheDocument()
    expect(screen.getByText('Refused by the network · No money moved')).toBeInTheDocument()

    // The neutral Refused badge rides every row — five row badges plus the
    // facet chip's own "Refused" value span.
    expect(screen.getAllByText('Refused')).toHaveLength(6)

    // The amount is UNSIGNED (no money moved): every USDC row reads 0.025
    // with no direction sign anywhere on it.
    const amounts = screen.getAllByText('0.025 USDC')
    expect(amounts).toHaveLength(5)
    for (const amount of amounts) expect(amount.textContent).not.toContain('-')
    expect(document.body.textContent).not.toContain('-0.025')
  })

  it('refusal rows are NOT interactive — ledger rows hold no controls', () => {
    state.refusals = FIXTURE
    window.history.replaceState(null, '', '/agents/agent-1?tab=activity&status=refused')
    const { container } = renderRefused()
    expect(container.querySelector('[role="button"]')).toBeNull()
  })

  it('the Token facet is hidden while Refused is selected — a refusal has no token address', () => {
    state.refusals = FIXTURE
    window.history.replaceState(null, '', '/agents/agent-1?tab=activity&status=refused')
    renderRefused()
    // Two contract tokens are offered (so the facet would not hide for want
    // of options) — its absence on Refused is the population switch, not the
    // single-option rule. The Status trigger remains (toolbar + sheet).
    expect(screen.queryByText(/Token:/)).toBeNull()
    expect(screen.getAllByText(/Status:/).length).toBeGreaterThan(0)
  })

  it('an empty refusal population reads "No refused attempts"', () => {
    state.refusals = []
    window.history.replaceState(null, '', '/agents/agent-1?tab=activity&status=refused')
    renderRefused()
    expect(screen.getByText('No refused attempts')).toBeInTheDocument()
  })
})
