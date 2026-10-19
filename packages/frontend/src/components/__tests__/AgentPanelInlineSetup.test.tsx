/**
 * The inline first-agent flow on `/agents` (#4065), rendered with the REAL
 * shared flow (`ConnectAgentFlow`), the real flow hook and the real modal
 * container. Only the network edges are mocked: the agents list, the setup
 * status poll, `api.post`, wagmi, and the passkey approval step.
 *
 * What it pins:
 * - the latch: the flow stays mounted while a `pending_approval` agent joins
 *   the list, while an approval is in flight and while `finalizingAgent` is
 *   true, and nothing else of the agents surface renders meanwhile;
 * - Escape: a real `keydown` on `window` never resets it, including the
 *   Escape that closes the Labels or Organizations manager above it;
 * - every leave path leaves it — to the list with agents, to a FRESH flow
 *   (starter budget seeded again) without;
 * - step 1 has no Cancel inline, and the page never autofocuses on load.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  SAFE,
  mockUseAuth,
  mockUseAgents,
  mockApiPost,
  mockUseAgentConnectionSetupStatus,
  statusState,
  approvalGate,
} = vi.hoisted(() => ({
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
  mockUseAgents: vi.fn(),
  mockApiPost: vi.fn(),
  mockUseAgentConnectionSetupStatus: vi.fn(),
  // The polled setup status the flow reads once a setup exists.
  statusState: { data: null as Record<string, unknown> | null },
  // An approval held unresolved: the stub awaits this before `onApproved`.
  approvalGate: { release: null as null | (() => void) },
}))

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined, chain: undefined }),
  useSwitchChain: () => ({ switchChain: vi.fn(), isPending: false }),
}))

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}))

vi.mock('@/hooks/useAgents', () => ({
  useAgents: () => mockUseAgents(),
}))

vi.mock('@/hooks/useOrganizations', () => ({
  useOrganizations: () => ({
    organizations: [],
    loading: false,
    error: null,
    fetchOrganizations: vi.fn(),
    createOrganization: vi.fn(),
    updateOrganization: vi.fn(),
    deleteOrganization: vi.fn(),
  }),
}))

vi.mock('@/hooks/useLabels', () => ({
  useLabels: () => ({
    labels: [],
    loading: false,
    error: null,
    fetchLabels: vi.fn(),
    createLabel: vi.fn(),
    updateLabel: vi.fn(),
    deleteLabel: vi.fn(),
    putAgentLabels: vi.fn(),
  }),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/agents',
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('@/hooks/useAgentConnectionSetupStatus', () => ({
  useAgentConnectionSetupStatus: (setupId: string | null, options: { enabled?: boolean }) =>
    mockUseAgentConnectionSetupStatus(setupId, options),
}))

vi.mock('@/lib/api', () => ({
  api: { post: (...args: unknown[]) => mockApiPost(...args), get: vi.fn() },
  getResolvedApiBaseUrl: () => 'https://api.haven.example',
}))

// The passkey step is proven in its own suite. Here it stands in for an
// approval the user starts and the chain has not confirmed yet: `onApproved`
// fires only once the test releases the gate.
vi.mock('@/components/connect-agent/DelegationApprovalStep', async () => {
  const { useState } = await import('react')
  return {
    DelegationApprovalStep: ({
      onApproved,
      onClose,
    }: {
      onApproved: () => Promise<void>
      onClose: () => void
    }) => {
      const [approving, setApproving] = useState(false)
      return (
        <div>
          {approving ? <p>stub: approval in flight</p> : null}
          <button
            type="button"
            onClick={() => {
              setApproving(true)
              void new Promise<void>((resolve) => {
                approvalGate.release = resolve
              }).then(onApproved)
            }}
          >
            stub: approve
          </button>
          <button type="button" onClick={onClose}>
            stub: close approval
          </button>
        </div>
      )
    },
  }
})

import AgentPanel from '../AgentPanel'

const SETUP = {
  setup_id: 'setup-1',
  setup_token: 'hvn_setup_token',
  setup_prompt: 'Connect to Haven with this prompt.',
  connector_command: 'npx -y @haven_ai/connect@alpha --setup hvn_setup_token',
  expires_at: '2099-01-01T00:00:00.000Z',
  status: 'awaiting_connection',
}

const PENDING_AGENT = {
  id: 'agent-1',
  name: 'Research agent',
  description: null,
  delegate_address: '0x2222222222222222222222222222222222222222',
  status: 'pending_approval',
  created_at: '2026-10-19T00:00:00.000Z',
  account_chain_id: SAFE.chain_id,
  archived_at: null,
  allowances: [],
  labels: [],
}

function status(kind: string): Record<string, unknown> {
  return {
    setup_id: SETUP.setup_id,
    status: kind,
    agent_id: PENDING_AGENT.id,
    delegate_address: PENDING_AGENT.delegate_address,
    runtime: 'claude_code',
    failure_reason: null,
    install_status: {
      local_mcp_configured: true,
      local_mcp_acknowledged: true,
      skill_installed: true,
      manual_credential_fallback: false,
    },
    agent: { name: PENDING_AGENT.name },
    agent_budget: [],
    haven_wallet: { id: SAFE.id, name: SAFE.name, chain_id: SAFE.chain_id, network: 'Base Sepolia' },
  }
}

let agentsList: unknown[] = []
let refetchImpl: () => Promise<unknown> = async () => agentsList

function setAgentsList(list: unknown[], extra: Record<string, unknown> = {}) {
  agentsList = list
  mockUseAgents.mockReturnValue({
    agents: list,
    loading: false,
    error: null,
    revokeAgent: vi.fn(),
    pauseAgent: vi.fn(),
    resumeAgent: vi.fn(),
    archiveAgent: vi.fn(),
    unarchiveAgent: vi.fn(),
    refetch: vi.fn(() => refetchImpl()),
    ...extra,
  })
}

const inlineFlow = () => screen.queryByRole('region', { name: 'Connect your first agent' })

/** The header's "Agents N" count chip (its text is split across a span). */
const countChip = () =>
  screen.queryByText(
    (_content, element) =>
      element?.tagName === 'DIV' &&
      element.firstElementChild?.tagName === 'SPAN' &&
      /^Agents\s*\d+$/.test(element.textContent?.trim() ?? ''),
  )

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

/** The surface the latch must keep hidden: chip, header button, list, placeholder. */
function expectNothingElseOfTheSurface() {
  expect(screen.queryByTestId('agent-card')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Connect agent' })).not.toBeInTheDocument()
  expect(countChip()).not.toBeInTheDocument()
  expect(screen.queryByTestId('agent-list-toolbar')).not.toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: 'Finalizing your agent…' })).not.toBeInTheDocument()
  expect(screen.queryByRole('status', { name: 'Finalizing agent setup' })).not.toBeInTheDocument()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
}

beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState(null, '', '/agents')
  mockUseAuth.mockReturnValue({ user: { accounts: [SAFE] } })
  statusState.data = null
  approvalGate.release = null
  refetchImpl = async () => agentsList
  setAgentsList([])
  mockApiPost.mockResolvedValue(SETUP)
  mockUseAgentConnectionSetupStatus.mockImplementation(
    (setupId: string | null, options: { enabled?: boolean }) => ({
      data: setupId && options?.enabled !== false ? statusState.data : null,
      loading: false,
      error: null,
      refetch: vi.fn(async () => undefined),
      awaitingConnectionStage: 'starting',
    }),
  )
})

afterEach(() => {
  window.history.replaceState(null, '', '/')
})

describe('AgentPanel inline first-agent flow (#4065)', () => {
  it('replaces the empty state for a user with no agents, without the chip or the header button', () => {
    render(<AgentPanel />)

    const flow = inlineFlow()
    expect(flow).toBeInTheDocument()
    expect(within(flow!).getByRole('heading', { name: 'Connect your first agent' })).toBeInTheDocument()
    expect(within(flow!).getByText('Step 1 of 3', { exact: false })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'No agents yet' })).not.toBeInTheDocument()
    expect(screen.queryByText('Set up with your AI agent')).not.toBeInTheDocument()
    // Owner decision 2026-10-19: no "Agents 0" chip, no header Connect agent.
    expect(countChip()).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Connect agent' })).not.toBeInTheDocument()
    // Labels and Organizations stay.
    expect(screen.getByRole('button', { name: 'Labels' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Organizations' })).toBeInTheDocument()
  })

  it('has no Cancel on step 1 — the one action is Set agent budget', () => {
    render(<AgentPanel />)

    const flow = inlineFlow()!
    expect(within(flow).queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
    expect(within(flow).getByRole('button', { name: 'Set agent budget' })).toBeInTheDocument()
  })

  it('never autofocuses on page load', () => {
    render(<AgentPanel />)

    expect(screen.getByLabelText('Agent name')).not.toHaveFocus()
    expect(document.activeElement).toBe(document.body)
  })

  it('opens with the starter budget prefilled', () => {
    render(<AgentPanel />)
    fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'Research agent' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set agent budget' }))

    expect(screen.getByPlaceholderText('Amount')).toHaveValue('10')
  })

  it('does not render while the first list load is in flight', () => {
    setAgentsList([], { loading: true })
    render(<AgentPanel />)

    expect(inlineFlow()).not.toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'Loading agents' })).toBeInTheDocument()
  })

  it('does not render with agents: the list and the header Connect agent show', () => {
    setAgentsList([{ ...PENDING_AGENT, status: 'active' }])
    render(<AgentPanel />)

    expect(inlineFlow()).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect agent' })).toBeInTheDocument()
    // The chip matcher can say yes: with agents it finds the chip.
    expect(countChip()).toHaveTextContent('1')
  })
})

describe('the latch: inline stays mounted until the user leaves (#4065)', () => {
  // Review round 1: the latch is set when a SETUP starts, not when the flow
  // mounts. An idle step 1 must not trap a user whose agent was created
  // elsewhere (another tab, an agent-led link) behind a flow with no Cancel.
  it.each([
    ['a pristine step 1', () => {}],
    ['step 1 with a typed name', () => {
      fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'Research agent' } })
    }],
    ['step 2, before the create', () => {
      fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'Research agent' } })
      fireEvent.click(screen.getByRole('button', { name: 'Set agent budget' }))
    }],
  ])('does not latch on %s: an agent created elsewhere brings the list back', (_label, interact) => {
    const { rerender } = render(<AgentPanel />)
    interact()

    setAgentsList([{ ...PENDING_AGENT, status: 'active' }])
    rerender(<AgentPanel />)

    expect(inlineFlow()).not.toBeInTheDocument()
    expect(screen.getByTestId('agent-card')).toHaveTextContent('Research agent')
    expect(screen.getByRole('button', { name: 'Connect agent' })).toBeInTheDocument()
    expect(countChip()).toHaveTextContent('1')
  })

  it('a non-silent list refresh keeps an unlatched step 2 as typed — no skeleton, no remount', () => {
    const { rerender } = render(<AgentPanel />)
    fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'Research agent' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set agent budget' }))
    fireEvent.change(screen.getByPlaceholderText('Amount'), { target: { value: '25' } })

    // A Labels change refetches non-silently: `loading` goes true, then false.
    setAgentsList([], { loading: true })
    rerender(<AgentPanel />)
    expect(screen.queryByRole('status', { name: 'Loading agents' })).not.toBeInTheDocument()
    expect(screen.getByPlaceholderText('Amount')).toHaveValue('25')

    setAgentsList([])
    rerender(<AgentPanel />)
    expect(inlineFlow()).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Amount')).toHaveValue('25')
  })

  it('latches while the create is in flight: an agent appearing then does not orphan the setup', async () => {
    mockApiPost.mockReturnValue(new Promise(() => {}))
    const { rerender } = render(<AgentPanel />)
    fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'Research agent' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set agent budget' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create setup prompt' }))
    })

    setAgentsList([{ ...PENDING_AGENT, status: 'active' }])
    rerender(<AgentPanel />)

    expect(within(inlineFlow()!).getByRole('button', { name: 'Creating setup...' })).toBeDisabled()
    expect(screen.queryByTestId('agent-card')).not.toBeInTheDocument()
  })

  it('latches once the setup is created, even before the connector registers', async () => {
    const { rerender } = render(<AgentPanel />)
    await startSetup()

    // A refetch that fails while the setup waits must not swap the flow for
    // the "Agents could not load" state.
    setAgentsList([], { error: 'request failed' })
    rerender(<AgentPanel />)

    expect(within(inlineFlow()!).getByText('Copy setup prompt')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Agents could not load' })).not.toBeInTheDocument()
  })

  it('survives a pending agent joining the list, an approval in flight, and finalizingAgent', async () => {
    const { rerender } = render(<AgentPanel />)
    await startSetup()
    expect(within(inlineFlow()!).getByText('Copy setup prompt')).toBeInTheDocument()

    // The connector registers: the backend inserts a `pending_approval` agent
    // and the 10 s list poll picks it up, as the status reaches approval.
    statusState.data = status('awaiting_wallet_approval')
    setAgentsList([PENDING_AGENT])
    rerender(<AgentPanel />)
    expect(within(inlineFlow()!).getByText('Review and approve')).toBeInTheDocument()
    expectNothingElseOfTheSurface()

    // The user approves; the chain has not confirmed yet.
    fireEvent.click(screen.getByRole('button', { name: 'stub: approve' }))
    expect(within(inlineFlow()!).getByText('stub: approval in flight')).toBeInTheDocument()
    rerender(<AgentPanel />)
    expectNothingElseOfTheSurface()

    // The grant lands: `onApproved` → `pollForNewAgent` sets finalizingAgent,
    // and its first refetch is held open so it stays set.
    refetchImpl = () => new Promise(() => {})
    await act(async () => {
      approvalGate.release?.()
    })
    expect(screen.queryByRole('status', { name: 'Finalizing agent setup' })).not.toBeInTheDocument()
    expect(within(inlineFlow()!).getByText('stub: approval in flight')).toBeInTheDocument()
    expectNothingElseOfTheSurface()

    // With the list back to empty (an approval whose agent row has not
    // propagated), the flow is still the one the user is in.
    setAgentsList([])
    rerender(<AgentPanel />)
    expect(within(inlineFlow()!).getByText('Review and approve')).toBeInTheDocument()
  })
})

/** How many `Card` surfaces (the primitive's `shadow-card`) enclose an element. */
function cardDepth(element: Element): number {
  let depth = 0
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (node.classList.contains('shadow-card')) depth += 1
  }
  return depth
}

describe('no nested filled card inline (#4065)', () => {
  it('step 3 disclosure CopyBlocks sit in the inline Card without a Card of their own', async () => {
    render(<AgentPanel />)
    await startSetup()

    // "Having trouble connecting?" holds the Local command CopyBlock.
    const label = within(inlineFlow()!).getByText('Local command')
    expect(cardDepth(label)).toBe(1)
  })

  it('the server-credential .env CopyBlock sits in the inline Card without a Card of its own', async () => {
    mockApiPost.mockImplementation(async (path: string) => {
      if (path === '/agent-connection-setups/resolve') {
        return {
          agent: { name: 'Research agent', description: null },
          haven_wallet: { id: SAFE.id, name: SAFE.name, chain_id: SAFE.chain_id, network: 'Base Sepolia' },
          agent_budget: [],
          challenge: { id: 'challenge-1', message: 'Sign to prove control of this delegate address' },
          hosted_mcp_url: 'https://mcp.haven.example',
        }
      }
      if (path === '/agent-connection-setups/register') {
        return {
          setup_id: SETUP.setup_id,
          agent_id: PENDING_AGENT.id,
          status: 'connected_local',
          delegate_address: '0x3333333333333333333333333333333333333333',
          hosted_mcp_url: 'https://mcp.haven.example',
        }
      }
      return SETUP
    })
    render(<AgentPanel />)
    await startSetup()

    await act(async () => {
      fireEvent.click(within(inlineFlow()!).getByRole('button', { name: 'Generate credentials' }))
    })

    const label = await within(inlineFlow()!).findByText('.env block')
    expect(cardDepth(label)).toBe(1)
  })
})

describe('Escape never resets the inline flow (#4065)', () => {
  it('keeps the typed name on a keydown on window', () => {
    render(<AgentPanel />)
    fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'Research agent' } })

    pressEscape()

    expect(inlineFlow()).toBeInTheDocument()
    expect(screen.getByLabelText('Agent name')).toHaveValue('Research agent')
  })

  it('keeps a created setup, so the prompt can still be copied', async () => {
    render(<AgentPanel />)
    await startSetup()

    pressEscape()

    expect(within(inlineFlow()!).getByText('Copy setup prompt')).toBeInTheDocument()
  })

  it.each([
    ['Labels', 'Manage labels'],
    ['Organizations', 'Manage organizations'],
  ])('Escape that closes the %s manager leaves the flow as it was', (button, dialogName) => {
    render(<AgentPanel />)
    fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'Research agent' } })
    fireEvent.click(screen.getByRole('button', { name: button }))
    expect(screen.getByRole('dialog', { name: dialogName })).toBeInTheDocument()

    pressEscape()

    expect(screen.queryByRole('dialog', { name: dialogName })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Agent name')).toHaveValue('Research agent')
  })
})

describe('leaving the inline flow (#4065)', () => {
  // Every `handleClose` exit the inline flow can reach. The resume
  // not-found / waiting Close are modal-only: inline never resumes a setup.
  const leavePaths: Array<[string, string, string]> = [
    ['Done on the success screen', 'active', 'Done'],
    ['Close on the approval step', 'awaiting_wallet_approval', 'stub: close approval'],
    ['Close on an expired setup', 'expired', 'Close'],
    ['Close on a cancelled setup', 'cancelled', 'Close'],
    ['Close on a failed setup', 'failed', 'Close'],
    ['Done on an unknown status', 'some_future_status', 'Done'],
  ]

  it.each(leavePaths)('%s, with an agent now listed, shows the list', async (_label, kind, exit) => {
    const { rerender } = render(<AgentPanel />)
    await startSetup()
    statusState.data = status(kind)
    setAgentsList([{ ...PENDING_AGENT, status: kind === 'active' ? 'active' : 'pending_approval' }])
    rerender(<AgentPanel />)

    fireEvent.click(within(inlineFlow()!).getByRole('button', { name: exit }))

    expect(inlineFlow()).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect agent' })).toBeInTheDocument()
    expect(screen.getByTestId('agent-card')).toHaveTextContent('Research agent')
  })

  it.each(leavePaths)('%s, with the list still empty, remounts a fresh flow', async (_label, kind, exit) => {
    const { rerender } = render(<AgentPanel />)
    await startSetup()
    statusState.data = status(kind)
    rerender(<AgentPanel />)

    fireEvent.click(within(inlineFlow()!).getByRole('button', { name: exit }))

    const flow = inlineFlow()
    expect(flow).toBeInTheDocument()
    expect(within(flow!).getByLabelText('Agent name')).toHaveValue('')
  })

  it('a zero-agent leave remounts with the starter budget seeded again', async () => {
    const { rerender } = render(<AgentPanel />)
    await startSetup()
    statusState.data = status('expired')
    rerender(<AgentPanel />)
    fireEvent.click(within(inlineFlow()!).getByRole('button', { name: 'Close' }))
    statusState.data = null

    fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'Second try' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set agent budget' }))

    // Reusing the instance would show '' here: the hook's seed runs on
    // `open`'s transition only, and `resetForm` empties the amount.
    expect(screen.getByPlaceholderText('Amount')).toHaveValue('10')
  })

  it('a leave re-arms the latch: the remounted flow survives a pending agent too', async () => {
    const { rerender } = render(<AgentPanel />)
    await startSetup()
    statusState.data = status('expired')
    rerender(<AgentPanel />)
    fireEvent.click(within(inlineFlow()!).getByRole('button', { name: 'Close' }))
    statusState.data = null

    await startSetup()
    statusState.data = status('awaiting_wallet_approval')
    setAgentsList([PENDING_AGENT])
    rerender(<AgentPanel />)

    expect(within(inlineFlow()!).getByText('Review and approve')).toBeInTheDocument()
    expectNothingElseOfTheSurface()
  })

  it('Cancel setup does not leave: it moves to the cancelled view', async () => {
    const { rerender } = render(<AgentPanel />)
    await startSetup()

    await act(async () => {
      fireEvent.click(within(inlineFlow()!).getByRole('button', { name: 'Cancel setup' }))
    })
    rerender(<AgentPanel />)

    expect(within(inlineFlow()!).getByText('Setup cancelled')).toBeInTheDocument()
  })
})

describe('deep links with no agents (#4065)', () => {
  it('?setup=first lands on the inline flow, not a modal on top of it', () => {
    window.history.replaceState(null, '', '/agents?setup=first')
    render(<AgentPanel />)

    expect(inlineFlow()).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(window.location.search).toBe('')
  })

  it('?setup=<uuid> opens the resume modal and no inline flow under it', () => {
    window.history.replaceState(null, '', '/agents?setup=2f1c0f7e-6f1d-4c7e-9a8f-1234567890ab')
    render(<AgentPanel />)

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(inlineFlow()).not.toBeInTheDocument()
  })
})
