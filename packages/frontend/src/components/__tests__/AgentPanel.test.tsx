import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseAuth = vi.hoisted(() => vi.fn())
const mockUseAgents = vi.hoisted(() => vi.fn())
const mockUseOrganizations = vi.hoisted(() => vi.fn())

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}))

vi.mock('@/hooks/useAgents', () => ({
  useAgents: () => mockUseAgents(),
}))

// #3164: the organization list feeds the tree above the list and the
// facet registered in the toolbar; tests that need orgs set
// `mockUseOrganizations` directly (default: none, loading settled).
vi.mock('@/hooks/useOrganizations', () => ({
  useOrganizations: () => mockUseOrganizations(),
}))

vi.mock('next/navigation', () => ({
  // #3165: the list toolbar mirrors its state to the URL.
  usePathname: () => '/agents',
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('../ConnectAgentModal', () => ({
  default: () => null,
}))

// #4065: the inline first-agent flow is the other container of the shared
// connect flow. Mocking only the modal left it running the real flow hook
// (wagmi, the setup-status poll) in every zero-agent case here. Its own
// behaviour is proven in AgentPanelInlineSetup.test.tsx; this stand-in only
// says whether the panel mounted it.
vi.mock('../connect-agent/InlineAgentSetup', () => ({
  InlineAgentSetup: () => <section aria-label="Connect your first agent" />,
}))

vi.mock('../ConfirmDialog', () => ({
  default: () => null,
}))

// The dialog's own sequence is proven in RemoveAgentDialog.test.tsx; here only
// what the PANEL wires into it matters: the mode, and what happens when it
// reports the budget ended (#3542).
vi.mock('../agent-panel/RemoveAgentDialog', () => ({
  RemoveAgentDialog: ({
    mode,
    onBudgetEnded,
    onClose,
  }: {
    mode?: string
    onBudgetEnded?: () => void
    onClose: () => void
  }) => (
    <div data-testid="remove-agent-dialog" data-mode={mode ?? 'remove'}>
      <button
        type="button"
        onClick={() => {
          onBudgetEnded?.()
          onClose()
        }}
      >
        stub: budget ended
      </button>
    </div>
  ),
}))

import AgentPanel from '../AgentPanel'
import { MCP_NOT_RECORDED_NOTE } from '../agent-panel/McpServerName'

const SAFE = {
  id: 'safe-1',
  name: 'Main account',
  account_address: '0x1111111111111111111111111111111111111111',
  chain_id: 100,
  account_type: 'delegator_hybrid',
}

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agent-1',
    name: 'Research agent',
    description: null,
    delegate_address: '0x2222222222222222222222222222222222222222',
    account_id: SAFE.id,
    account_address: SAFE.account_address,
    account_name: SAFE.name,
    account_chain_id: SAFE.chain_id,
    account_type: SAFE.account_type,
    status: 'active',
    created_at: '2026-05-01T00:00:00Z',
    allowances: [],
    labels: [],
    ...overrides,
  }
}

function setAgents(agents: unknown[], extra: Record<string, unknown> = {}) {
  mockUseAgents.mockReturnValue({
    agents,
    loading: false,
    revokeAgent: vi.fn(),
    pauseAgent: vi.fn(),
    resumeAgent: vi.fn(),
    archiveAgent: vi.fn(),
    unarchiveAgent: vi.fn(),
    refetch: vi.fn(),
    ...extra,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockUseAuth.mockReturnValue({ user: { accounts: [SAFE] } })
  setAgents([])
  mockUseOrganizations.mockReturnValue({
    organizations: [],
    loading: false,
    error: null,
    fetchOrganizations: vi.fn(),
    createOrganization: vi.fn(),
    updateOrganization: vi.fn(),
    deleteOrganization: vi.fn(),
  })
})

describe('AgentPanel agent detail navigation (#3550)', () => {
  it('renders the agent name as the detail link and removes Details', () => {
    setAgents([agent({ id: 'agent-9' })])

    render(<AgentPanel />)

    expect(screen.getByRole('link', { name: 'Research agent' })).toHaveAttribute(
      'href',
      '/agents/agent-9',
    )
    expect(screen.queryByRole('button', { name: /Open details/ })).toBeNull()
  })

  it('leaves no Edit modal affordance on the list — the detail page owns name and description editing', () => {
    setAgents([agent()])

    render(<AgentPanel />)

    expect(screen.queryByRole('button', { name: 'Edit Research agent' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Research agent' })).toBeInTheDocument()
  })
})

describe('AgentPanel rail affordances', () => {
  it('announces the agent list loading state', () => {
    mockUseAgents.mockReturnValue({
      agents: [],
      loading: true,
      revokeAgent: vi.fn(),
      pauseAgent: vi.fn(),
      resumeAgent: vi.fn(),
      archiveAgent: vi.fn(),
      unarchiveAgent: vi.fn(),
      refetch: vi.fn(),
    })

    render(<AgentPanel />)

    expect(screen.getByRole('status', { name: 'Loading agents' })).toHaveAttribute('aria-busy', 'true')
  })

  it('keeps the delegation connect entry point and agent budget readable', () => {
    setAgents([agent({ allowances: [{
      id: 'allowance-1',
      agent_id: 'agent-1',
      token_address: '0x3333333333333333333333333333333333333333',
      token_symbol: 'USDC',
      allowance_amount: '1000000',
      reset_period_min: 1440,
    }] })])

    render(<AgentPanel />)

    expect(screen.getAllByRole('button', { name: 'Connect agent' }).length).toBeGreaterThan(0)
    expect(screen.getByText('Research agent')).toBeInTheDocument()
    expect(screen.getByText('1.00')).toBeInTheDocument()
  })

  it('shows a retry state instead of claiming there are no agents when the list fails', () => {
    const refetch = vi.fn()
    setAgents([], { error: 'request failed', refetch })

    render(<AgentPanel />)

    expect(screen.getByRole('heading', { name: 'Agents could not load' })).toBeInTheDocument()
    // #4065: the inline first-agent flow replaced "No agents yet"; asserting
    // that heading's absence would now pass vacuously. A failed load is not
    // "no agents", so the flow must not render under the retry state.
    expect(screen.queryByRole('region', { name: 'Connect your first agent' })).not.toBeInTheDocument()
    screen.getByRole('button', { name: 'Try again' }).click()
    expect(refetch).toHaveBeenCalled()
  })

  it('marks a populated list as stale when refreshing agents fails', () => {
    setAgents([agent()], { error: 'request failed' })

    render(<AgentPanel />)

    expect(screen.getByRole('alert')).toHaveTextContent('Showing the last loaded records')
    expect(screen.getByText('Research agent')).toBeInTheDocument()
  })

  it('archived agents are hidden by default, behind the toolbar facet — no Removed disclosure (#4113)', () => {
    setAgents([agent(), agent({ id: 'archived-agent', name: 'Old agent', archived_at: '2026-06-01T00:00:00Z' })])

    render(<AgentPanel />)

    expect(screen.getByText('Research agent')).toBeInTheDocument()
    expect(screen.queryByText('Old agent')).toBeNull()
    expect(screen.queryByRole('button', { name: /Removed/ })).toBeNull()
    expect(document.getElementById('removed-agent-list')).toBeNull()
    // The count is the default view: archived agents are not in it.
    expect(screen.getByTestId('list-toolbar-count')).toHaveTextContent('1 agent')
  })

  it('Archived: Shown lists archived agents alongside the others, and the count includes them', () => {
    setAgents([agent(), agent({ id: 'archived-agent', name: 'Old agent', archived_at: '2026-06-01T00:00:00Z' })])

    render(<AgentPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Archived: Hidden' }))
    expect(screen.getAllByRole('menuitemradio').map((r) => r.textContent)).toEqual(['Hidden', 'Shown'])
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Shown' }))

    expect(screen.getByText('Old agent')).toBeInTheDocument()
    expect(screen.getByText('Research agent')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove Archived: Shown' })).toBeInTheDocument()
    expect(screen.getByTestId('list-toolbar-count')).toHaveTextContent('2 of 2 agents')
  })

  it('an archived card keeps its archived treatment when shown: Restore to list, no operational actions', () => {
    setAgents([agent({ id: 'archived-agent', name: 'Old agent', archived_at: '2026-06-01T00:00:00Z' })])

    render(<AgentPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Show archived' }))

    expect(screen.getByRole('button', { name: 'Restore Old agent to the list' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Pause/ })).toBeNull()
  })

  it('a list whose every agent is archived says so and offers Show archived, not a Clear filters that changes nothing', () => {
    setAgents([agent({ id: 'archived-agent', name: 'Old agent', archived_at: '2026-06-01T00:00:00Z' })])

    render(<AgentPanel />)

    expect(screen.getByText('All your agents are archived')).toBeInTheDocument()
    expect(screen.queryByText('No agents match these filters')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show archived' }))
    expect(screen.getByText('Old agent')).toBeInTheDocument()
  })

  it('Status: Revoked still matches a revoked agent that is not archived; the facets stay independent', () => {
    setAgents([
      agent({ id: 'r1', name: 'Revoked live', status: 'revoked' }),
      agent({ id: 'r2', name: 'Revoked archived', status: 'revoked', archived_at: '2026-06-01T00:00:00Z' }),
      agent({ id: 'a1', name: 'Alpha' }),
    ])

    render(<AgentPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Status: All' }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Revoked/ }))

    expect(screen.getByText('Revoked live')).toBeInTheDocument()
    expect(screen.queryByText('Revoked archived')).toBeNull()
    expect(screen.queryByText('Alpha')).toBeNull()
  })
})

/**
 * #3542 (D), carried over by #4113: archived agents are hidden by default, so
 * one whose budget is still redeemable on-chain must be visible from the list
 * itself — a callout while they are hidden, the card's own marker once shown.
 */
describe('AgentPanel hidden archived agents with a live budget (#3542)', () => {
  const ARCHIVED = '2026-06-01T00:00:00Z'
  const halfRevokedArchived = (overrides: Record<string, unknown> = {}) =>
    agent({
      id: 'old-1',
      name: 'Old agent',
      status: 'revoked',
      archived_at: ARCHIVED,
      live_delegation_count: 1,
      ...overrides,
    })
  const callout = () => screen.queryByTestId('hidden-active-budget-callout')

  it('shows the callout while archived agents are hidden and one still has a live budget', () => {
    setAgents([agent(), halfRevokedArchived(), agent({ id: 'old-2', name: 'Clean', status: 'revoked', archived_at: ARCHIVED, live_delegation_count: 0 })])
    render(<AgentPanel />)

    expect(callout()).toHaveTextContent('1 archived agent still has an active budget')
    expect(screen.queryByText('Old agent')).toBeNull()
  })

  it('counts several qualifying agents, plural', () => {
    setAgents([agent(), halfRevokedArchived(), halfRevokedArchived({ id: 'old-2', name: 'Older agent' })])
    render(<AgentPanel />)
    expect(callout()).toHaveTextContent('2 archived agents still have an active budget')
  })

  it('Show archived sets the facet to Shown: the callout goes and the card with its marker appears', () => {
    setAgents([agent(), halfRevokedArchived()])
    render(<AgentPanel />)

    fireEvent.click(within(callout()!).getByRole('button', { name: 'Show archived' }))

    expect(callout()).toBeNull()
    expect(screen.getByRole('button', { name: 'Archived: Shown' })).toBeInTheDocument()
    expect(screen.getByText(/its budget is still active on.chain/i)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Finish revoking Old agent' })).toBeVisible()
  })

  it('with every agent archived, one Show archived on screen: the empty state owns it, the callout still warns', () => {
    setAgents([halfRevokedArchived()])
    render(<AgentPanel />)
    expect(callout()).toHaveTextContent('1 archived agent still has an active budget')
    expect(within(callout()!).queryByRole('button', { name: 'Show archived' })).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Show archived' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Show archived' }))
    expect(screen.getByRole('button', { name: 'Finish revoking Old agent' })).toBeVisible()
  })

  it('is absent when no archived agent has a live budget', () => {
    setAgents([
      agent(),
      agent({ id: 'old-1', name: 'Old agent', status: 'revoked', archived_at: ARCHIVED, live_delegation_count: 0 }),
      agent({ id: 'old-2', name: 'Older agent', status: 'revoked', archived_at: ARCHIVED }),
    ])
    render(<AgentPanel />)
    // Non-vacuity: the toolbar rendered, archived agents hidden.
    expect(screen.getByRole('button', { name: 'Archived: Hidden' })).toBeInTheDocument()
    expect(callout()).toBeNull()
  })

  it('an ACTIVE agent with live budgets does not trigger it', () => {
    setAgents([
      agent({ live_delegation_count: 3 }),
      agent({ id: 'old-1', name: 'Old agent', status: 'revoked', archived_at: ARCHIVED, live_delegation_count: 0 }),
    ])
    render(<AgentPanel />)
    expect(callout()).toBeNull()
  })

  it('Finish revoking opens the dialog in finish mode; once the budget ends the marker clears without a reload', () => {
    // The real hook refetches; the mock does what that refetch returns: the
    // server's count, now zero.
    const refetch = vi.fn(() => {
      setAgents([agent(), halfRevokedArchived({ live_delegation_count: 0 })], { refetch })
      view.rerender(<AgentPanel />)
      return Promise.resolve([])
    })
    setAgents([agent(), halfRevokedArchived()], { refetch })
    const view = render(<AgentPanel />)

    fireEvent.click(within(callout()!).getByRole('button', { name: 'Show archived' }))
    fireEvent.click(screen.getByRole('button', { name: 'Finish revoking Old agent' }))
    expect(screen.getByTestId('remove-agent-dialog').getAttribute('data-mode')).toBe('finish')

    fireEvent.click(screen.getByRole('button', { name: 'stub: budget ended' }))

    expect(refetch).toHaveBeenCalledWith({ silent: true })
    expect(screen.queryByText(/its budget is still active on.chain/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /Finish revoking/ })).toBeNull()
    // Still archived, still listed under Shown: finishing moves nothing.
    expect(screen.getByText('Old agent')).toBeInTheDocument()
  })

  it('a revoked, un-archived agent in the main list gets the card marker, and no callout', () => {
    setAgents([agent({ status: 'revoked', live_delegation_count: 1 })])
    render(<AgentPanel />)
    expect(screen.getByText(/its budget is still active on.chain/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Finish revoking Research agent' })).toBeInTheDocument()
    expect(callout()).toBeNull()
  })
})

describe('AgentPanel list toolbar (#3165, on ListToolbar since #4113)', () => {
  beforeEach(() => {
    mockUseAuth.mockReturnValue({ user: { accounts: [SAFE] } })
  })

  it('renders the toolbar above a non-empty list and filters the cards on every keystroke', () => {
    setAgents([agent({ id: 'a1', name: 'Alpha', status: 'active' }), agent({ id: 'a2', name: 'Bravo', status: 'paused' })])
    render(<AgentPanel />)
    expect(screen.getByTestId('list-toolbar')).toBeInTheDocument()
    expect(screen.queryByTestId('agent-list-toolbar')).toBeNull()
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Bravo')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search agents' }), { target: { value: 'brav' } })
    expect(screen.queryByText('Alpha')).toBeNull()
    expect(screen.getByText('Bravo')).toBeInTheDocument()
    expect(screen.getByTestId('list-toolbar-count')).toHaveTextContent('1 of 2 agents')
  })

  it('a zero-result filter shows the standard no-match state and never hides the toolbar', () => {
    setAgents([agent({ id: 'a1', name: 'Alpha' })])
    render(<AgentPanel />)
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search agents' }), { target: { value: 'zzz' } })
    expect(screen.getByText('No agents match these filters')).toBeInTheDocument()
    // The toolbar must survive the zero state (mutation: gate it on the
    // filtered length → this line goes red).
    expect(screen.getByTestId('list-toolbar')).toBeInTheDocument()
    expect(screen.getByTestId('list-toolbar-count')).toHaveTextContent('0 of 1 agent')
    // The no-match state's Clear filters (the status row has its own too).
    const clears = screen.getAllByRole('button', { name: 'Clear filters' })
    fireEvent.click(clears[clears.length - 1])
    expect(screen.getByText('Alpha')).toBeInTheDocument()
  })

  it('the MCP "not recorded" note follows the filtered list, not every agent', () => {
    setAgents([
      agent({ id: 'a1', name: 'Alpha', mcp_server_name: null, mcp_last_seen_at: '2026-09-01T00:00:00Z' }),
      agent({ id: 'a2', name: 'Bravo', mcp_server_name: 'claude-desktop' }),
    ])
    render(<AgentPanel />)
    expect(screen.getByText(MCP_NOT_RECORDED_NOTE)).toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search agents' }), { target: { value: 'bravo' } })
    // Alpha (the unrecorded one) is filtered out, so the note explaining its
    // label has nothing on the page to explain. Mutation: gate the predicate
    // on every agent again → red.
    expect(screen.queryByText(MCP_NOT_RECORDED_NOTE)).toBeNull()
  })

  it('the MCP note ignores a hidden archived agent', () => {
    setAgents([
      agent({ id: 'a1', name: 'Alpha', mcp_server_name: 'claude-desktop' }),
      agent({ id: 'a2', name: 'Old', mcp_server_name: null, mcp_last_seen_at: '2026-09-01T00:00:00Z', archived_at: '2026-06-01T00:00:00Z' }),
    ])
    render(<AgentPanel />)
    expect(screen.queryByText(MCP_NOT_RECORDED_NOTE)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Archived: Hidden' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Shown' }))
    expect(screen.getByText(MCP_NOT_RECORDED_NOTE)).toBeInTheDocument()
  })

  it('no toolbar on an empty list — the inline first-agent flow owns that screen', () => {
    setAgents([])
    render(<AgentPanel />)
    expect(screen.getByRole('region', { name: 'Connect your first agent' })).toBeInTheDocument()
    expect(screen.queryByTestId('list-toolbar')).toBeNull()
  })

  it('the sort is a "Sort: Name" chip of radio rows with no All row', () => {
    setAgents([agent({ id: 'a1', name: 'Alpha' })])
    render(<AgentPanel />)
    expect(screen.queryByRole('combobox', { name: 'Sort agents' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Sort: Name' }))
    expect(screen.getAllByRole('menuitemradio').map((r) => r.textContent)).toEqual(['Name', 'Recently seen', 'Newest', 'Largest budget'])
  })

  // Round-3 review (NB2): the org facet EXTENDS the built-ins — the hook's
  // default fires only on `undefined`, so passing `[]` (no organizations)
  // used to strip Status/Budget entirely and a shared `?status=active` link
  // was silently ignored. Mutation: pass `orgFacets` raw again → both
  // assertions go red (org-less users lose Status; org users lose Status
  // AND Budget).
  it('keeps the built-in Status/Budget facets when no organizations exist', () => {
    setAgents([agent({ id: 'a1', name: 'Alpha' })])
    render(<AgentPanel />)
    expect(screen.getByRole('button', { name: /Status:/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Budget:/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Organization:/ })).toBeNull()
  })

  it('appends the Organization facet alongside Status and Budget', () => {
    mockUseOrganizations.mockReturnValue({
      organizations: [
        { id: 'org-1', parent_organization_id: null, name: 'Company A', created_at: '2026-09-22T00:00:00Z', updated_at: '2026-09-22T00:00:00Z', agent_count: 0 },
      ],
      loading: false,
      error: null,
      fetchOrganizations: vi.fn(),
      createOrganization: vi.fn(),
      updateOrganization: vi.fn(),
      deleteOrganization: vi.fn(),
    })
    setAgents([agent({ id: 'a1', name: 'Alpha' })])
    render(<AgentPanel />)
    expect(screen.getByRole('button', { name: /Status:/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Budget:/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Organization:/ })).toBeInTheDocument()
  })
})

describe('AgentPanel across accounts (#3719)', () => {
  const OPERATING = { ...SAFE, id: 'acc-op', name: 'Operating', chain_id: 8453, is_default: true }
  const TREASURY = { ...SAFE, id: 'acc-tr', name: 'Treasury', chain_id: 84532, is_default: false }
  const onOperating = agent({
    id: 'agent-op', name: 'Research agent',
    account_id: OPERATING.id, account_name: OPERATING.name, account_chain_id: OPERATING.chain_id,
  })
  const onTreasury = agent({
    id: 'agent-tr', name: 'Payroll agent',
    account_id: TREASURY.id, account_name: TREASURY.name, account_chain_id: TREASURY.chain_id,
  })

  it('lists every account’s agents, each naming its account and chain', () => {
    mockUseAuth.mockReturnValue({ user: { accounts: [OPERATING, TREASURY] } })
    setAgents([onOperating, onTreasury])

    render(<AgentPanel />)

    expect(screen.getByRole('link', { name: 'Research agent' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Payroll agent' })).toBeInTheDocument()
    expect(screen.getByText((_, el) => el?.tagName === 'P' && el.textContent === 'Account: Operating · Base')).toBeInTheDocument()
    expect(screen.getByText((_, el) => el?.tagName === 'P' && el.textContent === 'Account: Treasury · Base Sepolia')).toBeInTheDocument()
  })

  it('offers the Account filter with two or more accounts', () => {
    mockUseAuth.mockReturnValue({ user: { accounts: [OPERATING, TREASURY] } })
    setAgents([onOperating, onTreasury])

    render(<AgentPanel />)

    expect(screen.getByRole('button', { name: /^Account:/ })).toBeInTheDocument()
  })

  it('offers no Account filter with a single account', () => {
    mockUseAuth.mockReturnValue({ user: { accounts: [OPERATING] } })
    setAgents([onOperating])

    render(<AgentPanel />)

    // Non-vacuity: the toolbar rendered its built-in facets.
    expect(screen.getByRole('button', { name: /^Status:/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Account:/ })).toBeNull()
  })
})
