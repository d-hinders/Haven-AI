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
  mockUseDelegateBalance,
  mockUseAgentPassport,
} = vi.hoisted(() => ({
  mockUseAuth: vi.fn(),
  mockUseAgents: vi.fn(),
  mockUseAgentActivity: vi.fn(),
  mockUseDelegateBalance: vi.fn(),
  mockUseAgentPassport: vi.fn(),
}))

const { mockRouterPush } = vi.hoisted(() => ({ mockRouterPush: vi.fn() }))

const { mockUseCompanyDetails } = vi.hoisted(() => ({ mockUseCompanyDetails: vi.fn() }))

vi.mock('@/hooks/useCompanyDetails', () => ({
  useCompanyDetails: () => mockUseCompanyDetails(),
}))

// #1402: the component navigates to /agents after a completed remove.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockRouterPush, replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
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
  }
})

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
  default: () => null,
}))

vi.mock('@/components/agent-panel/ReplaceSigningKeyModal', () => ({
  ReplaceSigningKeyModal: () => null,
}))

vi.mock('@/components/ConfirmDialog', () => ({
  default: () => null,
}))

vi.mock('@/components/transactions/TransactionsTable', () => ({
  default: ({
    transactions = [],
  }: {
    transactions?: Array<{
      hash: string
      accountName?: string
      movementOverride?: ReactNode
    }>
  }) => (
    <div>
      <div>Transactions table</div>
      {transactions.map((tx) => (
        <div key={tx.hash}>
          <span>{tx.accountName}</span>
          {tx.movementOverride}
        </div>
      ))}
    </div>
  ),
}))

import { AGENT_PAUSED_BODY, AGENT_PAUSED_TITLE } from '@/lib/agent-pause-copy'
import { HALF_REVOKED_TITLE } from '@/lib/half-revoked'
import AgentDetailClient from '../AgentDetailClient'

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
      stats: { all_time: [], today: [], this_week: [], pending_approvals: 0 },
      loading: false,
    })
    render(<AgentDetailClient agentId="agent-1" />)

    expect(screen.queryByText('Pending approvals')).not.toBeInTheDocument()
    expect(screen.queryByText('Payments waiting on you')).not.toBeInTheDocument()
  })

  /**
   * #3696: the two stat cards are gone. Their figures read as the summary
   * line on the Activity section header, drawn from the SAME `stats` source
   * the cards used (all_time/today are per-token aggregates summed by
   * tx_count). The "All-time transactions" label no longer appearing is the
   * check that fails on the pre-slice tree — the card carried that label.
   */
  it('folds the stat cards into the Activity header summary line (#3696)', () => {
    mockUseAgentActivity.mockReturnValue({
      activity: [],
      stats: {
        all_time: [{ token: 'USDC', total_spent: '482.50', tx_count: 37 }],
        today: [{ token: 'USDC', total_spent: '25.00', tx_count: 1 }],
        this_week: [],
        pending_approvals: 0,
      },
      loading: false,
    })
    render(<AgentDetailClient agentId="agent-1" />)

    expect(screen.getByText(/1 today · 37 all time/)).toBeInTheDocument()
    expect(screen.queryByText('All-time transactions')).not.toBeInTheDocument()
    expect(screen.queryByText('Confirmed agent payments')).not.toBeInTheDocument()
  })

  it('links the Activity summary line to the agent-filtered transactions view (#3696)', () => {
    render(<AgentDetailClient agentId="agent-1" />)

    const link = screen.getByRole('link', { name: 'View in Transactions' })
    expect(link).toHaveAttribute('href', '/transactions?agentId=agent-1')
  })

  /**
   * #3696: no unit test exists for McpToolCallsPanel itself, so its placement
   * contract is asserted at page level: the panel renders INSIDE the
   * #agent-activity anchor section (the #2196 scroll target) and BELOW the
   * transactions table in DOM order.
   */
  it('renders the MCP tool calls panel inside the Activity section, below the table (#3696)', () => {
    mockUseAgentActivity.mockReturnValue({
      activity: [
        {
          type: 'mcp_tool_call',
          id: 'mcp-1',
          agent_id: 'agent-1',
          tool_name: 'get_payment_status',
          payment_id: null,
          result_status: 'ok',
          next_action: null,
          error_code: null,
          status_code: 200,
          created_at: '2026-06-01T10:00:00Z',
        },
      ],
      stats: null,
      loading: false,
    })
    render(<AgentDetailClient agentId="agent-1" />)

    const section = document.getElementById('agent-activity')
    expect(section).not.toBeNull()

    const panelHeading = screen.getByText('MCP tool calls')
    expect(section!.contains(panelHeading)).toBe(true)

    // DOM order: the mocked table's marker precedes the panel heading.
    const table = screen.getByText('Transactions table')
    expect(
      table.compareDocumentPosition(panelHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('renders last activity in the header meta without a default connected badge', () => {
    render(<AgentDetailClient agentId="agent-1" />)

    expect(screen.getByRole('heading', { level: 1, name: 'Research agent' })).toBeInTheDocument()
    expect(screen.getByText('Last activity 2h ago')).toBeInTheDocument()
    expect(screen.queryByText('Connected')).not.toBeInTheDocument()
  })

  // #3694: the "About this agent" card's four facts moved into the header's
  // meta line (#3692's PageHeader slot); the card is gone.
  it('carries wallet, network, created and last activity in the header meta, with no About card (#3694)', () => {
    render(<AgentDetailClient agentId="agent-1" />)
    expect(screen.queryByRole('heading', { name: 'About this agent' })).not.toBeInTheDocument()
    const header = screen.getByRole('banner')
    expect(header).toHaveTextContent('Main account · Gnosis Chain · Created 1mo ago · Last activity 2h ago')
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
    // (`ReceiveFundsModal`'s "Refresh page"). (#2927: the fill reads the bg
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

  it('uses the activity row wallet name for historical payment movement', () => {
    mockUseAgentActivity.mockReturnValue({
      activity: [
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
      ],
      stats: null,
      loading: false,
    })

    render(<AgentDetailClient agentId="agent-1" />)

    expect(screen.getAllByText('Previous wallet').length).toBeGreaterThan(0)
    expect(screen.getByText('api.example.com')).toBeInTheDocument()
  })

  it('does not fall back to the current wallet name when historical activity has only an address', () => {
    mockUseAgentActivity.mockReturnValue({
      activity: [
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
      ],
      stats: null,
      loading: false,
    })

    render(<AgentDetailClient agentId="agent-1" />)

    expect(screen.getAllByText('Haven wallet 0x4444…4444').length).toBeGreaterThan(0)
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
    // #3549 tests pin Add budget present on a live agent, absent on a retired one).
    expect(screen.queryByRole('button', { name: /Add budget|Update budget/ })).not.toBeInTheDocument()
  })

  it('offers no Update budget entry point anywhere — button or menu item (#3694)', () => {
    mockDelegationAgent()
    render(<AgentDetailClient agentId="agent-1" />)
    expect(screen.queryByRole('button', { name: 'Update budget' })).not.toBeInTheDocument()
    expect(openAgentMenu()).not.toContain('Update budget')
  })

  // ── Backup & recovery pointer, not a second copy (#1089) ────────────────

  it('points a delegation agent at the account page instead of rendering signer controls', () => {
    mockDelegationAgent()
    render(<AgentDetailClient agentId="agent-1" />)

    const link = screen.getByRole('link', { name: /Backup & recovery/ })
    expect(link).toHaveAttribute('href', '/accounts/safe-1')
    // No enrollment controls on the agent page — those live only on the account page now.
    expect(screen.queryByRole('button', { name: /Add a backup/ })).not.toBeInTheDocument()
  })

  // ── Identity and settings card (#3697) ──────────────────────────────────
  // The page's optional and account-level items — the Agent Passport row, the
  // tax declaration row (when VIES-valid) and the Backup & recovery pointer —
  // are ONE quiet card at the bottom. No standalone Passport or Tax card.

  it('groups the passport row, the tax row and Backup & recovery into one Identity and settings card (#3697)', () => {
    mockUseCompanyDetails.mockReturnValue({ status: 'ready', details: VIES_VALID_ROW })
    mockDelegationAgent()
    render(<AgentDetailClient agentId="agent-1" />)

    const section = screen.getByTestId('identity-settings-section')
    // Exactly ONE card in the section — no standalone Passport or Tax card.
    const cards = section.querySelectorAll('.rounded-\\[10px\\]')
    expect(cards.length).toBe(1)
    const card = cards[0]

    // All three rows live inside that one card.
    expect(within(card as HTMLElement).getByTestId('agent-passport-row')).toBeTruthy()
    expect(within(card as HTMLElement).getByTestId('tax-declaration-row')).toBeTruthy()
    expect(
      within(card as HTMLElement).getByRole('link', { name: /Backup & recovery/ }),
    ).toHaveAttribute('href', '/accounts/safe-1')

    // The tax row keeps its own wording rules: the copy did not change, only
    // the wrapper.
    expect(within(card as HTMLElement).getByRole('checkbox')).toBeInTheDocument()
  })

  it('hides the tax row without leaving a stray divider or empty gap (#3697)', () => {
    // 'off' — the flag-off answer the route gives when HAVEN_OWNER_COMPANY_DETAILS is unset.
    mockUseCompanyDetails.mockReturnValue({ status: 'off', details: null })
    mockDelegationAgent()
    render(<AgentDetailClient agentId="agent-1" />)

    expect(screen.queryByTestId('tax-declaration-row')).not.toBeInTheDocument()
    const card = screen
      .getByTestId('identity-settings-section')
      .querySelector('.rounded-\\[10px\\]') as HTMLElement
    // The card's direct rows are the passport row and the Backup section —
    // exactly two, so the tax row's divider left no orphan and no gap.
    expect(card.children.length).toBe(2)
    expect(card.textContent).not.toContain('Tax declaration')

    // ...and the non-valid VIES state hides it too.
    mockUseCompanyDetails.mockReturnValue({ status: 'ready', details: { ...VIES_VALID_ROW, vies_status: 'invalid' } })
    render(<AgentDetailClient agentId="agent-1" />)
    expect(screen.queryByTestId('tax-declaration-row')).not.toBeInTheDocument()
  })

  it('orders the page: header, banner slot, Spending, Activity, Identity and settings (#3697)', () => {
    mockDelegationAgent()
    render(<AgentDetailClient agentId="agent-1" />)

    const header = document.querySelector('header')
    const banner = screen.getByTestId('agent-banner-slot')
    const budget = document.getElementById('delegation-budget-card')
    const activity = document.getElementById('agent-activity')
    const identity = screen.getByTestId('identity-settings-section')
    expect(header).toBeTruthy()
    expect(budget).toBeTruthy()
    expect(activity).toBeTruthy()

    // Each pair FOLLOWING in document order — the section rule's final page
    // shape, asserted structurally rather than by pixel position.
    const pairs: [Element, Element][] = [
      [header!, banner],
      [banner, budget!],
      [budget!, activity!],
      [activity!, identity],
    ]
    for (const [before, after] of pairs) {
      expect(
        before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING,
        `${before.nodeName} must precede ${after.nodeName}`,
      ).toBeTruthy()
    }
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
  // budget lives in the Spending card, which hides it for a retired agent.
  // So the page's half of the gate is handing the card the right `retired`
  // state (the it.each below, incl. the archived-but-not-revoked shape
  // ARCHIVE_AGENT_SQL allows: an UNLINKED agent with no live budget), and the
  // card's half is pinned in DelegationBudgetCard.test.tsx with Add budget
  // asserted present on a live agent and absent on a retired one.
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
    // changes, which is what makes the announcement reliable.
    expect(screen.getByRole('status')).toHaveTextContent('')
    openAgentMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Restore to list' }))
    const trigger = screen.getByRole('button', { name: 'Agent options' })
    expect(trigger).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Restoring…')
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
    ['active', { status: 'active' }, 'Pause agent',
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

    for (const name of ['Pause agent', 'Resume agent'] as const) {
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
    fireEvent.click(screen.getByRole('button', { name: 'Pause agent' }))
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
    expect(screen.getByRole('banner')).toContainElement(screen.getByRole('button', { name: 'Pause agent' }))
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
      fireEvent.click(screen.getByRole('button', { name: 'Pause agent' }))
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
