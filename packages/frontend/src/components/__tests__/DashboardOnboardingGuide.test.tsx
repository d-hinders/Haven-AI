import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import DashboardOnboardingGuide from '@/components/DashboardOnboardingGuide'
import type { SafeFunding } from '@/hooks/useSafeFunding'

/**
 * The empty-state funding card, fed by the funding endpoint (#2534).
 *
 * The card used to hard-code "Even $5" — a second copy of the minimum-useful
 * constant `@haven_ai/core` owns, and the drift #2534 closes. What is pinned:
 *
 * 1. With funding facts, step 1 speaks the endpoint's numbers — the minimum,
 *    the token, the no-gas guarantee, the account address — and holds no
 *    "Even $5" of its own.
 * 2. WITHOUT the payload (still loading, or the read failed) the step keeps
 *    the old general copy and stays actionable: the checklist must not go
 *    blank because one GET did.
 * 3. The address line shows only while the account is unfunded — a completed
 *    step collapses back to "Funded — your agents can spend."
 */

vi.mock('@/components/ui/Button', () => ({
  Button: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
}))

const FUNDING: SafeFunding = {
  account_address: '0xabc0000000000000000000000000000000000004',
  chain: { id: 8453, name: 'Base', explorer_url: 'https://sepolia.basescan.org' },
  tokens: [
    { symbol: 'USDC', address: '0xusdc', decimals: 6, balance_human: '0', minimum_useful_human: '5' },
  ],
  native: { symbol: 'ETH', balance_human: '0', needed: false },
  funded: false,
}

function renderGuide(overrides: Partial<Parameters<typeof DashboardOnboardingGuide>[0]> = {}) {
  return render(
    <DashboardOnboardingGuide
      hasFunds={false}
      hasAgents={false}
      hasFirstAgentPayment={false}
      onReceiveFunds={vi.fn()}
      onAddAgent={vi.fn()}
      onShowAgentUsage={vi.fn()}
      onDismiss={vi.fn()}
      onDismissComplete={vi.fn()}
      inProgressDismissed={false}
      completeDismissed={false}
      {...overrides}
    />,
  )
}

describe('DashboardOnboardingGuide — funding card (#2534)', () => {
  it('renders step 1 from the endpoint payload, no local minimum', () => {
    renderGuide({ funding: FUNDING })

    const text = document.body.textContent ?? ''
    expect(text).toContain('Add 5 USDC')
    expect(text).toContain('no gas token needed: Haven sponsors it')
    expect(text).toContain('Send to 0xabc0000000000000000000000000000000000004')
    expect(text).toContain('sepolia.basescan.org')
    expect(text).not.toContain('Even $5')
  })

  it('keeps the general copy while the funding read is absent', () => {
    renderGuide({ funding: null })

    expect(document.body.textContent).toContain('Even $5 lets you try x402 micropayments.')
    expect(screen.getByRole('button', { name: 'Receive funds' })).toBeInTheDocument()
  })

  it('hides the address line once the account is funded', () => {
    renderGuide({ funding: FUNDING, hasFunds: true })

    expect(document.body.textContent).not.toContain('Send to 0xabc')
    expect(document.body.textContent).toContain('Funded — your agents can spend.')
  })

  it('falls back to the general copy when no token carries a minimum', () => {
    const noMinimum: SafeFunding = {
      ...FUNDING,
      tokens: [
        { symbol: 'USDC', address: '0xusdc', decimals: 6, balance_human: '0', minimum_useful_human: null },
      ],
    }
    renderGuide({ funding: noMinimum })

    expect(document.body.textContent).toContain('Add USDC so your agents have money to spend.')
    expect(document.body.textContent).toContain('Send to 0xabc')
  })
})
