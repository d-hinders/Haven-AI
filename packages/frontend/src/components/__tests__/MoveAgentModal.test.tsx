import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import MoveAgentModal from '../MoveAgentModal'
import type { Agent } from '@/hooks/useAgents'
import type { Organization } from '@/hooks/useOrganizations'

const mockPut = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    put: (...args: unknown[]) => mockPut(...args),
  },
}))

const AGENT: Agent = {
  id: 'agent-1',
  name: 'Food',
  description: 'Foodie',
  delegate_address: '0x2222222222222222222222222222222222222222',
  account_id: 'safe-1',
  account_address: '0x1111111111111111111111111111111111111111',
  account_name: 'Operating wallet',
  account_chain_id: 100,
  account_type: 'legacy_safe',
  api_key_prefix: 'sk_agent_abc',
  status: 'active',
  created_at: '2026-05-01T00:00:00Z',
  allowances: [],
  labels: [],
  organization_id: null,
  tax_declaration_enabled: false,
  avatar_tint: 1,
}

const ORGANIZATIONS: Organization[] = [
  {
    id: 'org-1',
    parent_organization_id: null,
    name: 'Acme',
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
    agent_count: 0,
  },
  {
    id: 'org-2',
    parent_organization_id: 'org-1',
    name: 'Tech Agents',
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
    agent_count: 0,
  },
]

beforeEach(() => {
  vi.clearAllMocks()
  mockPut.mockResolvedValue({ ...AGENT, organization_id: 'org-2' })
})

function renderModal(agent: Agent = AGENT) {
  const onClose = vi.fn()
  const onMoved = vi.fn()
  render(
    <MoveAgentModal
      open
      onClose={onClose}
      agent={agent}
      organizations={ORGANIZATIONS}
      onMoved={onMoved}
    />,
  )
  return { onClose, onMoved }
}

/** The dialog behind an opener button, so focus return has somewhere to go. */
function Harness() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open move
      </button>
      <MoveAgentModal
        open={open}
        onClose={() => setOpen(false)}
        agent={AGENT}
        organizations={ORGANIZATIONS}
        onMoved={vi.fn()}
      />
    </>
  )
}

describe('MoveAgentModal', () => {
  it('opens on the agent’s current placement with every organisation as an option', () => {
    renderModal()
    expect(screen.getByRole('dialog', { name: 'Move Food' })).toBeInTheDocument()
    expect(screen.getByText('Choose where the agent is filed.')).toBeInTheDocument()
    const picker = screen.getByLabelText('Organisation')
    expect(picker).toHaveValue('')
    expect(screen.getByRole('option', { name: 'Acme / Tech Agents' })).toBeInTheDocument()
    // Nothing to save until the placement changes.
    expect(screen.getByRole('button', { name: 'Move agent' })).toBeDisabled()
  })

  it('moves the agent with one PUT and hands the updated agent back', async () => {
    const { onClose, onMoved } = renderModal()
    fireEvent.change(screen.getByLabelText('Organisation'), { target: { value: 'org-2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Move agent' }))

    await vi.waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/agents/agent-1', { organization_id: 'org-2' }),
    )
    await vi.waitFor(() => expect(onMoved).toHaveBeenCalledWith({ ...AGENT, organization_id: 'org-2' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('sends null for Top level', async () => {
    renderModal({ ...AGENT, organization_id: 'org-2' })
    fireEvent.change(screen.getByLabelText('Organisation'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Move agent' }))

    await vi.waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/agents/agent-1', { organization_id: null }),
    )
  })

  it('shows a failed move inline and keeps the dialog open', async () => {
    mockPut.mockRejectedValueOnce(new Error('The agent could not be moved.'))
    const { onClose } = renderModal()
    fireEvent.change(screen.getByLabelText('Organisation'), { target: { value: 'org-2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Move agent' }))

    await vi.waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('The agent could not be moved.'),
    )
    expect(screen.getByRole('dialog', { name: 'Move Food' })).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    // The action is re-enabled for a retry.
    expect(screen.getByRole('button', { name: 'Move agent' })).toBeEnabled()
  })

  it('Escape closes the dialog and returns focus to its opener', async () => {
    render(<Harness />)
    const opener = screen.getByRole('button', { name: 'Open move' })
    opener.focus()
    fireEvent.click(opener)
    expect(screen.getByRole('dialog', { name: 'Move Food' })).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(opener).toHaveFocus())
  })

  it('keeps the dialog open on Escape while the move is in flight', async () => {
    let resolvePut: (value: unknown) => void = () => {}
    mockPut.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolvePut = resolve
      }),
    )
    renderModal()
    fireEvent.change(screen.getByLabelText('Organisation'), { target: { value: 'org-2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Move agent' }))
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Moving…' })).toBeInTheDocument())

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.getByRole('dialog', { name: 'Move Food' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled()

    await act(async () => {
      resolvePut({ ...AGENT, organization_id: 'org-2' })
    })
  })
})
