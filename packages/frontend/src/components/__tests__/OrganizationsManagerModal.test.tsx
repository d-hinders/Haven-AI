import { render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import OrganizationsManagerModal from '../OrganizationsManagerModal'

const mockGet = vi.fn()
const mockPost = vi.fn()
const mockPut = vi.fn()
const mockDelete = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
    put: (...args: unknown[]) => mockPut(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
  },
}))

const ORGS = {
  organizations: [
    {
      id: 'org-1',
      parent_organization_id: null,
      name: 'Company A very long organization name',
      created_at: '2026-05-01T00:00:00Z',
      updated_at: '2026-05-01T00:00:00Z',
      agent_count: 2,
    },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGet.mockResolvedValue(ORGS)
  mockPost.mockResolvedValue(ORGS.organizations[0])
  mockPut.mockResolvedValue(ORGS.organizations[0])
  mockDelete.mockResolvedValue({})
})

function renderModal() {
  render(<OrganizationsManagerModal open onClose={vi.fn()} />)
}

describe('OrganizationsManagerModal', () => {
  it('lists organizations with rename, move and delete controls', async () => {
    renderModal()
    await vi.waitFor(() => expect(screen.getByTestId('organization-manager-list')).toBeInTheDocument())
    // `within(list)`: the name also appears in the place-inside select's
    // options, and every control below is scoped to the row list.
    const list = within(screen.getByTestId('organization-manager-list'))
    expect(list.getByText('Company A very long organization name')).toBeInTheDocument()
    expect(list.getByRole('button', { name: 'Rename Company A very long organization name' })).toBeInTheDocument()
    expect(list.getByRole('button', { name: 'Move Company A very long organization name' })).toBeInTheDocument()
    expect(list.getByRole('button', { name: 'Delete Company A very long organization name' })).toBeInTheDocument()
  })

  // Round-3 review (NB3) headless equivalent: the name takes the FULL row
  // below `sm` (no flex-1 squeezing it beside a fixed action group — at 390px
  // that truncated every name and path to 2-3 characters), and the actions
  // drop to their own line (`mt-2 sm:mt-0`) that only joins the name's line
  // at `sm` and up (`sm:flex` on the row, `sm:shrink-0` on the actions).
  // Mutation: reverting the row to the old `flex flex-wrap` + `min-w-0
  // flex-1` shape fails all three assertions.
  it('gives the name the full row below sm and stacks the actions underneath (NB3)', async () => {
    renderModal()
    await vi.waitFor(() =>
      expect(screen.getByTestId('organization-manager-list')).toBeInTheDocument(),
    )
    const list = screen.getByTestId('organization-manager-list')

    // The row: single-line ONLY from sm up.
    const row = within(list)
      .getByText('Company A very long organization name')
      .closest('div.sm\\:flex') as HTMLElement | null
    expect(row, 'the row must lay out as one line only from sm up (sm:flex)').not.toBeNull()
    expect(row?.className).toContain('sm:items-center')

    // The name box: NOT bare `flex-1` — below sm the row is not a flex
    // container, so the name is full-width there; from sm up `sm:flex-1`
    // squeezes only beside the (by then inline) actions. Token-exact so the
    // responsive variant does not false-positive the assertion.
    const nameBox = within(list).getByText('Company A very long organization name')
      .parentElement as HTMLElement
    const nameBoxTokens = nameBox.className.split(/\s+/)
    expect(nameBoxTokens).toContain('min-w-0')
    expect(nameBoxTokens).not.toContain('flex-1')

    // The actions group: its own line below sm, inline from sm up.
    const actions = within(list)
      .getByRole('button', { name: 'Delete Company A very long organization name' })
      .closest('div.mt-2') as HTMLElement | null
    expect(actions, 'the actions group must sit on its own line below sm (mt-2)').not.toBeNull()
    expect(actions?.className).toContain('sm:shrink-0')
  })
})

describe('OrganizationsManagerModal — move mode and delete weight (#3222 re-review)', () => {
  it('keeps the folder being moved named, with a visible "Move inside" label', async () => {
    renderModal()
    await vi.waitFor(() => expect(screen.getByTestId('organization-manager-list')).toBeInTheDocument())
    const list = within(screen.getByTestId('organization-manager-list'))
    list.getByRole('button', { name: 'Move Company A very long organization name' }).click()
    await waitFor(() => expect(list.getByText('Move inside')).toBeInTheDocument())
    // The row's own name is still on screen next to the picker.
    expect(list.getByText('Company A very long organization name')).toBeInTheDocument()
    const select = list.getByLabelText('Move inside')
    expect(select.tagName).toBe('SELECT')
  })

  it('the per-row Delete is not the solid danger button — the confirmation dialog is', async () => {
    renderModal()
    await vi.waitFor(() => expect(screen.getByTestId('organization-manager-list')).toBeInTheDocument())
    const list = within(screen.getByTestId('organization-manager-list'))
    const del = list.getByRole('button', { name: 'Delete Company A very long organization name' })
    expect(del.className).not.toMatch(/bg-\[var\(--v2-danger\)\]/)
  })
})
