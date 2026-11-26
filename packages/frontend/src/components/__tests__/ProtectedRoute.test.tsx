import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

// Mock next/navigation
const mockReplace = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: mockReplace,
    push: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
}))

// Mock AuthContext
const mockUseAuth = vi.fn()
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}))

import ProtectedRoute from '@/components/ProtectedRoute'

describe('ProtectedRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders children when user is authenticated', () => {
    mockUseAuth.mockReturnValue({
      user: { id: '1', email: 'test@example.com', wallet_address: '0x1234567890abcdef1234567890abcdef12345678', account_address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' },
      loading: false,
      loadError: false,
      retryLoad: vi.fn(),
    })

    render(
      <ProtectedRoute>
        <div>Protected Content</div>
      </ProtectedRoute>,
    )

    expect(screen.getByText('Protected Content')).toBeInTheDocument()
  })

  it('redirects to /login when user is null and not loading', () => {
    mockUseAuth.mockReturnValue({
      user: null,
      loading: false,
      loadError: false,
      retryLoad: vi.fn(),
    })

    render(
      <ProtectedRoute>
        <div>Protected Content</div>
      </ProtectedRoute>,
    )

    expect(mockReplace).toHaveBeenCalledWith('/login')
    expect(screen.queryByText('Protected Content')).not.toBeInTheDocument()
  })

  it('shows loading state while auth is loading', () => {
    mockUseAuth.mockReturnValue({
      user: null,
      loading: true,
      loadError: false,
      retryLoad: vi.fn(),
    })

    render(
      <ProtectedRoute>
        <div>Protected Content</div>
      </ProtectedRoute>,
    )

    expect(screen.getByText('Loading…')).toBeInTheDocument()
    expect(screen.queryByText('Protected Content')).not.toBeInTheDocument()
    expect(mockReplace).not.toHaveBeenCalled()
  })

  /**
   * #4827: a failed READ is not a signed-out session. The owner stays on the
   * route with the load-error shape of EmptyState and one Try again action,
   * instead of being bounced to `/login` with a valid token still stored.
   */
  it('renders the load-error page instead of redirecting when the session read failed', () => {
    const retryLoad = vi.fn()
    mockUseAuth.mockReturnValue({
      user: null,
      loading: false,
      loadError: true,
      retryLoad,
    })

    render(
      <ProtectedRoute>
        <div>Protected Content</div>
      </ProtectedRoute>,
    )

    expect(screen.getByText('Your account could not load')).toBeInTheDocument()
    expect(screen.getByText('You are still signed in, and nothing has changed.')).toBeInTheDocument()
    expect(screen.queryByText('Protected Content')).not.toBeInTheDocument()
    expect(mockReplace).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(retryLoad).toHaveBeenCalledTimes(1)
  })
})
