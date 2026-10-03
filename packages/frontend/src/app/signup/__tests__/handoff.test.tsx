import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

/**
 * The signup hand-off, end to end (#2522, proven per #3578).
 *
 * The existing suites pin the form's validation and the hand-off LINE, but no
 * test asserted that `next` and `via` survive submission: an agent pastes
 * `/signup?next=/agents&via=agent`, a human fills the form, and the signup
 * call must carry the `agent` marker while the redirect keeps `/agents`.
 * `postAuthDestination` routes an account-holding user straight to `next`.
 *
 * Run twice: against the legacy branch (gate off — today's screen, where the
 * behaviour already worked) and against the redesigned shell (gate on) — the
 * reshell must not have changed where the hand-off lands.
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

/** Fill the real form and submit it, with the agent link in the URL. */
async function fillAndSubmit() {
  const user = userEvent.setup()
  render(<SignupPage />)

  await user.type(screen.getByLabelText('Name'), 'Ada Lovelace')
  await user.type(screen.getByLabelText('Email'), 'test@example.com')
  await user.type(screen.getByLabelText('Password'), 'password123')
  await user.type(screen.getByLabelText('Confirm password'), 'password123')
  await user.click(screen.getByRole('button', { name: 'Create account' }))

  await waitFor(() => {
    expect(mockSignup).toHaveBeenCalledWith(
      'Ada Lovelace',
      'test@example.com',
      'password123',
      'agent',
    )
  })
  await waitFor(() => {
    expect(mockPush).toHaveBeenCalledWith('/agents')
  })
}

describe('SignupPage agent hand-off (#2522, #3578)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSignup.mockResolvedValue({
      id: '1',
      email: 'test@example.com',
      wallet_address: null,
      account_address: '0xabc',
    })
    window.history.replaceState(null, '', '/signup?next=/agents&via=agent')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('routes the agent link through the legacy branch (gate off)', async () => {
    await fillAndSubmit()
  })

  it('routes the agent link through the redesigned shell (gate on)', async () => {
    vi.stubEnv('NEXT_PUBLIC_HAVEN_ENV', '')
    vi.stubEnv('NEXT_PUBLIC_HAVEN_SITE_PREVIEW', '1')
    await fillAndSubmit()
  })
})
