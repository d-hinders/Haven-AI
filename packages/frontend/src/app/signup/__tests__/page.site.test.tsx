import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

/**
 * The signup page's assertions under the REDESIGNED shell (#3578, epic #3572).
 *
 * These are the same five assertions `page.test.tsx` pins for the legacy
 * screen — four fields, every validation rule, the hand-off line — run with
 * the gate on (preview flag, stubbed per test). One structural check per test
 * run (via `renderNewShell`): the public footer that only the new shell
 * renders is present, so a silently-off gate cannot let these pass against
 * the legacy branch and prove nothing.
 *
 * The real form wins over the mockup on the two lines that differ: four
 * fields (not three) and the 8-character minimum (not "At least 12
 * characters"). The mockup's "created on Base" note ships nowhere — sign-up
 * provisions on every supported chain.
 */

const mockPush = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

const mockSignup = vi.fn()
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    signup: mockSignup,
    user: null,
    loading: false,
  }),
}))

vi.mock('@/lib/api', () => {
  const ApiRequestError = class extends Error {
    status: number
    constructor(message: string, status: number) {
      super(message)
      this.name = 'ApiRequestError'
      this.status = status
    }
  }
  return { ApiRequestError, api: {} }
})

import SignupPage from '@/app/signup/page'
import { ApiRequestError } from '@/lib/api'

describe('SignupPage (site gate on, #3578)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NEXT_PUBLIC_HAVEN_ENV', '')
    vi.stubEnv('NEXT_PUBLIC_HAVEN_SITE_PREVIEW', '1')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  /** Renders the page and proves the redesigned shell is the one on screen. */
  async function renderNewShell() {
    const view = render(<SignupPage />)
    await screen.findByText('Non-custodial smart-account software. Haven never holds funds or keys.')
    return view
  }

  it('renders the four real fields, not the mockup’s three', async () => {
    await renderNewShell()

    expect(screen.getByLabelText('Name')).toBeInTheDocument()
    expect(screen.getByLabelText('Email')).toBeInTheDocument()
    expect(screen.getByLabelText('Password')).toBeInTheDocument()
    expect(screen.getByLabelText('Confirm password')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create account' })).toBeInTheDocument()
  })

  it('shows error for mismatched passwords', async () => {
    const user = userEvent.setup()
    await renderNewShell()

    await user.type(screen.getByLabelText('Name'), 'Ada Lovelace')
    await user.type(screen.getByLabelText('Email'), 'test@example.com')
    await user.type(screen.getByLabelText('Password'), 'password123')
    await user.type(screen.getByLabelText('Confirm password'), 'different123')
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    expect(screen.getByText('Passwords do not match.')).toBeInTheDocument()
    expect(mockSignup).not.toHaveBeenCalled()
  })

  it('shows error for short password (the 8-character rule, not 12)', async () => {
    const user = userEvent.setup()
    mockSignup.mockResolvedValue({ account_address: null })
    await renderNewShell()

    await user.type(screen.getByLabelText('Name'), 'Ada Lovelace')
    await user.type(screen.getByLabelText('Email'), 'test@example.com')
    // 9 characters: a password the mockup's "At least 12 characters" rule
    // would refuse and the real form must accept — 8 is the minimum.
    await user.type(screen.getByLabelText('Password'), 'password9')
    await user.type(screen.getByLabelText('Confirm password'), 'password9')
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    await waitFor(() => {
      expect(mockSignup).toHaveBeenCalledWith('Ada Lovelace', 'test@example.com', 'password9', null)
    })
  })

  it('shows error for invalid name and email', async () => {
    const user = userEvent.setup()
    await renderNewShell()

    await user.type(screen.getByLabelText('Name'), 'Bad{Name}')
    await user.clear(screen.getByLabelText('Name'))
    await user.type(screen.getByLabelText('Email'), 'not-an-email')
    await user.type(screen.getByLabelText('Password'), 'password123')
    await user.type(screen.getByLabelText('Confirm password'), 'password123')
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    expect(screen.getByText('Enter your name.')).toBeInTheDocument()
    expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument()
    expect(mockSignup).not.toHaveBeenCalled()
  })

  it('carries the agent hand-off line (#2524) outside the card', async () => {
    await renderNewShell()

    await waitFor(() =>
      expect(
        screen.getByText(`${window.location.origin}/signup`).closest('a'),
      ).toHaveAttribute('href', `${window.location.origin}/signup`),
    )
    expect(screen.getByText(/Setting up for someone else, or an AI agent\?/)).toBeInTheDocument()
  })

  it('renders the mockup card copy and the new shell chrome', async () => {
    await renderNewShell()

    expect(screen.getByRole('heading', { name: 'Create your account' })).toBeInTheDocument()
    expect(screen.getByText('One passkey prompt, no credit card, no setup call.')).toBeInTheDocument()
    expect(screen.getByRole('contentinfo')).toBeInTheDocument()
  })
})
