import { fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { budgetCardTokens, budgetCardRetired } = vi.hoisted(() => ({
  budgetCardTokens: [] as Array<Array<{ address: string; symbol: string; decimals: number }>>,
  budgetCardRetired: [] as Array<string | undefined>,
}))

const {
  mockUseAuth,
  mockUseAgents,
  mockUseAgentActivity,
  mockUseAgentPaymentLedger,
  mockUseAgentToolCallLog,
  mockUseDelegateBalance,
  mockUseAgentPassport,
  mockUseDashboardOverview,
} = vi.hoisted(() => ({
  mockUseAuth: vi.fn(),
  mockUseAgents: vi.fn(),
  mockUseAgentActivity: vi.fn(),
  mockUseAgentPaymentLedger: vi.fn(),
  mockUseAgentToolCallLog: vi.fn(),
  mockUseDelegateBalance: vi.fn(),
  mockUseAgentPassport: vi.fn(),
  mockUseDashboardOverview: vi.fn(),
}))

const { mockRouterPush, mockRouterReplace } = vi.hoisted(() => ({
  mockRouterPush: vi.fn(),
  mockRouterReplace: vi.fn(),
}))

const { mockUseCompanyDetails, mockRegistryTokens, mockRegistryState } = vi.hoisted(() => ({
  mockUseCompanyDetails: vi.fn(),
  // #4249 (review M1): whether the token registry is still loading.
  mockRegistryState: { loading: false },
  // #4226: the token registry the Token facet reads. Default: one token —
  // facets with a single option render nothing (ListToolbar's rule), so a
  // test that wants the Token trigger seeds a second entry and restores.
  mockRegistryTokens: [
    {
      key: '100:0x036cbd53842c5426634e7929541ec2318f3dcf7e',
      symbol: 'USDC',
      address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      chainId: 100,
      isNative: false,
    },
  ] as Array<{ key: string; symbol: string; address?: string; chainId: number; isNative: boolean }>,
}))

vi.mock('@/hooks/useTransactionFilters', () => ({
  useTransactionFilters: () => ({ tokens: mockRegistryTokens, loading: mockRegistryState.loading }),
}))

vi.mock('@/hooks/useCompanyDetails', () => ({
  useCompanyDetails: () => mockUseCompanyDetails(),
}))

// #1402: the component navigates to /agents after a completed remove.
// #4226: the page owns `?tab=` through `useSearchParams`, read from the real
// URL so a tab test seeds it with `window.history.replaceState`.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockRouterPush, replace: mockRouterReplace, back: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search),
  usePathname: () => typeof window === 'undefined' ? '/' : window.location.pathname,
}))

// The dialog's own sequence is proven in RemoveAgentDialog.test.tsx. Here only
// what the PAGE wires into it matters (#3542): which mode it opens in, what it
// does when the budget ends, and whether it navigates.
vi.mock('@/components/agent-panel/RemoveAgentDialog', () => ({
  RemoveAgentDialog: ({
    mode,
    onArchive,
    onBudgetEnded,
    onClose,
  }: {
    mode?: string
    onArchive: () => Promise<void>
    onBudgetEnded?: () => void
    onClose: () => void
  }) => (
    <div data-testid="remove-agent-dialog" data-mode={mode ?? 'remove'}>
      <button type="button" onClick={() => { onBudgetEnded?.(); onClose() }}>
        stub: budget ended
      </button>
      <button type="button" onClick={() => void onArchive()}>
        stub: archive
      </button>
    </div>
  ),
}))

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}))

vi.mock('@/hooks/useAgents', () => ({
  useAgents: () => mockUseAgents(),
}))

vi.mock('@/hooks/useAgentActivity', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useAgentActivity')>('@/hooks/useAgentActivity')
  return {
    ...actual,
    useAgentActivity: () => mockUseAgentActivity(),
    // #4226: the Activity tab's paged reader — the page tests assert on the
    // rendered rows, so the reader is the mock surface, not `api`.
    useAgentPaymentLedger: (...args: unknown[]) => mockUseAgentPaymentLedger(...args),
    // #4227: the Tool calls tab's paged reader — same mock surface.
    useAgentToolCallLog: () => mockUseAgentToolCallLog(),
  }
})

vi.mock('@/hooks/useDashboardOverview', () => ({
  useDashboardOverview: () => mockUseDashboardOverview(),
}))

vi.mock('@/hooks/useContacts', () => ({
  useContacts: () => ({ resolveAddress: () => null }),
}))

vi.mock('@/hooks/useDelegateBalance', () => ({
  useDelegateBalance: (...args: unknown[]) => mockUseDelegateBalance(...args),
}))

vi.mock('@/hooks/useAgentPassport', () => ({
  useAgentPassport: (...args: unknown[]) => mockUseAgentPassport(...args),
}))

vi.mock('@/components/OnchainActionGate', () => ({
  default: ({ children }: { children: ReactNode | (() => ReactNode) }) => (
    <>{typeof children === 'function' ? children() : children}</>
  ),
  OnchainActionNotice: () => null,
  isOnchainActionBlocked: () => false,
}))

vi.mock('@/components/PasskeyOtherDeviceNotice', () => ({
  default: () => null,
}))

vi.mock('@/components/EditAgentModal', () => ({
  // Renders a marker when open so routing tests can assert the modal did /
  // did not open (#1079).
  default: ({ open }: { open: boolean }) =>
    open ? <div data-testid="edit-agent-modal">Edit agent</div> : null,
}))

vi.mock('@/components/DelegationBudgetCard', () => ({
  // #2473: records the token options it was handed, so the first-budget
  // regression can be asserted without rendering the real card.
  default: (props: { tokens: Array<{ address: string; symbol: string; decimals: number }>; retired?: string }) => {
    budgetCardTokens.push(props.tokens)
    budgetCardRetired.push(props.retired)
    return <div>DelegationBudgetCard</div>
  },
  DELEGATION_BUDGET_CARD_ID: 'delegation-budget-card',
}))

vi.mock('@/components/PaymentCredentialsModal', () => ({
  default: ({ open }: { open: boolean }) =>
    open ? <div data-testid="payment-credentials-modal" /> : null,
}))

vi.mock('@/components/agent-panel/ReplaceSigningKeyModal', () => ({
  ReplaceSigningKeyModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="replace-signing-key-modal" /> : null,
}))

vi.mock('@/components/ConfirmDialog', () => ({
  default: () => null,
}))

import { AGENT_PAUSED_BODY, AGENT_PAUSED_TITLE } from '@/lib/agent-pause-copy'
import { HALF_REVOKED_TITLE } from '@/lib/half-revoked'
import { AgentRow, type DashboardAgent } from '@/components/haven/AgentRow'
import AgentDetailClient from '../AgentDetailClient'
import { DEFAULT_CHAIN_ID } from '@/lib/chains'
import { MCP_NOT_RECORDED_NOTE } from '@/components/agent-panel/McpServerName'

const VIES_VALID_ROW = {
  legal_name: 'Acme AB',
  country: 'SE',
  org_number: '556677-8899',
  vat_number: 'SE556677889901',
  vies_status: 'valid',
  vies_checked_at: '2026-09-28T12:00:00.000Z',
  created_at: '2026-09-28T10:00:00.000Z',
  updated_at: '2026-09-28T12:00:00.000Z',
} as const

const SAFE = {
  id: 'safe-1',
  name: 'Main account',
  account_address: '0x1111111111111111111111111111111111111111',
  chain_id: 100,
}

// #3694: Remove, Restore and the rest live in the ⋮ menu. Opens it and
// returns the item labels in render order — the order is part of the claim.
function openAgentMenu(): string[] {
  fireEvent.click(screen.getByRole('button', { name: 'Agent options' }))
  return screen.getAllByRole('menuitem').map((item) => item.textContent ?? '')
}

/**
 * #4226: seeds the Activity tab's paged reader. Rows here are the tab's own
 * render input; `total` is #4229's server figure.
 */
function mockLedgerWith(
  payments: Array<Record<string, unknown>>,
  total: number = payments.length,
  extra: Record<string, unknown> = {},
) {
  mockUseAgentPaymentLedger.mockReturnValue({
    payments,
    total,
    hasMore: false,
    loading: false,
    loadingMore: false,
    error: null,
    loadMore: vi.fn(),
    refresh: vi.fn(),
    ...extra,
  })
}

/** Seeds `?tab=settings` — the Settings tab's content (#4228). */
function renderOnSettingsTab(ui: React.ReactElement) {
  window.history.replaceState(null, '', '/agents/agent-1?tab=settings')
  return render(ui)
}

describe('AgentDetailClient last-activity metadata', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-01T12:00:00Z'))
    mockUseAuth.mockReturnValue({
      user: {
        accounts: [SAFE],
      },
    })
    mockUseAgents.mockReturnValue({
      agents: [
        {
          id: 'agent-1',
          name: 'Research agent',
          description: null,
          delegate_address: '0x2222222222222222222222222222222222222222',
          account_id: 'safe-1',
          account_address: SAFE.account_address,
          account_name: 'Main account',
          status: 'active',
          created_at: '2026-05-01T00:00:00Z',
          mcp_last_seen_at: '2026-06-01T10:00:00Z',
          allowances: [],
          labels: [],
          account_type: 'delegator_hybrid',
        },
      ],
      loading: false,
      pauseAgent: vi.fn(),
      resumeAgent: vi.fn(),
      revokeAgent: vi.fn(),
      refetch: vi.fn(),
    })
    mockUseAgentActivity.mockReturnValue({
      activity: [],
      stats: null,
      loading: false,
    })
    // #4226: the Activity tab's reader — empty and idle unless a test seeds
    // rows. `loadMore`/`refresh` are fns so a stray call cannot crash.
    mockUseAgentPaymentLedger.mockReturnValue({
      payments: [],
      total: 0,
      hasMore: false,
      loading: false,
      loadingMore: false,
      error: null,
      loadMore: vi.fn(),
      refresh: vi.fn(),
    })
    // #4227: the Tool calls tab's reader — empty and idle unless seeded.
    mockUseAgentToolCallLog.mockReturnValue({
      items: [],
      total: 0,
      hasMore: false,
      errorCount: 0,
      loading: false,
      loadingMore: false,
      error: null,
      loadMore: vi.fn(),
      refresh: vi.fn(),
    })
    // Default: the overview answers nothing — the hero renders no Last 30
    // days column. Hero-column tests override this.
    mockUseDashboardOverview.mockReturnValue({
      data: null,
      loading: false,
      error: null,
      refetch: vi.fn(),
    })
    // Default: delegate wallet is empty, so recovery UI stays hidden.
    mockUseDelegateBalance.mockReturnValue({
      balance: null,
      hasStranded: false,
      hasRecoverableUsdc: false,
      hasBelowMinimumUsdc: false,
      loading: false,
      refetch: vi.fn(),
    })
    mockUseAgentPassport.mockReturnValue({
      passport: null,
      standing: null,
      loading: false,
      issuing: false,
      issueError: null,
      issuePassport: vi.fn(),
      refetch: vi.fn(),
    })
    // Default: the tax row's visibility rule reads "flag off" — deterministic
    // for every test that does not care; the #3697 tests override it.
    mockUseCompanyDetails.mockReturnValue({ status: 'off', details: null })
  })

  afterEach(() => {
    vi.useRealTimers()
    // #4226: tab tests seed the URL; reset it so the next render starts clean.
    window.history.replaceState(null, '', '/agents/agent-1')
  })

  /**
   * #2106: the headline stat row carried a "Pending approvals" tile fed by
   * `routes/agent-activity.ts`'s hardcoded `const pendingApprovals = 0` — the
   * backend's own comment says the queue died with the AllowanceModule rail.
   * A counter that can only ever read 0 tells the user a queue EXISTS and is
   * currently empty; on the delegation rail an out-of-budget payment reverts
   * on-chain and is never held for anyone. The tile is removed rather than
   * re-labelled.
   *
   * Asserted on the LABEL and on the helper separately: a rename that kept the
   * permanently-zero counter would pass a label-only check.
   */
  it('renders no Pending-approvals tile — the queue it implies does not exist (#2106)', () => {
    mockUseAgentActivity.mockReturnValue({
      activity: [],
      stats: { all_time: [], today: [], pending_approvals: 0 },
      loading: false,
    })
    render(<AgentDetailClient agentId="agent-1" />)

    expect(screen.queryByText('Pending approvals')).not.toBeInTheDocument()
    expect(screen.queryByText('Payments waiting on you')).not.toBeInTheDocument()
  })

  /**
   * #3696 moved the stat cards' figures into the Activity header's summary
   * line; #4226 replaced that header with the tab's own toolbar figures —
   * the count line and the "Out {total}" summary, both from #4229's `total`
   * over the FILTERED set. The retired labels no longer appearing is the
   * check that fails on the pre-slice tree.
   */
  it('replaces the stat-card figures with the Activity tab\'s server count (#4226)', () => {
    mockUseAgentActivity.mockReturnValue({
      activity: [],
      stats: {
        all_time: [{ token: 'USDC', total_spent: '482.50', tx_count: 37 }],
        today: [{ token: 'USDC', total_spent: '25.00', tx_count: 1 }],
        pending_approvals: 0,
      },
      loading: false,
    })
    mockLedgerWith([], 37)

    render(<AgentDetailClient agentId="agent-1" />)

    expect(screen.queryByText('All-time transactions')).not.toBeInTheDocument()
    expect(screen.queryByText('Confirmed agent payments')).not.toBeInTheDocument()
    // #4274 (owner decision (a)): the toolbar's count stands alone — the old
    // "Out <total>" summary repeated it and, beside the account tab's money
    // In/Out, read as an amount. Assert the count itself, and that no
    // visible "Out" figure rides beside it.
    expect(screen.getByTestId('list-toolbar-count')).toHaveTextContent('37')
    expect(screen.queryByText('Out')).not.toBeInTheDocument()
  })

  it('carries no "see elsewhere" link to /transactions — the tab is a full ledger (#4327)', () => {
    render(<AgentDetailClient agentId="agent-1" />)

    // #4226 put a transactions link under the list; #4327 removes it, as
    // the account tab and /transactions have none. Export CSV is the tab's
    // own action instead.
    expect(screen.queryByRole('link', { name: /in Transactions/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeInTheDocument()
  })

  /**
   * #4226 put the MCP panel in its own Tool calls TAB; #4227 rebuilds it —
   * plain-language labels over #4229's kinded read. Placement contract
   * asserted structurally: the tab lives in the tool-calls section and the
   * Activity section (the #2196 scroll target) does not exist on this tab.
   */
  it('renders the rebuilt Tool calls tab in its tab, out of Activity (#4227)', () => {
    mockUseAgentToolCallLog.mockReturnValue({
      items: [
        {
          type: 'mcp_tool_call',
          id: 'mcp-1',
          agent_id: 'agent-1',
          tool_name: 'haven_get_payment_status',
          payment_id: null,
          result_status: 'ok',
          next_action: null,
          error_code: null,
          status_code: 200,
          created_at: '2026-05-30T10:00:00Z',
        },
      ],
      total: 1,
      hasMore: false,
      errorCount: 0,
      loading: false,
      loadingMore: false,
      error: null,
      loadMore: vi.fn(),
      refresh: vi.fn(),
    })
    window.history.replaceState(null, '', '/agents/agent-1?tab=tool-calls')

    render(<AgentDetailClient agentId="agent-1" />)

    const section = screen.getByTestId('agent-tool-calls-section')
    // The row leads with the plain-language label; the raw name is second.
    expect(within(section).getByText('Checked a payment')).toBeInTheDocument()
    expect(within(section).getByText('haven_get_payment_status').tagName).toBe('CODE')
    // The old panel is gone: no "MCP tool calls" heading, no --v2-divider.
    expect(within(section).queryByText('MCP tool calls')).toBeNull()
    expect(document.body.innerHTML).not.toContain('v2-divider')
    // Out of the Activity tab: its section (and the #2196 anchor with it)
    // does not exist while Tool calls is showing.
    expect(document.getElementById('agent-activity')).toBeNull()
  })

  /**
   * #4227: a call that touched a payment links to it — the link selects the
   * Activity tab and carries the payment id, which the Activity tab reads
   * (#4229's `paymentId`) to open that payment's detail panel.
   */
  it('a tool call with a payment links to the Activity tab with the payment id (#4227)', () => {
    mockUseAgentToolCallLog.mockReturnValue({
      items: [
        {
          type: 'mcp_tool_call',
          id: 'mcp-2',
          agent_id: 'agent-1',
          tool_name: 'haven_pay_x402_quote',
          payment_id: 'pay-77',
          result_status: 'ok',
          next_action: null,
          error_code: null,
          status_code: 200,
          created_at: '2026-05-30T10:00:00Z',
        },
      ],
      total: 1,
      hasMore: false,
      errorCount: 0,
      loading: false,
      loadingMore: false,
      error: null,
      loadMore: vi.fn(),
      refresh: vi.fn(),
    })
    window.history.replaceState(null, '', '/agents/agent-1?tab=tool-calls')

    render(<AgentDetailClient agentId="agent-1" />)

    fireEvent.click(screen.getByTestId('tool-call-payment-link'))
    expect(mockRouterReplace).toHaveBeenCalledWith(
      '/agents/agent-1?tab=activity&paymentId=pay-77',
      { scroll: false },
    )
  })

  it('renders last activity in the header meta without a default connected badge', () => {
    render(<AgentDetailClient agentId="agent-1" />)

    expect(screen.getByRole('heading', { level: 1, name: 'Research agent' })).toBeInTheDocument()
    expect(screen.getByText('Last activity 2h ago')).toBeInTheDocument()
    expect(screen.queryByText('Connected')).not.toBeInTheDocument()
  })

  it('uses the same decorative initials and tint in the shared row and detail header (#4208)', () => {
    const dashboardAgent: DashboardAgent = {
      id: 'agent-1',
      name: 'Research agent',
      status: 'active',
      avatarTint: 1,
      accountId: 'safe-1',
      accountName: 'Main account',
      accountChainId: 8453, budgetEndedAt: null,
      allowances: [],
      budgets: [],
      receivedSubBudgets: [],
      stats: {
        d7: {
          gross: { usd: 0, eur: 0, sek: 0 },
          net: { usd: 0, eur: 0, sek: 0 },
          approx: false,
          payments: 0,
          refusals: { budget: 0, expired: 0, scope: 0, failed: 0, haven: 0 },
        },
        d30: {
          gross: { usd: 0, eur: 0, sek: 0 },
          net: { usd: 0, eur: 0, sek: 0 },
          approx: false,
          payments: 0,
          refusals: { budget: 0, expired: 0, scope: 0, failed: 0, haven: 0 },
        },
        lastPaymentAt: null,
        lastCounterparty: null,
      },
    }

    render(
      <>
        <AgentRow
          agent={dashboardAgent}
          budgetRemaining={null}
          attentionItems={[]}
          accountNames={{}}
          accountCount={1}
          nowMs={Date.parse('2026-06-01T12:00:00Z')}
        />
        <AgentDetailClient agentId="agent-1" />
      </>,
    )

    const row = screen.getByRole('link', {
      name: 'Research agent No budget No payments yet',
    })
    const rowMark = row.firstElementChild as HTMLElement
    const header = screen.getByRole('banner')
    const headerMark = header.querySelector<HTMLElement>('[aria-hidden="true"].h-12')

    expect(headerMark).not.toBeNull()
    expect(rowMark).toHaveAttribute('aria-hidden', 'true')
    expect(headerMark).toHaveAttribute('aria-hidden', 'true')
    expect(rowMark).toHaveTextContent('RA')
    expect(headerMark).toHaveTextContent('RA')
    expect(headerMark?.className.match(/bg-\[var\(--v2-avatar-[^)]+-soft\)\]/)?.[0]).toBe(
      rowMark.className.match(/bg-\[var\(--v2-avatar-[^)]+-soft\)\]/)?.[0],
    )
    expect(headerMark?.firstElementChild?.className.match(/text-\[var\(--v2-avatar-[^)]+\)\]/)?.[0]).toBe(
      rowMark.firstElementChild?.className.match(/text-\[var\(--v2-avatar-[^)]+\)\]/)?.[0],
    )
    expect(screen.getAllByRole('heading', { level: 1, name: 'Research agent' })).toHaveLength(1)
  })

  // #3694: the "About this agent" card's four facts moved into the header's
  // meta line (#3692's PageHeader slot); the card is gone.
  it('carries wallet, network, created and last activity in the header meta, with no About card (#3694)', () => {
    render(<AgentDetailClient agentId="agent-1" />)
    expect(screen.queryByRole('heading', { name: 'About this agent' })).not.toBeInTheDocument()
    const header = screen.getByRole('banner')
    expect(header).toHaveTextContent('Main account · Gnosis Chain · Created 1mo ago · Last activity 2h ago')
  })

  // #4028 — the way back to the agents list exists in EVERY state of the
  // page. The top bar's link used to cover the loading and not-found states
  // by accident of living outside the page; with it gone, each branch carries
  // its own BackLink.
  describe('back link to the agents list (#4028)', () => {
    function expectBackToAgents() {
      const link = screen.getByRole('link', { name: 'Agents' })
      expect(link.getAttribute('href')).toBe('/agents')
    }

    it('renders above the title in the loaded page', () => {
      render(<AgentDetailClient agentId="agent-1" />)
      expectBackToAgents()
      const link = screen.getByRole('link', { name: 'Agents' })
      const title = screen.getByRole('heading', { level: 1, name: 'Research agent' })
      expect(link.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    it('renders while the agent is loading, outside the live region', () => {
      mockUseAgents.mockReturnValue({ ...mockUseAgents(), agents: [], loading: true })
      render(<AgentDetailClient agentId="agent-1" />)
      expectBackToAgents()
      const status = screen.getByRole('status', { name: 'Loading agent details' })
      expect(status.contains(screen.getByRole('link', { name: 'Agents' }))).toBe(false)
    })

    it('renders when the agent is not found', () => {
      mockUseAgents.mockReturnValue({ ...mockUseAgents(), agents: [], loading: false })
      render(<AgentDetailClient agentId="agent-1" />)
      expect(screen.getByRole('heading', { name: 'Agent not found' })).toBeInTheDocument()
      expectBackToAgents()
    })

    it('renders when the agent could not load', () => {
      mockUseAgents.mockReturnValue({
        ...mockUseAgents(),
        agents: [],
        loading: false,
        error: new Error('offline'),
      })
      render(<AgentDetailClient agentId="agent-1" />)
      expect(screen.getByRole('heading', { name: 'Agent could not load' })).toBeInTheDocument()
      expectBackToAgents()
    })
  })

  it('says "No activity yet" in the meta when the agent was never seen (#3694)', () => {
    const base = mockUseAgents()
    mockUseAgents.mockReturnValue({
      ...base,
      agents: base.agents.map((a: Record<string, unknown>) => ({ ...a, mcp_last_seen_at: null })),
    })
    render(<AgentDetailClient agentId="agent-1" />)
    expect(screen.getByRole('banner')).toHaveTextContent('Created 1mo ago · No activity yet')
  })

  // #4209: the MCP server name moved here from the `/agents` card, with its
  // copy button, and the `not recorded` note (#2043) moved with it. #4228
  // rebuilt the row as the Settings tab's Connection row — the testids and
  // copy contracts stand; #4209's tests are retargeted, not duplicated.
  describe('Connection row (#4209, retargeted #4228)', () => {
    function withMcpName(value: string | null) {
      const base = mockUseAgents()
      mockUseAgents.mockReturnValue({
        ...base,
        agents: base.agents.map((a: Record<string, unknown>) => ({ ...a, mcp_server_name: value })),
      })
    }

    it('shows the recorded name with a copy button, and no not-recorded note', () => {
      withMcpName('haven-research')
      renderOnSettingsTab(<AgentDetailClient agentId="agent-1" />)
      const row = screen.getByTestId('mcp-server-name-row')
      expect(within(row).getByText('MCP server name')).toBeInTheDocument()
      expect(within(row).getByText('haven-research')).toBeInTheDocument()
      expect(within(row).getByRole('button', { name: /copy mcp server name/i })).toBeInTheDocument()
      expect(screen.queryByText(MCP_NOT_RECORDED_NOTE)).toBeNull()
    })

    it('says "not recorded" and explains it in visible text, not a tooltip', () => {
      withMcpName(null)
      renderOnSettingsTab(<AgentDetailClient agentId="agent-1" />)
      const row = screen.getByTestId('mcp-server-name-row')
      expect(within(row).getByText('not recorded')).toBeInTheDocument()
      expect(within(row).getByText(MCP_NOT_RECORDED_NOTE)).toBeInTheDocument()
    })

    it('an agent never seen on MCP (no name, no last seen) reads No MCP connection recorded (#4228)', () => {
      const base = mockUseAgents()
      mockUseAgents.mockReturnValue({
        ...base,
        agents: base.agents.map((a: Record<string, unknown>) => ({
          ...a,
          mcp_server_name: null,
          mcp_last_seen_at: null,
        })),
      })
      renderOnSettingsTab(<AgentDetailClient agentId="agent-1" />)

      const row = screen.getByTestId('mcp-server-name-row')
      expect(within(row).getByText('No MCP connection recorded')).toBeInTheDocument()
      // A null name alone is not "no connection" — the never-seen sentence is
      // the only empty state, and it does NOT say "API key" (#4228).
      expect(within(row).queryByText('not recorded')).toBeNull()
      expect(within(row).queryByText(MCP_NOT_RECORDED_NOTE)).toBeNull()
    })

    it('an API-key agent gets the API-key line; an agent without a prefix does not (#4228)', () => {
      const base = mockUseAgents()
      mockUseAgents.mockReturnValue({
        ...base,
        agents: base.agents.map((a: Record<string, unknown>) => ({ ...a, api_key_prefix: 'haven_e2e' })),
      })
      // No prefix — no line (the prefix is all the agents read carries).
      // Unmount first: RTL cleanup is manual in this file, and both renders
      // would otherwise stand in the document.
      const first = renderOnSettingsTab(<AgentDetailClient agentId="agent-1" />)
      const row = screen.getByTestId('mcp-server-name-row')
      expect(within(row).getByText('API key')).toBeInTheDocument()
      expect(within(row).getByText('haven_e2e')).toBeInTheDocument()
      first.unmount()
      mockUseAgents.mockReturnValue({
        ...base,
        agents: base.agents.map((a: Record<string, unknown>) => ({ ...a, api_key_prefix: null })),
      })
      renderOnSettingsTab(<AgentDetailClient agentId="agent-1" />)
      expect(screen.queryByText('API key')).not.toBeInTheDocument()
    })

    it('shows Last active from the MCP last-seen read (#4228)', () => {
      renderOnSettingsTab(<AgentDetailClient agentId="agent-1" />)
      // The fixture's mcp_last_seen_at is 2026-06-01T10:00:00Z against the
      // frozen 12:00 clock — the same figure the header meta renders.
      expect(screen.getByTestId('mcp-server-name-row').textContent).toContain('Last active 2h ago')
    })
  })

  it('shows the description as the header subtitle (#3694)', () => {
    const base = mockUseAgents()
    mockUseAgents.mockReturnValue({
      ...base,
      agents: base.agents.map((a: Record<string, unknown>) => ({ ...a, description: 'Buys research data' })),
    })
    render(<AgentDetailClient agentId="agent-1" />)
    expect(screen.getByRole('banner')).toHaveTextContent('Buys research data')
  })

  it('hides the recover-funds prompt when the delegate wallet is empty', () => {
    render(<AgentDetailClient agentId="agent-1" />)

    expect(
      screen.queryByRole('link', { name: 'Recover funds to your Haven wallet' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Recoverable funds in agent wallet')).not.toBeInTheDocument()
  })

  it('shows the recover-funds prompt with the amount when the delegate holds USDC', () => {
    mockUseDelegateBalance.mockReturnValue({
      balance: {
        delegate_address: '0x2222222222222222222222222222222222222222',
        account_address: SAFE.account_address,
        chain_id: 8453,
        eth: '0',
        eth_atomic: '0',
        usdc: '0.04',
        usdc_atomic: '40000',
        usdc_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        sweep_min_usdc: '0.01',
      },
      hasStranded: true,
      hasRecoverableUsdc: true,
      loading: false,
      refetch: vi.fn(),
    })

    render(<AgentDetailClient agentId="agent-1" />)

    expect(screen.getByText('Recoverable funds in agent wallet')).toBeInTheDocument()
    expect(screen.getByText(/Recover 0\.04 USDC to your Haven wallet\./)).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: 'Recover funds to your Haven wallet' }),
    ).toHaveAttribute('href', '/agents/agent-1/sweep')
  })

  it('explains when stranded USDC is below the recovery minimum without offering a sweep', () => {
    mockUseDelegateBalance.mockReturnValue({
      balance: {
        delegate_address: '0x2222222222222222222222222222222222222222',
        account_address: SAFE.account_address,
        chain_id: 8453,
        eth: '0',
        eth_atomic: '0',
        usdc: '0.005',
        usdc_atomic: '5000',
        usdc_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        sweep_min_usdc: '0.01',
      },
      hasStranded: true,
      hasRecoverableUsdc: false,
      hasBelowMinimumUsdc: true,
      loading: false,
      refetch: vi.fn(),
    })

    render(<AgentDetailClient agentId="agent-1" />)

    expect(screen.getByText('Recovery minimum not met')).toBeInTheDocument()
    expect(screen.getByText(/0\.005 USDC below the 0\.01 USDC recovery minimum/)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Recover funds to your Haven wallet' })).not.toBeInTheDocument()
  })

  it('hides the recover-funds prompt for an ETH-only delegate (gasless path is USDC-only)', () => {
    mockUseDelegateBalance.mockReturnValue({
      balance: {
        delegate_address: '0x2222222222222222222222222222222222222222',
        account_address: SAFE.account_address,
        chain_id: 8453,
        eth: '0.01',
        eth_atomic: '10000000000000000',
        usdc: '0',
        usdc_atomic: '0',
        usdc_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        sweep_min_usdc: '0.01',
      },
      hasStranded: true,
      hasRecoverableUsdc: false,
      loading: false,
      refetch: vi.fn(),
    })

    render(<AgentDetailClient agentId="agent-1" />)

    expect(screen.queryByText('Recoverable funds in agent wallet')).not.toBeInTheDocument()
  })


  // ── The recoverable-funds surface: #2203 / #2195 / #2196 ─────────────────
  //
  // All three were filed by reviewers on PRs #2197 and #2205, which gave this
  // banner its first rendered evidence. They are guarded together because they
  // are one surface: the tap target, the sentence, and the link to the rows.

  const STRANDED_TAIL =
    'funded on-chain but didn’t reach the merchant, leaving money in your agent’s wallet.'

  /** A balance the route could actually serve, with a caller-chosen figure. */
  function mockRecoverable(usdc: string, usdcAtomic: string) {
    mockUseDelegateBalance.mockReturnValue({
      balance: {
        delegate_address: '0x2222222222222222222222222222222222222222',
        account_address: SAFE.account_address,
        chain_id: 8453,
        eth: '0',
        eth_atomic: '0',
        usdc,
        usdc_atomic: usdcAtomic,
        usdc_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        sweep_min_usdc: '0.01',
      },
      hasStranded: true,
      hasRecoverableUsdc: true,
      loading: false,
      refetch: vi.fn(),
    })
  }

  /** An activity row the reconciliation endpoint would have accepted (#2197). */
  function unsettledRow(id: string, amount: string) {
    return {
      type: 'payment' as const,
      id,
      agent_id: 'agent-1',
      token: 'USDC',
      token_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount,
      to: '0x9999999999999999999999999999999999999999',
      status: 'confirmed' as const,
      tx_hash: '0x' + id.padEnd(64, 'a'),
      source: 'x402',
      explorer_url: 'https://basescan.org/tx/0x' + id,
      payment_flow_status: 'needs_attention' as const,
      payment_attention_reason: 'merchant_retry_rejected_after_payment' as const,
      created_at: '2026-05-30T00:00:00Z',
    }
  }

  function mockUnsettled(rows: ReturnType<typeof unsettledRow>[]) {
    mockUseAgentActivity.mockReturnValue({ activity: rows, stats: null, loading: false })
  }

  /**
   * The banner's own subtree, found STRUCTURALLY.
   *
   * `ApprovalRequiredBanner` renders `<h3>{title}</h3>` and the body as
   * siblings inside one div, so the heading's parent is the banner content.
   * Deliberately not located by class string: this helper's whole job is to
   * check class strings, and #1811/#1820's rule is that a gate must not also
   * TRUST the thing it is under contract to check.
   */
  function bannerBody(): HTMLElement {
    return screen.getByRole('heading', { name: 'Recoverable funds in agent wallet' })
      .parentElement as HTMLElement
  }

  it('routes the Recover funds CTA through Button so it inherits the 44px tap target (#2203)', () => {
    mockRecoverable('8.00', '8000000')
    mockUnsettled([unsettledRow('1', '8.00')])
    render(<AgentDetailClient agentId="agent-1" />)

    const cta = screen.getByRole('link', { name: 'Recover funds to your Haven wallet' })
    expect(cta).toHaveAttribute('href', '/agents/agent-1/sweep')
    // `Button`'s SIZE_CLASS.sm + TAP_TARGET_CLASS.sm (#1726): a 36px painted
    // control whose hit area is extended to 44px by a transparent ::after.
    // The old markup was `px-2.5 py-1 text-xs` — ~24 CSS px, measured on the
    // 390px capture in #2205.
    expect(cta.className).toContain('h-9')
    expect(cta.className).toContain('after:h-11')
    expect(cta.className).not.toContain('py-1 text-xs')
  })

  it('gives EVERY control in the recoverable-funds banner the tap target, not just the CTA (#2203)', () => {
    mockRecoverable('8.00', '8000000')
    mockUnsettled([unsettledRow('1', '8.00')])
    render(<AgentDetailClient agentId="agent-1" />)

    const controls = Array.from(bannerBody().querySelectorAll('a, button'))
    // Both of them: the recovery CTA and #2196's review affordance. A fix that
    // lands one at spec while its neighbour stays at 24px is half a fix.
    expect(controls).toHaveLength(2)
    for (const control of controls) {
      expect(
        control.className,
        `banner control "${control.textContent?.trim()}" has no 44px tap target`,
      ).toContain('after:h-11')
    }
  })

  /**
   * `haven-design-reviewer` on this change: rendered against the banner's
   * `--v2-warning-soft` fill, a chrome-less `tertiary` Button read as prose
   * rather than as a control. It must carry RESTING affordance, not only a
   * hover state — a control you cannot see is not a connection (#2196).
   */
  it('gives the review affordance resting chrome, so it reads as a control (#2196)', () => {
    mockRecoverable('8.00', '8000000')
    mockUnsettled([unsettledRow('1', '8.00')])
    render(<AgentDetailClient agentId="agent-1" />)

    const review = screen.getByRole('button', { name: 'Review the payment' })
    // `Button`'s ghost variant — a surface fill and a hairline, the same
    // variant the one other Button inside an ApprovalRequiredBanner uses
    // (`ReceiveDialog`'s "Refresh page"). (#2927: the fill reads the bg
    // token, so the resting chrome renders in both themes.)
    expect(review.className).toContain('bg-[var(--v2-bg)]')
    expect(review.className).toContain('border-[var(--v2-border-strong)]')
    // `tertiary` is `bg-transparent` with no border — the shape that failed.
    expect(review.className).not.toContain('bg-transparent')
  })

  it('uses the SHARED cause clause on the detail banner, singular for one event (#2195)', () => {
    mockRecoverable('8.00', '8000000')
    mockUnsettled([unsettledRow('1', '8.00')])
    render(<AgentDetailClient agentId="agent-1" />)

    expect(screen.getByText(new RegExp(`A payment was ${STRANDED_TAIL}`.replace(/[.]/g, '\\.')))).toBeInTheDocument()
    expect(screen.getByText(/Recover 8\.00 USDC to your Haven wallet\./)).toBeInTheDocument()
  })

  it('goes plural when a second event coexists — nothing bounds the list at one (#2195)', () => {
    mockRecoverable('20.00', '20000000')
    mockUnsettled([unsettledRow('1', '8.00'), unsettledRow('2', '12.00')])
    render(<AgentDetailClient agentId="agent-1" />)

    expect(screen.getByText(new RegExp(`2 payments were ${STRANDED_TAIL}`.replace(/[.]/g, '\\.')))).toBeInTheDocument()
    expect(screen.queryByText(/^A payment was funded/)).not.toBeInTheDocument()
  })

  it('keeps the generic sentence when the wallet holds funds with no flagged payment (#2195)', () => {
    mockRecoverable('8.00', '8000000')
    mockUnsettled([])
    render(<AgentDetailClient agentId="agent-1" />)

    expect(screen.getByText(/Your agent’s wallet is holding funds that weren’t spent\./)).toBeInTheDocument()
    // Nothing to point at, so no review affordance is offered.
    expect(screen.queryByRole('button', { name: /^Review the/ })).not.toBeInTheDocument()
  })

  it('offers a way from the banner to the rows that caused it, labelled with the count (#2196)', () => {
    const scrollIntoView = vi.fn()
    window.HTMLElement.prototype.scrollIntoView = scrollIntoView
    mockRecoverable('8.00', '8000000')
    mockUnsettled([unsettledRow('1', '8.00')])
    render(<AgentDetailClient agentId="agent-1" />)

    // The anchor exists on the page, not only in the link's href.
    expect(document.getElementById('agent-activity')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Review the payment' }))
    expect(scrollIntoView).toHaveBeenCalled()
  })

  it('counts the rows it promises — the review label is plural-aware too (#2196)', () => {
    mockRecoverable('20.00', '20000000')
    mockUnsettled([unsettledRow('1', '8.00'), unsettledRow('2', '12.00')])
    render(<AgentDetailClient agentId="agent-1" />)

    expect(screen.getByRole('button', { name: 'Review the 2 payments' })).toBeInTheDocument()
  })

  /**
   * The honesty guard for #2196, and the reason the link is navigational.
   *
   * The banner's figure is the delegate EOA's live USDC BALANCE; the rows are
   * payment intents. Nothing apportions the balance to an intent, so a banner
   * that named an individual payment's amount would be asserting a link the
   * data cannot support. Here the balance (20.00) is neither seeded payment's
   * amount, and the banner must print only the balance.
   */
  it('never attributes the recoverable balance to a specific payment (#2196)', () => {
    mockRecoverable('20.00', '20000000')
    mockUnsettled([unsettledRow('1', '8.00'), unsettledRow('2', '12.00')])
    render(<AgentDetailClient agentId="agent-1" />)

    const text = bannerBody().textContent ?? ''
    expect(text).toContain('Recover 20.00 USDC to your Haven wallet.')
    expect(text).not.toContain('8.00')
    expect(text).not.toContain('12.00')
  })

  it('shows the historical wallet name in the detail panel, not on the row (#4226)', () => {
    mockLedgerWith([
      {
        type: 'payment',
        id: 'payment-1',
        agent_id: 'agent-1',
        token: 'USDC',
        token_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        amount_raw: '10000',
        amount: '0.01',
        to: '0x2222222222222222222222222222222222222222',
        status: 'confirmed',
        tx_hash: '0x72d03a8ff551e443c118c93c54d32260941deb613e51fcd2733cd3455e8fa1a1',
        source: 'x402',
        x402_resource_url: 'https://api.example.com/data',
        x402_merchant_address: '0x2222222222222222222222222222222222222222',
        chain_id: 8453,
        account_id: 'safe-old',
        account_address: '0x4444444444444444444444444444444444444444',
        account_name: 'Previous wallet',
        explorer_url: null,
        confirmed_at: '2026-05-08T11:49:59Z',
        created_at: '2026-05-08T11:49:00Z',
      },
    ])

    render(<AgentDetailClient agentId="agent-1" />)

    // The row's title is WHO WAS PAID — the merchant — and the "From
    // <wallet> →" movement line is gone with it (#4226).
    expect(screen.getByText('api.example.com')).toBeInTheDocument()
    expect(screen.queryByText(/From Previous wallet/)).not.toBeInTheDocument()
    // The historical wallet name survives in the detail surface: opening the
    // row shows which wallet the money left (the panel's own subtitle).
    fireEvent.click(screen.getByText('api.example.com'))
    expect(screen.getAllByText(/Previous wallet/).length).toBeGreaterThan(0)
  })

  it('does not fall back to the current wallet name when historical activity has only an address', () => {
    mockLedgerWith([
      {
        type: 'payment',
        id: 'payment-1',
        agent_id: 'agent-1',
        token: 'USDC',
        token_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        amount_raw: '10000',
        amount: '0.01',
        to: '0x2222222222222222222222222222222222222222',
        status: 'confirmed',
        tx_hash: '0x72d03a8ff551e443c118c93c54d32260941deb613e51fcd2733cd3455e8fa1a1',
        source: 'x402',
        x402_resource_url: 'https://api.example.com/data',
        x402_merchant_address: '0x2222222222222222222222222222222222222222',
        chain_id: 8453,
        account_id: null,
        account_address: '0x4444444444444444444444444444444444444444',
        account_name: null,
        explorer_url: null,
        confirmed_at: '2026-05-08T11:49:59Z',
        created_at: '2026-05-08T11:49:00Z',
      },
    ])

    render(<AgentDetailClient agentId="agent-1" />)

    // #3811: list rows carry no addresses — an unnamed historical wallet
    // never reads as `Haven wallet 0x4444…4444`, and no address text
    // surfaces on the row at all (#4226: no movement line either).
    expect(screen.queryByText(/Haven wallet 0x4444/)).not.toBeInTheDocument()
    expect(screen.queryByText(/0x4444/)).not.toBeInTheDocument()
  })

  // #3811, amended by #3950: the activity rows adopt the shared rules — the
  // movement's counterparty is `counterpartyLabel`'s no-address mode (never a
  // truncated address), and the row's fiat is #3824's serve-time
  // `approx_amount` rendered PLAIN (the `≈` mark lives only on the detail
  // panel now) — or an em dash when unpriced, never 0.
  it('renders the activity rows without addresses and the serve-time figure without the "≈" mark', () => {
    mockLedgerWith([
        {
          type: 'payment',
          id: 'payment-1',
          agent_id: 'agent-1',
          agent_name: 'Research agent',
          token: 'USDC',
          token_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          amount_raw: '10000',
          amount: '0.01',
          approx_amount: '0.11',
          approx_currency: 'SEK',
          to: '0x2222222222222222222222222222222222222222',
          status: 'confirmed',
          tx_hash: '0x72d03a8ff551e443c118c93c54d32260941deb613e51fcd2733cd3455e8fa1a1',
          source: 'direct',
          chain_id: 8453,
          account_id: 'safe-old',
          account_address: '0x4444444444444444444444444444444444444444',
          account_name: 'Previous wallet',
          explorer_url: null,
          confirmed_at: '2026-05-08T11:49:59Z',
          created_at: '2026-05-08T11:49:00Z',
        },
    ])

    render(<AgentDetailClient agentId="agent-1" />)

    // No truncated address anywhere in the rows…
    expect(screen.queryByText('0x2222…2222')).not.toBeInTheDocument()
    // …the unresolvable counterparty reads as calm copy, and the serve-time
    // figure renders plain — no `≈` on list rows (#3950) — through the shared
    // currency formatter (per-currency locale, so the decimal mark follows
    // the currency, not the test runner's locale).
    expect(screen.getAllByText('New recipient').length).toBeGreaterThan(0)
    // The serve-time figure renders PLAIN — no `≈` on list rows (#3950, the
    // one rule's row kind short-circuits it) — through the shared currency
    // formatter: per-currency locale ("kr" for SEK), signed by direction.
    expect(screen.queryByText('≈')).not.toBeInTheDocument()
    expect(screen.getByText(/-0[.,]11 kr/)).toBeInTheDocument()
  })

  it('renders an unpriced activity row as an em dash, never 0', () => {
    mockLedgerWith([
        {
          type: 'payment',
          id: 'payment-1',
          agent_id: 'agent-1',
          agent_name: 'Research agent',
          token: 'USDC',
          token_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          amount_raw: '10000',
          amount: '0.01',
          approx_amount: null,
          approx_currency: 'SEK',
          to: '0x2222222222222222222222222222222222222222',
          status: 'confirmed',
          tx_hash: '0x72d03a8ff551e443c118c93c54d32260941deb613e51fcd2733cd3455e8fa1a1',
          source: 'x402',
          x402_resource_url: 'https://api.example.com/data',
          chain_id: 8453,
          account_id: 'safe-old',
          account_address: '0x4444444444444444444444444444444444444444',
          account_name: 'Previous wallet',
          explorer_url: null,
          confirmed_at: '2026-05-08T11:49:59Z',
          created_at: '2026-05-08T11:49:00Z',
        },
    ])

    render(<AgentDetailClient agentId="agent-1" />)

    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
    expect(screen.getAllByText('api.example.com').length).toBeGreaterThan(0)
  })

  // ── Budget-affordance routing (#1079) ──────────────────────────────────

  function mockDelegationAgent() {
    mockUseAgents.mockReturnValue({
      agents: [
        {
          id: 'agent-1',
          name: 'Delegation agent',
          description: null,
          delegate_address: '0x2222222222222222222222222222222222222222',
          account_id: 'safe-1',
          account_address: SAFE.account_address,
          account_name: 'Main account',
          status: 'active',
          created_at: '2026-05-01T00:00:00Z',
          mcp_last_seen_at: null,
          allowances: [],
          labels: [],
          account_type: 'delegator_hybrid',
        },
      ],
      loading: false,
      pauseAgent: vi.fn(),
      resumeAgent: vi.fn(),
      revokeAgent: vi.fn(),
      refetch: vi.fn(),
    })
  }

  // #3695: ONE budget surface. The read-only "Agent budget" summary (and its
  // "No agent budget set" empty state with a scroll-to-card "Add budget") is
  // gone; budgets change only in the Spending card, which also owns Add
  // budget. Fails on f9e02ee0, where both surfaces rendered.
  it('renders exactly one budget surface — no second "Agent budget" summary (#3695)', () => {
    mockDelegationAgent()
    render(<AgentDetailClient agentId="agent-1" />)
    expect(screen.getAllByText('DelegationBudgetCard')).toHaveLength(1)
    expect(screen.queryByRole('heading', { name: 'Agent budget' })).not.toBeInTheDocument()
    expect(screen.queryByText('No agent budget set')).not.toBeInTheDocument()
    expect(screen.queryByText('Spend from')).not.toBeInTheDocument()
    // The page itself offers no budget entry point; the card does (its own
    // #3549 tests pin the rows' Add budget menu item present on a live agent,
    // absent on a retired one — #4261).
    expect(screen.queryByRole('button', { name: /Add budget|Update budget/ })).not.toBeInTheDocument()
  })

  it('offers no Update budget entry point anywhere — button or menu item (#3694)', () => {
    mockDelegationAgent()
    render(<AgentDetailClient agentId="agent-1" />)
    expect(screen.queryByRole('button', { name: 'Update budget' })).not.toBeInTheDocument()
    expect(openAgentMenu()).not.toContain('Update budget')
  })

  // ── Who can approve pointer, not a second copy (#1089) ──────────────────

  it('points a delegation agent at the account page instead of rendering signer controls', () => {
    mockDelegationAgent()
    renderOnSettingsTab(<AgentDetailClient agentId="agent-1" />)

    const link = screen.getByRole('link', { name: /Who can approve/ })
    // #4228: the pointer targets the account's Security & details tab.
    expect(link).toHaveAttribute('href', '/accounts/safe-1?tab=security')
    // No enrollment controls on the agent page — those live only on the account page now.
    expect(screen.queryByRole('button', { name: /Add a backup/ })).not.toBeInTheDocument()
  })

  // ── The Settings tab (#4228) ─────────────────────────────────────────────
  // One Card of divided rows under "This agent" — connection, credentials,
  // labels, tax, passport — plus the account-level pointer under
  // "On {account name}". The rows open the page-owned modals; nothing here
  // is a second copy of a flow.

  it('renders the five sections in ONE card under This agent, plus the account card (#4228)', () => {
    mockUseCompanyDetails.mockReturnValue({ status: 'ready', details: VIES_VALID_ROW })
    mockDelegationAgent()
    renderOnSettingsTab(<AgentDetailClient agentId="agent-1" />)

    const section = screen.getByTestId('agent-settings-section')
    // Exactly TWO cards in the section: the agent rows, then the account-level one.
    const cards = section.querySelectorAll('.rounded-\\[10px\\]')
    expect(cards.length).toBe(2)
    const card = cards[0] as HTMLElement

    expect(card.textContent).toContain('This agent')
    expect(within(card).getByTestId('mcp-server-name-row')).toBeTruthy()
    expect(within(card).getByTestId('payment-credentials-row')).toBeTruthy()
    expect(within(card).getByTestId('labels-row')).toBeTruthy()
    expect(within(card).getByTestId('tax-declaration-row')).toBeTruthy()
    expect(within(card).getByTestId('agent-passport-row')).toBeTruthy()

    // The account-level section carries the Who can approve pointer under
    // its own "On {account name}" label — the label sits ABOVE the card, so
    // the assertion scopes to the section, not the card.
    const accountSection = screen.getByTestId('agent-account-section')
    expect(accountSection.textContent).toContain('On Main account')
    expect(
      within(accountSection).getByRole('link', { name: /Who can approve/ }),
    ).toHaveAttribute('href', '/accounts/safe-1?tab=security')
  })

  it('opens the existing flows from the rows: credentials, replace key, edit labels (#4228)', () => {
    mockDelegationAgent()
    renderOnSettingsTab(<AgentDetailClient agentId="agent-1" />)

    // Nothing is open on render.
    expect(screen.queryByTestId('payment-credentials-modal')).toBeNull()
    expect(screen.queryByTestId('replace-signing-key-modal')).toBeNull()
    expect(screen.queryByTestId('edit-agent-modal')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'View' }))
    expect(screen.getByTestId('payment-credentials-modal')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Replace signing key' }))
    expect(screen.getByTestId('replace-signing-key-modal')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByTestId('edit-agent-modal')).toBeInTheDocument()
  })

  it('hides Payment credentials and Replace signing key for a REVOKED agent, and keeps Connection and Labels readable (#4228)', () => {
    const base = mockUseAgents()
    mockUseAgents.mockReturnValue({
      ...base,
      agents: base.agents.map((a: Record<string, unknown>) => ({ ...a, status: 'revoked' })),
    })
    renderOnSettingsTab(<AgentDetailClient agentId="agent-1" />)

    expect(screen.queryByTestId('payment-credentials-row')).not.toBeInTheDocument()
    expect(screen.getByTestId('mcp-server-name-row')).toBeInTheDocument()
    expect(screen.getByTestId('labels-row')).toBeInTheDocument()
    // The passport row keeps its OWN gate: it renders, and its Issue control
    // is what AgentPassportCard hides for a revoked agent.
    expect(screen.getByTestId('agent-passport-row')).toBeInTheDocument()
  })

  it('an ARCHIVED agent also loses the credential rows (#4228)', () => {
    const base = mockUseAgents()
    mockUseAgents.mockReturnValue({
      ...base,
      agents: base.agents.map((a: Record<string, unknown>) => ({
        ...a,
        status: 'active',
        archived_at: '2026-05-20T00:00:00Z',
      })),
    })
    renderOnSettingsTab(<AgentDetailClient agentId="agent-1" />)

    expect(screen.queryByTestId('payment-credentials-row')).not.toBeInTheDocument()
    expect(screen.getByTestId('mcp-server-name-row')).toBeInTheDocument()
    expect(screen.getByTestId('labels-row')).toBeInTheDocument()
    // Archived is not newly gated for the passport — its own gate is
    // revoked-only, so the row (and its Issue control) still renders.
    expect(screen.getByTestId('agent-passport-row')).toBeInTheDocument()
  })

  it('hides the tax row without leaving a stray divider or empty gap (#3697, retargeted #4228)', () => {
    // 'off' — the flag-off answer the route gives when HAVEN_OWNER_COMPANY_DETAILS is unset.
    mockUseCompanyDetails.mockReturnValue({ status: 'off', details: null })
    mockDelegationAgent()
    renderOnSettingsTab(<AgentDetailClient agentId="agent-1" />)

    expect(screen.queryByTestId('tax-declaration-row')).not.toBeInTheDocument()
    // The agent card's direct children: the connection row, the credentials
    // row, the labels row and the passport section — exactly four, so the
    // tax row's divider left no orphan and no gap.
    const card = screen
      .getByTestId('agent-settings-section')
      .querySelector('.rounded-\\[10px\\]') as HTMLElement
    expect(card.children.length).toBe(4)
    expect(card.textContent).not.toContain('Tax declaration')

    // ...and the non-valid VIES state hides it too.
    mockUseCompanyDetails.mockReturnValue({ status: 'ready', details: { ...VIES_VALID_ROW, vies_status: 'invalid' } })
    render(<AgentDetailClient agentId="agent-1" />)
    expect(screen.queryByTestId('tax-declaration-row')).not.toBeInTheDocument()
  })

  it('orders the page: header, banner slot, Spending hero, tabs, Activity (#4226)', () => {
    mockDelegationAgent()
    render(<AgentDetailClient agentId="agent-1" />)

    const header = document.querySelector('header')
    const banner = screen.getByTestId('agent-banner-slot')
    const budget = document.getElementById('delegation-budget-card')
    const activity = document.getElementById('agent-activity')
    expect(header).toBeTruthy()
    expect(budget).toBeTruthy()
    expect(activity).toBeTruthy()

    // Each pair FOLLOWING in document order — mockup v2's stack: header,
    // banners, the Spending hero, then the tab row and its Activity panel.
    // Identity and settings is no longer page-level: it is the Settings tab.
    const tablist = screen.getByRole('tablist', { name: 'Agent' })
    const pairs: [Element, Element][] = [
      [header!, banner],
      [banner, budget!],
      [budget!, tablist],
      [tablist, activity!],
    ]
    for (const [before, after] of pairs) {
      expect(
        before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING,
        `${before.nodeName} must precede ${after.nodeName}`,
      ).toBeTruthy()
    }
    // The hero leads — the reason to open an agent at all. (The card itself
    // is mocked at this level; its states are DelegationBudgetCard's tests.)
    expect(screen.getByText('DelegationBudgetCard')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Activity', selected: true })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Tool calls', selected: false })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Settings', selected: false })).toBeInTheDocument()
  })

  it('reads the delegate balance for REVOKED agents too — the recovery banner must reach them (#1403)', () => {
    // The old gate skipped the read for revoked agents ("the endpoint 404s
    // anyway") — false since #1403, and exactly backwards: the sequence that
    // strands delegate funds is revoke-mid-x402. The hook must be called with
    // the agentId regardless of status.
    const base = mockUseAgents()
    mockUseAgents.mockReturnValue({
      ...base,
      agents: base.agents.map((a: { id: string }) =>
        a.id === 'agent-1' ? { ...a, status: 'revoked' } : a,
      ),
    })
    render(<AgentDetailClient agentId="agent-1" />)
    const calls = mockUseDelegateBalance.mock.calls
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[calls.length - 1][0]).toBe('agent-1')
  })

  it('reads delegate balance for a legacy agent so residual funds remain recoverable (#2258)', () => {
    const base = mockUseAgents()
    mockUseAgents.mockReturnValue({
      ...base,
      agents: base.agents.map((agent: { id: string }) => ({
        ...agent,
        account_type: 'legacy_safe',
      })),
    })

    render(<AgentDetailClient agentId="agent-1" />)

    const calls = mockUseDelegateBalance.mock.calls
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[calls.length - 1][0]).toBe('agent-1')
  })

  it('shows recovery for a legacy agent with a residual USDC balance (#2258)', () => {
    mockAgentWith({ account_type: 'legacy_safe' })
    mockUseDelegateBalance.mockReturnValue({
      balance: {
        delegate_address: '0x2222222222222222222222222222222222222222',
        account_address: SAFE.account_address,
        chain_id: 8453,
        eth: '0',
        eth_atomic: '0',
        usdc: '0.04',
        usdc_atomic: '40000',
        usdc_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        sweep_min_usdc: '0.01',
      },
      hasStranded: true,
      hasRecoverableUsdc: true,
      loading: false,
      refetch: vi.fn(),
    })

    render(<AgentDetailClient agentId="agent-1" />)

    expect(screen.getByText('Recoverable funds in agent wallet')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Recover funds to your Haven wallet' }))
      .toHaveAttribute('href', '/agents/agent-1/sweep')
  })

  // #1402: the Remove/Restore visibility gates on the detail footer.
  function mockAgentWith(overrides: Record<string, unknown>) {
    mockUseAgents.mockReturnValue({
      agents: [
        {
          id: 'agent-1',
          name: 'Delegation agent',
          description: null,
          delegate_address: '0x2222222222222222222222222222222222222222',
          account_id: 'safe-1',
          account_address: SAFE.account_address,
          account_name: 'Main account',
          status: 'active',
          created_at: '2026-05-01T00:00:00Z',
          mcp_last_seen_at: null,
          allowances: [],
          labels: [],
          account_type: 'delegator_hybrid',
          ...overrides,
        },
      ],
      loading: false,
      pauseAgent: vi.fn(),
      resumeAgent: vi.fn(),
      revokeAgent: vi.fn(),
      archiveAgent: vi.fn().mockResolvedValue(undefined),
      unarchiveAgent: vi.fn(),
      markBudgetEnded: vi.fn(),
      refetch: vi.fn(),
    })
  }

  /**
   * #3542 (D): "Revoked" on this page is only half true while a budget
   * delegation is still redeemable on-chain. The callout sits above the budget
   * card and carries the one action that ends it.
   */
  describe('half-revoked callout (#3542)', () => {
    const MARKER = HALF_REVOKED_TITLE

    beforeEach(() => {
      mockRouterPush.mockClear()
    })

    it('revoked + live budget: callout with Finish revoking, above the budget card', () => {
      mockAgentWith({ status: 'revoked', live_delegation_count: 1 })
      render(<AgentDetailClient agentId="agent-1" />)
      const callout = screen.getByTestId('half-revoked-callout')
      expect(callout).toHaveTextContent(MARKER)
      expect(screen.getByRole('button', { name: 'Finish revoking' })).toBeInTheDocument()
      const budgetCard = screen.getByText('DelegationBudgetCard')
      expect(
        callout.compareDocumentPosition(budgetCard) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
      // The page no longer implies access fully ended.
      expect(screen.queryByText('This agent no longer has access through Haven.')).not.toBeInTheDocument()
      // #3694: the footer's "credential is revoked, but its budget is still
      // active" line went with the footer. Its claim is the banner's title,
      // one element away, so it is asserted there instead of being repeated.
      expect(callout).toHaveTextContent(/its budget is still active/i)
    })

    it('revoked + count 0: no callout, the retired status line stands (moved under the header, #3694)', () => {
      mockAgentWith({ status: 'revoked', live_delegation_count: 0 })
      render(<AgentDetailClient agentId="agent-1" />)
      expect(screen.queryByTestId('half-revoked-callout')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Finish revoking' })).not.toBeInTheDocument()
      expect(screen.getByText('This agent no longer has access through Haven.')).toBeInTheDocument()
    })

    it('an active agent with live budgets shows no callout', () => {
      mockAgentWith({ status: 'active', live_delegation_count: 2 })
      render(<AgentDetailClient agentId="agent-1" />)
      expect(screen.queryByTestId('half-revoked-callout')).not.toBeInTheDocument()
    })

    it('archived + live budget: callout and Finish revoking, alongside Restore', () => {
      mockAgentWith({
        status: 'revoked',
        archived_at: '2026-06-01T00:00:00Z',
        live_delegation_count: 1,
      })
      render(<AgentDetailClient agentId="agent-1" />)
      expect(screen.getByTestId('half-revoked-callout')).toHaveTextContent(MARKER)
      expect(screen.getByRole('button', { name: 'Finish revoking' })).toBeInTheDocument()
      expect(openAgentMenu()).toContain('Restore to list')
    })

    it('an unlinked agent gets the callout and NO action', () => {
      mockAgentWith({ status: 'revoked', account_id: null, live_delegation_count: 1 })
      render(<AgentDetailClient agentId="agent-1" />)
      const callout = screen.getByTestId('half-revoked-callout')
      expect(callout).toHaveTextContent(MARKER)
      expect(callout).toHaveTextContent(/cannot end it from here/i)
      expect(screen.queryByRole('button', { name: 'Finish revoking' })).not.toBeInTheDocument()
    })

    it('Finish revoking opens the dialog in finish mode; ending the budget clears the marker and keeps the user on the page', () => {
      mockAgentWith({ status: 'revoked', live_delegation_count: 1 })
      const markBudgetEnded = vi.fn()
      mockUseAgents.mockReturnValue({ ...mockUseAgents(), markBudgetEnded })
      render(<AgentDetailClient agentId="agent-1" />)

      fireEvent.click(screen.getByRole('button', { name: 'Finish revoking' }))
      expect(screen.getByTestId('remove-agent-dialog').getAttribute('data-mode')).toBe('finish')

      fireEvent.click(screen.getByRole('button', { name: 'stub: budget ended' }))
      expect(markBudgetEnded).toHaveBeenCalledWith('agent-1')
      // Finish mode never navigates: the page is where the marker clears.
      expect(mockRouterPush).not.toHaveBeenCalled()
      expect(screen.queryByTestId('remove-agent-dialog')).not.toBeInTheDocument()
    })

    it('finish mode wires NO archive that navigates, even if the dialog invoked it', async () => {
      mockAgentWith({ status: 'revoked', live_delegation_count: 1 })
      render(<AgentDetailClient agentId="agent-1" />)
      fireEvent.click(screen.getByRole('button', { name: 'Finish revoking' }))
      fireEvent.click(screen.getByRole('button', { name: 'stub: archive' }))
      await Promise.resolve()
      expect(mockRouterPush).not.toHaveBeenCalled()
    })

    it('plain Remove still lands on /agents after archiving (#1402, unchanged)', async () => {
      mockAgentWith({})
      render(<AgentDetailClient agentId="agent-1" />)
      openAgentMenu()
      fireEvent.click(screen.getByRole('menuitem', { name: 'Remove agent…' }))
      expect(screen.getByTestId('remove-agent-dialog').getAttribute('data-mode')).toBe('remove')
      fireEvent.click(screen.getByRole('button', { name: 'stub: archive' }))
      await vi.waitFor(() => expect(mockRouterPush).toHaveBeenCalledWith('/agents'))
    })
  })

  it('shows Remove agent for an operational delegation agent, never Restore (#1402)', () => {
    mockAgentWith({})
    render(<AgentDetailClient agentId="agent-1" />)
    const items = openAgentMenu()
    expect(items).toContain('Remove agent…')
    expect(items).not.toContain('Restore to list')
  })

  /**
   * #2230: this banner's sentence is the one BOTH surfaces render.
   *
   * `AgentCard.test.tsx` proves the card reads `lib/agent-pause-copy.ts`;
   * that says nothing about this page, which is where the sentence came from.
   * Both halves are needed, because the divergence #2230 is about could
   * reappear by either surface re-hardcoding — and the module is only a
   * mechanism until both ends actually read it.
   *
   * Compared against the module rather than a literal, on purpose: the words
   * themselves are pinned once, in `lib/__tests__/agent-pause-copy.test.ts`.
   */
  it('renders the SHARED paused banner sentence, not a second copy of it (#2230)', () => {
    mockAgentWith({ status: 'paused' })
    render(<AgentDetailClient agentId="agent-1" />)
    expect(screen.getByRole('heading', { name: AGENT_PAUSED_TITLE })).toBeInTheDocument()
    expect(screen.getByText(AGENT_PAUSED_BODY)).toBeInTheDocument()
  })

  it('an archived agent gets Restore to list and no Remove (#1402)', () => {
    mockAgentWith({ status: 'revoked', archived_at: '2026-06-01T00:00:00Z' })
    render(<AgentDetailClient agentId="agent-1" />)
    const items = openAgentMenu()
    expect(items).not.toContain('Remove agent…')
    expect(items).toContain('Restore to list')
  })

  it('offers Restore to list for an archived legacy record without adding authority (#2258)', () => {
    mockAgentWith({ account_type: undefined, status: 'revoked', archived_at: '2026-06-01T00:00:00Z' })
    render(<AgentDetailClient agentId="agent-1" />)
    const items = openAgentMenu()
    expect(items).toContain('Restore to list')
    expect(items).not.toContain('Unlink agent')
    expect(items).not.toContain('Remove agent…')
  })

  // #3549: since #3695 the page has no budget entry point of its own — Add
  // budget lives in the Spending card, which hides it for a retired agent
  // (as a row ⋯ menu item since #4261).
  // So the page's half of the gate is handing the card the right `retired`
  // state (the it.each below, incl. the archived-but-not-revoked shape
  // ARCHIVE_AGENT_SQL allows: an UNLINKED agent with no live budget), and the
  // card's half is pinned in DelegationBudgetCard.test.tsx with the Add
  // budget menu item asserted present on a live agent and absent on a
  // retired one.
  it('an archived agent is offered no Update budget anywhere on the page (#3549)', () => {
    mockAgentWith({ account_id: null, status: 'active', archived_at: '2026-06-01T00:00:00Z' })
    render(<AgentDetailClient agentId="agent-1" />)
    expect(screen.queryByRole('button', { name: /Update budget|Add budget/ })).not.toBeInTheDocument()
    expect(openAgentMenu()).not.toContain('Update budget')
  })

  // #3549: the card hides set/edit/issue-sub-budget for a retired agent — the
  // page must tell it which agents are retired, or the gate never engages.
  it.each([
    ['an active agent', { status: 'active', archived_at: null }, undefined],
    ['a revoked agent', { status: 'revoked', archived_at: null }, 'revoked'],
    ['a paused agent', { status: 'paused', archived_at: null }, undefined],
    ['a pending_approval agent', { status: 'pending_approval', archived_at: null }, undefined],
    ['an archived unlinked agent', { account_id: null, status: 'active', archived_at: '2026-06-01T00:00:00Z' }, 'archived'],
    ['a revoked and archived agent', { status: 'revoked', archived_at: '2026-06-01T00:00:00Z' }, 'revoked'],
  ])('hands the budget card retired=%s state (#3549)', (_label, overrides, expected) => {
    budgetCardRetired.length = 0
    mockAgentWith(overrides)
    render(<AgentDetailClient agentId="agent-1" />)
    expect(budgetCardRetired.length).toBeGreaterThan(0)
    expect(budgetCardRetired.at(-1)).toBe(expected)
  })

  // #3694: Restore moved into the ⋮ menu, which closes on select. A second
  // Restore therefore needs the menu reopened, and pendingAction disables the
  // trigger while the first is in flight — the same guard, one control up.
  it('a second Restore cannot fire while the first is in flight — pendingAction guards it (#1402)', async () => {
    let release!: () => void
    const unarchiveAgent = vi.fn(
      () => new Promise<void>((resolve) => { release = resolve }),
    )
    mockAgentWith({ status: 'revoked', archived_at: '2026-06-01T00:00:00Z' })
    mockUseAgents.mockReturnValue({ ...mockUseAgents(), unarchiveAgent })
    render(<AgentDetailClient agentId="agent-1" />)
    // The live region is mounted, empty, BEFORE the restore — only its text
    // changes, which is what makes the announcement reliable. Scoped to the
    // header: the Activity tab's toolbar carries its own status region now.
    expect(within(screen.getByRole('banner')).getByRole('status')).toHaveTextContent('')
    openAgentMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Restore to list' }))
    const trigger = screen.getByRole('button', { name: 'Agent options' })
    expect(trigger).toBeDisabled()
    expect(within(screen.getByRole('banner')).getByRole('status')).toHaveTextContent('Restoring…')
    fireEvent.click(trigger)
    expect(screen.queryByRole('menuitem', { name: 'Restore to list' })).not.toBeInTheDocument()
    release()
    await Promise.resolve()
    expect(unarchiveAgent).toHaveBeenCalledTimes(1)
  })

  /**
   * #3694: the per-state action matrix. Every state keeps a terminal action
   * in the ⋮ menu — Remove, or Restore once archived — and Pause/Resume sit in
   * the header only for a live, un-archived agent. Archived dominates: the
   * archived-unlinked shape is still `active` (ARCHIVE_AGENT_SQL lets an
   * unlinked agent be archived unrevoked) and must not be offered Pause or
   * Remove. The menu order is asserted whole, so a reorder or a stray item
   * fails here.
   */
  const ARCHIVED_AT = '2026-06-01T00:00:00Z'
  it.each([
    ['active', { status: 'active' }, 'Pause payments',
      ['Edit agent', 'Manage labels', 'Payment credentials', 'Replace signing key', 'Remove agent…']],
    ['paused', { status: 'paused' }, 'Resume agent',
      ['Edit agent', 'Manage labels', 'Payment credentials', 'Replace signing key', 'Remove agent…']],
    ['pending_approval', { status: 'pending_approval' }, null,
      ['Edit agent', 'Manage labels', 'Payment credentials', 'Replace signing key', 'Remove agent…']],
    ['revoked', { status: 'revoked', live_delegation_count: 0 }, null,
      ['Remove agent…']],
    ['half-revoked', { status: 'revoked', live_delegation_count: 1 }, null,
      ['Remove agent…']],
    ['archived', { status: 'revoked', archived_at: ARCHIVED_AT }, null,
      ['Restore to list']],
    ['archived-unlinked', { status: 'active', account_id: null, archived_at: ARCHIVED_AT }, null,
      ['Edit agent', 'Manage labels', 'Restore to list']],
  ] as const)('action matrix — %s (#3694)', (_state, overrides, headerAction, menuItems) => {
    mockAgentWith(overrides)
    render(<AgentDetailClient agentId="agent-1" />)

    for (const name of ['Pause payments', 'Resume agent'] as const) {
      if (name === headerAction) {
        expect(screen.getByRole('button', { name })).toBeInTheDocument()
      } else {
        expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
      }
    }
    // No terminal action survives outside the menu (the old footer).
    expect(screen.queryByRole('button', { name: /^Remove agent/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Restore to list' })).not.toBeInTheDocument()

    expect(openAgentMenu()).toEqual([...menuItems])
  })

  // The retired line follows `isHalfRevoked`'s meaning of "ended": revoked OR
  // archived. An archived agent that was never revoked (still `active`) is
  // ended too — before #3694 the footer told it "Pause the agent…".
  it.each([
    ['revoked', { status: 'revoked', live_delegation_count: 0 }, true],
    ['archived-unlinked', { status: 'active', account_id: null, archived_at: ARCHIVED_AT }, true],
    ['active', { status: 'active' }, false],
    ['paused', { status: 'paused' }, false],
    ['half-revoked', { status: 'revoked', live_delegation_count: 1 }, false],
  ] as const)('retired status line — %s (#3694)', (_state, overrides, shown) => {
    mockAgentWith(overrides)
    render(<AgentDetailClient agentId="agent-1" />)
    const line = screen.queryByText('This agent no longer has access through Haven.')
    if (shown) expect(line).toBeInTheDocument()
    else expect(line).not.toBeInTheDocument()
  })

  it('styles Remove agent as the danger item, last, after a separator (#3694)', () => {
    mockAgentWith({})
    render(<AgentDetailClient agentId="agent-1" />)
    openAgentMenu()
    const menu = screen.getByRole('menu')
    const last = menu.lastElementChild as HTMLElement
    expect(last).toHaveTextContent('Remove agent…')
    expect(last.className).toContain('text-[var(--v2-danger)]')
    expect(last.previousElementSibling).toHaveAttribute('role', 'separator')
  })

  it('Pause in the header pauses; Resume in the header resumes (#3694)', () => {
    const pauseAgent = vi.fn().mockResolvedValue(undefined)
    const resumeAgent = vi.fn().mockResolvedValue(undefined)

    mockAgentWith({ status: 'active' })
    mockUseAgents.mockReturnValue({ ...mockUseAgents(), pauseAgent, resumeAgent })
    const { unmount } = render(<AgentDetailClient agentId="agent-1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Pause payments' }))
    expect(pauseAgent).toHaveBeenCalledWith('agent-1')
    unmount()

    mockAgentWith({ status: 'paused' })
    mockUseAgents.mockReturnValue({ ...mockUseAgents(), pauseAgent, resumeAgent })
    render(<AgentDetailClient agentId="agent-1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Resume agent' }))
    expect(resumeAgent).toHaveBeenCalledWith('agent-1')
  })

  it('renders Pause and Resume inside the page header (#3694)', () => {
    mockAgentWith({ status: 'active' })
    const { unmount } = render(<AgentDetailClient agentId="agent-1" />)
    expect(screen.getByRole('banner')).toContainElement(screen.getByRole('button', { name: 'Pause payments' }))
    unmount()
    mockAgentWith({ status: 'paused' })
    render(<AgentDetailClient agentId="agent-1" />)
    expect(screen.getByRole('banner')).toContainElement(screen.getByRole('button', { name: 'Resume agent' }))
  })

  describe('banner slot (#3694)', () => {
    const RECOVERABLE = {
      balance: {
        delegate_address: '0x2222222222222222222222222222222222222222',
        account_address: SAFE.account_address,
        chain_id: 8453,
        eth: '0',
        eth_atomic: '0',
        usdc: '8.00',
        usdc_atomic: '8000000',
        usdc_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        sweep_min_usdc: '0.01',
      },
      hasStranded: true,
      hasRecoverableUsdc: true,
      hasBelowMinimumUsdc: false,
      loading: false,
      refetch: vi.fn(),
    }

    function slotOrder(): string[] {
      const slot = screen.getByTestId('agent-banner-slot')
      const markers: Array<[string, HTMLElement | null]> = [
        ['half-revoked', screen.queryByTestId('half-revoked-callout')],
        ['refresh-error', screen.queryByText(/Agent data could not refresh/)],
        ['paused', screen.queryByRole('heading', { name: AGENT_PAUSED_TITLE })],
        ['recoverable', screen.queryByText('Recoverable funds in agent wallet')],
      ]
      return markers
        .filter(([, el]) => el !== null)
        .map(([name, el]) => {
          expect(slot).toContainElement(el)
          return [name, el] as const
        })
        .sort(([, a], [, b]) => (a!.compareDocumentPosition(b!) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
        .map(([name]) => name)
    }

    // Order is design-system.md's detail-page rule (#3692): warning before
    // neutral, and within a tone the banner asking for a decision first.
    it('stacks the recoverable-funds warning above the neutral paused banner, in the one slot under the header', () => {
      mockAgentWith({ status: 'paused' })
      mockUseDelegateBalance.mockReturnValue(RECOVERABLE)
      render(<AgentDetailClient agentId="agent-1" />)
      expect(slotOrder()).toEqual(['recoverable', 'paused'])
      // The slot sits before the budget card: banners lead the page.
      const slot = screen.getByTestId('agent-banner-slot')
      expect(
        slot.compareDocumentPosition(screen.getByText('DelegationBudgetCard')) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
    })

    it('puts the decision-asking warnings (half-revoked, recoverable) before the refresh error', () => {
      mockAgentWith({ status: 'revoked', live_delegation_count: 1 })
      mockUseAgents.mockReturnValue({ ...mockUseAgents(), error: new Error('offline') })
      mockUseDelegateBalance.mockReturnValue(RECOVERABLE)
      render(<AgentDetailClient agentId="agent-1" />)
      expect(slotOrder()).toEqual(['half-revoked', 'recoverable', 'refresh-error'])
    })

    it('puts a failed header action first, above every other banner', async () => {
      const pauseAgent = vi.fn().mockRejectedValue(new Error('network down'))
      mockAgentWith({ status: 'active' })
      mockUseAgents.mockReturnValue({ ...mockUseAgents(), pauseAgent })
      mockUseDelegateBalance.mockReturnValue(RECOVERABLE)
      render(<AgentDetailClient agentId="agent-1" />)
      fireEvent.click(screen.getByRole('button', { name: 'Pause payments' }))
      const failure = await vi.waitFor(() => screen.getByText('Action failed'))
      const slot = screen.getByTestId('agent-banner-slot')
      expect(slot.firstElementChild).toContainElement(failure)
      expect(slot).toHaveTextContent('network down')
    })

    it('renders the refresh-error alert in the slot for a paused agent too', () => {
      mockAgentWith({ status: 'paused' })
      mockUseAgents.mockReturnValue({ ...mockUseAgents(), error: new Error('offline') })
      render(<AgentDetailClient agentId="agent-1" />)
      expect(slotOrder()).toEqual(['refresh-error', 'paused'])
    })
  })
})

// #2473: the token options for a FIRST budget grant must come from the chain,
// not from `allowances` — which is a view over ACTIVE delegations (#1090) and
// is therefore empty for exactly the agent that has no budget yet. Deriving
// them from allowances left the grant form unrendered and "Add budget" inert.
describe('AgentDetailClient first-budget token options (#2473)', () => {
  beforeEach(() => {
    budgetCardTokens.length = 0
    mockUseAuth.mockReturnValue({
      user: { accounts: [{ ...SAFE, chain_id: 8453 }] },
    })
    mockUseAgents.mockReturnValue({
      agents: [
        {
          id: 'agent-1',
          name: 'Research agent',
          description: null,
          delegate_address: '0x2222222222222222222222222222222222222222',
          account_id: 'safe-1',
          account_address: SAFE.account_address,
          account_name: 'Main account',
          status: 'active',
          created_at: '2026-05-01T00:00:00Z',
          mcp_last_seen_at: null,
          allowances: [],
          labels: [],
          account_type: 'delegator_hybrid',
        },
      ],
      loading: false,
      pauseAgent: vi.fn(),
      resumeAgent: vi.fn(),
      revokeAgent: vi.fn(),
      refetch: vi.fn(),
    })
    mockUseAgentActivity.mockReturnValue({ activity: [], stats: null, loading: false })
    mockUseDelegateBalance.mockReturnValue({
      balance: null,
      hasStranded: false,
      hasRecoverableUsdc: false,
      hasBelowMinimumUsdc: false,
      loading: false,
      refetch: vi.fn(),
    })
    mockUseAgentPassport.mockReturnValue({ passport: null, loading: false, refetch: vi.fn() })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('offers grantable tokens to an agent with no budget yet', () => {
    render(<AgentDetailClient agentId="agent-1" />)
    const tokens = budgetCardTokens.at(-1)
    expect(tokens).toBeDefined()
    expect(tokens!.length).toBeGreaterThan(0)
    expect(tokens!.map((t) => t.symbol)).toContain('USDC')
  })

  // Reviewer finding (#2473): an allowance token the chain registry does not
  // know has no trustworthy `decimals`. Guessing one and handing it to
  // BudgetRow makes `formatUnits` render a real on-chain amount at the wrong
  // scale — a spend cap shown as ~0 or ~unlimited. Omitting it instead lets
  // BudgetRow fall through to its raw-atomic fallback: ugly, never wrong.
  it('omits an allowance token the chain registry does not know, rather than guessing its decimals', () => {
    mockUseAgents.mockReturnValue({
      agents: [
        {
          id: 'agent-1',
          name: 'Research agent',
          description: null,
          delegate_address: '0x2222222222222222222222222222222222222222',
          account_id: 'safe-1',
          account_address: SAFE.account_address,
          account_name: 'Main account',
          status: 'active',
          created_at: '2026-05-01T00:00:00Z',
          mcp_last_seen_at: null,
          allowances: [
            {
              token_symbol: 'MYSTERY',
              token_address: '0x9999999999999999999999999999999999999999',
              allowance_amount: '1.00',
              reset_period_min: 1440,
            },
          ],
          labels: [],
          account_type: 'delegator_hybrid',
        },
      ],
      loading: false,
      pauseAgent: vi.fn(),
      resumeAgent: vi.fn(),
      revokeAgent: vi.fn(),
      refetch: vi.fn(),
    })
    render(<AgentDetailClient agentId="agent-1" />)
    const tokens = budgetCardTokens.at(-1)!
    expect(tokens.map((t) => t.symbol)).not.toContain('MYSTERY')
    expect(
      tokens.some((t) => t.address.toLowerCase() === '0x9999999999999999999999999999999999999999'),
    ).toBe(false)
    // The registry's own tokens are still offered.
    expect(tokens.map((t) => t.symbol)).toContain('USDC')
  })

  it('offers only tokens a budget can be metered in — no native token', () => {
    render(<AgentDetailClient agentId="agent-1" />)
    const tokens = budgetCardTokens.at(-1)!
    // A budget delegation is per ERC-20 token; the chain's native token has
    // no token address in the registry and cannot be granted.
    expect(tokens.map((t) => t.symbol)).not.toContain('ETH')
    expect(tokens.every((t) => /^0x[0-9a-fA-F]{40}$/.test(t.address))).toBe(true)
  })
})

describe('AgentDetailClient tabs and the Activity tab (#4226)', () => {
  beforeEach(() => {
    mockUseAuth.mockReturnValue({ user: { accounts: [SAFE] } })
    mockUseAgents.mockReturnValue({
      agents: [
        {
          id: 'agent-1',
          name: 'Research agent',
          description: null,
          delegate_address: '0x2222222222222222222222222222222222222222',
          account_id: 'safe-1',
          account_address: SAFE.account_address,
          account_name: 'Main account',
          status: 'active',
          created_at: '2026-05-01T00:00:00Z',
          mcp_last_seen_at: '2026-06-01T10:00:00Z',
          allowances: [],
          labels: [],
          account_type: 'delegator_hybrid',
        },
      ],
      loading: false,
      pauseAgent: vi.fn(),
      resumeAgent: vi.fn(),
      revokeAgent: vi.fn(),
      refetch: vi.fn(),
    })
    mockUseAgentActivity.mockReturnValue({ activity: [], stats: null, loading: false })
    mockUseAgentPaymentLedger.mockReturnValue({
      payments: [],
      total: 0,
      hasMore: false,
      loading: false,
      loadingMore: false,
      error: null,
      loadMore: vi.fn(),
      refresh: vi.fn(),
    })
    // #4227: the Tool calls tab's reader — empty and idle unless seeded.
    mockUseAgentToolCallLog.mockReturnValue({
      items: [],
      total: 0,
      hasMore: false,
      errorCount: 0,
      loading: false,
      loadingMore: false,
      error: null,
      loadMore: vi.fn(),
      refresh: vi.fn(),
    })
    mockUseDashboardOverview.mockReturnValue({ data: null, loading: false, error: null, refetch: vi.fn() })
    mockUseDelegateBalance.mockReturnValue({
      balance: null,
      hasStranded: false,
      hasRecoverableUsdc: false,
      hasBelowMinimumUsdc: false,
      loading: false,
      refetch: vi.fn(),
    })
    mockUseAgentPassport.mockReturnValue({
      passport: null,
      standing: null,
      loading: false,
      issuing: false,
      issueError: null,
      issuePassport: vi.fn(),
      refetch: vi.fn(),
    })
    mockUseCompanyDetails.mockReturnValue({ status: 'off', details: null })
    mockRouterPush.mockClear()
    mockRouterReplace.mockClear()
  })

  afterEach(() => {
    window.history.replaceState(null, '', '/agents/agent-1')
  })

  /** One kinded-read payment row the tab renders (merchant-first, no addresses). */
  function ledgerRow(overrides: Record<string, unknown> = {}) {
    return {
      type: 'payment' as const,
      id: 'p1',
      agent_id: 'agent-1',
      token: 'USDC',
      token_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount: '0.40',
      amount_raw: '400000',
      to: '0x9999999999999999999999999999999999999999',
      status: 'confirmed' as const,
      tx_hash: '0x' + 'f1'.repeat(32),
      source: 'x402',
      x402_resource_url: 'https://api.merchant.com/purchase',
      explorer_url: 'https://basescan.org/tx/0xf1',
      created_at: '2026-05-30T09:30:00Z',
      ...overrides,
    }
  }

  it('defaults to the Activity tab, and the URL carries no tab parameter', () => {
    render(<AgentDetailClient agentId="agent-1" />)
    expect(screen.getByRole('tab', { name: 'Activity', selected: true })).toBeInTheDocument()
    expect(window.location.search).toBe('')
  })

  it('an unknown ?tab= falls back to Activity', () => {
    window.history.replaceState(null, '', '/agents/agent-1?tab=yesterday')
    render(<AgentDetailClient agentId="agent-1" />)
    expect(screen.getByRole('tab', { name: 'Activity', selected: true })).toBeInTheDocument()
    expect(screen.queryByTestId('agent-tool-calls-section')).toBeNull()
  })

  it('switching tabs writes ONLY the tab into the URL — the tab filters clear with it', () => {
    window.history.replaceState(null, '', '/agents/agent-1?tab=tool-calls&status=failed')
    render(<AgentDetailClient agentId="agent-1" />)
    fireEvent.click(screen.getByRole('tab', { name: 'Activity' }))
    // Back to Activity: no parameter at all — the seeded facet goes with it,
    // the account page's rule.
    expect(mockRouterReplace).toHaveBeenCalledWith('/agents/agent-1', { scroll: false })
  })

  it('the tabs carry no counts', () => {
    mockLedgerWith([ledgerRow()], 1)
    render(<AgentDetailClient agentId="agent-1" />)
    for (const name of ['Activity', 'Tool calls', 'Settings']) {
      expect(screen.getByRole('tab', { name })).not.toHaveTextContent(/[0-9]/)
    }
  })

  it('the Activity tab renders the ledger rows with day bands, and no by-agent title or movement line', () => {
    mockLedgerWith([ledgerRow(), ledgerRow({ id: 'p2', amount: '1.10', created_at: '2026-05-31T18:00:00Z' })], 2)
    render(<AgentDetailClient agentId="agent-1" />)
    // Merchant-first titles: the x402 host, never the address, never the agent.
    expect(screen.getAllByText('api.merchant.com')).toHaveLength(2)
    // Day bands: two distinct days render two band headers (en-GB short month).
    expect(screen.getByText('30 May')).toBeInTheDocument()
    expect(screen.getByText('31 May')).toBeInTheDocument()
    // The removed row anatomy: no "by <agent>" title, no "From … →" movement.
    expect(document.body.textContent).not.toContain('by Research agent')
    expect(document.body.textContent).not.toMatch(/From [^]*→/)
    expect(document.body.textContent).not.toContain('0x9999999999999999999999999999999999999999')
  })

  it('a failed payment appears in the Activity tab', () => {
    mockLedgerWith([ledgerRow({ id: 'pf', status: 'failed', tx_hash: null })], 1)
    render(<AgentDetailClient agentId="agent-1" />)
    expect(screen.getByText('api.merchant.com')).toBeInTheDocument()
    expect(screen.getByText('Failed')).toBeInTheDocument()
  })

  it('the toolbar offers the Status facet with Needs attention, plus Token and Period', () => {
    // A single-option facet renders nothing (ListToolbar's rule), so the
    // Token trigger needs a second registry entry — on the agent's own chain
    // (#4249: other chains' tokens are not offered).
    mockRegistryTokens.push({
      key: '100:0x0000000000000000000000000000000000000eur',
      symbol: 'EURC',
      address: '0x0000000000000000000000000000000000000eur',
      chainId: 100,
      isNative: false,
    })
    try {
      render(<AgentDetailClient agentId="agent-1" />)
      // Facet triggers read "Label:" (FacetMenu's trigger anatomy).
      fireEvent.click(screen.getByText('Status:'))
      expect(screen.getByRole('menuitemradio', { name: 'Needs attention' })).toBeInTheDocument()
      expect(screen.getByRole('menuitemradio', { name: 'Failed' })).toBeInTheDocument()
      expect(screen.getByText('Token:')).toBeInTheDocument()
      expect(screen.getByText('Period:')).toBeInTheDocument()
      // The summary line's count is the toolbar's own (#4274): no "Out"
      // figure beside it — the count stands alone.
      expect(screen.getByTestId('list-toolbar-count')).toHaveTextContent('0')
      expect(screen.queryByText('Out')).not.toBeInTheDocument()
    } finally {
      mockRegistryTokens.splice(1)
    }
  })

  describe('the Token facet is honest (#4249, #4246 review B2)', () => {
    const NATIVE = { key: '100:native', symbol: 'xDAI', address: undefined, chainId: 100, isNative: true }
    const EURC = {
      key: '100:0x0000000000000000000000000000000000000eur',
      symbol: 'EURC',
      address: '0x0000000000000000000000000000000000000eur',
      chainId: 100,
      isNative: false,
    }
    const OTHER_CHAIN = {
      key: '8453:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      symbol: 'USDC',
      address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      chainId: 8453,
      isNative: false,
    }
    /** The filters of the reader's LAST call, and the agent id it read for. */
    function lastLedgerCall(): { agentId: unknown; filters: Record<string, unknown> } {
      const call = mockUseAgentPaymentLedger.mock.calls.at(-1) ?? []
      return { agentId: call[0], filters: (call[1] ?? {}) as Record<string, unknown> }
    }

    afterEach(() => {
      mockRegistryTokens.splice(1)
      mockRegistryState.loading = false
    })

    it('a selected token the loading registry has not resolved holds the read (#4249 review M1)', () => {
      mockRegistryState.loading = true
      window.history.replaceState(null, '', `/agents/agent-1?tokenKey=${encodeURIComponent(EURC.key)}`)
      render(<AgentDetailClient agentId="agent-1" />)
      expect(lastLedgerCall().agentId).toBeNull()
    })

    it('a loading registry holds nothing when no token is selected (#4249 review M1)', () => {
      mockRegistryState.loading = true
      render(<AgentDetailClient agentId="agent-1" />)
      expect(lastLedgerCall().agentId).toBe('agent-1')
    })

    it('an agent whose chain is unknown is offered every chain — no default chain is guessed (#4249 review N1)', () => {
      mockUseAuth.mockReturnValue({ user: { accounts: [] } })
      const agents = mockUseAgents()
      mockUseAgents.mockReturnValue({
        ...agents,
        agents: agents.agents.map((a: Record<string, unknown>) => ({ ...a, account_chain_id: null })),
      })
      const ON_DEFAULT = {
        key: `${DEFAULT_CHAIN_ID}:0x0000000000000000000000000000000000000def`,
        symbol: 'DEF',
        address: '0x0000000000000000000000000000000000000def',
        chainId: DEFAULT_CHAIN_ID,
        isNative: false,
      }
      const original = mockRegistryTokens.slice()
      mockRegistryTokens.splice(0, mockRegistryTokens.length, ON_DEFAULT, EURC)
      try {
        render(<AgentDetailClient agentId="agent-1" />)
        const trigger = screen.queryByText('Token:')
        expect(trigger).not.toBeNull()
        fireEvent.click(trigger!)
        const options = screen.getAllByRole('menuitemradio').map((el) => el.textContent ?? '')
        expect(options.some((label) => label.includes('EURC'))).toBe(true)
        expect(options.some((label) => label.includes('DEF'))).toBe(true)
      } finally {
        mockRegistryTokens.splice(0, mockRegistryTokens.length, ...original)
      }
    })

    it('offers only ERC-20s on the agent chain — never a native token, never another chain', () => {
      mockRegistryTokens.push(NATIVE, EURC, OTHER_CHAIN)
      render(<AgentDetailClient agentId="agent-1" />)
      fireEvent.click(screen.getByText('Token:'))
      const options = screen.getAllByRole('menuitemradio').map((el) => el.textContent ?? '')
      expect(options.some((label) => label.includes('EURC'))).toBe(true)
      expect(options.some((label) => /Native/.test(label))).toBe(false)
      expect(options.some((label) => label.includes('Base'))).toBe(false)
    })

    it('a selected token reaches the reader as its contract address', () => {
      mockRegistryTokens.push(EURC)
      window.history.replaceState(null, '', `/agents/agent-1?tokenKey=${encodeURIComponent(EURC.key)}`)
      render(<AgentDetailClient agentId="agent-1" />)
      const { agentId, filters } = lastLedgerCall()
      expect(agentId).toBe('agent-1')
      expect(filters.token).toBe(EURC.address)
    })

    it('a key that does not resolve is sent verbatim — an honest empty result, never an unfiltered read', () => {
      window.history.replaceState(null, '', `/agents/agent-1?tokenKey=${encodeURIComponent('100:native')}`)
      render(<AgentDetailClient agentId="agent-1" />)
      const { agentId, filters } = lastLedgerCall()
      expect(agentId).toBe('agent-1')
      expect(filters.token).toBe('100:native')
    })
  })

  it('the needs-setup empty state points at the budget', () => {
    mockUseAgents.mockReturnValue({
      agents: [
        {
          id: 'agent-1',
          name: 'Research agent',
          description: null,
          delegate_address: '0x2222222222222222222222222222222222222222',
          account_id: 'safe-1',
          account_address: SAFE.account_address,
          account_name: 'Main account',
          status: 'pending_approval',
          created_at: '2026-05-01T00:00:00Z',
          mcp_last_seen_at: null,
          allowances: [],
          labels: [],
          account_type: 'delegator_hybrid',
        },
      ],
      loading: false,
      pauseAgent: vi.fn(),
      resumeAgent: vi.fn(),
      revokeAgent: vi.fn(),
      refetch: vi.fn(),
    })
    render(<AgentDetailClient agentId="agent-1" />)
    expect(screen.getByText('No payments yet')).toBeInTheDocument()
    expect(screen.getByText('Once you set a budget, every payment this agent makes shows here.')).toBeInTheDocument()
  })

  describe('review-the-payment navigation (#2196 retargeted)', () => {
    function mockRecoverable(usdc: string, usdcAtomic: string) {
      mockUseDelegateBalance.mockReturnValue({
        balance: {
          delegate_address: '0x2222222222222222222222222222222222222222',
          account_address: SAFE.account_address,
          chain_id: 8453,
          eth: '0',
          eth_atomic: '0',
          usdc,
          usdc_atomic: usdcAtomic,
          usdc_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          sweep_min_usdc: '0.01',
        },
        hasStranded: true,
        hasRecoverableUsdc: true,
        loading: false,
        refetch: vi.fn(),
      })
    }

    function unsettledRow(id: string, amount: string) {
      return {
        type: 'payment' as const,
        id,
        agent_id: 'agent-1',
        token: 'USDC',
        token_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        amount,
        to: '0x9999999999999999999999999999999999999999',
        status: 'confirmed' as const,
        tx_hash: '0x' + id.padEnd(64, 'a'),
        source: 'x402',
        explorer_url: 'https://basescan.org/tx/0x' + id,
        payment_flow_status: 'needs_attention' as const,
        payment_attention_reason: 'merchant_retry_rejected_after_payment' as const,
        created_at: '2026-05-30T00:00:00Z',
      }
    }

    it('Review the payment selects the Activity tab, then scrolls to it', () => {
      const scrollIntoView = vi.fn()
      window.HTMLElement.prototype.scrollIntoView = scrollIntoView
      mockRecoverable('8.00', '8000000')
      mockUseAgentActivity.mockReturnValue({
        activity: [unsettledRow('1', '8.00')],
        stats: null,
        loading: false,
      })
      window.history.replaceState(null, '', '/agents/agent-1?tab=settings')
      render(<AgentDetailClient agentId="agent-1" />)

      fireEvent.click(screen.getByRole('button', { name: 'Review the payment' }))
      // The tab is selected by URL first; the scroll effect fires once the
      // Activity panel is mounted.
      expect(mockRouterReplace).toHaveBeenCalledWith('/agents/agent-1?tab=activity', { scroll: false })
    })

    it('the Activity tab carries a warning dot while unsettled payments exist', () => {
      mockUseAgentActivity.mockReturnValue({
        activity: [unsettledRow('1', '8.00')],
        stats: null,
        loading: false,
      })
      render(<AgentDetailClient agentId="agent-1" />)
      const activityTab = screen.getByRole('tab', { name: /Activity/ })
      expect(within(activityTab).getByText('Needs attention')).toBeInTheDocument()
    })

    it('no unsettled payments, no warning dot on the Activity tab', () => {
      render(<AgentDetailClient agentId="agent-1" />)
      const activityTab = screen.getByRole('tab', { name: /Activity/ })
      expect(within(activityTab).queryByText('Needs attention')).toBeNull()
    })

    it('the affected rows carry the Needs attention badge in the Activity tab', () => {
      // #4249: the PRODUCTION shape. A stranded payment's intent is
      // `confirmed` — the funding leg settled — and only the machine-payment
      // lifecycle says it needs attention. `payment_intents.status` never
      // holds `needs_attention`, so a fixture that put it there proved the
      // humanised status, not the lifecycle badge the row must read (#4246
      // review B1).
      mockUseAgentPaymentLedger.mockReturnValue({
        payments: [ledgerRow({ id: 'pn', status: 'confirmed', payment_attention_reason: 'merchant_retry_rejected_after_payment', payment_flow_status: 'needs_attention' })],
        total: 1,
        hasMore: false,
        loading: false,
        loadingMore: false,
        error: null,
        loadMore: vi.fn(),
        refresh: vi.fn(),
      })
      mockUseAgentActivity.mockReturnValue({
        activity: [ledgerRow({ id: 'pn', status: 'confirmed', payment_attention_reason: 'merchant_retry_rejected_after_payment', payment_flow_status: 'needs_attention' })],
        stats: null,
        loading: false,
      })
      render(<AgentDetailClient agentId="agent-1" />)
      // The row itself carries the badge — never the settled intent's "Sent".
      const panel = screen.getByTestId('agent-activity-section')
      expect(within(panel).queryAllByText('Needs attention')).toHaveLength(1)
      expect(within(panel).queryByText('Sent')).toBeNull()
    })
  })
})
