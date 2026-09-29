import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'

const { mockIsDemoPageVisible, mockNotFound } = vi.hoisted(() => ({
  mockIsDemoPageVisible: vi.fn(),
  mockNotFound: vi.fn(),
}))

vi.mock('@/lib/demo-gate', () => ({
  isDemoPageVisible: () => mockIsDemoPageVisible(),
}))

vi.mock('next/navigation', () => ({
  notFound: () => mockNotFound(),
}))

import DemoPage, { metadata, dynamic } from '../page'

/**
 * `/demo` render + gate wiring (#3477). `demo-gate.test.ts` proves the gate
 * function itself; this proves the PAGE calls it and reacts.
 */
describe('/demo page', () => {
  beforeEach(() => {
    mockIsDemoPageVisible.mockReset()
    mockNotFound.mockReset()
  })

  it('emits noindex,nofollow robots metadata', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false })
  })

  it('is rendered per-request, not prerendered at build time (review round 1 blocker)', () => {
    // Without this, Next prerenders the page once at build — on CI, that is a
    // production build with no HAVEN_DEMO_PAGE_VISIBLE — and bakes in a 404
    // that no per-request override can undo. Mirrors route.test.ts's own
    // `dynamic` assertion and /releases/page.tsx's precedent.
    expect(dynamic).toBe('force-dynamic')
  })

  it('calls notFound() and renders nothing further useful when the gate is closed', () => {
    mockIsDemoPageVisible.mockReturnValue(false)
    render(<DemoPage />)
    expect(mockNotFound).toHaveBeenCalledTimes(1)
  })

  it('renders the marketing shell and all eight steps when the gate is open', () => {
    mockIsDemoPageVisible.mockReturnValue(true)
    const { container } = render(<DemoPage />)
    expect(mockNotFound).not.toHaveBeenCalled()
    const pageText = container.textContent ?? ''

    // Marketing shell links, same as /how-it-works.
    expect(screen.getAllByRole('link', { name: /Haven/ }).length).toBeGreaterThan(0)
    expect(screen.getByRole('link', { name: 'Back to Haven' })).toHaveAttribute('href', '/')

    // The hero renders as the page's ONE <h1> (design review round 4) — not
    // Section's `title` prop, which always emits an <h2>.
    const h1 = screen.getByRole('heading', { level: 1 })
    expect(h1).toHaveTextContent('See a Haven agent pay, in about 10 minutes')
    expect(screen.queryAllByRole('heading', { level: 1 })).toHaveLength(1)

    // Testnet banner + laptop note + prerequisites. The banner is the ONLY
    // place "Test funds only" appears now — the lede no longer duplicates it
    // (design review round 4).
    expect(screen.getAllByText(/Test funds only/)).toHaveLength(1)
    expect(screen.getByText(/works best on a laptop/)).toBeInTheDocument()
    expect(screen.getByText(/passkey-capable device/)).toBeInTheDocument()
    // "harness" jargon dropped (design review round 4, nit 6).
    expect(pageText).not.toMatch(/harness/i)
    expect(screen.getByText(/One AI agent \(Claude Code, Codex, or Hermes\)/)).toBeInTheDocument()

    // All eight steps, in order.
    const stepTitles = [
      'Create your account',
      'Fund it with test USDC',
      'Connect an agent',
      'Approve its budget with your passkey',
      "Check that it's connected",
      'Buy a joke',
      'Try to overspend',
      'What you just saw',
    ]
    for (const title of stepTitles) {
      expect(screen.getByRole('heading', { name: title })).toBeInTheDocument()
    }
    // Six of eight now — steps 3 and 5 dropped a generic reused line rather
    // than keep a "why it matters" that added nothing (design review round 4).
    expect(screen.getAllByText(/Why it matters:/).length).toBe(6)

    // Step 1: onboarding's live Network selector, kept on Base Sepolia. Text
    // spans multiple inline <strong> elements, so checked against the whole
    // container's text rather than one leaf node.
    expect(pageText).toMatch(/under Network when onboarding/)

    // Step 2: Base Sepolia named explicitly, pointing at the Add funds
    // modal's own faucet card (#3478) AND a direct fallback link, now with
    // an external-link affordance (design review round 4, nit 7).
    expect(screen.getByText(/Get test funds/)).toBeInTheDocument()
    expect(screen.getByText(/Open Circle's faucet/)).toBeInTheDocument()
    expect(screen.getAllByText(/Base Sepolia/).length).toBeGreaterThan(0)
    const faucetLink = screen.getByRole('link', { name: /faucet\.circle\.com/ })
    expect(faucetLink).toHaveAttribute('href', 'https://faucet.circle.com')
    expect(faucetLink).toHaveAccessibleName(/opens in a new tab/)

    // Step 3: the budget is set IN the connect flow, before the paste — not
    // as a separate step 4 (review round 1 F5; the real flow is
    // details → policy (amount+period) → review → connect/paste).
    expect(screen.getByText(/0\.05 USDC, Daily/)).toBeInTheDocument()
    // "recipient pin" jargon reduced to plain language (design review round
    // 4, nit 6).
    expect(pageText).not.toMatch(/recipient pin/)
    expect(screen.getByText(/Leave the budget as set/)).toBeInTheDocument()

    // Step 7: Haven's own address rendered through the `Address` primitive
    // (design review round 4, item 3) — full value, not truncated, with a
    // copy affordance — and the real refusal signal, not a fabricated
    // two-layer story (review round 1).
    expect(screen.getByText('0x0A5B4da361AfBc5109030010c3f1d0b64b60ba6C')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /copy address/i })).toBeInTheDocument()
    expect(screen.getByText(/under 1 USDC/)).toBeInTheDocument()
    expect(screen.getByText(/before any money moves/)).toBeInTheDocument()
    expect(screen.getByText(/checked against the rules in your account/)).toBeInTheDocument()

    // Step 8 is an UNNUMBERED summary surface now, not StepCard 8 (design
    // review round 4). No false "never held custody" claim either — EIP-3009
    // funds the agent's delegate transiently (review round 1, F4).
    expect(screen.getByText(/budget you signed and it could not exceed/)).toBeInTheDocument()
    expect(screen.queryByText('8')).not.toBeInTheDocument()
    // "Questions? Ask the team" links out (design review round 4, nit 5) —
    // SiteFooter's own "Contact" nav item is itself an unwired "#" (no real
    // destination exists in this codebase to point at instead), so this
    // matches it faithfully rather than inventing one.
    expect(screen.getByRole('link', { name: 'Ask the team' })).toHaveAttribute('href', '#')

    // Signup link carries no ?src=demo tracking param (owner decision).
    const signupLink = screen.getByRole('link', { name: 'Sign up' })
    expect(signupLink).toHaveAttribute('href', '/signup')

    // Links to its agent-readable companion.
    expect(screen.getByRole('link', { name: '/demo.md' })).toHaveAttribute('href', '/demo.md')
  })
})
