import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import FirstAgentPaymentCard from '@/components/FirstAgentPaymentCard'
import { hasPlayedFirstAgentPaymentPeak } from '@/lib/first-agent-payment'

/**
 * #4707: the first-agent-payment card.
 *
 * Pinned here, at the component:
 * 1. It names the agent, the amount, the counterparty and when — and never an
 *    address (#3810 rule 4).
 * 2. A sub-cent payment reads its token amount, never `$0.00` (rule 3).
 * 3. Peak plays once per device, on a per-user marker, and the card is a
 *    `role="status"` region exactly when it plays.
 * 4. Under reduced motion the animation class is withheld while the region
 *    still exists.
 * 5. Dismiss is the caller's.
 */

const PAYMENT = {
  id: 'payment-1',
  agentName: 'Research agent',
  amountHuman: '0.05',
  amountRaw: '50000',
  tokenSymbol: 'USDC',
  chainId: 8453,
  confirmedAt: new Date(Date.now() - 60_000).toISOString(),
  usdValue: 0.05,
  eurValue: 0.046,
  sekValue: 0.54,
  merchantName: null,
  x402ResourceUrl: 'https://research.example/paper',
}

function setReducedMotion(reduce: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: reduce && query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
}

describe('FirstAgentPaymentCard (#4707)', () => {
  beforeEach(() => {
    window.localStorage.clear()
    setReducedMotion(false)
  })

  it('names the agent, the amount, the counterparty and when', () => {
    render(
      <FirstAgentPaymentCard
        payment={{ ...PAYMENT, merchantName: 'Research Co' }}
        currency="USD"
        userId="user-1"
        onDismiss={() => {}}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Research agent made its first payment' })).toBeInTheDocument()
    expect(screen.getByText('$0.05 to Research Co, just now. You’re set up.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View transaction' })).toHaveAttribute('href', '/transactions')
  })

  it('falls back to the x402 resource host when no contact or receipt name exists', () => {
    render(
      <FirstAgentPaymentCard payment={PAYMENT} currency="USD" userId="user-1" onDismiss={() => {}} />,
    )
    expect(screen.getByText('$0.05 to research.example, just now. You’re set up.')).toBeInTheDocument()
  })

  it('drops the "to …" clause rather than naming an address', () => {
    render(
      <FirstAgentPaymentCard
        payment={{ ...PAYMENT, x402ResourceUrl: null }}
        currency="USD"
        userId="user-1"
        onDismiss={() => {}}
      />,
    )
    expect(screen.getByText('$0.05, just now. You’re set up.')).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/0x[0-9a-fA-F]{6}/)
  })

  it('a sub-cent payment reads its token amount, never $0.00', () => {
    render(
      <FirstAgentPaymentCard
        payment={{ ...PAYMENT, amountHuman: '0.001', usdValue: 0.001 }}
        currency="USD"
        userId="user-1"
        onDismiss={() => {}}
      />,
    )
    expect(screen.getByText(/0\.001 USDC to research\.example/)).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('$0.00')
  })

  it('is a role="status" region when Peak plays, and writes the per-user marker', () => {
    render(
      <FirstAgentPaymentCard payment={PAYMENT} currency="USD" userId="user-1" onDismiss={() => {}} />,
    )
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(hasPlayedFirstAgentPaymentPeak('user-1')).toBe(true)
  })

  it('plays no Peak and is no status region once the marker is set', () => {
    window.localStorage.setItem('haven-first-agent-payment-peak:user-1', '1')
    render(
      <FirstAgentPaymentCard payment={PAYMENT} currency="USD" userId="user-1" onDismiss={() => {}} />,
    )
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(document.querySelector('.v2-animate-bloom')).toBeNull()
  })

  it('plays no Peak for a payment more than seven days old (owner decision 1)', () => {
    render(
      <FirstAgentPaymentCard
        payment={{ ...PAYMENT, confirmedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString() }}
        currency="USD"
        userId="user-1"
        onDismiss={() => {}}
      />,
    )
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(document.querySelector('.v2-animate-bloom')).toBeNull()
    // The card still shows, with the real date and no bloom.
    expect(screen.getByText(/You’re set up\./)).toBeInTheDocument()
  })

  it('withholds the animation class under reduced motion while the region still exists', () => {
    setReducedMotion(true)
    render(
      <FirstAgentPaymentCard payment={PAYMENT} currency="USD" userId="user-1" onDismiss={() => {}} />,
    )
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(document.querySelector('.v2-animate-bloom')).toBeNull()
    expect(document.querySelector('.animate-check-pop')).toBeNull()
  })

  it('hands the dismiss to the caller', async () => {
    const onDismiss = vi.fn()
    render(
      <FirstAgentPaymentCard payment={PAYMENT} currency="USD" userId="user-1" onDismiss={onDismiss} />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
