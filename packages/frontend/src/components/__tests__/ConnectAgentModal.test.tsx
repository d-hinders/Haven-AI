import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ConnectAgentModal from '../ConnectAgentModal'

const mockUseAgentConnectionSetup = vi.fn()
const mockUseRetiredRailOwnerAccess = vi.fn()

vi.mock('@/hooks/useAgentConnectionSetup', () => ({
  useAgentConnectionSetup: (...args: unknown[]) => mockUseAgentConnectionSetup(...args),
}))

vi.mock('@/hooks/useRetiredRailOwnerAccess', () => ({
  useRetiredRailOwnerAccess: (...args: unknown[]) => mockUseRetiredRailOwnerAccess(...args),
}))

vi.mock('@/components/connect-agent/DetailsStep', () => ({
  DetailsStep: () => <div>Agent details</div>,
}))

vi.mock('@/components/connect-agent/PolicyStep', () => ({
  PolicyStep: () => <div>Agent policy</div>,
}))

vi.mock('@/components/connect-agent/ReviewStep', () => ({
  ReviewStep: () => <div>Review agent</div>,
}))

vi.mock('@/components/connect-agent/ConnectStep', () => ({
  ConnectStep: () => <div>Connect step</div>,
}))

function flow(overrides: Record<string, unknown> = {}) {
  return {
    handleClose: vi.fn(),
    selectableSafes: [],
    selectedSafeId: null,
    isRetiredRail: false,
    headerSubtitleText: 'Name the agent and describe what it does',
    step: 'details',
    setupStepCount: 4,
    currentStepIndex: 0,
    busy: false,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockUseAgentConnectionSetup.mockReturnValue(flow())
  mockUseRetiredRailOwnerAccess.mockReturnValue({ ownerAccess: 'unknown' })
})

describe('ConnectAgentModal', () => {
  it('keeps the normal details step for a delegation account', () => {
    render(<ConnectAgentModal open onClose={vi.fn()} safeAddress="0x111" safeId="safe-1" />)

    expect(screen.getByText('Agent details')).toBeInTheDocument()
    expect(screen.queryByText('Haven no longer sends payments from this account.')).not.toBeInTheDocument()
  })
})
