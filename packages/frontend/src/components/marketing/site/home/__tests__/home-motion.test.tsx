import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NewSiteHome } from '../HomeSections'
import {
  AnimatedPasskeyMiniCard,
  AnimatedBudgetMiniCard,
  AnimatedConnectorTerminal,
} from '../HowItWorksAnimated'
import { AnimatedHeroFrame } from '../AnimatedHeroFrame'
import { AnimatedAccountingFrame } from '../AnimatedAccountingFrame'
import { AccountingFrame } from '../AccountingFrame'
import { AnimatedRefusalReceipt } from '../AnimatedRefusalReceipt'

/**
 * The home page's motion (#3575, epic #3572).
 *
 * JSDOM gates every loop twice over, which is exactly the posture the
 * settled-state criterion needs: the global test setup pins
 * `prefers-reduced-motion: reduce`, and JSDOM has no IntersectionObserver,
 * so `useInView` reports in view but the reduced-motion gate still wins —
 * every controller renders slice 2's settled state by default here. The
 * choreography tests re-install a no-preference `matchMedia` and drive the
 * loops with fake timers, which the engine is built to ride (motion.ts).
 */

/** Flip the media-query stub to "motion allowed" for the loop tests. */
function allowMotion() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: no-preference)',
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
}

/** Reinstall the suite default: `prefers-reduced-motion: reduce`. */
function reduceMotion() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
}

afterEach(() => {
  vi.useRealTimers()
  reduceMotion()
})

describe('the home page motion, settled (#3575)', () => {
  it('reduced motion shows slice 2’s settled state in every animated region', () => {
    const { container } = render(<NewSiteHome />)
    const text = (container.textContent ?? '').replace(/\s+/g, ' ')

    // Hero: the fixture budget, untouched by any tween.
    expect(container.querySelector('[data-testid="hero-used"]')?.textContent).toBe(
      '201.50 of 250.00 USDC',
    )
    expect(container.querySelector('[data-testid="hero-percent"]')?.textContent).toBe('81%')
    // How it works: settled budget card, no confirmation anywhere.
    expect(text).toContain('250.00')
    expect(text).toContain('Approve budget')
    expect(container.querySelectorAll('[data-testid="confirmation"]')).toHaveLength(0)
    // Accounting: the settled failed push.
    expect(container.querySelector('[data-testid="accounting-status"]')?.textContent).toBe('Failed')
    // Enforcement: the receipt fully assembled.
    expect(text).toContain('Nothing to book')
    expect(text).toContain('Refused: over budget')
    // Terminal: every real output line settled ("on").
    expect(text).toContain('Haven setup on this machine is complete.')
  })

  it('nothing announces: no live region, no role="status" on the page', () => {
    const { container } = render(<NewSiteHome />)
    expect(container.querySelectorAll('[aria-live], [role="status"]')).toHaveLength(0)
  })

  it('the animated regions are the decorative frames, hidden from assistive tech', () => {
    const { container } = render(<NewSiteHome />)
    for (const testId of [
      'hero-animated',
      'passkey-animated',
      'budget-animated',
      'accounting-animated',
      'refusal-receipt',
    ]) {
      const node = container.querySelector(`[data-testid="${testId}"]`)
      expect(node, testId).not.toBeNull()
      // Each sits inside an aria-hidden wrapper (the slice-2 posture).
      expect(node!.closest('[aria-hidden="true"]'), `${testId} aria-hidden`).not.toBeNull()
    }
    // The terminal stays real content: present, NOT aria-hidden.
    const terminal = container.querySelector('[data-connector-terminal]')
    expect(terminal).not.toBeNull()
    expect(terminal!.closest('[aria-hidden="true"]')).toBeNull()
    // And no animated region inserts or removes rows settled: the hero shows
    // exactly the mockup's three activity rows.
    expect(container.querySelectorAll('[data-testid="hero-activity"] > div')).toHaveLength(3)
  })

  it('animated texts cannot change their row height mid-loop', () => {
    // Mid-loop the accounting row's detail truncates instead of wrapping —
    // its three states have different lengths and the row's height must not
    // move. Rendered here WITH loop state (settled renders no truncate).
    const { container } = render(
      <AccountingFrame
        state={{ rowStatus: 'Retrying', rowDetail: 'Retrying the push to Fortnox', lastPush: 'Last push 2 minutes ago' }}
      />,
    )
    const detail = container.querySelector('span + div .truncate, [class*="truncate"]')
    expect(detail).not.toBeNull()
    expect(detail!.className).toContain('truncate')
    expect(detail!.textContent).toBe('Retrying the push to Fortnox')
  })

  it('the settled page carries no truncation guard (slice 2’s pixels unchanged)', () => {
    const { container } = render(<NewSiteHome />)
    expect(container.querySelectorAll('[class*="truncate"]')).toHaveLength(0)
  })

  it('the design system’s motion section amends the public-site allowances', () => {
    const doc = join(__dirname, '..', '..', '..', '..', '..', '..', '..', '..', 'docs/product/design-system.md')
    expect(existsSync(doc), 'design-system.md exists').toBe(true)
    const motion = readFileSync(doc, 'utf8').split('## 4. Motion')[1] ?? ''
    expect(motion).toContain('Allowed on the public site')
    expect(motion).toContain('in-view animation loops')
    expect(motion).toContain('row-by-row assembly')
    expect(motion).toContain('Banned everywhere')
    expect(motion).toContain('hero product frame')
  })
})

describe('the mockup’s loops, driven by fake timers', () => {
  it('hero: pending → settled tween → accounting badge → refusal → reset, through one cycle', () => {
    vi.useFakeTimers()
    allowMotion()
    const { container } = render(<AnimatedHeroFrame />)

    const text = () => (container.querySelector('[data-testid="hero-activity"]')?.textContent ?? '').replace(/\s+/g, ' ')
    const used = () => container.querySelector('[data-testid="hero-used"]')?.textContent ?? ''

    // Before the first step: the settled frame.
    expect(used()).toBe('201.50 of 250.00 USDC')
    expect(text()).toContain('Paid data.example over x402')

    // 3000 — pending appears (mockup index.html:105).
    act(() => vi.advanceTimersByTime(3000))
    expect(text()).toContain('Paying research.example over x402')
    expect(text()).toContain('Pending')

    // 5200 — settles; the tween starts (index.html:106-109).
    act(() => vi.advanceTimersByTime(2200))
    expect(text()).toContain('Paid research.example over x402')
    expect(text()).not.toContain('Pending')
    // Mid-tween: between the endpoints (the tween's first tick already ran).
    const mid = Number(used().split(' ')[0])
    expect(mid).toBeGreaterThan(201.5)
    expect(mid).toBeLessThan(214)
    // Tween done (900 ms): 201.50 + 12.50, 86%, bar at 85.6%.
    act(() => vi.advanceTimersByTime(900))
    expect(used()).toBe('214.00 of 250.00 USDC')
    expect(container.querySelector('[data-testid="hero-percent"]')?.textContent).toBe('86%')
    expect(
      Number.parseFloat((container.querySelector('[data-testid="hero-bar"]') as HTMLElement).style.width),
    ).toBeCloseTo(85.6, 1)
    // 6800 — the row gains its accounting badge (index.html:111).
    act(() => vi.advanceTimersByTime(700))
    expect(text()).toContain('In Fortnox')

    // 11000 — the over-budget attempt is refused (index.html:112, :91).
    act(() => vi.advanceTimersByTime(4200))
    expect(text()).toContain('Refused: over budget · 36.00 left, nothing paid')
    expect(text()).toContain('40.00 USDC')
    // The displaced row leaves visually (overlay) without changing the
    // section's height — the layout-shift bar — and is dropped 420 ms later.
    act(() => vi.advanceTimersByTime(420))
    expect(text()).toContain('Refused: over budget')
    expect(text()).not.toContain('Paid api.example over x402')

    // 17500 — the list fades out (:113).
    act(() => vi.advanceTimersByTime(6080))
    expect(container.querySelector('[data-testid="hero-activity"]')).toHaveAttribute(
      'style',
      expect.stringContaining('opacity: 0'),
    )

    // 18100 — the settled baseline is restored (:114).
    act(() => vi.advanceTimersByTime(600))
    expect(used()).toBe('201.50 of 250.00 USDC')
    expect(text()).toContain('Paid data.example over x402')
    expect(text()).toContain('Paid api.example over x402')
    expect(container.querySelectorAll('[data-testid="hero-activity"] > div')).toHaveLength(3)

    // 19000 — the cycle rearmed; at 22000 (its 3000 ms step) the payment
    // pends again (:115).
    act(() => vi.advanceTimersByTime(900 + 3000))
    expect(text()).toContain('Paying research.example over x402')
  })

  it('how it works: passkey completes, budget types 0.00 → 250.00, approval lands, terminal prints', () => {
    vi.useFakeTimers()
    allowMotion()
    const { container } = render(
      <>
        <AnimatedPasskeyMiniCard />
        <AnimatedBudgetMiniCard />
        <AnimatedConnectorTerminal />
      </>,
    )

    const passkey = () => container.querySelector('[data-testid="passkey-animated"]')!.textContent ?? ''
    const budget = () => container.querySelector('[data-testid="budget-animated"]')!.textContent ?? ''
    const confirmations = () => container.querySelectorAll('[data-testid="confirmation"]')
    const budgetAmount = () =>
      (container.querySelector('[data-testid="budget-animated"] .font-local, [data-testid="budget-animated"] span')?.textContent ?? '')

    // Settled inside a running cycle, pre-steps: budget at the reset 0.00,
    // passkey at its start. (React flushes hook effects at the act boundary,
    // so typing progress is asserted across windows, not at exact offsets.)
    expect(passkey()).toContain('Create your passkey')
    expect(passkey()).not.toContain('Account created')
    act(() => vi.advanceTimersByTime(100))
    expect(budget()).toContain('0.00')
    expect(budget()).not.toContain('250.00')

    // 2100 — the passkey completes to the green confirmation (:279).
    act(() => vi.advanceTimersByTime(2000))
    expect(passkey()).toContain('Account created')
    expect(passkey()).toContain('Passkey saved on this device.')
    expect(confirmations().length).toBeGreaterThanOrEqual(1)

    // 2500 — the type step: from 0.00 (:280) toward 250.00, 95 ms per
    // keystroke. The typing hook's first keystroke is synchronous with the
    // step, later ones ride the 95 ms chain.
    act(() => vi.advanceTimersByTime(400))
    expect(budgetAmount()).toBe('2')
    act(() => vi.advanceTimersByTime(95 * 5))
    expect(budgetAmount()).toBe('250.00')

    // 3400 — "Signing…" (a control state, not a confirmation).
    // (Advanced so far: 100+2000+400+475 = 2975, where typing completes.)
    act(() => vi.advanceTimersByTime(500))
    expect(budget()).toContain('Signing…')
    expect(budget()).not.toContain('Budget approved')

    // 4500 — "Budget approved" as text + check (:282).
    act(() => vi.advanceTimersByTime(1025))
    expect(budget()).toContain('Budget approved')
    expect(confirmations().length).toBeGreaterThanOrEqual(2)

    // The terminal's lines are in the DOM from the start (opacity-only
    // reveal) and finish printing by 8000 (:283-284 + the five-line stagger).
    const terminalText = () =>
      (container.querySelector('[data-connector-terminal]')?.textContent ?? '').replace(/\s+/g, ' ')
    expect(terminalText()).toContain('Haven setup on this machine is complete.')

    // 12000 — the boundary resets everything and loops (:285-287).
    // Advanced so far: 100+2000+400+475+500+1025 = 4500.
    act(() => vi.advanceTimersByTime(12000 - 4500))
    expect(passkey()).toContain('Create your passkey')
    expect(passkey()).not.toContain('Account created')
    expect(confirmations()).toHaveLength(0)
    expect(budget()).toContain('0.00')
  })

  it('accounting: one row goes Failed → Retrying → Synced → back, on an 11 s cycle', () => {
    vi.useFakeTimers()
    allowMotion()
    const { container } = render(<AnimatedAccountingFrame />)

    const status = () => container.querySelector('[data-testid="accounting-status"]')?.textContent ?? ''
    const lastPush = () => container.querySelector('[data-testid="accounting-last-push"]')?.textContent ?? ''
    const text = () => (container.querySelector('[data-testid="accounting-animated"]')?.textContent ?? '').replace(/\s+/g, ' ')

    expect(status()).toBe('Failed')
    expect(lastPush()).toBe('Last push 2 minutes ago')

    // 1600 — Retrying (:294).
    act(() => vi.advanceTimersByTime(1600))
    expect(status()).toBe('Retrying')
    expect(text()).toContain('Retrying the push to Fortnox')

    // 3300 — Synced, invoice 1043, "just now" (:295).
    act(() => vi.advanceTimersByTime(1700))
    expect(status()).toBe('Synced')
    expect(text()).toContain('Fortnox invoice 1043 · payment evidence attached')
    expect(lastPush()).toBe('Last push just now')

    // 11000 — the reset returns the row to Failed and the line to its
    // settled text (:296).
    act(() => vi.advanceTimersByTime(11000 - 3300))
    expect(status()).toBe('Failed')
    expect(text()).toContain('Fortnox answered 503 · will retry')
    expect(lastPush()).toBe('Last push 2 minutes ago')
  })

  it('the refusal receipt assembles with the mockup’s 110 ms stagger and remounts per entry', () => {
    vi.useFakeTimers()
    allowMotion()
    const { container } = render(<AnimatedRefusalReceipt />)

    // JSDOM has no IntersectionObserver: useInView reports in view, so the
    // first entry has already armed the assembly. Every dt/dd carries the
    // pair's staggered delay (index × 110 ms — index.html:301).
    const delays = Array.from(container.querySelectorAll('dl dt')).map(
      (node) => (node as HTMLElement).style.animationDelay,
    )
    expect(delays).toEqual(['0ms', '110ms', '220ms', '330ms', '440ms'])

    // The rows stay in the DOM (nothing announced, nothing inserted).
    expect(container.querySelector('dl')?.textContent).toContain('Nothing to book')
  })
})
