import { afterEach, describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import PaymentCredentialsModal from '@/components/PaymentCredentialsModal'

const { mockToastError, mockToastSuccess } = vi.hoisted(() => ({
  mockToastError: vi.fn(),
  mockToastSuccess: vi.fn(),
}))

vi.mock('@/components/ui/Toast', () => ({
  useToast: () => ({
    toast: Object.assign(vi.fn(), { success: mockToastSuccess, error: mockToastError }),
  }),
}))
vi.mock('@/lib/api', () => ({ api: { post: vi.fn(), get: vi.fn() } }))

const originalClipboard = navigator.clipboard

afterEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard })
})

describe('PaymentCredentialsModal leak guidance (#3722)', () => {
  const agent = {
    id: 'agent-1',
    name: 'Research Agent',
    api_key_prefix: 'sk_agent_ab',
    delegate_address: '0x1111111111111111111111111111111111111111',
    created_at: '2026-10-07T00:00:00Z',
  }

  it('points a compromised key at Replace signing key or Remove agent…, never "revoke the agent and create a new one"', () => {
    const { container } = render(<PaymentCredentialsModal open onClose={() => {}} agent={agent} />)
    const text = (container.ownerDocument.body.textContent ?? '').replace(/\s+/g, ' ')
    expect(text).toContain('If you suspect this agent’s signing key is compromised, choose Replace signing key from this agent’s menu, or Remove agent… to end its budgets.')
    expect(text).not.toMatch(/open the agent/)
    expect(text).toContain('The key also controls any funds already at this address; ending the budget does not recover them.')
    expect(text).not.toMatch(/revoke the agent and create a new one/)
  })
})

describe('PaymentCredentialsModal copy (#4573)', () => {
  const agentWithKey = {
    id: 'agent-1',
    name: 'Research Agent',
    api_key: 'sk_agent_full_credential',
    api_key_prefix: 'sk_agent_ab',
    delegate_address: '0x1111111111111111111111111111111111111111',
    created_at: '2026-10-07T00:00:00Z',
  }

  it('tells the user when a one-time credential copy fails, and never claims success', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    })
    render(<PaymentCredentialsModal open onClose={() => {}} agent={agentWithKey} />)

    fireEvent.click(screen.getByRole('button', { name: 'Copy credential' }))

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('Could not copy credential'))
    // A rejected write copied nothing: no inline "Copied", no success toast.
    expect(screen.queryByRole('button', { name: 'Credential copied' })).toBeNull()
    expect(mockToastSuccess).not.toHaveBeenCalled()
  })

  it('confirms a successful credential copy inline, without a toast as well', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
    render(<PaymentCredentialsModal open onClose={() => {}} agent={agentWithKey} />)

    fireEvent.click(screen.getByRole('button', { name: 'Copy credential' }))

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Credential copied' })).toBeInTheDocument(),
    )
    expect(mockToastSuccess).not.toHaveBeenCalled()
    expect(mockToastError).not.toHaveBeenCalled()
  })
})
