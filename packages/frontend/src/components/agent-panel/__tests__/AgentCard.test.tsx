/**
 * #4209: the `/agents` card rebuilt on the dashboard's budget pieces.
 *
 * Pins, per mockup state (version 4), what the card says and which controls
 * it offers: the one badge (the dashboard's `agentBadge` plus Archived and
 * Revoked), the dashboard row's own `AgentBudget`, the footer's three arms
 * (never a raw address), the ONE call to action, and the ⋯ menu that holds
 * every other action. RemoveAgentDialog.test.tsx proves the dialog itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { Agent } from '@/hooks/useAgents'
import { AGENT_PAUSED_BODY, AGENT_PAUSED_TITLE } from '@/lib/agent-pause-copy'
import { STRANDED_FUNDS_TITLE, strandedFundsCause } from '@/lib/stranded-funds-copy'
import { DELEGATION_BUDGET_CARD_ID } from '@/components/DelegationBudgetCard'
import { AgentRow, type DashboardAgent } from '@/components/haven/AgentRow'
import {
  computeAttentionItems,
  type DashboardBudgetRemaining,
  type DashboardOverview,
} from '@/lib/dashboard-attention'
import type { AgentCardDashboard } from '../AgentCard'

/** Escape a copy string for use inside a text-matching RegExp. */
function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

vi.mock('../RemoveAgentDialog', () => ({
  RemoveAgentDialog: ({ mode }: { mode?: string }) => (
    <div data-testid="remove-agent-dialog" data-mode={mode ?? 'remove'} />
  ),
}))

vi.mock('../../MoveAgentModal', () => ({
  default: () => <div data-testid="move-agent-modal" />,
}))

const { AgentCard, agentCardBadge } = await import('../AgentCard')

const NOW = Date.parse('2026-10-10T12:00:00.000Z')
const TOKEN = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const ARCHIVED = '2026-06-01T00:00:00Z'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
})

function agentFixture(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'Research agent',
    description: null,
    delegate_address: '0x' + '22'.repeat(20),
    account_id: 'safe-1',
    account_address: '0x' + '11'.repeat(20),
    account_name: 'Main account',
    account_chain_id: 84532,
    status: 'active',
    account_type: 'delegator_hybrid',
    created_at: '2026-05-01T00:00:00Z',
    allowances: [],
    labels: [],
    organization_id: null,
    ...overrides,
  } as Agent
}

const ZERO_WINDOW = {
  gross: { usd: 0, eur: 0, sek: 0 },
  net: { usd: 0, eur: 0, sek: 0 },
  approx: false,
  payments: 0,
  refusals: { budget: 0, scope: 0, failed: 0, haven: 0 },
}

function makeBudget(
  overrides: Partial<DashboardAgent['budgets'][number]> = {},
): DashboardAgent['budgets'][number] {
  return {
    id: 'budget-1',
    delegationHash: `0x${'11'.repeat(32)}`,
    chainId: 84532,
    tokenAddress: TOKEN,
    tokenSymbol: 'USDC',
    decimals: 6,
    budgetAtomic: '3000000',
    periodSeconds: 86_400,
    startDate: '2026-10-01T00:00:00.000Z',
    expiresAt: '2027-01-01T00:00:00.000Z',
    periodEnd: '2026-10-11T00:00:00.000Z',
    ...overrides,
  }
}

function overviewAgent(overrides: Partial<DashboardAgent> = {}): DashboardAgent {
  return {
    id: 'agent-1',
    name: 'Research agent',
    status: 'active',
    accountId: 'safe-1',
    accountName: 'Main account',
    accountChainId: 84532,
    allowances: [],
    budgets: [makeBudget()],
    receivedSubBudgets: [],
    stats: { d7: ZERO_WINDOW, d30: ZERO_WINDOW, lastPaymentAt: null, lastCounterparty: null },
    ...overrides,
  } as DashboardAgent
}

function makeRead(
  overrides: Partial<DashboardBudgetRemaining['budgets'][number]> = {},
): DashboardBudgetRemaining['budgets'][number] {
  return {
    agent_id: 'agent-1',
    chain_id: 84532,
    delegation_hash: `0x${'11'.repeat(32)}`,
    token_address: TOKEN,
    token_symbol: 'USDC',
    token_decimals: 6,
    budget_atomic: '3000000',
    read_at: '2026-10-10T11:00:00.000Z',
    period_end: '2026-10-11T00:00:00.000Z',
    remaining_atomic: '1800000',
    remaining_from_chain: true,
    used_atomic: '1200000',
    sub_budget_spend: [],
    ...overrides,
  }
}

/** The card's dashboard slice, computed the way `AgentPanel` computes it. */
function dashboardFor(
  agent: DashboardAgent | null,
  reads: DashboardBudgetRemaining['budgets'] = agent ? [makeRead({ agent_id: agent.id })] : [],
  { ready = true }: { ready?: boolean } = {},
): AgentCardDashboard {
  const budgetRemaining = { budgets: reads } as DashboardBudgetRemaining
  const overview = { agents: agent ? [agent] : [], accounts: [] } as unknown as DashboardOverview
  return {
    ready,
    agent,
    budgetRemaining,
    attentionItems: computeAttentionItems({
      overview,
      budgetRemaining,
      accountNames: {},
      dismissedIds: new Set(),
    }),
    nowMs: NOW,
  }
}

function renderCard(
  agent: Agent,
  {
    dashboard = dashboardFor(overviewAgent({ id: agent.id, name: agent.name, status: agent.status as DashboardAgent['status'] })),
    busyAction = null,
    organizations = [],
    showAccountName = false,
  }: {
    dashboard?: AgentCardDashboard
    busyAction?: import('@/hooks/useAgentPanelState').AgentBusyAction
    organizations?: import('@/hooks/useOrganizations').Organization[]
    showAccountName?: boolean
  } = {},
) {
  const onRestore = vi.fn()
  const onPause = vi.fn()
  const onResume = vi.fn()
  const utils = render(
    <AgentCard
      agent={agent}
      dashboard={dashboard}
      showAccountName={showAccountName}
      onPause={onPause}
      onResume={onResume}
      onRevokeCredential={vi.fn().mockResolvedValue(undefined)}
      onArchive={vi.fn().mockResolvedValue(undefined)}
      onRestore={onRestore}
      onMoveToOrganization={vi.fn()}
      busyAction={busyAction}
      organizations={organizations}
    />,
  )
  return { onRestore, onPause, onResume, ...utils }
}

function openMenu(name = 'Research agent') {
  fireEvent.click(screen.getByRole('button', { name: `Actions for ${name}` }))
  return screen.getByRole('menu')
}

function menuItemNames(name = 'Research agent'): string[] {
  const menu = openMenu(name)
  return within(menu).getAllByRole('menuitem').map((item) => item.textContent ?? '')
}

const ORG = { id: 'org-1', name: 'Ops', parent_id: null } as unknown as import('@/hooks/useOrganizations').Organization

describe('AgentCard head', () => {
  it('links the whole card to the agent page through the name, with nothing interactive inside the link', () => {
    renderCard(agentFixture())
    const link = screen.getByRole('link', { name: 'Research agent' })
    expect(link.getAttribute('href')).toBe('/agents/agent-1')
    expect(link.querySelector('a, button')).toBeNull()
  })

  it('draws the agent monogram, hidden from assistive tech, and no robot tile', () => {
    renderCard(agentFixture())
    const card = screen.getByTestId('agent-card')
    const mark = card.querySelector('[aria-hidden="true"]')
    expect(mark?.textContent).toBe('RA')
    expect(card.querySelector('.lucide-bot')).toBeNull()
  })

  it('names the account only when the user has two or more', () => {
    const { unmount } = renderCard(agentFixture())
    expect(screen.queryByText('Main account')).toBeNull()
    unmount()
    renderCard(agentFixture(), { showAccountName: true })
    expect(screen.getByText('Main account')).toBeTruthy()
  })

  it('no longer prints the network, the MCP name, the description or "Last activity"', () => {
    renderCard(
      agentFixture({ description: 'Finds papers', mcp_server_name: 'haven-research', mcp_last_seen_at: '2026-10-10T10:00:00.000Z' }),
      { showAccountName: true },
    )
    const text = screen.getByTestId('agent-card').textContent ?? ''
    expect(text).not.toMatch(/Base Sepolia/)
    expect(text).not.toMatch(/haven-research|MCP/)
    expect(text).not.toMatch(/Finds papers/)
    expect(text).not.toMatch(/Last activity/)
  })
})

/** #3197: the labels wrapper renders only when labels exist. */
describe('AgentCard label chips (#3167, #3197)', () => {
  it('renders no labels wrapper for an unlabelled agent', () => {
    const { container } = renderCard(agentFixture())
    expect(container.querySelector('[data-testid="agent-card-labels"]')).toBeNull()
  })

  it('shows up to three labels, then "+N"', () => {
    const labels = ['travel', 'ops', 'q4', 'eu'].map((name, i) => ({ id: `l${i}`, name, color: 'blue' }))
    renderCard(agentFixture({ labels } as Partial<Agent>))
    const card = screen.getByTestId('agent-card')
    expect(screen.getByTestId('agent-card-labels')).toBeTruthy()
    expect(within(card).getByText('travel')).toBeTruthy()
    expect(within(card).queryByText('eu')).toBeNull()
    expect(within(card).getByText('+1')).toBeTruthy()
  })
})

describe('AgentCard badge: the dashboard agentBadge plus Archived and Revoked', () => {
  const chip = () => screen.queryByTestId('agent-status-chip')?.textContent ?? null

  it('active with room left: no badge', () => {
    renderCard(agentFixture())
    expect(chip()).toBeNull()
  })

  it('≥ 90% used: "N% used"', () => {
    const agent = overviewAgent()
    renderCard(agentFixture(), {
      dashboard: dashboardFor(agent, [makeRead({ used_atomic: '2850000', remaining_atomic: '150000' })]),
    })
    expect(chip()).toBe('95% used')
  })

  it('pending_approval: "Needs setup"', () => {
    const agent = overviewAgent({ status: 'pending_approval', budgets: [] })
    renderCard(agentFixture({ status: 'pending_approval' }), { dashboard: dashboardFor(agent, []) })
    expect(chip()).toBe('Needs setup')
  })

  it('active with no usable budget: "Needs setup"', () => {
    const agent = overviewAgent({ budgets: [] })
    renderCard(agentFixture(), { dashboard: dashboardFor(agent, []) })
    expect(chip()).toBe('Needs setup')
  })

  it('paused: "Paused"', () => {
    const agent = overviewAgent({ status: 'paused' })
    renderCard(agentFixture({ status: 'paused' }), { dashboard: dashboardFor(agent) })
    expect(chip()).toBe('Paused')
  })

  it('revoked: "Revoked", without an overview entry', () => {
    renderCard(agentFixture({ status: 'revoked' }), { dashboard: dashboardFor(null) })
    expect(chip()).toBe('Revoked')
  })

  it('archived: "Archived" — archive outranks the lifecycle status', () => {
    renderCard(agentFixture({ status: 'revoked', archived_at: ARCHIVED }), { dashboard: dashboardFor(null) })
    expect(chip()).toBe('Archived')
    expect(agentCardBadge({ status: 'active', archived_at: ARCHIVED }, dashboardFor(overviewAgent({ budgets: [] }), []))?.label).toBe('Archived')
  })

  it('shows no badge while the dashboard reads are in flight', () => {
    const agent = overviewAgent({ budgets: [] })
    renderCard(agentFixture(), { dashboard: dashboardFor(agent, [], { ready: false }) })
    expect(chip()).toBeNull()
  })

  /**
   * The point of reading `agentBadge`: one agent, one badge, on the
   * dashboard row and on this card.
   */
  it('gives each agent the same badge the dashboard row gives it', () => {
    const cases: Array<{ agent: DashboardAgent; reads: DashboardBudgetRemaining['budgets'] }> = [
      { agent: overviewAgent(), reads: [makeRead()] },
      { agent: overviewAgent(), reads: [makeRead({ used_atomic: '3000000', remaining_atomic: '0' })] },
      { agent: overviewAgent({ budgets: [] }), reads: [] },
      { agent: overviewAgent({ status: 'pending_approval', budgets: [] }), reads: [] },
      { agent: overviewAgent({ status: 'paused' }), reads: [makeRead()] },
    ]
    for (const { agent, reads } of cases) {
      const dashboard = dashboardFor(agent, reads)
      const row = render(
        <AgentRow
          agent={agent}
          budgetRemaining={dashboard.budgetRemaining}
          attentionItems={dashboard.attentionItems}
          accountNames={{}}
          accountCount={1}
          nowMs={NOW}
        />,
      )
      const rowBadge = row.container.querySelector('p > span.rounded-full, p > span[class*="rounded-full"]')?.textContent ?? null
      row.unmount()
      const card = renderCard(agentFixture({ status: agent.status as Agent['status'] }), { dashboard })
      expect(chip(), `status ${agent.status}`).toBe(rowBadge)
      card.unmount()
    }
  })
})

describe('AgentCard budget body: the dashboard row’s own AgentBudget', () => {
  it('reads exactly what the dashboard row reads for the same agent', () => {
    const agent = overviewAgent()
    const dashboard = dashboardFor(agent)
    const row = render(
      <AgentRow
        agent={agent}
        budgetRemaining={dashboard.budgetRemaining}
        attentionItems={dashboard.attentionItems}
        accountNames={{}}
        accountCount={1}
        nowMs={NOW}
      />,
    )
    const rowMeter = row.getByRole('progressbar')
    const rowLabel = rowMeter.getAttribute('aria-label')
    const rowCaption = rowMeter.parentElement?.parentElement?.textContent ?? ''
    row.unmount()

    renderCard(agentFixture(), { dashboard })
    const budget = screen.getByTestId('agent-card-budget')
    const meter = within(budget).getByRole('progressbar')
    expect(meter.getAttribute('aria-label')).toBe(rowLabel)
    expect(rowCaption).toContain(budget.textContent ?? '∅')
    expect(budget.textContent).toMatch(/1\.20\sof\s3\.00\sUSDC/)
  })

  it('several budgets: "+N budgets", as the dashboard says it', () => {
    const agent = overviewAgent({
      budgets: [makeBudget(), makeBudget({ id: 'budget-2', delegationHash: `0x${'22'.repeat(32)}` })],
    })
    renderCard(agentFixture(), {
      dashboard: dashboardFor(agent, [
        makeRead(),
        makeRead({ delegation_hash: `0x${'22'.repeat(32)}`, used_atomic: '0', remaining_atomic: '3000000' }),
      ]),
    })
    expect(screen.getByTestId('agent-card-budget').textContent).toMatch(/\+1 budget/)
  })

  it('received sub-budget: says which agent it came from, never "No budget"', () => {
    const agent = overviewAgent({
      budgets: [],
      receivedSubBudgets: [{ parentAgentId: 'agent-9', parentAgentName: 'Research bot', open: true }],
    } as Partial<DashboardAgent>)
    renderCard(agentFixture(), { dashboard: dashboardFor(agent, []) })
    expect(screen.getByTestId('agent-card-budget').textContent).toBe("Spends from Research bot's budget")
    expect(screen.queryByRole('link', { name: 'Set budget' })).toBeNull()
  })

  it('no budget: "No budget" and the card’s one CTA, Set budget', () => {
    renderCard(agentFixture(), { dashboard: dashboardFor(overviewAgent({ budgets: [] }), []) })
    expect(screen.getByTestId('agent-card-budget').textContent).toBe('No budget')
    const cta = within(screen.getByTestId('agent-card-cta')).getByRole('link', { name: 'Set budget' })
    expect(cta.getAttribute('href')).toBe(`/agents/agent-1#${DELEGATION_BUDGET_CARD_ID}`)
  })

  it('while the reads load: a skeleton, never "No budget"', () => {
    renderCard(agentFixture(), { dashboard: dashboardFor(overviewAgent({ budgets: [] }), [], { ready: false }) })
    expect(screen.getByTestId('agent-card-budget-loading')).toBeTruthy()
    expect(screen.queryByText('No budget')).toBeNull()
    expect(screen.queryByRole('link', { name: 'Set budget' })).toBeNull()
  })

  it('a failed overview: an em dash, never a meter and never "No budget"', () => {
    renderCard(agentFixture(), { dashboard: dashboardFor(null) })
    expect(screen.getByTestId('agent-card-budget').textContent).toBe('—')
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  it('revoked and archived cards draw no meter, and say why', () => {
    const { unmount } = renderCard(agentFixture({ status: 'revoked' }), { dashboard: dashboardFor(null) })
    expect(screen.queryByTestId('agent-card-budget')).toBeNull()
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.getByText('Network access already revoked')).toBeTruthy()
    unmount()

    // An archived agent can still be in the overview (it filters on status
    // only) — the card still draws no meter for it.
    renderCard(agentFixture({ archived_at: ARCHIVED }), { dashboard: dashboardFor(overviewAgent()) })
    expect(screen.queryByTestId('agent-card-budget')).toBeNull()
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.getByText(/restoring never re-enables spending/i)).toBeTruthy()
  })
})

describe('AgentCard footer: one line, never a raw address', () => {
  const footer = () => screen.getByTestId('agent-card-footer').textContent

  function paid(counterparty: NonNullable<DashboardAgent['stats']>['lastCounterparty']) {
    return overviewAgent({
      stats: {
        d7: ZERO_WINDOW,
        d30: ZERO_WINDOW,
        lastPaymentAt: '2026-10-09T16:00:00.000Z',
        lastCounterparty: counterparty,
      },
    })
  }

  it('merchantName: "Last paid 20h ago · <name>"', () => {
    renderCard(agentFixture(), {
      dashboard: dashboardFor(paid({ source: 'x402', merchantName: 'Bitrefill', x402ResourceUrl: 'https://api.bitrefill.com/x', to: '0x' + '33'.repeat(20) })),
    })
    expect(footer()).toBe('Last paid 20h ago · Bitrefill')
  })

  it('no name: the host of the x402 resource', () => {
    renderCard(agentFixture(), {
      dashboard: dashboardFor(paid({ source: 'x402', merchantName: null, x402ResourceUrl: 'https://api.bitrefill.com/v1/buy', to: '0x' + '33'.repeat(20) })),
    })
    expect(footer()).toBe('Last paid 20h ago · api.bitrefill.com')
  })

  it('to-only: no merchant at all — the address never prints', () => {
    const to = '0x' + '33'.repeat(20)
    renderCard(agentFixture(), {
      dashboard: dashboardFor(paid({ source: 'direct', merchantName: null, x402ResourceUrl: null, to })),
    })
    expect(footer()).toBe('Last paid 20h ago')
    expect(screen.getByTestId('agent-card').textContent).not.toMatch(/0x[0-9a-f]{4}/i)
  })

  it('never paid but connected: "Connected <time ago>"', () => {
    renderCard(agentFixture({ mcp_last_seen_at: '2026-10-10T10:00:00.000Z' }))
    expect(footer()).toBe('Connected 2h ago')
  })

  it('otherwise: "No payments yet", the dashboard’s words', () => {
    renderCard(agentFixture())
    expect(footer()).toBe('No payments yet')
  })

  it('an agent the overview does not cover never claims "No payments yet"', () => {
    renderCard(agentFixture({ status: 'revoked' }), { dashboard: dashboardFor(null) })
    expect(footer()).toBe('')
  })

  it('pins the footer to the bottom of a column card', () => {
    renderCard(agentFixture())
    expect(screen.getByTestId('agent-card').className).toMatch(/\bflex-col\b/)
    expect(screen.getByTestId('agent-card-footer').className).toMatch(/\bmt-auto\b/)
  })
})

describe('AgentCard ⋯ menu: every action that is not the CTA', () => {
  it('active: Pause payments and Remove; Move only when an organization exists (#3222)', () => {
    const { unmount } = renderCard(agentFixture())
    expect(menuItemNames()).toEqual(['Pause payments', 'Remove'])
    unmount()
    renderCard(agentFixture(), { organizations: [ORG] })
    expect(menuItemNames()).toEqual(['Pause payments', 'Move to organization', 'Remove'])
  })

  it('paused: Resume payments, not Pause', () => {
    renderCard(agentFixture({ status: 'paused' }))
    expect(menuItemNames()).toEqual(['Resume payments', 'Remove'])
  })

  it('pending_approval: Remove in the menu; Finish setup is the CTA, to the budget card', () => {
    renderCard(agentFixture({ status: 'pending_approval' }), {
      dashboard: dashboardFor(overviewAgent({ status: 'pending_approval', budgets: [] }), []),
    })
    const cta = within(screen.getByTestId('agent-card-cta')).getByRole('link', { name: 'Finish setup' })
    expect(cta.getAttribute('href')).toBe(`/agents/agent-1#${DELEGATION_BUDGET_CARD_ID}`)
    expect(menuItemNames()).toEqual(['Remove'])
  })

  it('revoked: Remove from list only', () => {
    renderCard(agentFixture({ status: 'revoked' }), { dashboard: dashboardFor(null) })
    expect(menuItemNames()).toEqual(['Remove from list'])
  })

  it('archived: Restore to list only — even for an active agent', () => {
    renderCard(agentFixture({ archived_at: ARCHIVED }))
    expect(menuItemNames()).toEqual(['Restore to list'])
  })

  /** #3717: one click, no confirm dialog. */
  it('Pause payments pauses directly', () => {
    const { onPause } = renderCard(agentFixture())
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'Pause payments' }))
    expect(onPause).toHaveBeenCalledWith(expect.objectContaining({ id: 'agent-1' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Resume payments resumes', () => {
    const { onResume } = renderCard(agentFixture({ status: 'paused' }))
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'Resume payments' }))
    expect(onResume).toHaveBeenCalledTimes(1)
  })

  it('Remove opens RemoveAgentDialog; it is not mounted before that', () => {
    renderCard(agentFixture())
    expect(screen.queryByTestId('remove-agent-dialog')).toBeNull()
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'Remove' }))
    expect(screen.getByTestId('remove-agent-dialog').getAttribute('data-mode')).toBe('remove')
  })

  it('Remove from list opens the same dialog for a revoked agent', () => {
    renderCard(agentFixture({ status: 'revoked' }), { dashboard: dashboardFor(null) })
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'Remove from list' }))
    expect(screen.getByTestId('remove-agent-dialog').getAttribute('data-mode')).toBe('remove')
  })

  it('Move to organization opens MoveAgentModal', () => {
    renderCard(agentFixture(), { organizations: [ORG] })
    expect(screen.queryByTestId('move-agent-modal')).toBeNull()
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'Move to organization' }))
    expect(screen.getByTestId('move-agent-modal')).toBeTruthy()
  })

  it('Restore to list restores', () => {
    const { onRestore } = renderCard(agentFixture({ status: 'revoked', archived_at: ARCHIVED }), { dashboard: dashboardFor(null) })
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'Restore to list' }))
    expect(onRestore).toHaveBeenCalledTimes(1)
  })

  it('Escape closes the menu and returns focus to its trigger', () => {
    renderCard(agentFixture())
    const trigger = screen.getByRole('button', { name: 'Actions for Research agent' })
    fireEvent.click(trigger)
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('the menu trigger and the CTA sit outside the stretched link, separately focusable', () => {
    renderCard(agentFixture({ status: 'pending_approval' }), {
      dashboard: dashboardFor(overviewAgent({ status: 'pending_approval', budgets: [] }), []),
    })
    const trigger = screen.getByRole('button', { name: 'Actions for Research agent' })
    const cta = screen.getByRole('link', { name: 'Finish setup' })
    for (const control of [trigger, cta]) {
      expect(control.closest('a[href="/agents/agent-1"]')).toBeNull()
      expect(control.closest('[class*="z-[var(--v2-z-content)]"]')).not.toBeNull()
    }
  })

  it('disables the trigger and says what is happening while an action runs', () => {
    renderCard(agentFixture(), { busyAction: 'pause' })
    expect((screen.getByRole('button', { name: 'Actions for Research agent' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('status').textContent).toBe('Pausing…')
    // The stretched name link stays live.
    expect(screen.getByRole('link', { name: 'Research agent' }).getAttribute('href')).toBe('/agents/agent-1')
  })
})

/**
 * #2195: the stranded-funds notice and the detail page's banner describe one
 * event, so the title and cause clause are the shared ones. The list knows
 * only that funds are stranded — no count, no amount.
 */
describe('AgentCard recoverable funds (#2195)', () => {
  it('keeps the notice with the shared title and count-free cause clause', () => {
    renderCard(agentFixture({ has_stranded_funds: true } as Partial<Agent>))
    expect(screen.getByRole('heading', { name: STRANDED_FUNDS_TITLE })).toBeTruthy()
    const text = screen.getByText(new RegExp(escapeRe(strandedFundsCause(null)))).textContent ?? ''
    expect(text).toContain('At least one payment')
    expect(text).not.toMatch(/\d+ payments were|USDC/)
    expect(screen.getByText(/Open the agent to recover these funds\./).closest('a')).toBeNull()
  })

  it('offers Recover funds as the card’s one CTA, to the agent page', () => {
    renderCard(agentFixture({ has_stranded_funds: true } as Partial<Agent>))
    const cta = within(screen.getByTestId('agent-card-cta')).getByRole('link', { name: 'Recover funds' })
    expect(cta.getAttribute('href')).toBe('/agents/agent-1')
  })

  it('shows nothing when there is no open reconciliation event', () => {
    renderCard(agentFixture())
    expect(screen.queryByText(STRANDED_FUNDS_TITLE)).toBeNull()
    expect(screen.queryByTestId('agent-card-cta')).toBeNull()
  })
})

/** #2230 / #2216: the paused notice is the detail page's banner, shared. */
describe('AgentCard paused notice (#2230)', () => {
  it('renders the shared title and body as a titled banner', () => {
    renderCard(agentFixture({ status: 'paused' }))
    expect(screen.getByRole('heading', { name: AGENT_PAUSED_TITLE })).toBeTruthy()
    expect(screen.getByText(new RegExp(escapeRe(AGENT_PAUSED_BODY)))).toBeTruthy()
  })

  it('titles both notices with headings at once — no hand-rolled copy beside them', () => {
    const { container } = renderCard(agentFixture({ status: 'paused', has_stranded_funds: true } as Partial<Agent>))
    const headings = Array.from(container.querySelectorAll('h3')).map((h) => (h.textContent ?? '').trim())
    expect(headings).toEqual(['Research agent', AGENT_PAUSED_TITLE, STRANDED_FUNDS_TITLE])
  })
})

describe('AgentCard half-revoked (#3542)', () => {
  const MARKER = /its budget is still active/i

  it('revoked + live budget: the marker replaces "Network access already revoked", with Finish revoking as the CTA', () => {
    renderCard(agentFixture({ status: 'revoked', live_delegation_count: 1 }), { dashboard: dashboardFor(null) })
    expect(screen.getByText(MARKER)).toBeTruthy()
    expect(screen.queryByText('Network access already revoked')).toBeNull()
    expect(within(screen.getByTestId('agent-card-cta')).getByRole('button', { name: 'Finish revoking Research agent' })).toBeTruthy()
  })

  it('revoked + count 0: no marker, no Finish revoking', () => {
    renderCard(agentFixture({ status: 'revoked', live_delegation_count: 0 }), { dashboard: dashboardFor(null) })
    expect(screen.queryByText(MARKER)).toBeNull()
    expect(screen.queryByRole('button', { name: /Finish revoking/ })).toBeNull()
  })

  it('an active agent with live budgets is NOT half-revoked', () => {
    renderCard(agentFixture({ live_delegation_count: 2 }))
    expect(screen.queryByText(MARKER)).toBeNull()
  })

  it('archived + live budget: marker, Finish revoking, and the restore helper that does not promise the budget ended', () => {
    renderCard(agentFixture({ status: 'revoked', archived_at: ARCHIVED, live_delegation_count: 1 }), { dashboard: dashboardFor(null) })
    expect(screen.getByText(MARKER)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Finish revoking Research agent' })).toBeTruthy()
    expect(screen.queryByText(/restoring never re-enables spending/i)).toBeNull()
    expect(screen.getByText(/restoring to the list does not end its budget/i)).toBeTruthy()
    expect(menuItemNames()).toEqual(['Restore to list'])
  })

  it('Finish revoking opens the dialog in finish mode', () => {
    renderCard(agentFixture({ status: 'revoked', live_delegation_count: 1 }), { dashboard: dashboardFor(null) })
    fireEvent.click(screen.getByRole('button', { name: 'Finish revoking Research agent' }))
    expect(screen.getByTestId('remove-agent-dialog').getAttribute('data-mode')).toBe('finish')
  })

  it('an unlinked agent gets the marker and NO action', () => {
    renderCard(agentFixture({ status: 'revoked', account_id: null, live_delegation_count: 1 }), { dashboard: dashboardFor(null) })
    expect(screen.getByText(MARKER)).toBeTruthy()
    expect(screen.getByText(/cannot end it from here/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Finish revoking/ })).toBeNull()
  })
})
