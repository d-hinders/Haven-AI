import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockUseSend, mockToast } = vi.hoisted(() => ({
  mockUseSend: vi.fn(),
  mockToast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

vi.mock('@/hooks/useDelegationSend', () => ({ useDelegationSend: (...a: unknown[]) => mockUseSend(...a) }))
vi.mock('@/components/ui/Toast', () => ({
  useToast: () => ({ toast: Object.assign(vi.fn(), mockToast) }),
}))

const DelegationSendModal = (await import('../DelegationSendModal')).default

const PROPS = {
  open: true,
  onClose: vi.fn(),
  accountAddress: '0x' + 'aa'.repeat(20),
  chainId: 84532,
}

function base(overrides: Record<string, unknown> = {}) {
  return { busy: false, ready: true, send: vi.fn().mockResolvedValue({ ok: true, txHash: '0xfeed' }), ...overrides }
}

beforeEach(() => {
  mockUseSend.mockReset()
  mockToast.success.mockReset()
  mockToast.error.mockReset()
  mockToast.info.mockReset()
})

describe('DelegationSendModal (#1083)', () => {
  it('Send stays disabled until amount and recipient are valid', () => {
    mockUseSend.mockReturnValue(base())
    render(<DelegationSendModal {...PROPS} />)
    const sendBtn = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement
    expect(sendBtn.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '1.5' } })
    expect(sendBtn.disabled).toBe(true) // recipient still missing
    fireEvent.change(screen.getByLabelText('Recipient address'), { target: { value: '0x' + 'cc'.repeat(20) } })
    expect(sendBtn.disabled).toBe(false)
  })

  it('sends atomic units for the selected token and closes on success', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, txHash: '0xfeed' })
    const onClose = vi.fn()
    mockUseSend.mockReturnValue(base({ send }))
    render(<DelegationSendModal {...PROPS} onClose={onClose} />)
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '1.5' } })
    fireEvent.change(screen.getByLabelText('Recipient address'), { target: { value: '0x' + 'cc'.repeat(20) } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(send).toHaveBeenCalled())
    // USDC has 6 decimals on Base Sepolia — 1.5 → 1500000 atomic.
    expect(send.mock.calls[0][0]).toMatchObject({ amountAtomic: '1500000' })
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(mockToast.success).toHaveBeenCalled()
  })

  it('a dismissed passkey sheet is a NEUTRAL cancel, never an error toast', async () => {
    const send = vi.fn().mockResolvedValue({ ok: false, reason: 'cancelled' })
    mockUseSend.mockReturnValue(base({ send }))
    render(<DelegationSendModal {...PROPS} />)
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText('Recipient address'), { target: { value: '0x' + 'cc'.repeat(20) } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(send).toHaveBeenCalled())
    expect(mockToast.info).toHaveBeenCalledWith('Signature was cancelled.')
    expect(mockToast.error).not.toHaveBeenCalled()
  })

  it('names the real blocker when not ready (cross-device passkey)', () => {
    mockUseSend.mockReturnValue(base({ ready: false }))
    render(<DelegationSendModal {...PROPS} />)
    expect(screen.getByText(/lives on another device/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('copy is outcome language — no delegation/userop/treasury jargon', () => {
    mockUseSend.mockReturnValue(base())
    render(<DelegationSendModal {...PROPS} />)
    expect(document.body.textContent).not.toMatch(/delegation|userop|treasury|calldata|sponsor/i)
  })
})
