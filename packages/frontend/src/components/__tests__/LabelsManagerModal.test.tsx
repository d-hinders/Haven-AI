import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import LabelsManagerModal from '../LabelsManagerModal'

const mockGet = vi.fn()
const mockPut = vi.fn()
const mockDelete = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => mockGet(...args),
    put: (...args: unknown[]) => mockPut(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
  },
}))

const LABELS = {
  labels: [
    { id: 'label-1', name: 'prod', color: 'brand', created_at: '2026-05-01T00:00:00Z' },
    { id: 'label-2', name: 'finance', color: 'debit', created_at: '2026-05-01T00:00:00Z' },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGet.mockResolvedValue(LABELS)
  mockPut.mockImplementation((_url: string, body: { name?: string; color?: string }) =>
    Promise.resolve({
      id: 'label-1',
      name: body.name ?? 'prod',
      color: body.color ?? 'brand',
      created_at: '2026-05-01T00:00:00Z',
    }),
  )
  mockDelete.mockResolvedValue({})
})

function renderModal(onLabelsChanged = vi.fn()) {
  render(
    <LabelsManagerModal open onClose={vi.fn()} onLabelsChanged={onLabelsChanged} />,
  )
  return { onLabelsChanged }
}

/** The manager behind an opener button, so focus return has somewhere to go. */
function Harness() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open manager
      </button>
      <LabelsManagerModal open={open} onClose={() => setOpen(false)} />
    </>
  )
}

/** The inline delete confirmation — the only confirmation this dialog has. */
function deletePanel() {
  return screen.getByTestId('list-manager-delete-panel')
}

describe('LabelsManagerModal', () => {
  it('lists every label as a chip with rename and delete controls', async () => {
    renderModal()
    await vi.waitFor(() => expect(screen.getByTestId('label-manager-list')).toBeInTheDocument())
    expect(screen.getByText('prod')).toBeInTheDocument()
    expect(screen.getByText('finance')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Rename prod' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete finance' })).toBeInTheDocument()
  })

  it('renames a label through the API', async () => {
    renderModal()
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Rename prod' })).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Rename prod' }))
    fireEvent.change(screen.getByLabelText('Label name'), { target: { value: 'production' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await vi.waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/labels/label-1', { name: 'production' }),
    )
  })

  it('recolors from the fixed palette only', async () => {
    renderModal()
    await vi.waitFor(() => expect(screen.getByTestId('label-manager-list')).toBeInTheDocument())

    // Two rows each render a four-swatch palette; scope to the first row.
    const row = screen.getByLabelText('Colour for prod')
    expect(row.querySelectorAll('button')).toHaveLength(4) // neutral, brand, success, debit — no picker

    fireEvent.click(within(row).getByRole('button', { name: 'Use success colour' }))
    await vi.waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/labels/label-1', { color: 'success' }),
    )
  })

  it('delete confirms inline and states agents keep everything else', async () => {
    renderModal()
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Delete prod' })).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Delete prod' }))
    // The inline panel carries the cascade promise.
    expect(within(deletePanel()).getByText(/Agents carrying this label keep everything else/)).toBeInTheDocument()

    fireEvent.click(within(deletePanel()).getByRole('button', { name: 'Delete label' }))
    await vi.waitFor(() => expect(mockDelete).toHaveBeenCalledWith('/labels/label-1'))
  })

  it('shows the empty state when the user has no labels', async () => {
    mockGet.mockResolvedValue({ labels: [] })
    render(<LabelsManagerModal open onClose={vi.fn()} />)
    await vi.waitFor(() =>
      expect(screen.getByText(/No labels yet/)).toBeInTheDocument(),
    )
  })
})

// The inline confirmation is exercised above through the real component; this
// assertion pins that the panel only mounts from the manager (the manager owns
// the destructive action, not the editor).
describe('LabelsManagerModal delete gating', () => {
  it('does not open a confirmation panel before a delete is requested', async () => {
    mockGet.mockResolvedValue(LABELS)
    render(<LabelsManagerModal open onClose={vi.fn()} />)
    await vi.waitFor(() => expect(screen.getByTestId('label-manager-list')).toBeInTheDocument())
    expect(screen.queryByTestId('list-manager-delete-panel')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete label' })).toBeNull()
  })
})

/**
 * #4565: the manager is `ui/Modal` now, and its delete confirmation is an
 * inline panel inside that one dialog rather than a second `ConfirmDialog`.
 * These are the assertions the labels manager had none of: Escape, focus
 * return, and the rename and delete error states.
 */
describe('LabelsManagerModal — Modal anatomy and inline confirmation (#4565)', () => {
  it('Escape closes the manager and returns focus to its opener', async () => {
    render(<Harness />)
    const opener = screen.getByRole('button', { name: 'Open manager' })
    opener.focus()
    fireEvent.click(opener)
    await vi.waitFor(() => expect(screen.getByTestId('label-manager-list')).toBeInTheDocument())

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(opener).toHaveFocus())
  })

  it('holds exactly one role="dialog" while a delete is being confirmed', async () => {
    renderModal()
    await vi.waitFor(() => expect(screen.getByTestId('label-manager-list')).toBeInTheDocument())
    expect(screen.getAllByRole('dialog')).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Delete prod' }))

    expect(deletePanel()).toBeInTheDocument()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(within(deletePanel()).getByText('Delete prod?')).toBeInTheDocument()
  })

  it('Escape cancels the confirmation without closing the manager, and returns focus to the row trigger', async () => {
    renderModal()
    await vi.waitFor(() => expect(screen.getByTestId('label-manager-list')).toBeInTheDocument())
    const trigger = screen.getByRole('button', { name: 'Delete prod' })
    fireEvent.click(trigger)
    expect(deletePanel()).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByTestId('list-manager-delete-panel')).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Manage labels' })).toBeInTheDocument()
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('Cancel closes the panel and returns focus to the row trigger', async () => {
    renderModal()
    await vi.waitFor(() => expect(screen.getByTestId('label-manager-list')).toBeInTheDocument())
    const trigger = screen.getByRole('button', { name: 'Delete prod' })
    fireEvent.click(trigger)
    fireEvent.click(within(deletePanel()).getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByTestId('list-manager-delete-panel')).toBeNull()
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('shows a rename failure in the row, in our words', async () => {
    mockPut.mockRejectedValueOnce(Object.assign(new Error('duplicate key value'), { status: 409 }))
    renderModal()
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Rename prod' })).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Rename prod' }))
    fireEvent.change(screen.getByLabelText('Label name'), { target: { value: 'production' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'This name is already in use or could not be saved.',
      ),
    )
    // The row stays in its rename field so the name can be corrected.
    expect(screen.getByLabelText('Label name')).toBeInTheDocument()
  })

  it('shows a delete failure in the panel and keeps it open for a retry', async () => {
    mockDelete.mockRejectedValueOnce(Object.assign(new Error('An unexpected error occurred'), { status: 500 }))
    renderModal()
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Delete prod' })).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Delete prod' }))
    fireEvent.click(within(deletePanel()).getByRole('button', { name: 'Delete label' }))

    await waitFor(() =>
      expect(within(deletePanel()).getByRole('alert')).toHaveTextContent('prod was not deleted. Try again.'),
    )
    const retry = within(deletePanel()).getByRole('button', { name: 'Delete label' })
    expect(retry).toBeEnabled()
    await waitFor(() => expect(retry).toHaveFocus())
  })
})
