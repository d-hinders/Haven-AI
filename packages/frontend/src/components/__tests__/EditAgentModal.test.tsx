import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import EditAgentModal from '../EditAgentModal'
import type { Agent } from '@/hooks/useAgents'

const mockPut = vi.fn()

vi.mock('@/lib/api', () => ({
  api: { put: (...args: unknown[]) => mockPut(...args) },
}))

const AGENT: Agent = {
  id: 'agent-1',
  name: 'Food',
  description: 'Foodie',
  delegate_address: '0x2222222222222222222222222222222222222222',
  safe_id: 'safe-1',
  safe_address: '0x1111111111111111111111111111111111111111',
  safe_name: 'Operating wallet',
  safe_chain_id: 100,
  account_type: 'safe',
  api_key_prefix: 'sk_agent_abc',
  status: 'active',
  created_at: '2026-05-01T00:00:00Z',
  allowances: [],
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPut.mockResolvedValue({})
})

function renderModal() {
  const onClose = vi.fn()
  const onUpdated = vi.fn()
  render(<EditAgentModal open onClose={onClose} agent={AGENT} onUpdated={onUpdated} />)
  return { onClose, onUpdated }
}

describe('EditAgentModal', () => {
  it('edits identity only and has no budget controls', () => {
    renderModal()

    expect(screen.getByRole('heading', { name: 'Edit agent' })).toBeInTheDocument()
    expect(screen.getByLabelText('Agent name')).toHaveValue('Food')
    expect(screen.getByLabelText(/Description/)).toHaveValue('Foodie')
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
})
