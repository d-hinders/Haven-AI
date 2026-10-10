import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { DashboardAgentPreview } from '@/types/dashboard'
import type { AttentionRuleItem, DashboardBudgetRemaining, DashboardOverview } from '@/lib/dashboard-attention'
import { AgentsSection, type AgentsSectionProps } from '../AgentsSection'

/**
 * #3809's fixture matrix: two budgets (closest to running out + "+1
 * budget"), a paused agent (meter kept, pause copy from the shared module),
 * a pending agent, a received-sub-budget-only agent, nine agents (six rows +
 * "View all 9 agents"), a two-account and a one-account user, zero agents,
 * the stable two-group order, and the unknown-read em dash.
 */

// A fixed clock: the captions' words (refills, expiry) render against THIS
// instant, never the machine's (#3806 rule 1 — the clock is a parameter).
const NOW = Date.parse('2026-10-10T12:00:00.000Z')

const ZERO_WINDOW = {
  gross: { usd: 0, eur: 0, sek: 0 },
  net: { usd: 0, eur: 0, sek: 0 },
  approx: false,
  payments: 0,
  refusals: { budget: 0, scope: 0, failed: 0, haven: 0 },
}

const AGENT_IDS = {
  research: '11111111-1111-4111-8111-111111111111',
  watcher: '22222222-2222-4222-8222-222222222222',
  pending: '33333333-3333-4333-8333-333333333333',
  subOnly: '44444444-4444-4444-8444-444444444444',
}

const TOKEN = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

function makeStats(d30NetUsd = 0): DashboardAgentPreview['stats'] {
  return {
    d7: ZERO_WINDOW,
    d30: {
      ...ZERO_WINDOW,
      net: { usd: d30NetUsd, eur: 0, sek: 0 },
    },
    lastPaymentAt: null,
    lastCounterparty: null,
  }
}

function makeBudget(overrides: Partial<DashboardAgentPreview['budgets'][number]> = {}): DashboardAgentPreview['budgets'][number] {
  return {
    id: 'budget-1',
    delegationHash: `0x${'11'.repeat(32)}`,
    chainId: 8453,
    tokenAddress: TOKEN,
    tokenSymbol: 'USDC',
    decimals: 6,
    budgetAtomic: '250000000',
    periodSeconds: 86_400,
    startDate: '2026-10-01T00:00:00.000Z',
    expiresAt: '2027-01-01T00:00:00.000Z',
    periodEnd: '2026-10-11T00:00:00.000Z',
    ...overrides,
  }
}

function makeAgent(overrides: Partial<DashboardAgentPreview> = {}): DashboardAgentPreview {
  return {
    id: AGENT_IDS.research,
    name: 'Research agent',
    status: 'active',
    accountId: 'acct-1',
    accountName: 'Main account',
    accountChainId: 8453,
    allowances: [],
    budgets: [],
    receivedSubBudgets: [],
    stats: makeStats(),
    ...overrides,
  }
}

function makeRead(overrides: Partial<DashboardBudgetRemaining['budgets'][number]> = {}): DashboardBudgetRemaining['budgets'][number] {
  return {
    agent_id: AGENT_IDS.research,
    chain_id: 8453,
    delegation_hash: `0x${'11'.repeat(32)}`,
    token_address: TOKEN,
    token_symbol: 'USDC',
    token_decimals: 6,
    budget_atomic: '250000000',
    read_at: '2026-10-10T11:00:00.000Z',
    period_end: '2026-10-11T00:00:00.000Z',
    remaining_atomic: '125000000',
    remaining_from_chain: true,
    used_atomic: '125000000',
    sub_budget_spend: [],
    ...overrides,
  }
}

function makeOverview(overrides: {
  agents?: DashboardAgentPreview[]
  accounts?: DashboardOverview['accounts']
  agentCount?: DashboardOverview['agentCount']
  spotRates?: DashboardOverview['spotRates']
} = {}): DashboardOverview {
  return {
    accounts:
      overrides.accounts ??
      ([
        {
          accountId: 'acct-1',
          chainId: 8453,
          isTestnet: false,
          usdcBalanceAtomic: '1250000000',
          usdcDecimals: 6,
          funded: true,
          needs_backup_recommendation: false,
          usdcPace7dAtomic: '0',
        },
      ] as DashboardOverview['accounts']),
    agents: overrides.agents ?? [],
    agentCount: overrides.agentCount ?? { active: 1, paused: 0, pending_approval: 0 },
    spotRates: overrides.spotRates ?? { USDC: 1 },
  } as unknown as DashboardOverview
}

function baseProps(overrides: Partial<AgentsSectionProps> = {}): AgentsSectionProps {
  return {
    overview: makeOverview(),
    budgetRemaining: null,
    attentionItems: [],
    currency: 'USD',
    accountNames: { 'acct-1': 'Main account', 'acct-2': 'Showcase account' },
    hasAnyAgents: true,
    loading: false,
    unavailable: false,
    onRetry: vi.fn(),
    onConnectAgent: vi.fn(),
    nowMs: NOW,
    ...overrides,
  }
}

/** The dashboard rows, in DOM order — only agent links match this href shape. */
function rowNames(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLAnchorElement>('a[href^="/agents/"]')).map(
    (row) => row.querySelector('span.truncate')?.textContent ?? '',
  )
}

describe('AgentsSection (#3809)', () => {
  it('shows the budget closest to running out of two, plus "+1 budget"', () => {
    const agent = makeAgent({
      budgets: [
        makeBudget({ delegationHash: `0x${'11'.repeat(32)}`, budgetAtomic: '250000000', periodSeconds: 86_400 }),
        makeBudget({
          id: 'budget-2',
          delegationHash: `0x${'22'.repeat(32)}`,
          budgetAtomic: '1000000',
          periodSeconds: 604_800,
          startDate: '2026-10-05T00:00:00.000Z',
          periodEnd: '2026-10-12T00:00:00.000Z',
        }),
      ],
    })
    const budgetRemaining = {
      budgets: [
        makeRead({ used_atomic: '125000000' }), // 50% — the daily budget
        makeRead({
          delegation_hash: `0x${'22'.repeat(32)}`,
          budget_atomic: '1000000',
          used_atomic: '950000', // 95% — closest to running out
        }),
      ],
    }

    const { container } = render(<AgentsSection {...baseProps({ overview: makeOverview({ agents: [agent] }), budgetRemaining })} />)

    const meter = screen.getByRole('progressbar')
    expect(meter).toHaveAttribute('aria-valuenow', '95')
    expect(screen.getByText('+1 budget')).toBeInTheDocument()
    // The caption is #3806's, in the user's currency with the #3803 spot rate.
    expect(within(container).getByText(/≈\$0\.95 of \$1\.00 used this period/)).toBeInTheDocument()
  })

  it("keeps the paused agent's live meter and uses the shared pause wording", () => {
    const agent = makeAgent({
      id: AGENT_IDS.watcher,
      name: 'Watcher agent',
      status: 'paused',
      budgets: [makeBudget()],
    })
    const budgetRemaining = {
      budgets: [makeRead({ agent_id: AGENT_IDS.watcher, used_atomic: '100000000' })], // 40%
    }

    render(<AgentsSection {...baseProps({ overview: makeOverview({ agents: [agent] }), budgetRemaining })} />)

    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40')
    // agent-pause-copy.ts's short form — the module the agent page banner
    // reads, so the dashboard cannot drift from it.
    expect(screen.getByText('Payments paused in Haven — its budget is still live on-chain.')).toBeInTheDocument()
    expect(screen.getByText('Paused')).toBeInTheDocument()
  })

  it('badges a pending agent "Needs setup" and reads "No budget"', () => {
    const agent = makeAgent({ id: AGENT_IDS.pending, name: 'Connecting agent', status: 'pending_approval' })
    const attentionItems: AttentionRuleItem[] = [
      {
        id: `needs-setup:${AGENT_IDS.pending}`,
        kind: 'needs-setup',
        tone: 'brand',
        badge: 'Needs setup',
        title: 'Connecting agent is waiting to be set up',
        agentId: AGENT_IDS.pending,
      },
    ]

    render(<AgentsSection {...baseProps({ overview: makeOverview({ agents: [agent] }), attentionItems })} />)

    expect(screen.getByText('Needs setup')).toBeInTheDocument()
    expect(screen.getByText('No budget')).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it(`reads "Spends from <parent>'s budget" for an agent whose only authority is an open received sub-budget`, () => {
    const agent = makeAgent({
      id: AGENT_IDS.subOnly,
      name: 'Helper agent',
      receivedSubBudgets: [{ parentAgentId: AGENT_IDS.research, parentAgentName: 'Research agent', open: true }],
    })

    render(<AgentsSection {...baseProps({ overview: makeOverview({ agents: [agent] }) })} />)

    expect(screen.getByText("Spends from Research agent's budget")).toBeInTheDocument()
    expect(screen.queryByText('No budget')).not.toBeInTheDocument()
  })

  it('renders an unknown remaining as an em dash, with no 0% bar', () => {
    const agent = makeAgent({ budgets: [makeBudget()] })
    // No matching read at all — unknown, never 0.
    const budgetRemaining = { budgets: [makeRead({ agent_id: 'someone-else' })] }

    render(<AgentsSection {...baseProps({ overview: makeOverview({ agents: [agent] }), budgetRemaining })} />)

    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('caps at six rows with a "View all 9 agents" link from agentCount', () => {
    const agents = Array.from({ length: 9 }, (_, i) =>
      makeAgent({ id: `agent-${i}`, name: `Agent ${i}` }),
    )

    const { container } = render(
      <AgentsSection
        {...baseProps({
          overview: makeOverview({
            agents,
            agentCount: { active: 9, paused: 0, pending_approval: 0 },
          }),
        })}
      />,
    )

    expect(rowNames(container)).toHaveLength(6)
    expect(screen.getByRole('link', { name: 'View all 9 agents' })).toHaveAttribute('href', '/agents')
  })

  it('shows the account name only when the user has more than one account', () => {
    const agent = makeAgent()

    const two = render(
      <AgentsSection
        {...baseProps({
          overview: makeOverview({
            agents: [agent],
            accounts: [
              {
                accountId: 'acct-1',
                chainId: 8453,
                isTestnet: false,
                usdcBalanceAtomic: '1',
                usdcDecimals: 6,
                funded: true,
                needs_backup_recommendation: false,
                usdcPace7dAtomic: '0',
              },
              {
                accountId: 'acct-2',
                chainId: 8453,
                isTestnet: false,
                usdcBalanceAtomic: '1',
                usdcDecimals: 6,
                funded: true,
                needs_backup_recommendation: false,
                usdcPace7dAtomic: '0',
              },
            ] as DashboardOverview['accounts'],
          }),
        })}
      />,
    )
    expect(screen.getByText('From Main account')).toBeInTheDocument()
    two.unmount()

    render(<AgentsSection {...baseProps({ overview: makeOverview({ agents: [agent] }) })} />)
    expect(screen.queryByText('From Main account')).not.toBeInTheDocument()
  })

  it('keeps the zero-agents empty state with Connect agent', () => {
    render(
      <AgentsSection
        {...baseProps({ overview: makeOverview({ agents: [] }), hasAnyAgents: false })}
      />,
    )

    expect(screen.getByText('No agents connected yet')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect agent' })).toBeInTheDocument()
  })

  it("names the last payment's counterparty, never a raw address", () => {
    const agent = makeAgent({
      stats: {
        ...makeStats(),
        lastPaymentAt: '2026-10-09T09:41:00.000Z',
        lastCounterparty: {
          source: 'x402',
          x402ResourceUrl: 'https://research.example/report',
          to: '0x9999999999999999999999999999999999999999',
          merchantName: null,
        },
      },
    })

    render(<AgentsSection {...baseProps({ overview: makeOverview({ agents: [agent] }) })} />)

    expect(screen.getByText(/Last payment .* to research\.example/)).toBeInTheDocument()
    expect(screen.queryByText(/0x9999/)).not.toBeInTheDocument()
  })

  it('keeps rows still within a group when spend changes, and moves an agent that crosses into attention', () => {
    // C outspends B outspends A on the first load.
    const agents = [
      makeAgent({ id: 'a', name: 'Agent A', stats: makeStats(10) }),
      makeAgent({ id: 'b', name: 'Agent B', stats: makeStats(20) }),
      makeAgent({ id: 'c', name: 'Agent C', stats: makeStats(30) }),
    ]
    const first = render(
      <AgentsSection
        {...baseProps({ overview: makeOverview({ agents }) })}
      />,
    )
    expect(rowNames(first.container)).toEqual(['Agent C', 'Agent B', 'Agent A'])

    // A refresh where every agent's 30-day spend changed WITHIN its group:
    // the rows must not move — the order was fixed at the first data load.
    const respend = [
      makeAgent({ id: 'a', name: 'Agent A', stats: makeStats(500) }),
      makeAgent({ id: 'b', name: 'Agent B', stats: makeStats(1) }),
      makeAgent({ id: 'c', name: 'Agent C', stats: makeStats(300) }),
    ]
    first.rerender(
      <AgentsSection
        {...baseProps({ overview: makeOverview({ agents: respend }) })}
      />,
    )
    expect(rowNames(first.container)).toEqual(['Agent C', 'Agent B', 'Agent A'])

    // Agent B crosses into attention (a KNOWN 95% read): it moves — attention
    // first — while A and C keep their relative order.
    const crossed = respend.map((agent) =>
      agent.id === 'b' ? { ...agent, budgets: [makeBudget()] } : agent,
    )
    const budgetRemaining = {
      budgets: [makeRead({ agent_id: 'b', used_atomic: '240000000' })], // 96%
    }
    first.rerender(
      <AgentsSection
        {...baseProps({ overview: makeOverview({ agents: crossed }), budgetRemaining })}
      />,
    )
    expect(rowNames(first.container)).toEqual(['Agent B', 'Agent C', 'Agent A'])
    first.unmount()
  })
})
