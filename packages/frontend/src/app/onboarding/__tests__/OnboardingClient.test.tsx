import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseAuth = vi.fn()
const mockReplace = vi.fn()
const mockPush = vi.fn()
const mockLogout = vi.fn()
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

// The enroll flow has its own suite. Here it stands in as buttons that drive
// the two outcomes the host screen owns — completion and failure — so this
// suite can focus on the single-screen shape and the success handoff.
//
// There is only ONE flow to stand in for since #1984: the Safe rail is
// retired, so onboarding always provisions a Hybrid delegation-rail account.
vi.mock('@/app/onboarding/HybridEnrollFlow', () => ({
  default: ({
    onComplete,
    onError,
    onCreatingChange,
  }: {
    onComplete: (args: { accountAddress: string }) => void
    onError: (message: string) => void
    onCreatingChange?: (creating: boolean) => void
  }) => (
    <div data-testid="hybrid-enroll-flow">
      <button
        type="button"
        onClick={() => {
          onCreatingChange?.(true)
          onComplete({ accountAddress: CREATED_ADDRESS })
        }}
      >
        Create account with a passkey
      </button>
      <button type="button" onClick={() => onError(PASSKEY_REQUIRED_MESSAGE)}>
        fail-unsupported
      </button>
    </div>
  ),
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
    logout: mockLogout,
    ...overrides,
  }
}

beforeEach(() => {
  mockReplace.mockReset()
  mockPush.mockReset()
  mockLogout.mockReset()
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
    fireEvent.click(screen.getByRole('button', { name: /passkey/i }))
  })
  await screen.findByRole('button', { name: 'Go to dashboard' })
}

describe('OnboardingClient (#1162)', () => {
  // #1984: the Safe rail is retired, so onboarding provisions Hybrid
  // UNCONDITIONALLY. `NEXT_PUBLIC_DELEGATION_ONBOARDING` used to choose
  // between the Hybrid flow and a Safe deploy; it is gone. A flag whose
  // "off" branch now hits a 410 is not a switch, it is a way to brick
  // onboarding — so this asserts the flag has no effect at ANY value,
  // including absent, which is the state a fresh deployment starts in.
  it.each([
    ['absent', undefined],
    ['off', '0'],
    ['on', '1'],
    ['garbage', 'yes'],
  ])(
    'provisions Hybrid regardless of NEXT_PUBLIC_DELEGATION_ONBOARDING (%s)',
    (_label, value) => {
      if (value !== undefined) vi.stubEnv('NEXT_PUBLIC_DELEGATION_ONBOARDING', value)
      try {
        render(<OnboardingClient />)
        // Assert the HYBRID flow specifically, by test id, not by the copy on
        // its button. Measured, not assumed: an earlier version of this test
        // asserted `getByRole('button', { name: /passkey/i })`, and a mutation
        // that restored the old Safe fork PASSED it — because the Safe path's
        // real component renders a /passkey/i button too. A guard against a
        // fork has to name which branch it is on.
        expect(screen.getByTestId('hybrid-enroll-flow')).toBeTruthy()
        // ...and no Safe-deploy or Safe-import entry point is reachable.
        expect(screen.queryByText(/import/i)).toBeNull()
        expect(screen.queryByText(/deploy/i)).toBeNull()
      } finally {
        vi.unstubAllEnvs()
      }
    },
  )

  it('completing onboarding reports the account address, not a Safe address', async () => {
    const updateUser = vi.fn()
    mockUseAuth.mockReturnValue(authValue({ updateUser }))

    render(<OnboardingClient />)
    await completeCreation()

    expect(updateUser).toHaveBeenCalledWith({
      safe_address: CREATED_ADDRESS,
      wallet_address: null,
    })
  })

  it('renders one screen — welcome, network, passkey action — with no signer fork', () => {
    render(<OnboardingClient />)

    expect(screen.getByText('Welcome, Ada Lovelace')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Create your Haven account' })).toBeTruthy()
    expect(screen.getByLabelText('Network')).toBeTruthy()
    expect(screen.getByRole('button', { name: /passkey/i })).toBeTruthy()

    // No EOA fork...
    expect(screen.queryByText(/connect a wallet/i)).toBeNull()
    expect(screen.queryByText(/existing crypto wallet/i)).toBeNull()
    // ...and no step chrome, because there is only one step.
    expect(screen.queryByLabelText(/^Step \d+ of/)).toBeNull()
  })

  it('carries a way OUT of the auto-restored session (#1239)', () => {
    // This is the only page a signed-in user without accounts can reach:
    // /login auto-redirects here and ProtectedRoute bounces every other page
    // back here — so without this button, switching accounts requires
    // clearing site data.
    render(<OnboardingClient />)

    fireEvent.click(screen.getByRole('button', { name: 'Log out' }))
    expect(mockLogout).toHaveBeenCalledOnce()
    expect(mockReplace).toHaveBeenCalledWith('/login')
  })

  it('shows success in place rather than routing to a separate screen', async () => {
    render(<OnboardingClient />)
    await completeCreation()

    expect(screen.getByText(/You're in/)).toBeTruthy()
    // Same screen, swapped content: the create action is gone.
    expect(screen.queryByRole('button', { name: /passkey/i })).toBeNull()
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

  // #1153: the backup-signer recommendation moved to a funded-state trigger
  // on the dashboard (DashboardClient) and must never come back here — the
  // owner explicitly does not want it "in their face directly at onboarding".
  // #1162 already removed it; this is the regression guard so a future edit
  // can't quietly reintroduce it on either onboarding phase.
  it('never renders the backup-signer recovery nudge anywhere in onboarding (regression guard for #1153)', async () => {
    render(<OnboardingClient />)
    expect(screen.queryByText('Add a backup soon')).toBeNull()
    expect(screen.queryByText(/a lost device never means a lost account/i)).toBeNull()

    await completeCreation()

    expect(screen.getByText(/You're in/)).toBeTruthy()
    expect(screen.queryByText('Add a backup soon')).toBeNull()
    expect(screen.queryByText(/a lost device never means a lost account/i)).toBeNull()
  })
})
