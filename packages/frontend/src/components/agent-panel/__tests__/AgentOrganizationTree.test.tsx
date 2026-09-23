import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AgentOrganizationTree } from '../AgentOrganizationTree'
import type { Organization } from '@/hooks/useOrganizations'

const ORG: Organization = {
  id: 'org-1',
  parent_organization_id: null,
  name: 'Company A',
  created_at: '2026-09-22T00:00:00Z',
  updated_at: '2026-09-22T00:00:00Z',
  agent_count: 2,
}

function renderTree(overrides: Partial<Parameters<typeof AgentOrganizationTree>[0]> = {}) {
  const props: Parameters<typeof AgentOrganizationTree>[0] = {
    organizations: [ORG],
    loading: false,
    error: null,
    selectedId: null,
    onSelect: vi.fn(),
    onCreate: vi.fn(),
    onManage: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  }
  return render(<AgentOrganizationTree {...props} />)
}

// #3236: the loading/error states used to render only while
// `organizations.length === 0`, so a refetch with organizations present
// showed neither. Mutation: reverting either condition to the old
// `loading && organizations.length === 0` /
// `error && organizations.length === 0` shape fails the first two tests —
// the tree renders instead of the status panel.
describe('AgentOrganizationTree (#3236 refetch states)', () => {
  it('shows the loading state during a refetch with organizations present', () => {
    renderTree({ loading: true })

    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('aria-busy', 'true')
    expect(status).toHaveTextContent('Loading organizations…')
    // The status panel REPLACES the tree — the stale rows cannot be read or
    // clicked while the fetch that replaces them is in flight.
    expect(screen.queryByTestId('organization-tree')).toBeNull()
  })

  it('shows the error state with a working Try again after a failed refetch with organizations present', () => {
    const onRetry = vi.fn()
    renderTree({ error: 'We could not load your organizations. Try again in a moment.', onRetry })

    expect(
      screen.getByText('We could not load your organizations. Try again in a moment.'),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledOnce()
    expect(screen.queryByTestId('organization-tree')).toBeNull()
  })

  it('renders the tree once loading settles with organizations present', () => {
    renderTree()

    expect(screen.getByTestId('organization-tree')).toBeInTheDocument()
    expect(screen.getByText('Company A')).toBeInTheDocument()
    expect(screen.queryByRole('status')).toBeNull()
  })
})
