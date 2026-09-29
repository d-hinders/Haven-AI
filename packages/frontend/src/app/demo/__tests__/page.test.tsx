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

import DemoPage, { metadata } from '../page'

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

  it('calls notFound() and renders nothing further useful when the gate is closed', () => {
    mockIsDemoPageVisible.mockReturnValue(false)
    render(<DemoPage />)
    expect(mockNotFound).toHaveBeenCalledTimes(1)
  })

  it('renders the marketing shell and all eight steps when the gate is open', () => {
    mockIsDemoPageVisible.mockReturnValue(true)
    render(<DemoPage />)
    expect(mockNotFound).not.toHaveBeenCalled()

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
      'Set and approve its budget with your passkey',
      "Check that it's connected",
      'Buy a joke',
      'Try to overspend',
      'What you just saw',
    ]
    for (const title of stepTitles) {
      expect(screen.getByRole('heading', { name: title })).toBeInTheDocument()
    }
    expect(screen.getAllByText(/Why it matters:/).length).toBe(8)

    // Step 2: Base Sepolia named explicitly, and the faucet link.
    expect(screen.getByRole('link', { name: 'Circle faucet' })).toHaveAttribute(
      'href',
      'https://faucet.circle.com',
    )
    expect(screen.getAllByText(/Base Sepolia/).length).toBeGreaterThan(0)

    // Step 4: the exact budget, and "don't add a recipient pin", not "open".
    expect(screen.getByText(/0\.05 USDC, Daily/)).toBeInTheDocument()
    expect(screen.getByText(/recipient pin/)).toBeInTheDocument()

    // Step 7: Haven's own address, and the under-1-USDC condition.
    expect(screen.getByText(/0x0A5B4da361AfBc5109030010c3f1d0b64b60ba6C/)).toBeInTheDocument()
    expect(screen.getByText(/under 1 USDC/)).toBeInTheDocument()
    expect(screen.getByText(/before any money moves/)).toBeInTheDocument()

    // Signup link carries no ?src=demo tracking param (owner decision).
    const signupLink = screen.getByRole('link', { name: 'Sign up' })
    expect(signupLink).toHaveAttribute('href', '/signup')

    // Links to its agent-readable companion.
    expect(screen.getByRole('link', { name: '/demo.md' })).toHaveAttribute('href', '/demo.md')
  })
})
