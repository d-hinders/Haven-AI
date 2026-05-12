import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import DashboardOnboardingGuide from '@/components/DashboardOnboardingGuide'

describe('DashboardOnboardingGuide', () => {
  it('routes the funding step into the Receive flow without adding setup detail', () => {
    const onReceiveFunds = vi.fn()

    render(
      <DashboardOnboardingGuide
        stage="fund"
        onReceiveFunds={onReceiveFunds}
        onAddAgent={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )

    expect(screen.getByText('Next setup step')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Receive funds' })).toBeInTheDocument()
    expect(screen.getByText('Copy your Haven wallet address and network before sending funds.')).toBeInTheDocument()
    expect(screen.queryByText('Step 2 of 4')).not.toBeInTheDocument()
    expect(screen.queryByText('Network')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Receive funds' }))

    expect(onReceiveFunds).toHaveBeenCalledOnce()
  })

  it('routes the agent step into first agent setup and keeps budget as the next task', () => {
    const onAddAgent = vi.fn()

    render(
      <DashboardOnboardingGuide
        stage="add-agent"
        onReceiveFunds={vi.fn()}
        onAddAgent={onAddAgent}
        onDismiss={vi.fn()}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Connect your first agent' })).toBeInTheDocument()
    expect(screen.getByText('Set a budget, then add the Haven credential to the agent you want to use.')).toBeInTheDocument()
    expect(screen.queryByText('Step 3 of 4')).not.toBeInTheDocument()
    expect(screen.queryByText('Set budget')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Connect first agent' }))

    expect(onAddAgent).toHaveBeenCalledOnce()
  })
})
