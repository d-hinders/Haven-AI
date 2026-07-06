import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }))

vi.mock('wagmi', () => ({ usePublicClient: () => ({}) }))
vi.mock('@/lib/signer', () => ({ useActiveSigner: () => ({ type: 'eoa', address: '0x1' }) }))
vi.mock('@/lib/api', () => ({ api: { get: mockGet, post: vi.fn() } }))
vi.mock('@/components/ui/Toast', () => ({
  useToast: () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }) }),
}))

const ScheduleRenewalBanner = (await import('../ScheduleRenewalBanner')).default

const PROPS = {
  agentId: 'agent-1',
  safeAddress: '0x' + 'ab'.repeat(20),
  chainId: 84532,
  safeDetails: { threshold: 1 } as never,
}

// No local beforeEach: the global test setup already runs vi.clearAllMocks(),
// and an extra local reset/clear makes vitest re-flag the fail-quiet test's
// pre-handled rejection as an unhandled error.

describe('ScheduleRenewalBanner (#770)', () => {
  it('renders the renewal prompt when ≤2 budget periods remain', async () => {
    mockGet.mockResolvedValue({
      session_rail: true, enabled: true, periods_remaining: 2, renewal_due: true,
    })
    render(<ScheduleRenewalBanner {...PROPS} />)
    await waitFor(() => expect(screen.getByText(/Renew budget/)).toBeTruthy())
    expect(screen.getByText(/2 pre-approved budget periods left/)).toBeTruthy()
    // Outcome language only — no session/permission jargon (#736 bank):
    expect(document.body.textContent).not.toMatch(/session|permission/i)
  })

  it('warns harder on the last period', async () => {
    mockGet.mockResolvedValue({
      session_rail: true, enabled: true, periods_remaining: 1, renewal_due: true,
    })
    render(<ScheduleRenewalBanner {...PROPS} />)
    await waitFor(() => expect(screen.getByText(/last pre-approved budget period/)).toBeTruthy())
  })

  it('stays hidden while plenty of budget periods remain', async () => {
    mockGet.mockResolvedValue({
      session_rail: true, enabled: true, periods_remaining: 30, renewal_due: false,
    })
    const { container } = render(<ScheduleRenewalBanner {...PROPS} />)
    await waitFor(() => expect(mockGet).toHaveBeenCalled())
    expect(container.textContent).toBe('')
  })

  it('stays hidden on a legacy-rail account', async () => {
    mockGet.mockResolvedValue({ session_rail: false, enabled: false })
    const { container } = render(<ScheduleRenewalBanner {...PROPS} />)
    await waitFor(() => expect(mockGet).toHaveBeenCalled())
    expect(container.textContent).toBe('')
  })

  it('stays hidden when the schedule state cannot be loaded (fail-quiet)', async () => {
    // Pre-handled rejection so the mock's own promise never registers as
    // unhandled; the component's try/catch consumes the chained one.
    const rejection = Promise.reject(new Error('network'))
    rejection.catch(() => {})
    mockGet.mockImplementation(() => rejection)
    const { container } = render(<ScheduleRenewalBanner {...PROPS} />)
    await waitFor(() => expect(mockGet).toHaveBeenCalled())
    expect(container.textContent).toBe('')
  })
})
