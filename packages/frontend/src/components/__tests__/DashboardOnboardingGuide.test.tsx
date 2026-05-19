import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import DashboardOnboardingGuide from '@/components/DashboardOnboardingGuide'

function defaultProps(
  overrides: Partial<Parameters<typeof DashboardOnboardingGuide>[0]> = {},
) {
  return {
    hasFunds: false,
    hasAgents: false,
    hasFirstAgentPayment: false,
    onReceiveFunds: vi.fn(),
    onAddAgent: vi.fn(),
    onShowAgentUsage: vi.fn(),
    onDismiss: vi.fn(),
    onDismissComplete: vi.fn(),
    inProgressDismissed: false,
    completeDismissed: false,
    ...overrides,
  }
}

describe('DashboardOnboardingGuide', () => {
  it('renders all three onboarding steps in canonical order', () => {
    render(<DashboardOnboardingGuide {...defaultProps()} />)

    expect(screen.getByRole('heading', { name: 'Your first 3 steps' })).toBeInTheDocument()
    expect(screen.getByText('Fund your Haven account')).toBeInTheDocument()
    expect(screen.getByText('Connect your first agent')).toBeInTheDocument()
    expect(screen.getByText('Make your first agent payment')).toBeInTheDocument()
  })

  it('routes the active step CTA to the funding flow when no funds yet', () => {
    const onReceiveFunds = vi.fn()
    render(<DashboardOnboardingGuide {...defaultProps({ onReceiveFunds })} />)

    fireEvent.click(screen.getByRole('button', { name: 'Receive funds' }))
    expect(onReceiveFunds).toHaveBeenCalledOnce()
  })

  it('advances the active CTA to the agent step once funds land', () => {
    const onAddAgent = vi.fn()
    render(
      <DashboardOnboardingGuide
        {...defaultProps({ hasFunds: true, onAddAgent })}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Connect agent' }))
    expect(onAddAgent).toHaveBeenCalledOnce()
  })

  it('marks the agent step done even when fund is still pending (out-of-order completion)', () => {
    render(
      <DashboardOnboardingGuide
        {...defaultProps({ hasAgents: true })}
      />,
    )

    // Fund step is still the active CTA — agent step shows its completed body.
    expect(screen.getByRole('button', { name: 'Receive funds' })).toBeInTheDocument()
    expect(screen.getByText('Agent connected.')).toBeInTheDocument()
  })

  it('locks the first-payment step until an agent exists', () => {
    render(<DashboardOnboardingGuide {...defaultProps({ hasFunds: true })} />)

    expect(screen.queryByRole('button', { name: 'Show me how' })).not.toBeInTheDocument()
    expect(
      screen.getByText('Connect an agent first to unlock this step.'),
    ).toBeInTheDocument()
  })

  it('exposes the Show me how CTA only once an agent exists', () => {
    const onShowAgentUsage = vi.fn()
    render(
      <DashboardOnboardingGuide
        {...defaultProps({
          hasFunds: true,
          hasAgents: true,
          onShowAgentUsage,
        })}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Show me how' }))
    expect(onShowAgentUsage).toHaveBeenCalledOnce()
  })

  it('renders the setup-complete banner when all three steps are done', () => {
    const onDismissComplete = vi.fn()
    render(
      <DashboardOnboardingGuide
        {...defaultProps({
          hasFunds: true,
          hasAgents: true,
          hasFirstAgentPayment: true,
          onDismissComplete,
        })}
      />,
    )

    expect(screen.getByText('Setup complete')).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Your first 3 steps' }),
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDismissComplete).toHaveBeenCalledOnce()
  })

  it('hides the in-progress checklist when dismissed for the session', () => {
    const { container } = render(
      <DashboardOnboardingGuide
        {...defaultProps({ inProgressDismissed: true })}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('hides the completion banner once dismissed', () => {
    const { container } = render(
      <DashboardOnboardingGuide
        {...defaultProps({
          hasFunds: true,
          hasAgents: true,
          hasFirstAgentPayment: true,
          completeDismissed: true,
        })}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})
