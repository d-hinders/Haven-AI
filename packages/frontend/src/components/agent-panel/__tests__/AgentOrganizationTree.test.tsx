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
