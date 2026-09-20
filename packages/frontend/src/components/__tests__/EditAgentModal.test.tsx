import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import EditAgentModal from '../EditAgentModal'
import type { Agent } from '@/hooks/useAgents'

const mockPut = vi.fn()
const mockGet = vi.fn()
const mockPost = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    put: (...args: unknown[]) => mockPut(...args),
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
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
}

const VOCABULARY = {
  labels: [
    { id: 'label-1', name: 'prod', color: 'brand', created_at: '2026-05-01T00:00:00Z' },
    { id: 'label-2', name: 'finance', color: 'debit', created_at: '2026-05-01T00:00:00Z' },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPut.mockResolvedValue({})
  mockGet.mockResolvedValue(VOCABULARY)
  mockPost.mockResolvedValue(VOCABULARY.labels[0])
})

function renderModal(agent: Agent = AGENT) {
  const onClose = vi.fn()
  const onUpdated = vi.fn()
  render(<EditAgentModal open onClose={onClose} agent={agent} onUpdated={onUpdated} />)
  return { onClose, onUpdated }
}

describe('EditAgentModal', () => {
  it('edits identity and labels and has no budget controls', () => {
    renderModal()

    expect(screen.getByRole('heading', { name: 'Edit agent' })).toBeInTheDocument()
    expect(screen.getByLabelText('Agent name')).toHaveValue('Food')
    expect(screen.getByLabelText(/Description/)).toHaveValue('Foodie')
    expect(screen.getByText('Labels')).toBeInTheDocument()
    expect(screen.queryByText(/budget/i)).not.toBeInTheDocument()
  })

  it('saves a changed name and description', async () => {
    const { onUpdated } = renderModal()
    fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'Meals' } })
    fireEvent.change(screen.getByLabelText(/Description/), { target: { value: 'Dinner plans' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save details' }))

    await vi.waitFor(() => expect(mockPut).toHaveBeenCalledWith('/agents/agent-1', {
      name: 'Meals',
      description: 'Dinner plans',
    }))
    expect(onUpdated).toHaveBeenCalledTimes(1)
  })

  it('loads the vocabulary and tags the agent with one PUT on save', async () => {
    const { onUpdated } = renderModal()
    // The vocabulary arrives; both labels are unchecked for an unlabelled agent.
    await vi.waitFor(() => expect(screen.getByRole('checkbox', { name: 'prod' })).not.toBeChecked())

    fireEvent.click(screen.getByRole('checkbox', { name: 'prod' }))
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    // The review step previews the chips the agent will carry.
    expect(screen.getByTestId('review-label-chips')).toHaveTextContent('prod')

    fireEvent.click(screen.getByRole('button', { name: 'Save details' }))
    await vi.waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/agents/agent-1/labels', { label_ids: ['label-1'] }),
    )
    // Identity unchanged: no PUT to /agents/:id at all.
    expect(mockPut).toHaveBeenCalledTimes(1)
    expect(mockPut).toHaveBeenCalledWith('/agents/agent-1/labels', expect.anything())
    await vi.waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(1))
  })

  it('creating a label inline selects it for the agent', async () => {
    const { onUpdated } = renderModal()
    await vi.waitFor(() => expect(screen.getByLabelText('New label name')).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText('New label name'), { target: { value: 'Prod' } })
    // An existing label of the same (case-folded) name is SELECTED, not duplicated.
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await vi.waitFor(() => expect(screen.getByRole('checkbox', { name: 'prod' })).toBeChecked())
    expect(mockPost).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save details' }))
    await vi.waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/agents/agent-1/labels', { label_ids: ['label-1'] }),
    )
  })

  it('a tagging-only change can be reviewed and saved without touching identity', async () => {
    const labelled: Agent = {
      ...AGENT,
      labels: [{ id: 'label-1', name: 'prod', color: 'brand', created_at: '2026-05-01T00:00:00Z' }],
    }
    renderModal(labelled)
    await vi.waitFor(() => expect(screen.getByRole('checkbox', { name: 'prod' })).toBeChecked())

    fireEvent.click(screen.getByRole('checkbox', { name: 'prod' })) // untag
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    expect(screen.getByTestId('review-label-chips')).toHaveTextContent('No labels')
    fireEvent.click(screen.getByRole('button', { name: 'Save details' }))

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/agents/agent-1/labels', { label_ids: [] }),
    )
    expect(mockPut).not.toHaveBeenCalledWith('/agents/agent-1', expect.anything())
  })
})
