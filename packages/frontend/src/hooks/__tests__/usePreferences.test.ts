import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const mockUseAuth = vi.fn()

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}))

vi.mock('@/lib/api', () => ({
  api: { put: vi.fn() },
}))

import { usePreferences } from '@/hooks/usePreferences'

/**
 * The display-currency contract the whole frontend leans on (#3127).
 *
 * `currency` is the one value every fiat display surface reads, and its
 * no-preference fallback must agree with the backend: a null
 * `users.currency_preference` is served as SEK (the currency every user was
 * already being served), so a payload that omits the field must read as SEK
 * here too — a 'USD' fallback would put the frontend one currency away from
 * the wire on the exact users who never opened Settings.
 */
describe('usePreferences — the display currency (#3127)', () => {
  it('falls back to SEK when the user payload carries no currency_preference', () => {
    mockUseAuth.mockReturnValue({ user: { email: 'a@b.dev' }, updateUser: vi.fn() })

    const { result } = renderHook(() => usePreferences())

    expect(result.current.currency).toBe('SEK')
  })

  it('passes the stored preference through unchanged, including SEK', () => {
    mockUseAuth.mockReturnValue({
      user: { email: 'a@b.dev', currency_preference: 'SEK' },
      updateUser: vi.fn(),
    })

    const { result } = renderHook(() => usePreferences())

    expect(result.current.currency).toBe('SEK')
  })
})
