import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseAuth = vi.fn()
const mockReplace = vi.fn()
const mockPush = vi.fn()
const mockUseDeployableChains = vi.fn()

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace, push: mockPush }),
}))

vi.mock('@/hooks/useDeployableChains', () => ({
  useDeployableChains: () => mockUseDeployableChains(),
}))

// Both enroll flows have their own suites. Here they stand in as buttons that
// drive the two outcomes the host screen owns — completion and failure — so
// this suite can focus on the single-screen shape and the success handoff.
vi.mock('@/app/onboarding/PasskeyEnrollFlow', () => ({
  default: ({
    onComplete,
    onError,
    onCreatingChange,
  }: {
    onComplete: (args: { safeAddress: string; txHash: string }) => void
    onError: (message: string) => void
    onCreatingChange?: (creating: boolean) => void
  }) => (
    <>
      <button
        type="button"
        onClick={() => {
          onCreatingChange?.(true)
          onComplete({ safeAddress: CREATED_ADDRESS, txHash: `0x${'cd'.repeat(32)}` })
        }}
      >
        Create account with Face ID / Touch ID
      </button>
      <button type="button" onClick={() => onError(PASSKEY_REQUIRED_MESSAGE)}>
        fail-unsupported
      </button>
    </>
  ),
}))

vi.mock('@/app/onboarding/HybridEnrollFlow', () => ({
  default: () => <button type="button">Hybrid create</button>,
}))

import OnboardingClient, { SUCCESS_REDIRECT_MS } from '@/app/onboarding/OnboardingClient'
import { PASSKEY_REQUIRED_MESSAGE } from '@/app/onboarding/copy'

const CREATED_ADDRESS = `0x${'ab'.repeat(20)}`

const USER = {
  id: 'user-1',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  wallet_address: null,
  safe_address: null,
  safes: [],
}

function authValue(overrides: Record<string, unknown> = {}) {
  return {
    user: USER,
    loading: false,
    updateUser: vi.fn(),
    refreshUser: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

beforeEach(() => {
  mockReplace.mockReset()
  mockPush.mockReset()
  window.sessionStorage.clear()
  mockUseAuth.mockReturnValue(authValue())
  mockUseDeployableChains.mockReturnValue({
    chains: [
      { chainId: 8453, name: 'Base' },
      { chainId: 84532, name: 'Base Sepolia' },
    ],
    loading: false,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

async function completeCreation() {
  // act() so the success-state effects (including the auto-advance timer) have
  // flushed by the time the helper returns.
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Face ID/ }))
  })
  await screen.findByRole('button', { name: 'Go to dashboard' })
}

describe('OnboardingClient (#1162)', () => {
  it('renders one screen — welcome, network, passkey action — with no signer fork', () => {
    render(<OnboardingClient />)

    expect(screen.getByText('Welcome, Ada Lovelace')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Create your Haven account' })).toBeTruthy()
    expect(screen.getByLabelText('Network')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Face ID/ })).toBeTruthy()

    // No EOA fork...
    expect(screen.queryByText(/connect a wallet/i)).toBeNull()
    expect(screen.queryByText(/existing crypto wallet/i)).toBeNull()
    // ...and no step chrome, because there is only one step.
    expect(screen.queryByLabelText(/^Step \d+ of/)).toBeNull()
  })

  it('shows success in place rather than routing to a separate screen', async () => {
    render(<OnboardingClient />)
    await completeCreation()

    expect(screen.getByText(/You're in/)).toBeTruthy()
    // Same screen, swapped content: the create action is gone.
    expect(screen.queryByRole('button', { name: /Face ID/ })).toBeNull()
    // The address / setup-transaction ceremony left with the interstitial, so
    // the counterfactual (empty tx hash) case can't render a broken link.
    expect(document.querySelectorAll('a').length).toBe(1) // the Haven wordmark only
    expect(document.body.textContent).not.toContain(CREATED_ADDRESS)
  })

  it('auto-advances to the dashboard, marking just-onboarded before navigating', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(<OnboardingClient />)
    await completeCreation()

    expect(mockPush).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(SUCCESS_REDIRECT_MS)
    })

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/dashboard'))
    expect(window.sessionStorage.getItem('haven-just-onboarded')).toBe('1')
  })

  it('navigates immediately when the user does not want to wait', async () => {
    render(<OnboardingClient />)
    await completeCreation()

    fireEvent.click(screen.getByRole('button', { name: 'Go to dashboard' }))

    expect(mockPush).toHaveBeenCalledWith('/dashboard')
    expect(window.sessionStorage.getItem('haven-just-onboarded')).toBe('1')
  })

  it('surfaces a passkey-unsupported failure without offering a wallet fallback', async () => {
    render(<OnboardingClient />)

    fireEvent.click(screen.getByRole('button', { name: 'fail-unsupported' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain("can't create a passkey")
    expect(alert.textContent).toMatch(/Safari, Chrome, or Edge/)
    expect(alert.textContent).not.toMatch(/wallet/i)
    expect(screen.queryByText(/connect a wallet/i)).toBeNull()
  })

  it('bounces a user who already has an account straight to the dashboard', () => {
    mockUseAuth.mockReturnValue(
      authValue({ user: { ...USER, safe_address: `0x${'11'.repeat(20)}` } }),
    )

    render(<OnboardingClient />)

    expect(mockReplace).toHaveBeenCalledWith('/dashboard')
  })

  it('does not bounce mid-flow once creation has started', async () => {
    const { rerender } = render(<OnboardingClient />)
    await completeCreation()

    // The auth context now reports the freshly created account — the guard
    // must not fire and skip the success state.
    mockUseAuth.mockReturnValue(authValue({ user: { ...USER, safe_address: CREATED_ADDRESS } }))
    rerender(<OnboardingClient />)

    expect(mockReplace).not.toHaveBeenCalled()
    expect(screen.getByText(/You're in/)).toBeTruthy()
  })
})
