import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const { mockGet, mockPost, mockDelete, mockApply } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockDelete: vi.fn(),
  mockApply: vi.fn(),
}))

vi.mock('@/lib/api', () => ({ api: { get: mockGet, post: mockPost, delete: mockDelete } }))
vi.mock('@/hooks/useApplySchedule', () => ({
  useApplySchedule: () => ({ apply: mockApply, applying: false, ready: true }),
}))
vi.mock('@/components/ui/Toast', () => ({
  useToast: () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }) }),
}))

const AgentRecipientsCard = (await import('../AgentRecipientsCard')).default

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const RECIPIENT = '0x' + 'ab'.repeat(20)
const PROPS = {
  agentId: 'agent-1',
  safeAddress: '0x' + 'cd'.repeat(20),
  chainId: 84532,
  safeDetails: { threshold: 1 } as never,
  tokenAddress: USDC,
  tokenSymbol: 'USDC',
  tokenDecimals: 6,
}

function mockApi(opts: { sessionRail?: boolean; recipients?: unknown[] } = {}) {
  mockGet.mockImplementation((path: string) => {
    if (path.endsWith('/schedule')) {
      return Promise.resolve({ session_rail: opts.sessionRail ?? true, enabled: true })
    }
    return Promise.resolve({
      recipients:
        opts.recipients ??
        [{
          recipient_address: RECIPIENT,
          token_address: USDC,
          label: 'API provider',
          effective_budget: '5000000',
          inherits_allowance: true,
        }],
    })
  })
}

describe('AgentRecipientsCard (#796)', () => {
  it('lists recipients with the resolved budget, jargon-free', async () => {
    mockApi()
    render(<AgentRecipientsCard {...PROPS} />)
    await waitFor(() => expect(screen.getByText('API provider')).toBeTruthy())
    expect(screen.getByText(/5 USDC \(full budget\)/)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/session|permission/i)
  })

  it('renders nothing on a legacy-rail account', async () => {
    mockApi({ sessionRail: false })
    const { container } = render(<AgentRecipientsCard {...PROPS} />)
    await waitFor(() => expect(mockGet).toHaveBeenCalled())
    expect(container.textContent).toBe('')
  })

  it('adding a recipient saves the row and surfaces the sign-to-apply step', async () => {
    mockApi()
    mockPost.mockResolvedValue({ id: 'row-2', applied_on_chain: false })
    render(<AgentRecipientsCard {...PROPS} />)
    await waitFor(() => expect(screen.getByText('API provider')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('Recipient address'), {
      target: { value: '0x' + 'ef'.repeat(20) },
    })
    fireEvent.click(screen.getByText('Add'))

    await waitFor(() => expect(screen.getByText('Sign to apply')).toBeTruthy())
    expect(mockPost).toHaveBeenCalledWith('/agents/agent-1/recipients', {
      recipient_address: '0x' + 'ef'.repeat(20),
      token_address: USDC,
      label: null,
    })
    expect(screen.getByText(/saved but not active yet/)).toBeTruthy()
  })

  it('Add stays disabled for an invalid address', async () => {
    mockApi()
    render(<AgentRecipientsCard {...PROPS} />)
    await waitFor(() => expect(screen.getByText('Add')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Recipient address'), { target: { value: 'not-an-address' } })
    expect((screen.getByText('Add') as HTMLButtonElement).disabled).toBe(true)
  })

  it('sign-to-apply runs the shared apply flow and clears the pending state', async () => {
    mockApi()
    mockDelete.mockResolvedValue({ removed: 1, applied_on_chain: false })
    mockApply.mockResolvedValue({ ok: true })
    render(<AgentRecipientsCard {...PROPS} />)
    await waitFor(() => expect(screen.getByText('Remove')).toBeTruthy())

    fireEvent.click(screen.getByText('Remove'))
    await waitFor(() => expect(screen.getByText('Sign to apply')).toBeTruthy())

    fireEvent.click(screen.getByText('Sign to apply'))
    await waitFor(() => expect(mockApply).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByText('Sign to apply')).toBeNull())
  })
})
