import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Agents page's list controls (#4113): `AgentListToolbar`'s tests,
 * retargeted onto `ListToolbar` as the page wires it. What `AgentListToolbar`
 * already had — 44px targets, Escape, focus back on the trigger, counts — is
 * kept; arrow keys, Enter / Space / Arrow Down to open, and checkbox-row
 * semantics are NEW for Agents (its rows were `aria-pressed` toggles) and are
 * tested here against the page, not only against the pattern.
 */

const mockUseAuth = vi.hoisted(() => vi.fn())
const mockUseAgents = vi.hoisted(() => vi.fn())

vi.mock('@/context/AuthContext', () => ({ useAuth: () => mockUseAuth() }))
vi.mock('@/hooks/useAgents', () => ({ useAgents: () => mockUseAgents() }))
vi.mock('@/hooks/useOrganizations', () => ({
  useOrganizations: () => ({
    organizations: [],
    loading: false,
    error: null,
    fetchOrganizations: vi.fn(),
    createOrganization: vi.fn(),
    updateOrganization: vi.fn(),
    deleteOrganization: vi.fn(),
  }),
}))
vi.mock('next/navigation', () => ({
  usePathname: () => '/agents',
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('../ConnectAgentModal', () => ({ default: () => null }))
vi.mock('../connect-agent/InlineAgentSetup', () => ({ InlineAgentSetup: () => null }))
vi.mock('../ConfirmDialog', () => ({ default: () => null }))

import AgentPanel from '../AgentPanel'

const ACCOUNT = { id: 'acc-1', name: 'Main account', account_address: '0x1111111111111111111111111111111111111111', chain_id: 84532, account_type: 'delegator_hybrid' }

function agent(id: string, name: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    description: null,
    delegate_address: `0x${id.padStart(40, '0')}`,
    account_id: ACCOUNT.id,
    account_address: ACCOUNT.account_address,
    account_name: ACCOUNT.name,
    account_chain_id: ACCOUNT.chain_id,
    account_type: ACCOUNT.account_type,
    status,
    created_at: '2026-05-01T00:00:00Z',
    allowances: [],
    labels: [],
    ...extra,
  }
}

const AGENTS = [
  agent('1', 'Alpha', 'active'),
  agent('2', 'Bravo', 'active'),
  agent('3', 'Charlie', 'paused'),
  agent('4', 'Old', 'revoked', { archived_at: '2026-06-01T00:00:00Z' }),
]

beforeEach(() => {
  vi.clearAllMocks()
  mockUseAuth.mockReturnValue({ user: { accounts: [ACCOUNT] } })
  mockUseAgents.mockReturnValue({
    agents: AGENTS,
    loading: false,
    revokeAgent: vi.fn(),
    pauseAgent: vi.fn(),
    resumeAgent: vi.fn(),
    archiveAgent: vi.fn(),
    unarchiveAgent: vi.fn(),
    refetch: vi.fn(),
  })
})

const cards = () => ['Alpha', 'Bravo', 'Charlie', 'Old'].filter((n) => screen.queryByRole('link', { name: n }))

describe('Agents list controls (#4113)', () => {
  it('search filters as you type, offers a clear button only while it has text, and Escape clears it', async () => {
    const user = userEvent.setup()
    render(<AgentPanel />)
    const search = screen.getByRole('searchbox', { name: 'Search agents' })
    expect(search).toHaveAccessibleDescription('by name, description or delegate address')
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull()

    await user.type(search, 'br')
    expect(cards()).toEqual(['Bravo'])
    expect(screen.getByRole('button', { name: 'Remove “br”' })).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(search).toHaveValue('')
    expect(cards()).toEqual(['Alpha', 'Bravo', 'Charlie'])

    await user.type(search, 'ch')
    await user.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(cards()).toEqual(['Alpha', 'Bravo', 'Charlie'])
    expect(search).toHaveFocus()
  })

  it('a facet is a menu button: Arrow Down opens it on the first row, arrows move with wrap, Escape returns focus', async () => {
    const user = userEvent.setup()
    render(<AgentPanel />)
    const trigger = screen.getByRole('button', { name: 'Status: All' })
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    trigger.focus()
    await user.keyboard('{ArrowDown}')
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    const menu = screen.getByRole('menu', { name: 'Status: All' })
    const rows = within(menu).getAllByRole('menuitemcheckbox')
    expect(rows.map((r) => r.textContent?.replace(/\d+$/, ''))).toEqual(['Active', 'Paused', 'Pending approval', 'Revoked'])
    expect(rows[0]).toHaveFocus()

    await user.keyboard('{ArrowDown}')
    expect(rows[1]).toHaveFocus()
    await user.keyboard('{ArrowUp}{ArrowUp}')
    expect(rows[3]).toHaveFocus() // wrapped
    await user.keyboard('{Home}')
    expect(rows[0]).toHaveFocus()
    await user.keyboard('{End}')
    expect(rows[3]).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    // Focus returns to the trigger, never to <body>.
    expect(trigger).toHaveFocus()
  })

  it('Enter and Space open the menu too', async () => {
    const user = userEvent.setup()
    render(<AgentPanel />)
    const trigger = screen.getByRole('button', { name: 'Budget: All' })
    trigger.focus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('menu', { name: 'Budget: All' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    await user.keyboard(' ')
    expect(screen.getByRole('menu', { name: 'Budget: All' })).toBeInTheDocument()
  })

  it('multi-select rows are checkboxes with counts: ticking stays open, toggles aria-checked and filters', async () => {
    const user = userEvent.setup()
    render(<AgentPanel />)
    await user.click(screen.getByRole('button', { name: 'Status: All' }))
    const active = screen.getByRole('menuitemcheckbox', { name: /Active/, checked: false })
    // Faceted counts: hidden archived agents are not counted.
    expect(active).toHaveTextContent('2')
    expect(screen.getByRole('menuitemcheckbox', { name: /Revoked/ })).toHaveTextContent('0')

    await user.click(active)
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(screen.getByRole('menuitemcheckbox', { name: /Active/, checked: true })).toBeInTheDocument()
    await user.click(screen.getByRole('menuitemcheckbox', { name: /Paused/ }))
    expect(screen.getByRole('button', { name: 'Status: Active, Paused' })).toHaveAttribute('data-active', 'true')
    expect(cards()).toEqual(['Alpha', 'Bravo', 'Charlie'])

    await user.click(screen.getByRole('menuitemcheckbox', { name: /Paused/, checked: true }))
    expect(cards()).toEqual(['Alpha', 'Bravo'])
    expect(screen.getByTestId('list-toolbar-count')).toHaveTextContent('2 of 3 agents')
  })

  it('active filters show as removable chips; Clear filters resets them and keeps the sort', async () => {
    const user = userEvent.setup()
    render(<AgentPanel />)
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull()
    expect(screen.getByTestId('list-toolbar-count')).toHaveTextContent('3 agents')

    await user.click(screen.getByRole('button', { name: 'Sort: Name' }))
    await user.click(screen.getByRole('menuitemradio', { name: 'Newest' }))
    await user.click(screen.getByRole('button', { name: 'Status: All' }))
    await user.click(screen.getByRole('menuitemcheckbox', { name: /Paused/ }))
    await user.keyboard('{Escape}')

    await user.click(screen.getByRole('button', { name: 'Remove Status: Paused' }))
    expect(cards()).toEqual(['Alpha', 'Bravo', 'Charlie'])

    await user.click(screen.getByRole('button', { name: 'Archived: Hidden' }))
    await user.click(screen.getByRole('menuitemradio', { name: 'Shown' }))
    expect(cards()).toEqual(['Alpha', 'Bravo', 'Charlie', 'Old'])
    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(cards()).toEqual(['Alpha', 'Bravo', 'Charlie'])
    // Sort is a view choice, not a filter: no chip, and Clear filters keeps it.
    expect(screen.getByRole('button', { name: 'Sort: Newest' })).toBeInTheDocument()
  })

  it('every control is a 44px target below sm', async () => {
    const user = userEvent.setup()
    render(<AgentPanel />)
    const toolbar = screen.getByTestId('list-toolbar')
    for (const name of ['Status: All', 'Budget: All', 'Archived: Hidden', 'Sort: Name', 'Filters']) {
      expect(within(toolbar).getByRole('button', { name })).toHaveClass('min-h-11')
    }
    expect(within(toolbar).getByRole('searchbox', { name: 'Search agents' })).toHaveClass('min-h-11')
    await user.click(screen.getByRole('button', { name: 'Status: All' }))
    for (const row of screen.getAllByRole('menuitemcheckbox')) expect(row).toHaveClass('min-h-11')
  })

  it('the phone sheet holds every facet and the sort; Escape closes it and focus returns to Filters', async () => {
    const user = userEvent.setup()
    render(<AgentPanel />)
    const filters = screen.getByRole('button', { name: 'Filters' })
    await user.click(filters)
    const sheet = screen.getByRole('dialog', { name: 'Filters' })
    expect(within(sheet).getAllByRole('group').map((g) => g.querySelector('legend')?.textContent)).toEqual(['Status', 'Budget', 'Archived', 'Sort'])
    await user.click(within(sheet).getByRole('checkbox', { name: /Paused/ }))
    expect(within(sheet).getByRole('button', { name: 'Show 1 agent' })).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: 'Filters (1)' })).toHaveFocus()
  })
})
