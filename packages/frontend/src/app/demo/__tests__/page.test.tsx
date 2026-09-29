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

    // Testnet banner + laptop note + prerequisites.
    expect(screen.getByText(/Test funds only/)).toBeInTheDocument()
    expect(screen.getByText(/works best on a laptop/)).toBeInTheDocument()
    expect(screen.getByText(/passkey-capable device/)).toBeInTheDocument()

    // All eight steps, in order, each with a "why it matters" line.
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
    expect(screen.getAllByText(/Why it matters:/).length).toBe(8)

    // Step 1: onboarding's live Network selector, kept on Base Sepolia. Text
    // spans multiple inline <strong> elements, so checked against the whole
    // container's text rather than one leaf node.
    expect(pageText).toMatch(/under Network when onboarding/)

    // Step 2: Base Sepolia named explicitly, pointing at the Add funds
    // modal's own faucet card (#3478) AND a direct fallback link.
    expect(screen.getByText(/Get test funds/)).toBeInTheDocument()
    expect(screen.getByText(/Open Circle's faucet/)).toBeInTheDocument()
    expect(screen.getAllByText(/Base Sepolia/).length).toBeGreaterThan(0)
    expect(screen.getByRole('link', { name: 'faucet.circle.com' })).toHaveAttribute(
      'href',
      'https://faucet.circle.com',
    )

    // Step 3: the budget is set IN the connect flow, before the paste — not
    // as a separate step 4 (review round 1 F5; the real flow is
    // details → policy (amount+period) → review → connect/paste).
    expect(screen.getByText(/0\.05 USDC, Daily/)).toBeInTheDocument()
    expect(screen.getByText(/recipient pin/)).toBeInTheDocument()

    // Step 7: Haven's own address, the under-1-USDC condition, and the real
    // refusal signal — not a fabricated two-layer story (review round 1).
    expect(screen.getByText(/0x0A5B4da361AfBc5109030010c3f1d0b64b60ba6C/)).toBeInTheDocument()
    expect(screen.getByText(/under 1 USDC/)).toBeInTheDocument()
    expect(screen.getByText(/before any money moves/)).toBeInTheDocument()
    expect(screen.getByText(/checked against the rules in your account/)).toBeInTheDocument()

    // Step 8 / F4: no false "never held custody" claim — EIP-3009 funds the
    // agent's delegate transiently.
    expect(screen.getByText(/budget you signed and it could not exceed/)).toBeInTheDocument()

    // Signup link carries no ?src=demo tracking param (owner decision).
    const signupLink = screen.getByRole('link', { name: 'Sign up' })
    expect(signupLink).toHaveAttribute('href', '/signup')

    // Links to its agent-readable companion.
    expect(screen.getByRole('link', { name: '/demo.md' })).toHaveAttribute('href', '/demo.md')
  })
})
