/**
 * #3222 re-review: the tree's counts, its mobile fold and its icons.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { AgentOrganizationTree } from '../AgentOrganizationTree'

const ORGS = [
  { id: 'root', parent_organization_id: null, name: 'Company A', created_at: '', updated_at: '', agent_count: 0 },
  { id: 'tech', parent_organization_id: 'root', name: 'Tech Agents', created_at: '', updated_at: '', agent_count: 0 },
]

function renderTree(props: Partial<Parameters<typeof AgentOrganizationTree>[0]> = {}) {
  return render(
    <AgentOrganizationTree
      organizations={ORGS}
      loading={false}
      error={null}
      selectedId={null}
      onSelect={vi.fn()}
      onCreate={vi.fn()}
      onManage={vi.fn()}
      onRetry={vi.fn()}
      counts={undefined}
      {...props}
    />,
  )
}

describe('AgentOrganizationTree (#3222 re-review)', () => {
  it('shows the filter facet\'s counts, not direct members, so tree and dropdown agree (S6)', () => {
    // Direct members are 0 everywhere; the facet counts the subtree.
    renderTree({ counts: { root: 1, tech: 1, top_level: 1 } })
    const tech = screen.getByRole('button', { name: /Tech Agents/ })
    expect(within(tech).getByText('1')).toBeInTheDocument()
    const top = screen.getByRole('button', { name: /Top level/ })
    expect(within(top).getByText('1')).toBeInTheDocument()
  })

  it('folds the rows below lg behind a toggle naming the selection (S8)', () => {
    const { container } = renderTree({ selectedId: 'tech' })
    const toggle = container.querySelector('[aria-controls="organization-tree-rows"]') as HTMLElement
    expect(toggle.tagName).toBe('BUTTON')
    expect(toggle.textContent).toBe('Showing: Tech Agents')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle.className).toMatch(/lg:hidden/)
    const rows = document.getElementById('organization-tree-rows') as HTMLElement
    expect(rows.className).toMatch(/(^|\s)hidden(\s|$)/)
    expect(rows.className).toMatch(/lg:block/)
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(rows.className).not.toMatch(/(^|\s)hidden(\s|$)/)
  })

  it('folds again after a row is picked, so the filtered list is in view', () => {
    const onSelect = vi.fn()
    const { container } = renderTree({ onSelect })
    const toggle = container.querySelector('[aria-controls="organization-tree-rows"]') as HTMLElement
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(screen.getByRole('button', { name: /Tech Agents/ }))
    expect(onSelect).toHaveBeenCalledWith('tech')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })

  it('draws no chevron on the rows — nothing there expands or collapses', () => {
    const { container } = renderTree()
    const rowsEl = container.querySelector('#organization-tree-rows') as HTMLElement
    expect(rowsEl.querySelector('.lucide-chevron-right')).toBeNull()
    expect(rowsEl.querySelectorAll('.lucide-folder').length).toBeGreaterThan(0)
  })
})

// #3236 (built by @PhilipEriksson; reworked on the #3222 tree): the
// loading/error states used to render only while `organizations.length === 0`,
// so a refetch with organizations present showed neither. They now show in
// place — the tree stays, because the panel refetches after every move and
// swapping the tree for a status panel made the page below jump each time.
describe('AgentOrganizationTree (#3236 refetch states)', () => {
  it('says "Updating…" during a refetch with organizations present, and keeps the rows', () => {
    renderTree({ loading: true })

    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('Updating…')
    const tree = screen.getByTestId('organization-tree')
    expect(tree).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('button', { name: /Company A/ })).toBeInTheDocument()
  })

  it('shows the error with a working Try again after a failed refetch, above the last-known rows', () => {
    const onRetry = vi.fn()
    renderTree({ error: 'We could not load your organizations. Try again in a moment.', onRetry })

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('We could not load your organizations. Try again in a moment.')
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledOnce()
    expect(screen.getByTestId('organization-tree')).toBeInTheDocument()
  })

  it('first load with no rows yet is still the status panel', () => {
    renderTree({ organizations: [], loading: true })
    expect(screen.getByRole('status')).toHaveTextContent('Loading organizations…')
    expect(screen.queryByTestId('organization-tree')).toBeNull()
  })

  it('renders no status once loading settles', () => {
    renderTree()
    expect(screen.getByTestId('organization-tree')).not.toHaveAttribute('aria-busy')
    expect(screen.queryByRole('status')).toBeNull()
  })
})
