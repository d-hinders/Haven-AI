import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import LabelsManagerModal from '../LabelsManagerModal'
import ConfirmDialog from '@/components/ConfirmDialog'

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

  it('delete goes through ConfirmDialog and states agents keep everything else', async () => {
    renderModal()
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Delete prod' })).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Delete prod' }))
    // The confirm dialog carries the cascade promise.
    expect(screen.getByText(/Agents carrying this label keep everything else/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Delete label' }))
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

// The ConfirmDialog integration is exercised above through the real component;
// this assertion pins that the dialog only mounts its confirm flow from the
// manager (the manager owns the destructive action, not the editor).
describe('LabelsManagerModal delete gating', () => {
  it('does not open a confirm dialog before a delete is requested', async () => {
    mockGet.mockResolvedValue(LABELS)
    render(<LabelsManagerModal open onClose={vi.fn()} />)
    await vi.waitFor(() => expect(screen.getByTestId('label-manager-list')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Delete label' })).toBeNull()
  })
})

// Keep the import used (ConfirmDialog arrives through the modal under test).
void ConfirmDialog
