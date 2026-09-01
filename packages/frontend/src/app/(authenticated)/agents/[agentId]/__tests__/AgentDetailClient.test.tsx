import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

// #1402: the component navigates to /agents after a completed remove.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
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
  default: () => <div>DelegationBudgetCard</div>,
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
      safeName?: string
      movementOverride?: ReactNode
    }>
  }) => (
    <div>
      <div>Transactions table</div>
      {transactions.map((tx) => (
        <div key={tx.hash}>
          <span>{tx.safeName}</span>
          {tx.movementOverride}
        </div>
      ))}
    </div>
  ),
}))

import { AGENT_PAUSED_BODY, AGENT_PAUSED_TITLE } from '@/lib/agent-pause-copy'
import AgentDetailClient from '../AgentDetailClient'

const SAFE = {
  id: 'safe-1',
  name: 'Main account',
  safe_address: '0x1111111111111111111111111111111111111111',
  chain_id: 100,
}

describe('AgentDetailClient last-activity metadata', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-01T12:00:00Z'))
    mockUseAuth.mockReturnValue({
      user: {
        safes: [SAFE],
      },
    })
    mockUseAgents.mockReturnValue({
      agents: [
        {
          id: 'agent-1',
          name: 'Research agent',
          description: null,
          delegate_address: '0x2222222222222222222222222222222222222222',
          safe_id: 'safe-1',
          safe_address: SAFE.safe_address,
          safe_name: 'Main account',
          status: 'active',
          created_at: '2026-05-01T00:00:00Z',
          mcp_last_seen_at: '2026-06-01T10:00:00Z',
          allowances: [],
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

  it('keeps the two stat tiles that count something real (#2106)', () => {
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

    expect(screen.getByText('All-time transactions')).toBeInTheDocument()
    expect(screen.getByText('37')).toBeInTheDocument()
    expect(screen.getByText('Today')).toBeInTheDocument()
  })

  it('renders the compact last-activity field without a default connected badge', () => {
    render(<AgentDetailClient agentId="agent-1" />)

    expect(screen.getByRole('heading', { level: 1, name: 'Research agent' })).toBeInTheDocument()
    expect(screen.getByText('Last activity')).toBeInTheDocument()
    expect(screen.getByText('2h ago')).toBeInTheDocument()
    expect(screen.queryByText('Connected')).not.toBeInTheDocument()
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
        safe_address: SAFE.safe_address,
        chain_id: 8453,
        eth: '0',
        eth_atomic: '0',
        usdc: '0.04',
        usdc_atomic: '40000',
        usdc_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
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

  it('hides the recover-funds prompt for an ETH-only delegate (gasless path is USDC-only)', () => {
    mockUseDelegateBalance.mockReturnValue({
      balance: {
        delegate_address: '0x2222222222222222222222222222222222222222',
        safe_address: SAFE.safe_address,
        chain_id: 8453,
        eth: '0.01',
        eth_atomic: '10000000000000000',
        usdc: '0',
        usdc_atomic: '0',
        usdc_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
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
        safe_address: SAFE.safe_address,
        chain_id: 8453,
        eth: '0',
        eth_atomic: '0',
        usdc,
        usdc_atomic: usdcAtomic,
        usdc_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
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
    // `Button`'s ghost variant — a white fill and a hairline, the same variant
    // the one other Button inside an ApprovalRequiredBanner uses
    // (`ReceiveFundsModal`'s "Refresh page").
    expect(review.className).toContain('bg-white')
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
          safe_id: 'safe-old',
          safe_address: '0x4444444444444444444444444444444444444444',
          safe_name: 'Previous wallet',
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
          safe_id: null,
          safe_address: '0x4444444444444444444444444444444444444444',
          safe_name: null,
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
          safe_id: 'safe-1',
          safe_address: SAFE.safe_address,
          safe_name: 'Main account',
          status: 'active',
          created_at: '2026-05-01T00:00:00Z',
          mcp_last_seen_at: null,
          allowances: [],
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

  it('routes Update budget to the budget card — NOT EditAgentModal — on a delegation agent', () => {
    mockDelegationAgent()
    const scrollIntoView = vi.fn()
    window.HTMLElement.prototype.scrollIntoView = scrollIntoView

    render(<AgentDetailClient agentId="agent-1" />)

    fireEvent.click(screen.getByRole('button', { name: 'Update budget' }))

    expect(screen.queryByTestId('edit-agent-modal')).not.toBeInTheDocument()
    expect(scrollIntoView).toHaveBeenCalled()

    // The empty-state "Add budget" affordance takes the same route.
    fireEvent.click(screen.getByRole('button', { name: 'Add budget' }))
    expect(screen.queryByTestId('edit-agent-modal')).not.toBeInTheDocument()
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

  it('hides the backup & recovery pointer on a legacy agent', () => {
    mockAgentWith({ account_type: 'safe' })
    render(<AgentDetailClient agentId="agent-1" />)
    expect(screen.queryByRole('link', { name: /Backup & recovery/ })).not.toBeInTheDocument()
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

  it('does not read delegate balance for a legacy agent (#2258)', () => {
    const base = mockUseAgents()
    mockUseAgents.mockReturnValue({
      ...base,
      agents: base.agents.map((agent: { id: string }) => ({
        ...agent,
        account_type: 'safe',
      })),
    })

    render(<AgentDetailClient agentId="agent-1" />)

    const calls = mockUseDelegateBalance.mock.calls
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[calls.length - 1][0]).toBeNull()
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
          safe_id: 'safe-1',
          safe_address: SAFE.safe_address,
          safe_name: 'Main account',
          status: 'active',
          created_at: '2026-05-01T00:00:00Z',
          mcp_last_seen_at: null,
          allowances: [],
          account_type: 'delegator_hybrid',
          ...overrides,
        },
      ],
      loading: false,
      pauseAgent: vi.fn(),
      resumeAgent: vi.fn(),
      revokeAgent: vi.fn(),
      archiveAgent: vi.fn(),
      unarchiveAgent: vi.fn(),
      refetch: vi.fn(),
    })
  }

  it('shows Remove agent for an operational delegation agent, never Restore (#1402)', () => {
    mockAgentWith({})
    render(<AgentDetailClient agentId="agent-1" />)
    expect(screen.getByRole('button', { name: 'Remove agent' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Restore to list' })).not.toBeInTheDocument()
  })

  it('hides all authority controls on an operational LEGACY agent (#2258)', () => {
    mockAgentWith({ account_type: undefined })
    render(<AgentDetailClient agentId="agent-1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Agent options' }))
    expect(screen.queryByRole('button', { name: 'Remove agent' })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Update budget' })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Payment credentials' })).not.toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Rename agent' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Update budget' })).not.toBeInTheDocument()
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

  it('does not present a live pause or resume message for a paused legacy record (#2258)', () => {
    mockAgentWith({ account_type: undefined, status: 'paused' })
    render(<AgentDetailClient agentId="agent-1" />)
    expect(screen.queryByRole('heading', { name: AGENT_PAUSED_TITLE })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /resume/i })).not.toBeInTheDocument()
  })

  it('offers Unlink on an active legacy record without an authority action (#2258)', () => {
    mockAgentWith({ account_type: undefined, status: 'active' })
    render(<AgentDetailClient agentId="agent-1" />)
    expect(screen.getByRole('button', { name: 'Unlink agent' })).toBeInTheDocument()
  })

  it('an archived agent gets Restore to list and no Remove (#1402)', () => {
    mockAgentWith({ status: 'revoked', archived_at: '2026-06-01T00:00:00Z' })
    render(<AgentDetailClient agentId="agent-1" />)
    expect(screen.queryByRole('button', { name: 'Remove agent' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Restore to list' })).toBeInTheDocument()
  })

  it('double-clicking Restore fires unarchive ONCE — pendingAction guards it (#1402)', async () => {
    let release!: () => void
    const unarchiveAgent = vi.fn(
      () => new Promise<void>((resolve) => { release = resolve }),
    )
    mockAgentWith({ status: 'revoked', archived_at: '2026-06-01T00:00:00Z' })
    mockUseAgents.mockReturnValue({ ...mockUseAgents(), unarchiveAgent })
    render(<AgentDetailClient agentId="agent-1" />)
    const restore = screen.getByRole('button', { name: 'Restore to list' })
    fireEvent.click(restore)
    fireEvent.click(restore)
    release()
    await Promise.resolve()
    expect(unarchiveAgent).toHaveBeenCalledTimes(1)
  })
})
