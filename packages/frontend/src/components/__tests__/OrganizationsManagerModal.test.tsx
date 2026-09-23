import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
  return render(<OrganizationsManagerModal open onClose={vi.fn()} />)
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

  // #3236 acceptance 1: rowError had no render site on the create form, so a
  // rejected POST /organizations (409 sibling-name collision is the common
  // case) did nothing visible. The error must render on/near the create form.
  // Mutation: deleting the create form's `{rowError ? ... : null}` site fails
  // the getByRole('alert') assertion.
  it('surfaces a failed create next to the create form (#3236)', async () => {
    mockPost.mockRejectedValueOnce(new Error('An organization with this name already exists here.'))
    renderModal()
    await vi.waitFor(() =>
      expect(screen.getByTestId('organization-manager-list')).toBeInTheDocument(),
    )

    fireEvent.change(screen.getByLabelText('New organization name'), {
      target: { value: 'Company A' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    const form = screen.getByTestId('organization-create-form')
    await waitFor(() =>
      expect(within(form).getByRole('alert')).toHaveTextContent(
        'An organization with this name already exists here.',
      ),
    )
    // The list stays; the modal did not close or reset on the failure.
    expect(screen.getByTestId('organization-manager-list')).toBeInTheDocument()
  })

  // #3236 acceptance 2: confirmDelete had no catch, so a rejected DELETE
  // escaped past the `void confirmDelete()` call site as an unhandled
  // rejection and the dialog sat silent. The dialog must stay open, name the
  // failure, and leave no unhandled rejection behind.
  // Mutation: reverting confirmDelete to the catchless try/finally fails the
  // alert assertion (the error never renders) and the process-level handler
  // records the rejection.
  it('surfaces a failed delete inside the confirm dialog and does not reject unhandled (#3236)', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      mockDelete.mockRejectedValueOnce(new Error('The organization could not be deleted.'))
      renderModal()
      await vi.waitFor(() =>
        expect(screen.getByTestId('organization-manager-list')).toBeInTheDocument(),
      )

      fireEvent.click(within(screen.getByTestId('organization-manager-list')).getByRole('button', { name: 'Delete Company A very long organization name' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Delete organization' }))

      const dialog = await screen.findByRole('dialog', { name: 'Delete Company A very long organization name?' })
      await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent('The organization could not be deleted.'))
      // The dialog stays open (the organization was not deleted) with the
      // destructive action re-enabled for a retry.
      expect(screen.getByRole('button', { name: 'Delete organization' })).toBeEnabled()
      // Let a stray rejection surface before the process handler is removed.
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('clears a shown delete error when the dialog is reopened for another organization (#3236)', async () => {
    mockDelete.mockRejectedValueOnce(new Error('The organization could not be deleted.'))
    renderModal()
    await vi.waitFor(() =>
      expect(screen.getByTestId('organization-manager-list')).toBeInTheDocument(),
    )

    fireEvent.click(within(screen.getByTestId('organization-manager-list')).getByRole('button', { name: 'Delete Company A very long organization name' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete organization' }))
    await waitFor(async () =>
      expect(
        within(await screen.findByRole('dialog', { name: 'Delete Company A very long organization name?' })).getByRole('alert'),
      ).toHaveTextContent('The organization could not be deleted.'),
    )

    // Cancel the failed delete, then open the dialog again: the stale error
    // must be gone, and the second attempt (which succeeds here) closes it.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(within(screen.getByTestId('organization-manager-list')).getByRole('button', { name: 'Delete Company A very long organization name' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete Company A very long organization name?' })
    expect(within(dialog).queryByRole('alert')).toBeNull()
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete organization' }))
    })
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Delete Company A very long organization name?' })).toBeNull(),
    )
  })
})
