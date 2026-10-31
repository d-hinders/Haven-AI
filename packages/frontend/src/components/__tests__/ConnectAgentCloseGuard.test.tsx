/**
 * The connect flow's close guard (#4570), rendered with the REAL flow hook.
 *
 * Closing the flow while a one-time manual credential is unsaved used to be the
 * app's only `window.confirm`. It is now an INLINE panel inside the flow, so
 * both containers get the same question and neither nests a dialog:
 * `ConnectAgentModal` already wraps the flow in a `Modal`, and `ConfirmDialog`
 * is itself a `Modal`.
 *
 * What this pins:
 * - the panel appears instead of closing, and the flow's own dialog count does
 *   not change (one in the modal, none inline);
 * - Cancel keeps the credential and stays in the flow;
 * - Confirm drops it and leaves;
 * - Escape dismisses the PANEL, not the flow — including inline, where Escape
 *   is otherwise unbound (#4065).
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react'
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
import { ConnectAgentFlow } from '../connect-agent/ConnectAgentFlow'

const SETUP = {
  setup_id: 'setup-1',
  setup_token: 'hvn_setup_token',
  setup_prompt: 'Connect to Haven with this prompt.',
  connector_command: 'npx -y @haven_ai/connect@alpha --setup hvn_setup_token',
  expires_at: '2099-01-01T00:00:00.000Z',
  status: 'awaiting_connection',
}

const RESOLVED = {
  agent: { name: 'Research agent', description: null },
  haven_wallet: {
    id: SAFE.id,
    name: SAFE.name,
    address: SAFE.account_address,
    chain_id: 84532,
    network: 'Base Sepolia',
  },
  agent_budget: [],
  challenge: { id: 'challenge-1', message: 'Sign to prove control of this delegate address' },
  hosted_mcp_url: 'https://mcp.haven.example',
}

const REGISTERED = {
  setup_id: 'setup-1',
  agent_id: 'agent-1',
  status: 'connected_local',
  delegate_address: '0x3333333333333333333333333333333333333333',
  hosted_mcp_url: 'https://mcp.haven.example',
}

function pressEscape() {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
}

/** Name → Budget → Create: the setup exists and the flow is on step 3. */
async function startSetup() {
  fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'Research agent' } })
  fireEvent.click(screen.getByRole('button', { name: 'Set agent budget' }))
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Create setup prompt' }))
  })
}

/**
 * Generate the one-time manual credential. Its disclosure is a `<details>`, but
 * the button is in the DOM whether or not it is expanded, so no toggle is
 * needed — and the credential is unsaved from this moment on.
 */
async function generateManualCredential() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Generate credentials' }))
  })
  // The credential is unsaved from this moment on: the flow shows it once.
  expect(
    await screen.findByText('The signing key is shown once. If it leaks, replace it from the agent page.'),
  ).toBeInTheDocument()
}

const guard = () => screen.queryByTestId('connect-close-guard')

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
  mockApiPost.mockImplementation(async (path: string) => {
    if (path === '/agent-connection-setups/resolve') return RESOLVED
    if (path === '/agent-connection-setups/register') return REGISTERED
    return SETUP
  })
})

describe('connect flow close guard — modal container (#4570)', () => {
  it('asks instead of closing, and adds no second dialog', async () => {
    const onClose = vi.fn()
    render(<ConnectAgentModal open onClose={onClose} accountId={SAFE.id} starterAllowance />)
    await startSetup()
    await generateManualCredential()

    // The modal is the flow's own dialog, and the only one.
    expect(screen.getAllByRole('dialog')).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    expect(onClose).not.toHaveBeenCalled()
    expect(guard()).toBeInTheDocument()
    // The panel is a labelled group, not a dialog: the count is unchanged.
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(guard()).toHaveAttribute('role', 'group')
  })

  it('Cancel keeps the one-time credential and stays in the flow', async () => {
    const onClose = vi.fn()
    render(<ConnectAgentModal open onClose={onClose} accountId={SAFE.id} starterAllowance />)
    await startSetup()
    await generateManualCredential()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    fireEvent.click(within(guard()!).getByRole('button', { name: 'Cancel' }))

    expect(guard()).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    // The credential is still on screen — Cancel kept it.
    expect(
      screen.getByText('The signing key is shown once. If it leaks, replace it from the agent page.'),
    ).toBeInTheDocument()
  })

  it('Confirm clears the credential and leaves', async () => {
    const onClose = vi.fn()
    render(<ConnectAgentModal open onClose={onClose} accountId={SAFE.id} starterAllowance />)
    await startSetup()
    await generateManualCredential()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    fireEvent.click(within(guard()!).getByRole('button', { name: 'Close anyway' }))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(guard()).not.toBeInTheDocument()
  })

  it('Escape dismisses the panel, not the flow', async () => {
    const onClose = vi.fn()
    render(<ConnectAgentModal open onClose={onClose} accountId={SAFE.id} starterAllowance />)
    await startSetup()
    await generateManualCredential()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(guard()).toBeInTheDocument()

    pressEscape()

    expect(guard()).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    expect(
      screen.getByText('The signing key is shown once. If it leaks, replace it from the agent page.'),
    ).toBeInTheDocument()
  })
})

describe('connect flow close guard — inline container (#4570)', () => {
  /**
   * The inline flow is `ConnectAgentFlow` with `inline`, mounted by
   * `InlineAgentSetup` inside `AgentPanel` with no modal parent. The harness
   * supplies the one thing a container supplies — a control that calls
   * `flow.handleClose` — because the inline container has no close affordance
   * of its own (#4065: there is nothing for Escape to dismiss there). The
   * panel, the hook and the step body are the real ones.
   */
  function renderInline(onClose: () => void) {
    return render(
      <ConnectAgentFlow inline open onClose={onClose} accountId={SAFE.id} starterAllowance>
        {({ flow, steps }) => (
          <div>
            <button type="button" onClick={flow.handleClose}>
              Leave the flow
            </button>
            {steps}
          </div>
        )}
      </ConnectAgentFlow>,
    )
  }

  it('asks instead of closing, with no dialog at all', async () => {
    const onClose = vi.fn()
    renderInline(onClose)
    await startSetup()
    await generateManualCredential()

    // No modal parent: the inline flow has no dialog, and the panel adds none.
    expect(screen.queryAllByRole('dialog')).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Leave the flow' }))

    expect(onClose).not.toHaveBeenCalled()
    expect(guard()).toBeInTheDocument()
    expect(screen.queryAllByRole('dialog')).toHaveLength(0)
  })

  it('Cancel keeps the credential; Confirm clears it', async () => {
    const onClose = vi.fn()
    renderInline(onClose)
    await startSetup()
    await generateManualCredential()

    fireEvent.click(screen.getByRole('button', { name: 'Leave the flow' }))
    fireEvent.click(within(guard()!).getByRole('button', { name: 'Cancel' }))
    expect(onClose).not.toHaveBeenCalled()
    expect(
      screen.getByText('The signing key is shown once. If it leaks, replace it from the agent page.'),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Leave the flow' }))
    fireEvent.click(within(guard()!).getByRole('button', { name: 'Close anyway' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Escape dismisses the panel even though the inline flow binds no Escape', async () => {
    const onClose = vi.fn()
    renderInline(onClose)
    await startSetup()
    await generateManualCredential()
    fireEvent.click(screen.getByRole('button', { name: 'Leave the flow' }))
    expect(guard()).toBeInTheDocument()

    pressEscape()

    expect(guard()).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })
})
