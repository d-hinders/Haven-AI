import { fireEvent, render, screen } from '@testing-library/react'
import { useState, type ComponentType } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ConnectAgentModal from '../ConnectAgentModal'

const mockUseAgentConnectionSetup = vi.fn()
// #3687: the focus tests need the REAL DetailsStep — the criterion is that the
// input it renders gets focus, which a stand-in rendering its own <input>
// cannot show. Every other test keeps the light stand-in.
const realSteps = vi.hoisted(() => ({ details: false }))

vi.mock('@/hooks/useAgentConnectionSetup', () => ({
  useAgentConnectionSetup: (...args: unknown[]) => mockUseAgentConnectionSetup(...args),
}))
// The `useRetiredRailOwnerAccess` mock lived here; removed by #2673 with the
// hook itself (#2413 deleted it) — it mocked a module that no longer exists,
// so it propped nothing up (no assertion reads it, and no production import
// can resolve it).

vi.mock('@/components/connect-agent/DetailsStep', async (importOriginal) => {
  const actual = await importOriginal<{ DetailsStep: ComponentType<Record<string, unknown>> }>()
  return {
    DetailsStep: (props: Record<string, unknown>) =>
      realSteps.details ? <actual.DetailsStep {...props} /> : <div>Agent details</div>,
  }
})

vi.mock('@/components/connect-agent/PolicyStep', () => ({
  PolicyStep: ({ flow }: { flow: { setStep: (step: string) => void } }) => (
    <div>
      Agent policy
      <button type="button" onClick={() => flow.setStep('details')}>
        Back
      </button>
    </div>
  ),
}))

vi.mock('@/components/connect-agent/ConnectStep', () => ({
  ConnectStep: () => <div>Connect step</div>,
}))

function flow(overrides: Record<string, unknown> = {}) {
  return {
    handleClose: vi.fn(),
    selectableAccounts: [],
    selectedAccountId: null,
    isRetiredRail: false,
    headerSubtitleText: 'Name the agent and describe what it does',
    step: 'details',
    setupStepCount: 3,
    currentStepIndex: 0,
    busy: false,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockUseAgentConnectionSetup.mockReturnValue(flow())
})

afterEach(() => {
  realSteps.details = false
  vi.unstubAllGlobals()
})

/**
 * A flow whose step and name are real state, so a click on *Set agent budget*
 * re-renders the modal on the policy step the way the hook would. The mocked
 * hook runs inside ConnectAgentModal's render, so it may call hooks itself.
 */
function useStatefulFlow() {
  const [step, setStep] = useState('details')
  const [name, setName] = useState('Research Agent')
  return flow({
    step,
    setStep,
    name,
    setName,
    description: '',
    setDescription: vi.fn(),
    localMcp: false,
    setLocalMcp: vi.fn(),
  })
}

function stubPointer(coarse: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: coarse && query === '(pointer: coarse)',
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  )
}

describe('ConnectAgentModal', () => {
  it('keeps the normal details step for a delegation account', () => {
    render(<ConnectAgentModal open onClose={vi.fn()} accountAddress="0x111" accountId="safe-1" />)

    expect(screen.getByText('Agent details')).toBeInTheDocument()
    expect(screen.queryByText('Haven no longer sends payments from this account.')).not.toBeInTheDocument()
  })
})

describe('ConnectAgentModal focus (#3687)', () => {
  beforeEach(() => {
    realSteps.details = true
    mockUseAgentConnectionSetup.mockImplementation(useStatefulFlow)
  })

  it('opens with the caret in the Agent name input rendered by the real DetailsStep', () => {
    stubPointer(false)
    render(<ConnectAgentModal open onClose={vi.fn()} />)

    expect(document.activeElement).toBe(screen.getByLabelText('Agent name'))
  })

  it('does not focus the input on a coarse pointer, so the phone keyboard stays shut', () => {
    stubPointer(true)
    render(<ConnectAgentModal open onClose={vi.fn()} />)

    expect(screen.getByLabelText('Agent name')).not.toHaveFocus()
    // Today's behaviour there: the first focusable, the header Close button.
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus()
  })

  it('keeps focus inside the dialog across a step change, and Back lands in the name input', () => {
    stubPointer(false)
    render(<ConnectAgentModal open onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Set agent budget' }))
    expect(screen.getByText('Agent policy')).toBeInTheDocument()
    // The step region itself — `role="dialog"` is Modal's full-screen
    // wrapper, so containment in it would not say "inside the panel".
    expect(document.activeElement).toHaveAttribute('tabindex', '-1')
    expect(document.activeElement).toHaveTextContent('Agent policy')

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(document.activeElement).toBe(screen.getByLabelText('Agent name'))
  })

  it('moves no focus on the first render of the resume step: Close keeps it', () => {
    stubPointer(false)
    mockUseAgentConnectionSetup.mockReturnValue(flow({ step: 'connect' }))
    render(<ConnectAgentModal open onClose={vi.fn()} resumeSetupId="setup-1" />)

    expect(screen.getByText('Connect step')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus()
  })

  it('moves no focus on a re-render that does not change the step', () => {
    stubPointer(false)
    const { rerender } = render(<ConnectAgentModal open onClose={vi.fn()} />)
    const description = screen.getByLabelText(/Description/)
    description.focus()

    rerender(<ConnectAgentModal open onClose={vi.fn()} />)

    expect(description).toHaveFocus()
  })
})
