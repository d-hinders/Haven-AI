import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

/**
 * The login page's assertions inside the site's auth shell (#3578, epic
 * #3572). These are the four form-contract assertions `page.test.tsx` also
 * pins (fields, submission, error copy, hand-off line), plus one structural
 * check per test run (via `renderNewShell`): the public footer the shell
 * renders is present. Written while a build-time gate chose between this
 * shell and the legacy screen; since the switch-over (#3579) the shell is the
 * only screen, in a production-shaped environment too, which is what the
 * empty `NEXT_PUBLIC_HAVEN_ENV` below asserts.
 */

const mockPush = vi.fn()
const mockReplace = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: mockReplace,
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => ({
    get: vi.fn(() => null),
  }),
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

const mockLogin = vi.fn()
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    login: mockLogin,
    user: null,
    loading: false,
  }),
}))

vi.mock('@/lib/api', async () => {
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

import LoginPage from '@/app/login/page'
import { ApiRequestError } from '@/lib/api'

describe('LoginPage (site auth shell, #3578)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NEXT_PUBLIC_HAVEN_ENV', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  /** Renders the page and proves the redesigned shell is the one on screen. */
  async function renderNewShell() {
    const view = render(<LoginPage />)
    await screen.findByText('Non-custodial smart-account software. Haven never holds funds or keys.')
    return view
  }

  it('renders form fields', async () => {
    await renderNewShell()

    expect(screen.getByLabelText('Email')).toBeInTheDocument()
    expect(screen.getByLabelText('Password')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
  })

  it('calls login on submission', async () => {
    const user = userEvent.setup()
    mockLogin.mockResolvedValue({
      id: '1',
      email: 'test@example.com',
      wallet_address: null,
      account_address: '0xabc',
    })

    await renderNewShell()

    await user.type(screen.getByLabelText('Email'), 'test@example.com')
    await user.type(screen.getByLabelText('Password'), 'password123')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    await waitFor(() => {
      expect(mockLogin).toHaveBeenCalledWith('test@example.com', 'password123')
    })
  })

  it('displays API error messages', async () => {
    const user = userEvent.setup()
    mockLogin.mockRejectedValue(new ApiRequestError('Invalid credentials', 401))

    await renderNewShell()

    await user.type(screen.getByLabelText('Email'), 'test@example.com')
    await user.type(screen.getByLabelText('Password'), 'wrongpassword')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    await waitFor(() => {
      expect(screen.getByText('Invalid email or password.')).toBeInTheDocument()
    })
  })

  it('carries the agent hand-off line (#2524)', async () => {
    await renderNewShell()

    await waitFor(() =>
      expect(
        screen.getByText(`${window.location.origin}/login`).closest('a'),
      ).toHaveAttribute('href', `${window.location.origin}/login`),
    )
    expect(screen.getByText(/Setting up for someone else, or an AI agent\?/)).toBeInTheDocument()
  })

  it('renders the new shell chrome around the pinned form', async () => {
    // The banner copy and the `registered` read live inside the one form and
    // are pinned by `page.test.tsx` under the legacy branch; what is new here
    // is the shell around it — mockup heading, public footer, and no legacy
    // gradient header bar (the legacy branch renders none of the new chrome).
    await renderNewShell()

    expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeInTheDocument()
    expect(screen.getByRole('contentinfo')).toBeInTheDocument()
  })
})
