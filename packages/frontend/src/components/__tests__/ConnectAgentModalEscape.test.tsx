/**
 * Escape on the connect-agent MODAL, rendered with the real flow hook (#4065).
 *
 * The hook's own test mocks `useEscapeToClose`
 * (`useAgentConnectionSetup.test.tsx`), and `ConnectAgentModal.test.tsx`
 * mocks the whole hook, so until this file nothing proved that a real
 * `keydown` on `window` closes the modal and resets its form. #4065 gives the
 * hook an Escape opt-out for the inline first-agent flow; these cases pin
 * that the modal keeps the default.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { SAFE, mockUseAuth, mockApiPost, mockUseAgentConnectionSetupStatus } = vi.hoisted(() => ({
  SAFE: {
    id: 'safe-1',
    name: 'Operating wallet',
    account_address: '0x1111111111111111111111111111111111111111',
    chain_id: 84532,
    is_default: true,
    created_at: '2026-01-01T00:00:00.000Z',
    account_type: 'delegator_hybrid',
  },
  mockUseAuth: vi.fn(),
  mockApiPost: vi.fn(),
  mockUseAgentConnectionSetupStatus: vi.fn(),
}))

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined, chain: undefined }),
  useSwitchChain: () => ({ switchChain: vi.fn(), isPending: false }),
}))

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}))

vi.mock('@/hooks/useAgentConnectionSetupStatus', () => ({
  useAgentConnectionSetupStatus: (setupId: string | null, options: unknown) =>
    mockUseAgentConnectionSetupStatus(setupId, options),
}))

vi.mock('@/lib/api', () => ({
  api: { post: (...args: unknown[]) => mockApiPost(...args), get: vi.fn() },
  getResolvedApiBaseUrl: () => 'https://api.haven.example',
}))

import ConnectAgentModal from '../ConnectAgentModal'

function pressEscape() {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockUseAuth.mockReturnValue({ user: { accounts: [SAFE] } })
  mockUseAgentConnectionSetupStatus.mockReturnValue({
    data: null,
    loading: false,
    error: null,
    refetch: vi.fn(),
    awaitingConnectionStage: 'starting',
  })
})

describe('ConnectAgentModal Escape, rendered with the real flow hook', () => {
  it('closes the modal and resets the form on a keydown on window', () => {
    const onClose = vi.fn()
    const { rerender } = render(<ConnectAgentModal open onClose={onClose} accountId={SAFE.id} />)
    fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'Research agent' } })

    pressEscape()

    expect(onClose).toHaveBeenCalledTimes(1)
    // The parent closes it; reopening shows a fresh form, so Escape reset it.
    rerender(<ConnectAgentModal open={false} onClose={onClose} accountId={SAFE.id} />)
    rerender(<ConnectAgentModal open onClose={onClose} accountId={SAFE.id} />)
    expect(screen.getByLabelText('Agent name')).toHaveValue('')
  })

  it('does not close while the setup is being created', async () => {
    mockApiPost.mockReturnValue(new Promise(() => {}))
    const onClose = vi.fn()
    render(<ConnectAgentModal open onClose={onClose} accountId={SAFE.id} starterAllowance />)
    fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'Research agent' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set agent budget' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create setup prompt' }))
    })
    expect(screen.getByRole('button', { name: 'Creating setup...' })).toBeDisabled()

    pressEscape()

    expect(onClose).not.toHaveBeenCalled()
  })

  it('binds nothing while closed', () => {
    const onClose = vi.fn()
    render(<ConnectAgentModal open={false} onClose={onClose} accountId={SAFE.id} />)

    pressEscape()

    expect(onClose).not.toHaveBeenCalled()
  })
})

/**
 * #4065: the modal is unchanged by the inline container. Two of the three
 * inline differences are pinned here from the modal's side.
 */
describe('ConnectAgentModal keeps its own chrome, rendered with the real flow hook', () => {
  it('keeps Cancel on step 1', () => {
    render(<ConnectAgentModal open onClose={vi.fn()} accountId={SAFE.id} />)

    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('keeps each step-3 disclosure CopyBlock a standalone Card', async () => {
    mockApiPost.mockResolvedValue({
      setup_id: 'setup-1',
      setup_token: 'hvn_setup_token',
      setup_prompt: 'Connect to Haven with this prompt.',
      connector_command: 'npx -y @haven_ai/connect@alpha --setup hvn_setup_token',
      expires_at: '2099-01-01T00:00:00.000Z',
      status: 'awaiting_connection',
    })
    render(<ConnectAgentModal open onClose={vi.fn()} accountId={SAFE.id} starterAllowance />)
    fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'Research agent' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set agent budget' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create setup prompt' }))
    })

    const label = screen.getByText('Local command')
    expect(label.closest('.shadow-card')).not.toBeNull()
  })
})
