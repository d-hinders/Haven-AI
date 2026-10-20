/**
 * MoneyPanel unit tests (#3807). The panel is a pure render of the overview
 * wire, so these pin the money-clarity rules at the component boundary —
 * the headless equivalent of the rendered captures (repo closeout rule:
 * a logic-only change gets a vitest pin, not a screenshot).
 *
 * Round-2 design review (2026-10-09): the spending breakdown must RECONCILE
 * with its own headline. Revoked agents' 30-day spend sits inside
 * `spend.d30.net` but has no agent row on the wire — an unattributed
 * remainder renders as an "Agents since removed" row so the total the card
 * states is never contradicted by its own rows.
 */

import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import MoneyPanel from '../MoneyPanel'
import type { DashboardAgentPreview, DashboardOverviewResponse } from '@/types/dashboard'

const baseProps = {
  loading: false,
  unavailable: false,
  currency: 'USD' as const,
  totalFiat: 0,
  changeAvailable: false,
  sekChangeUnavailable: false,
  changeUnavailable: false,
  changeAmount: null,
  changePercent: 0,
  hasAccounts: true,
  hasFunds: true,
  fundingStateKnown: true,
  watchingForDeposit: false,
  requiresOtherDevice: false,
  showSpending: true,
  onReceive: vi.fn(),
  onSend: vi.fn(),
}

function agent(id: string, name: string, d30NetUsd: number): DashboardAgentPreview {
  return {
    id,
    name,
    status: 'active',
    accountId: null,
    accountName: null,
    accountChainId: 8453,
    allowances: [],
    budgets: [],
    receivedSubBudgets: [],
    stats: {
      d7: {
        gross: { usd: 0, eur: 0, sek: 0 },
        net: { usd: 0, eur: 0, sek: 0 },
        approx: false,
        payments: 0,
        refusals: { budget: 0, scope: 0, failed: 0, haven: 0 },
      },
      d30: {
        gross: { usd: 0, eur: 0, sek: 0 },
        net: { usd: d30NetUsd, eur: 0, sek: 0 },
        approx: false,
        payments: 0,
        refusals: { budget: 0, scope: 0, failed: 0, haven: 0 },
      },
      lastPaymentAt: null,
      lastCounterparty: null,
    },
  }
}

function overview(overrides: {
  d30NetUsd: number
  d30NetSek?: number
  d30Approx?: boolean
  /** #4165: the server's per-currency "≈" decision; omitted = an older backend. */
  d30ApproxByCurrency?: { usd: boolean; eur: boolean; sek: boolean }
  d30UnpricedByCurrency?: { usd: boolean; eur: boolean; sek: boolean }
  agents: DashboardAgentPreview[]
}): DashboardOverviewResponse {
  return {
    totals: { usd: 0, eur: 0 },
    change: {
      available: false,
      usdAmount: 0,
      eurAmount: 0,
      usdPercent: 0,
      eurPercent: 0,
    },
    actionableApprovals: 0,
    pendingApprovals: 0,
    onboardingProgress: { hasFirstAgentPayment: false },
    agents: overrides.agents,
    agentCount: { active: overrides.agents.length, paused: 0, pending_approval: 0 },
    accounts: [],
    spotRates: {},
    spend: {
      scope: 'mainnet',
      d7: {
        gross: { usd: 0, eur: 0, sek: 0 },
        net: { usd: 0, eur: 0, sek: 0 },
        approx: false,
        payments: 0,
        distinctMerchants: 0,
        budgetStops: 0,
      },
      d30: {
        gross: { usd: 0, eur: 0, sek: 0 },
        net: { usd: overrides.d30NetUsd, eur: 0, sek: overrides.d30NetSek ?? 0 },
        approx: overrides.d30Approx ?? false,
        ...(overrides.d30ApproxByCurrency ? { approxByCurrency: overrides.d30ApproxByCurrency } : {}),
        ...(overrides.d30UnpricedByCurrency ? { unpricedByCurrency: overrides.d30UnpricedByCurrency } : {}),
        payments: 0,
        distinctMerchants: 0,
        budgetStops: 0,
      },
      topMerchant7d: null,
      failedIntents7d: 0,
      balance_by_day: [],
    },
  }
}

describe('MoneyPanel — spending breakdown reconciles with the headline (#3807 round-2 review)', () => {
  it('names the unattributed remainder when the total carries spend no row accounts for', () => {
    // Two active agents at 17.485 each (34.97 attributed) against a 51.76
    // total — the 16.79 difference is removed agents' spend.
    render(
      <MoneyPanel
        {...baseProps}
        overview={overview({
          d30NetUsd: 51.76,
          agents: [agent('a1', 'Research agent', 17.485), agent('a2', 'Data-feed agent', 17.485)],
        })}
      />,
    )

    const row = screen.getByText('Agents since removed').closest('div')
    expect(row).not.toBeNull()
    expect(row).toHaveTextContent('$16.79')
  })

  it('re-priced USDC in USD carries no ≈ — on the total or the remainder (#4165)', () => {
    render(
      <MoneyPanel
        {...baseProps}
        overview={overview({
          d30NetUsd: 51.76,
          d30Approx: true,
          d30ApproxByCurrency: { usd: false, eur: true, sek: true },
          agents: [agent('a1', 'Research agent', 17.485), agent('a2', 'Data-feed agent', 17.485)],
        })}
      />,
    )

    const row = screen.getByText('Agents since removed').closest('div')
    expect(row).not.toHaveTextContent('\u2248')
    expect(screen.queryByTitle("Converted at today's rate")).not.toBeInTheDocument()
  })

  it('marks the total and the remainder ≈ in another currency, where the conversion changes the number', () => {
    render(
      <MoneyPanel
        {...baseProps}
        currency="SEK"
        overview={overview({
          d30NetUsd: 51.76,
          d30NetSek: 556.94,
          d30Approx: true,
          d30ApproxByCurrency: { usd: false, eur: true, sek: true },
          agents: [agent('a1', 'Research agent', 0), agent('a2', 'Data-feed agent', 0)].map((row) => ({
            ...row,
            stats: { ...row.stats, d30: { ...row.stats.d30, net: { usd: 0, eur: 0, sek: 188.14 } } },
          })),
        })}
      />,
    )

    const row = screen.getByText('Agents since removed').closest('div')
    expect(row).toHaveTextContent('\u2248')
    expect(screen.getAllByTitle("Converted at today's rate").length).toBeGreaterThan(1)
  })

  it('falls back to the provenance flag when an older backend sends no per-currency decision', () => {
    render(
      <MoneyPanel
        {...baseProps}
        overview={overview({
          d30NetUsd: 51.76,
          d30Approx: true,
          agents: [agent('a1', 'Research agent', 17.485), agent('a2', 'Data-feed agent', 17.485)],
        })}
      />,
    )

    const row = screen.getByText('Agents since removed').closest('div')
    expect(row).toHaveTextContent('\u2248')
  })

  it('an unpriced 30-day total says so in words, and with nothing priced reads "—", never "$0.00" (#4165)', () => {
    render(
      <MoneyPanel
        {...baseProps}
        overview={overview({
          d30NetUsd: 0,
          d30Approx: true,
          d30ApproxByCurrency: { usd: false, eur: false, sek: false },
          d30UnpricedByCurrency: { usd: true, eur: false, sek: false },
          agents: [],
        })}
      />,
    )

    expect(screen.getByText('Some amounts couldn’t be valued and aren’t included.')).toBeInTheDocument()
    // The spend half's headline — not the balance half, which has its own $0.00.
    const spending = screen.getByText('Agent spending, last 30 days').parentElement!
    expect(spending).not.toHaveTextContent('$0.00')
    expect(within(spending).getByText('\u2014')).toBeInTheDocument()
    expect(spending).not.toHaveTextContent('\u2248')
  })

  it('renders no remainder row when the agent rows already account for the total', () => {
    render(
      <MoneyPanel
        {...baseProps}
        overview={overview({
          d30NetUsd: 34.97,
          agents: [agent('a1', 'Research agent', 17.485), agent('a2', 'Data-feed agent', 17.485)],
        })}
      />,
    )

    expect(screen.queryByText('Agents since removed')).not.toBeInTheDocument()
  })

  it('holds a cent-level remainder back — rounding is not a hidden agent', () => {
    render(
      <MoneyPanel
        {...baseProps}
        overview={overview({
          d30NetUsd: 34.971,
          agents: [agent('a1', 'Research agent', 17.485), agent('a2', 'Data-feed agent', 17.485)],
        })}
      />,
    )

    expect(screen.queryByText('Agents since removed')).not.toBeInTheDocument()
  })
})

describe('MoneyPanel — spending half to the mockup (#3902)', () => {
  const twoAgents = () =>
    overview({
      d30NetUsd: 34.97,
      agents: [agent('a1', 'Research agent', 17.485), agent('a2', 'Data-feed agent', 17.485)],
    })

  const follows = (a: Element, b: Element) =>
    Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

  it('labels the half "Agent spending, last 30 days" and keeps it the section heading', () => {
    render(<MoneyPanel {...baseProps} overview={twoAgents()} />)

    const heading = screen.getByRole('heading', { name: 'Agent spending, last 30 days' })
    expect(heading.textContent).toBe('Agent spending, last 30 days')
    expect(heading.closest('section')).toHaveAttribute('aria-label', 'Spending')
    expect(heading).toHaveClass('text-[var(--v2-ink-2)]')
  })

  it('orders label, total, split bar, then the counts', () => {
    render(<MoneyPanel {...baseProps} overview={twoAgents()} />)

    const label = screen.getByRole('heading', { name: 'Agent spending, last 30 days' })
    const total = within(screen.getByRole('region', { name: 'Spending' })).getByText('$34.97', {
      selector: 'span.text-2xl',
    })
    const bar = screen.getByTestId('spending-split-bar')
    const counts = screen.getByTestId('spending-counts')

    expect(follows(label, total)).toBe(true)
    expect(follows(total, bar)).toBe(true)
    expect(follows(bar, counts)).toBe(true)
    // Left-aligned below the label: no justify-between row pushing it right.
    expect(total.closest('.justify-between')).toBeNull()
  })

  it('puts Payments, Merchants and Stopped by budget below a hairline divider', () => {
    render(<MoneyPanel {...baseProps} overview={twoAgents()} />)

    const counts = screen.getByTestId('spending-counts')
    expect(counts).toHaveClass('border-t', 'border-[var(--v2-border)]')
    // #3902 design review: the gap above the rule is padding on the pinned
    // wrapper, so it survives `lg:mt-auto` resolving to 0 — never a margin on
    // the ruled element itself.
    expect(counts.parentElement).toHaveClass('pt-5', 'lg:mt-auto')
    expect(counts.className).not.toMatch(/(^|\s)(lg:)?mt-/)
    for (const name of ['Payments', 'Merchants', 'Stopped by budget']) {
      expect(within(counts).getByText(name)).toBeInTheDocument()
    }
  })

  it('shows the muted "Agent spending" label before the first payment', () => {
    render(<MoneyPanel {...baseProps} noPaymentsYet overview={overview({ d30NetUsd: 0, agents: [] })} />)

    const heading = screen.getByRole('heading', { name: 'Agent spending' })
    expect(heading.textContent).toBe('Agent spending')
    expect(heading).toHaveClass('text-[var(--v2-ink-2)]')
    expect(screen.getByText(/After your agents/)).toBeInTheDocument()
    expect(screen.queryByTestId('spending-counts')).not.toBeInTheDocument()
  })
})

describe('MoneyPanel — the balance figures say what they measure (#3977)', () => {
  it('the sparkline aria-label names the UTC days the series is dated by', () => {
    // The snapshot rows are UTC-dated (builder's choice (b) on #3977), so the
    // label must not read like the Activity card's local-day windows beside
    // it. The empty-state variant carries the same qualifier — the flat
    // placeholder renders with < 3 measured days, and this fixture has none.
    render(
      <MoneyPanel
        {...baseProps}
        currency="USD"
        totalFiat={0}
        overview={overview({ d30NetUsd: 0, agents: [] })}
      />,
    )
    expect(screen.getByRole('img', { name: 'Balance over the last 30 UTC days. No snapshots yet.' })).toBeInTheDocument()
  })
})

describe('MoneyPanel — exactly one primary "Receive" (#3902, #4094)', () => {
  const receive = () => screen.getByRole('button', { name: 'Receive' })

  it('renders "Receive" primary by default', () => {
    render(<MoneyPanel {...baseProps} overview={null} />)

    expect(receive()).toHaveClass('bg-[var(--v2-brand)]')
    expect(receive()).not.toHaveClass('border-[var(--v2-border-strong)]')
  })

  it('renders "Receive" primary when receiveSecondary is false', () => {
    render(<MoneyPanel {...baseProps} receiveSecondary={false} overview={null} />)

    expect(receive()).toHaveClass('bg-[var(--v2-brand)]')
  })

  it('steps "Receive" down to ghost when receiveSecondary is true', () => {
    render(<MoneyPanel {...baseProps} receiveSecondary overview={null} />)

    expect(receive()).toHaveClass('border-[var(--v2-border-strong)]')
    expect(receive()).not.toHaveClass('bg-[var(--v2-brand)]')
  })

  it('keeps "Send" ghost either way', () => {
    const { rerender } = render(<MoneyPanel {...baseProps} overview={null} />)
    const send = () => screen.getByRole('button', { name: 'Send' })
    expect(send()).toHaveClass('border-[var(--v2-border-strong)]')
    rerender(<MoneyPanel {...baseProps} receiveSecondary overview={null} />)
    expect(send()).toHaveClass('border-[var(--v2-border-strong)]')
  })
})
