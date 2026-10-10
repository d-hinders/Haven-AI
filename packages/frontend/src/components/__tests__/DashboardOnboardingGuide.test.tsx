import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import DashboardOnboardingGuide, { SetupCompleteLine } from '@/components/DashboardOnboardingGuide'
import type { AccountFunding } from '@/hooks/useAccountFunding'

/**
 * The first-run steps (#2534 funding copy, #3818 rules).
 *
 * Pinned here, at the component:
 * 1. Step 1 completes on USDC only (`usdcFunded`), offers Add funds while the
 *    account is known to hold none, and says it could not read the balance —
 *    with NO funding action — when that read is unknown.
 * 2. The suggested amount comes from the funding endpoint, never a local
 *    constant; without the payload the general copy stays.
 * 3. The card never renders an address, even WITH a funding payload carrying
 *    one (copy lint cannot catch it: the address is filled in at runtime).
 * 4. Step 2 completes only on `hasSetUpAgent`, names a pending agent with the
 *    approve action, and is available before funding at secondary weight.
 *
 * The rule that decides those inputs is `firstRunSetupState` in
 * `lib/dashboard-attention.ts`, tested there; the wiring is tested in
 * `DashboardClient.test.tsx`.
 */

vi.mock('@/components/ui/Button', () => ({
  Button: ({
    children,
    onClick,
    href,
    variant,
  }: {
    children: React.ReactNode
    onClick?: () => void
    href?: string
    variant?: string
  }) =>
    href ? (
      <a href={href} data-variant={variant ?? 'primary'}>
        {children}
      </a>
    ) : (
      <button onClick={onClick} data-variant={variant ?? 'primary'}>
        {children}
      </button>
    ),
}))

const FUNDING: AccountFunding = {
  account_address: '0xabc0000000000000000000000000000000000004',
  chain: { id: 8453, name: 'Base', explorer_url: 'https://sepolia.basescan.org' },
  tokens: [
    { symbol: 'USDC', address: '0xusdc', decimals: 6, balance_human: '0', minimum_useful_human: '5' },
  ],
  native: { symbol: 'ETH', balance_human: '0', needed: false },
  funded: false,
}

function renderGuide(overrides: Partial<Parameters<typeof DashboardOnboardingGuide>[0]> = {}) {
  const props = {
    usdcFunded: false as boolean | null,
    hasSetUpAgent: false,
    hasFirstAgentPayment: false,
    onAddFunds: vi.fn(),
    onAddAgent: vi.fn(),
    onShowAgentUsage: vi.fn(),
    onHide: vi.fn(),
    ...overrides,
  }
  return { ...render(<DashboardOnboardingGuide {...props} />), props }
}

describe('DashboardOnboardingGuide — step 1 (#2534, #3818)', () => {
  it('suggests the endpoint\'s amount and offers Add funds, which opens the dialog with the faucet', async () => {
    const { props } = renderGuide({ funding: FUNDING })
    expect(document.body.textContent).toContain('We suggest 5 USDC')
    expect(document.body.textContent).toContain('no gas token needed')
    expect(document.body.textContent).not.toContain('Even $5')
    await userEvent.click(screen.getByRole('button', { name: 'Add funds' }))
    expect(props.onAddFunds).toHaveBeenCalledTimes(1)
  })

  it('keeps the general copy while the funding read is absent', () => {
    renderGuide()
    expect(document.body.textContent).toContain('Add USDC so your agents have money to spend.')
    expect(screen.getByRole('button', { name: 'Add funds' })).toBeInTheDocument()
  })

  it('renders no address — even with a funding payload that carries one', () => {
    for (const usdcFunded of [false, null, true] as const) {
      const { unmount } = renderGuide({ funding: FUNDING, usdcFunded })
      expect(document.body.textContent, String(usdcFunded)).not.toMatch(/0x[0-9a-f]/i)
      expect(document.body.textContent).not.toContain('basescan')
      unmount()
    }
  })

  it('an unknown USDC read says so and offers no funding action — never "not funded"', () => {
    renderGuide({ usdcFunded: null, funding: FUNDING })
    expect(document.body.textContent).toContain('could not read your USDC balance')
    expect(screen.queryByRole('button', { name: 'Add funds' })).not.toBeInTheDocument()
    expect(document.body.textContent).not.toContain('Funded')
  })

  it('USDC on the account completes step 1', () => {
    renderGuide({ usdcFunded: true })
    expect(document.body.textContent).toContain('Funded — your agents can spend.')
    expect(screen.queryByRole('button', { name: 'Add funds' })).not.toBeInTheDocument()
  })
})

describe('DashboardOnboardingGuide — step 2 and 3 (#3818)', () => {
  it('names the agent waiting for setup with the approve action, and "and N more"', () => {
    renderGuide({ usdcFunded: true, pendingAgent: { id: 'agt-1', name: 'Research agent', moreCount: 2 } })
    expect(document.body.textContent).toContain('Finish setting up Research agent and 2 more')
    const action = screen.getByRole('link', { name: 'Finish setup' })
    expect(action).toHaveAttribute('href', '/agents/agt-1')
    // Step 2 is the active step once funded: primary weight.
    expect(action).toHaveAttribute('data-variant', 'primary')
    expect(document.body.textContent).not.toContain('An agent is connected with a budget.')
  })

  it('connecting before funding stays allowed, at secondary weight', async () => {
    const { props, container } = renderGuide({ usdcFunded: false })
    // One next step at a time: step 2 is available, not a second "active".
    const statuses = [...container.querySelectorAll('li[data-status]')].map((li) => li.getAttribute('data-status'))
    expect(statuses).toEqual(['active', 'available', 'locked'])
    const connect = screen.getByRole('button', { name: 'Connect agent' })
    expect(connect).toHaveAttribute('data-variant', 'ghost')
    await userEvent.click(connect)
    expect(props.onAddAgent).toHaveBeenCalledTimes(1)
  })

  it('a set-up agent completes step 2 and unlocks step 3', () => {
    renderGuide({ usdcFunded: true, hasSetUpAgent: true })
    expect(document.body.textContent).toContain('An agent is connected with a budget.')
    expect(screen.getByRole('button', { name: 'Show me how' })).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('Set up an agent first')
  })

  it('without a set-up agent step 3 stays locked', () => {
    renderGuide({ usdcFunded: true, pendingAgent: { id: 'a', name: 'A', moreCount: 0 } })
    expect(document.body.textContent).toContain('Set up an agent first to unlock this step.')
    expect(screen.queryByRole('button', { name: 'Show me how' })).not.toBeInTheDocument()
  })

  it('Hide for now calls the caller, which owns persistence', async () => {
    const { props } = renderGuide()
    await userEvent.click(screen.getByRole('button', { name: 'Hide for now' }))
    expect(props.onHide).toHaveBeenCalledTimes(1)
  })
})

describe('SetupCompleteLine (#3818)', () => {
  it('is one line with a dismiss', async () => {
    const onDismiss = vi.fn()
    render(<SetupCompleteLine onDismiss={onDismiss} />)
    expect(document.body.textContent).toContain('You’re set up')
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
