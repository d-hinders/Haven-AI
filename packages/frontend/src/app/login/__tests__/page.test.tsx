import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

/**
 * The one login-page suite (#3660). Until #3660 there were two files —
 * `page.test.tsx` (the form contract under the legacy screen) and
 * `page.site.test.tsx` (the same four assertions inside the site's auth
 * shell, plus shell chrome). Since the switch-over (#3579) they rendered the
 * SAME page, so they are folded here: every form-contract assertion runs in
 * the production-shaped shell environment (`NEXT_PUBLIC_HAVEN_ENV` empty),
 * and the shell assertions are the `renderNewShell`-backed test below.
 *
 * The inline-error assertions are the #3660 acceptance criteria: each case
 * asserts the rendered message AND the aria wiring AND that no request
 * reached `login()` — not the call assertion alone, which jsdom's own form
 * validation could satisfy for the two empty cases.
 */

// Mock next/navigation
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

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

// Mock AuthContext
const mockLogin = vi.fn()
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    login: mockLogin,
    user: null,
    loading: false,
  }),
}))

// Mock api module (for ApiRequestError)
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

describe('LoginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NEXT_PUBLIC_HAVEN_ENV', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  /** A resolved login, for the paths that should reach the API. */
  function resolveLogin() {
    mockLogin.mockResolvedValue({
      id: '1',
      email: 'test@example.com',
      wallet_address: null,
      account_address: '0xabc',
    })
  }

  /** Renders the page and proves the redesigned shell is the one on screen. */
  async function renderNewShell() {
    const view = render(<LoginPage />)
    await screen.findByText('Non-custodial smart-account software. Haven never holds funds or keys.')
    return view
  }

  it('renders form fields', () => {
    render(<LoginPage />)

    expect(screen.getByLabelText('Email')).toBeInTheDocument()
    expect(screen.getByLabelText('Password')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
  })

  /**
   * #3660: the form opts out of the browser's validation bubbles (`noValidate`)
   * but keeps `required` for assistive tech and password managers.
   */
  it('sets noValidate while keeping the required attributes (#3660)', async () => {
    await renderNewShell()

    const form = screen.getByLabelText('Email').closest('form')
    expect(form).toHaveAttribute('novalidate')
    expect(screen.getByLabelText('Email')).toHaveAttribute('required')
    expect(screen.getByLabelText('Password')).toHaveAttribute('required')
  })

  it('calls login on submission', async () => {
    const user = userEvent.setup()
    resolveLogin()

    render(<LoginPage />)

    await user.type(screen.getByLabelText('Email'), 'test@example.com')
    await user.type(screen.getByLabelText('Password'), 'password123')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    await waitFor(() => {
      expect(mockLogin).toHaveBeenCalledWith('test@example.com', 'password123')
    })
  })

  /**
   * #3660: the email SENT is the trimmed value (the backend's normalizeEmail
   * trims and lowercases before the lookup; no client-side lowercasing).
   */
  it('sends the trimmed email (#3660)', async () => {
    const user = userEvent.setup()
    resolveLogin()

    render(<LoginPage />)

    await user.type(screen.getByLabelText('Email'), '  test@example.com  ')
    await user.type(screen.getByLabelText('Password'), 'password123')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    await waitFor(() => {
      expect(mockLogin).toHaveBeenCalledWith('test@example.com', 'password123')
    })
  })

  it('shows an inline error for an empty email and calls nothing (#3660)', async () => {
    const user = userEvent.setup()

    render(<LoginPage />)

    await user.type(screen.getByLabelText('Password'), 'password123')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(screen.getByText('Enter your email address.')).toBeInTheDocument()
    const email = screen.getByLabelText('Email')
    expect(email).toHaveAttribute('aria-invalid', 'true')
    expect(email).toHaveAttribute('aria-describedby', 'email-error')
    expect(document.getElementById('email-error')).toHaveAttribute('id', 'email-error')
    // The password field is untouched: its own error state stays clear.
    expect(screen.queryByText('Enter your password.')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'false')
    expect(mockLogin).not.toHaveBeenCalled()
  })

  /**
   * #3660's proving case: `a@b` is a valid `type=email` value, so the browser
   * never bubbles it — today it reached the server and came back as a
   * misleading "Invalid email or password.". Now it is refused inline, before
   * any request.
   */
  it('shows an inline error for a malformed email and calls nothing (#3660)', async () => {
    const user = userEvent.setup()

    render(<LoginPage />)

    await user.type(screen.getByLabelText('Email'), 'a@b')
    await user.type(screen.getByLabelText('Password'), 'password123')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument()
    const email = screen.getByLabelText('Email')
    expect(email).toHaveAttribute('aria-invalid', 'true')
    expect(email).toHaveAttribute('aria-describedby', 'email-error')
    expect(mockLogin).not.toHaveBeenCalled()
  })

  it('shows an inline error for an empty password and calls nothing (#3660)', async () => {
    const user = userEvent.setup()

    render(<LoginPage />)

    await user.type(screen.getByLabelText('Email'), 'test@example.com')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(screen.getByText('Enter your password.')).toBeInTheDocument()
    const password = screen.getByLabelText('Password')
    expect(password).toHaveAttribute('aria-invalid', 'true')
    expect(password).toHaveAttribute('aria-describedby', 'password-error')
    expect(mockLogin).not.toHaveBeenCalled()
  })

  /**
   * #3660: each field's error clears as the user edits it, and a corrected
   * field submits through to the API.
   */
  it('clears a field error as the user edits and then submits (#3660)', async () => {
    const user = userEvent.setup()
    resolveLogin()

    render(<LoginPage />)

    await user.type(screen.getByLabelText('Email'), 'a@b')
    await user.type(screen.getByLabelText('Password'), 'password123')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument()

    await user.type(screen.getByLabelText('Email'), '.c')

    expect(screen.queryByText('Enter a valid email address.')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'false')
    expect(screen.getByLabelText('Email')).not.toHaveAttribute('aria-describedby')

    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => {
      expect(mockLogin).toHaveBeenCalledWith('a@b.c', 'password123')
    })
  })

  it('displays API error messages', async () => {
    const user = userEvent.setup()
    mockLogin.mockRejectedValue(new ApiRequestError('Invalid credentials', 401))

    render(<LoginPage />)

    await user.type(screen.getByLabelText('Email'), 'test@example.com')
    await user.type(screen.getByLabelText('Password'), 'wrongpassword')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    await waitFor(() => {
      expect(screen.getByText('Invalid email or password.')).toBeInTheDocument()
    })
  })

  /**
   * #3660: the 5xx banner was untested — a 5xx says "our end", not "your
   * credentials".
   */
  it('displays the 5xx banner (#3660)', async () => {
    const user = userEvent.setup()
    mockLogin.mockRejectedValue(new ApiRequestError('Server error', 503))

    render(<LoginPage />)

    await user.type(screen.getByLabelText('Email'), 'test@example.com')
    await user.type(screen.getByLabelText('Password'), 'password123')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    await waitFor(() => {
      expect(screen.getByText('Something went wrong on our end. Please try again.')).toBeInTheDocument()
    })
  })

  /**
   * #2524: the hand-off line an agent needs on this page. The line's own
   * behaviour is covered in
   * `components/onboarding/__tests__/AgentHandoffNote.test.tsx`; what this
   * asserts is that the page still MOUNTS it, which is the part a refactor of
   * this file can silently drop.
   */
  it('carries the agent hand-off line (#2524)', async () => {
    render(<LoginPage />)

    await waitFor(() =>
      expect(
        screen.getByText(`${window.location.origin}/login`).closest('a'),
      ).toHaveAttribute('href', `${window.location.origin}/login`),
    )
    expect(screen.getByText(/Setting up for someone else, or an AI agent\?/)).toBeInTheDocument()
  })

  it('renders the new shell chrome around the pinned form', async () => {
    // From the folded `page.site.test.tsx`: the shell around the form is the
    // redesigned one — mockup heading, public footer, no legacy gradient bar.
    await renderNewShell()

    expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeInTheDocument()
    expect(screen.getByRole('contentinfo')).toBeInTheDocument()
  })
})
