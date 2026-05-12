import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import DashboardOnboardingGuide from '@/components/DashboardOnboardingGuide'

const SAFE = {
  id: 'safe-1',
  name: 'Operating wallet',
  safe_address: '0x1111111111111111111111111111111111111111',
  chain_id: 8453,
  is_default: true,
  created_at: '2026-05-12T00:00:00Z',
}

describe('DashboardOnboardingGuide', () => {
  it('routes the funding step into the Receive flow without showing the raw address inline', () => {
    const onReceiveFunds = vi.fn()

    render(
      <DashboardOnboardingGuide
        stage="fund"
        safes={[SAFE]}
        onReceiveFunds={onReceiveFunds}
        onAddAgent={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )

    expect(screen.getByText('First setup')).toBeInTheDocument()
    expect(screen.getByText('Receive funds in your Haven wallet')).toBeInTheDocument()
    expect(screen.getByText('Step 2 of 4')).toBeInTheDocument()
    expect(screen.getByText('Operating wallet')).toBeInTheDocument()
    expect(screen.getByText('Base')).toBeInTheDocument()
    expect(screen.queryByText(SAFE.safe_address)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Receive funds' }))

    expect(onReceiveFunds).toHaveBeenCalledOnce()
  })

  it('routes the agent step into first agent setup and keeps budget as the next task', () => {
    const onAddAgent = vi.fn()

    render(
      <DashboardOnboardingGuide
        stage="add-agent"
        safes={[SAFE]}
        onReceiveFunds={vi.fn()}
        onAddAgent={onAddAgent}
        onDismiss={vi.fn()}
      />,
    )

    expect(screen.getByText('Connect your first agent')).toBeInTheDocument()
    expect(screen.getByText('Step 3 of 4')).toBeInTheDocument()
    expect(screen.getByText('Set budget')).toBeInTheDocument()
    expect(screen.getByText('The agent can make payments within the budget. Anything above it waits for your approval.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Connect first agent' }))

    expect(onAddAgent).toHaveBeenCalledOnce()
  })
})
