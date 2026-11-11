import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DashboardOnboardingGuide from '@/components/DashboardOnboardingGuide'
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
    ...overrides,
  }
  return { ...render(<DashboardOnboardingGuide {...props} />), props }
}

describe('DashboardOnboardingGuide — step 1 (#2534, #3818)', () => {
  it('uses a static unfilled ink-2 ring without a brand-tinted active row', () => {
    const { container } = renderGuide()
    const active = container.querySelector('li[data-status="active"]')!
    expect(active.className).not.toContain('brand')
    const marker = active.querySelector('[aria-hidden="true"]')!
    expect(marker).toHaveClass('border-[1.5px]', 'border-[var(--v2-ink-2)]', 'text-[var(--v2-ink-2)]')
    expect(container.querySelector('.v2-step-halo')).toBeNull()
  })

  it('draws later steps with the stepper family quiet 1px ring', () => {
    const { container } = renderGuide()
    const later = container.querySelector('li[data-status="locked"] [aria-hidden="true"]')!
    expect(later).toHaveClass('border', 'border-[var(--v2-border)]', 'text-[var(--v2-ink-3)]')
    expect(later.className).not.toContain('border-strong')
  })

  it('suggests the endpoint\'s amount and offers Add funds, which opens the dialog with the faucet', async () => {
    const { props } = renderGuide({ funding: FUNDING })
    expect(document.body.textContent).toContain('We suggest 5 USDC')
    expect(document.body.textContent).toContain('Haven pays the network fees')
    expect(document.body.textContent).not.toContain('Even $5')
    // #3902: step 1's "Add funds" is THE primary while it is the active step
    // (the money card's steps back to ghost beside it).
    expect(screen.getByRole('button', { name: 'Add funds' })).toHaveAttribute('data-variant', 'primary')
    await userEvent.click(screen.getByRole('button', { name: 'Add funds' }))
    expect(props.onAddFunds).toHaveBeenCalledTimes(1)
  })

  it('keeps the general copy while the funding read is absent', () => {
    renderGuide()
    expect(document.body.textContent).toContain('Your agents spend from this balance.')
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
    expect(document.body.textContent).toContain('Your account holds USDC.')
    expect(document.body.textContent).not.toContain('your agents can spend')
    expect(screen.queryByRole('button', { name: 'Add funds' })).not.toBeInTheDocument()
  })
})

describe('DashboardOnboardingGuide — step 2 and 3 (#3818)', () => {
  it('names the agent waiting for setup with the approve action, and "and N more"', () => {
    renderGuide({ usdcFunded: true, pendingAgent: { id: 'agt-1', name: 'Research agent', moreCount: 2, awaiting: 'approval' as const } })
    // The agent is named in the step's heading; the body keeps only the action.
    expect(screen.getByText('Finish setting up Research agent and 2 more')).toBeInTheDocument()
    expect(screen.getByText('Approve its budget so it can pay.')).toBeInTheDocument()
    expect(screen.queryByText('Connect your first agent')).not.toBeInTheDocument()
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

  it('a completed step 2 names nobody — "Connect your first agent", no Finish setup (#3976)', () => {
    // The regression: with a set-up agent completing the step AND a pending
    // agent waiting, the ticked step still read "Finish setting up X" — and
    // in the unfunded focused view that wrong title was the only place the
    // waiting agent appeared at all. The caller is fixed at the source
    // (`stepTwoAgent`), but the component is guarded too so the title is
    // correct whatever a caller passes.
    const { container } = renderGuide({
      usdcFunded: true,
      hasSetUpAgent: true,
      pendingAgent: { id: 'agt-p', name: 'Sdf', moreCount: 0, awaiting: 'approval' as const },
    })
    // Step 2 is complete…
    const statuses = [...container.querySelectorAll('li[data-status]')].map((li) => li.getAttribute('data-status'))
    expect(statuses).toEqual(['complete', 'complete', 'active'])
    // …titled with the step's own imperative default, exactly…
    expect(screen.getByText('Connect your first agent')).toBeInTheDocument()
    expect(document.body.textContent).toContain('An agent is connected with a budget.')
    // …and no trace of a pending-agent ask anywhere in the step.
    expect(document.body.textContent).not.toContain('Finish setting up')
    expect(screen.queryByRole('link', { name: 'Finish setup' })).not.toBeInTheDocument()
    expect(document.body.textContent).not.toContain('Approve its budget so it can pay.')
  })

  it('an agent set up BEFORE funding: step 3 is available, not a second highlighted step', () => {
    const { container } = renderGuide({ usdcFunded: false, hasSetUpAgent: true })
    const statuses = [...container.querySelectorAll('li[data-status]')].map((li) => li.getAttribute('data-status'))
    expect(statuses).toEqual(['active', 'complete', 'available'])
    expect(container.querySelectorAll('[aria-current="step"]')).toHaveLength(1)
  })

  it('an active agent with no budget is asked for a budget, not an approval', () => {
    renderGuide({ usdcFunded: true, pendingAgent: { id: 'b', name: 'Bot', moreCount: 0, awaiting: 'budget' } })
    expect(screen.getByText('Finish setting up Bot')).toBeInTheDocument()
    expect(screen.getByText('Set a budget so it can pay.')).toBeInTheDocument()
  })

  it('a set-up agent completes step 2 and unlocks step 3', () => {
    renderGuide({ usdcFunded: true, hasSetUpAgent: true })
    expect(document.body.textContent).toContain('An agent is connected with a budget.')
    expect(screen.getByRole('button', { name: 'Show me how' })).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('Set up an agent first')
  })

  it('an agent whose budget ENDED: step 2 says when, since the card drops its "Budget ended" row (#4744)', () => {
    renderGuide({
      usdcFunded: true,
      pendingAgent: { id: 'b', name: 'Bot', moreCount: 0, awaiting: 'budget', budgetEndedOn: '2 Nov 2026' },
    })
    expect(screen.getByText('Finish setting up Bot')).toBeInTheDocument()
    expect(screen.getByText('Its budget ended 2 Nov 2026. Set a new one so it can pay.')).toBeInTheDocument()
    expect(screen.queryByText('Set a budget so it can pay.')).not.toBeInTheDocument()
  })

  it('without a set-up agent step 3 stays locked, and says what unlocks it (#4744, N1)', () => {
    renderGuide({ usdcFunded: true, pendingAgent: { id: 'a', name: 'A', moreCount: 0, awaiting: 'approval' as const } })
    // The old copy was wrong whenever an agent existed and only needed a budget.
    expect(screen.getByText('Unlocks when an agent has a budget.')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('Set up an agent first')
    expect(screen.queryByRole('button', { name: 'Show me how' })).not.toBeInTheDocument()
  })

  it('draws no "Hide for now" of its own — the card header carries it (#3897)', () => {
    renderGuide()
    expect(screen.queryByRole('button', { name: 'Hide for now' })).not.toBeInTheDocument()
    // The list keeps its accessible name, once.
    expect(screen.getByRole('list', { name: 'Your first 3 steps' })).toBeInTheDocument()
  })
})

// #4707: `SetupCompleteLine` is gone — the first agent payment is its own card
// (`components/FirstAgentPaymentCard`), tested in its own suite. The guide's
// finished state is no longer a branch of this component.

// #4704: a guide step plays Milestone Step only when it completes while the
// guide is open. The global setup stub answers `reduce`, so these cases set
// no-preference explicitly — under `reduce` Milestone never opts in at all.
describe('guide steps play Step on a completion you watch (#4704)', () => {
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
  const base = {
    hasSetUpAgent: false,
    hasFirstAgentPayment: false,
    onAddFunds: vi.fn(),
    onAddAgent: vi.fn(),
    onShowAgentUsage: vi.fn(),
  }
  const stepRow = (n: number) => document.querySelectorAll('li[data-status]')[n - 1] as HTMLElement

  afterEach(() => setReducedMotion(true))

  it('a step that completes while watched pops', () => {
    setReducedMotion(false)
    const { rerender } = render(<DashboardOnboardingGuide {...base} usdcFunded={false} />)
    expect(stepRow(1).querySelector('.animate-check-pop')).toBeNull()
    rerender(<DashboardOnboardingGuide {...base} usdcFunded={true} />)
    expect(stepRow(1).getAttribute('data-status')).toBe('complete')
    expect(stepRow(1).querySelector('.animate-check-pop')).not.toBeNull()
  })

  it('a step already complete when the guide opens (a reload) just shows its check', () => {
    setReducedMotion(false)
    render(<DashboardOnboardingGuide {...base} usdcFunded={true} hasSetUpAgent={true} />)
    expect(stepRow(1).getAttribute('data-status')).toBe('complete')
    expect(document.querySelector('.animate-check-pop')).toBeNull()
  })

  it('a balance read that recovers (unknown → complete) shows the check without a pop', () => {
    setReducedMotion(false)
    const { rerender } = render(<DashboardOnboardingGuide {...base} usdcFunded={null} />)
    expect(stepRow(1).getAttribute('data-status')).toBe('unknown')
    rerender(<DashboardOnboardingGuide {...base} usdcFunded={true} />)
    expect(stepRow(1).getAttribute('data-status')).toBe('complete')
    expect(stepRow(1).querySelector('.animate-check-pop')).toBeNull()
  })

  it('step 2 completing while watched pops too', () => {
    setReducedMotion(false)
    const props = { ...base, usdcFunded: true }
    const { rerender } = render(<DashboardOnboardingGuide {...props} />)
    rerender(<DashboardOnboardingGuide {...props} hasSetUpAgent={true} />)
    expect(stepRow(2).getAttribute('data-status')).toBe('complete')
    expect(stepRow(2).querySelector('.animate-check-pop')).not.toBeNull()
  })

  it('step 3 never pops: the first payment is its own card (#4707)', () => {
    setReducedMotion(false)
    const props = { ...base, usdcFunded: true, hasSetUpAgent: true }
    const { rerender } = render(<DashboardOnboardingGuide {...props} />)
    rerender(<DashboardOnboardingGuide {...props} hasFirstAgentPayment={true} />)
    expect(stepRow(3).getAttribute('data-status')).toBe('complete')
    expect(stepRow(3).querySelector('.animate-check-pop')).toBeNull()
  })

  it('under reduced motion the completed step shows its check with no pop', () => {
    setReducedMotion(true)
    const { rerender } = render(<DashboardOnboardingGuide {...base} usdcFunded={false} />)
    rerender(<DashboardOnboardingGuide {...base} usdcFunded={true} />)
    expect(stepRow(1).getAttribute('data-status')).toBe('complete')
    expect(stepRow(1).querySelector('.animate-check-pop')).toBeNull()
  })
})

describe('the guide is the shared Step status checklist (#4744)', () => {
  it('renders through StepChecklist: numbered markers, one connector per gap, a list label', () => {
    const { container } = renderGuide({ usdcFunded: false })
    const list = container.querySelector('ol')!
    expect(list).toHaveAttribute('aria-labelledby')
    const rows = [...list.querySelectorAll(':scope > li')]
    expect(rows.map((li) => li.getAttribute('data-step-state'))).toEqual(['active', 'pending', 'pending'])
    // Numbered: the list is the card's counter (screen-recipes, First-Run item 2).
    expect(rows.map((li) => li.querySelector('[aria-hidden="true"]')!.textContent)).toEqual(['1', '2', '3'])
    expect(container.querySelectorAll('[data-step-connector]')).toHaveLength(2)
  })

  it('a locked step is quiet by TOKEN, never by opacity — and a done step\'s heading is ink-3', () => {
    const { container } = renderGuide({ usdcFunded: true })
    const locked = container.querySelector('li[data-status="locked"]') as HTMLElement
    // On the rendered row and everything in it, so an opacity moved into the
    // primitive fails this too.
    for (const el of [locked, ...locked.querySelectorAll<HTMLElement>('*')]) {
      expect(el.getAttribute('class') ?? '').not.toMatch(/(^|\s)opacity-/)
    }
    expect(screen.getByText('Make your first agent payment').closest('p')).toHaveClass('text-[var(--v2-ink-2)]')
    expect(screen.getByText('Unlocks when an agent has a budget.')).toHaveClass('text-[var(--v2-ink-3)]')
    expect(screen.getByText('Add USDC to your account').closest('p')).toHaveClass('text-[var(--v2-ink-3)]')
    // An open-but-not-next step reads at full ink: actionable, not dimmed (#3818).
    expect(screen.getByText('Connect your first agent').closest('p')).toHaveClass('text-[var(--v2-ink)]')
  })

  it('states each step to assistive tech, except an unreadable one', () => {
    const { container } = renderGuide({ usdcFunded: null })
    const headings = [...container.querySelectorAll('ol > li')].map((li) => li.querySelector('p')!.textContent)
    // Step 1 is `unknown`: no "Not started" — the balance could not be read.
    expect(headings).toEqual([
      'Add USDC to your account',
      'Not started: Connect your first agent',
      'Not started: Make your first agent payment',
    ])
  })

  it('the step action sits in the row action slot, not under the heading block', () => {
    const { container } = renderGuide({ usdcFunded: false })
    const active = container.querySelector('li[data-status="active"]')!
    const slot = active.querySelector('[data-step-action]')!
    expect(slot).toContainElement(screen.getByRole('button', { name: 'Add funds' }))
    expect(slot.parentElement!.className).toContain('sm:flex-row')
    expect(active.querySelector('[data-step-text]')).not.toContainElement(slot as HTMLElement)
  })
})
