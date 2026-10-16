import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// #3812: the in-flow connect/switch control reads wagmi and RainbowKit, which
// these tests do not provide. Stub it so the test can assert WHEN a flow
// offers it; `WalletConnectAction.test.tsx` covers what it does.
vi.mock('@/components/WalletConnectAction', () => ({
  default: () => <button type="button">Connect wallet</button>,
}))

const { mockUseSend, mockToast, mockUseAccounts } = vi.hoisted(() => ({
  mockUseSend: vi.fn(),
  mockToast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  mockUseAccounts: vi.fn(),
}))

vi.mock('@/hooks/useDelegationSend', () => ({ useDelegationSend: (...a: unknown[]) => mockUseSend(...a) }))
vi.mock('@/hooks/useAccounts', () => ({ useAccounts: (...a: unknown[]) => mockUseAccounts(...a) }))
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
  return {
    busy: false,
    loaded: true,
    loadError: false,
    reload: vi.fn(),
    ready: true,
    passkeyElsewhere: false,
    send: vi.fn().mockResolvedValue({ ok: true, txHash: '0xfeed' }),
    ...overrides,
  }
}

beforeEach(() => {
  mockUseSend.mockReset()
  mockToast.success.mockReset()
  mockToast.error.mockReset()
  mockToast.info.mockReset()
  // Default: no other accounts — every pre-#4026 test runs the unchanged
  // one-account flow. The #4026 tests override with their fixtures.
  mockUseAccounts.mockReset()
  mockUseAccounts.mockReturnValue({ accounts: [], loading: false })
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

  // #1097: with the signer set LOADED, !ready is only reachable for owner-only
  // accounts — the copy names the wallet; cross-device passkeys are a hint on
  // a WORKING send instead.
  it('names the owner wallet as the blocker when loaded but not ready', () => {
    mockUseSend.mockReturnValue(base({ ready: false }))
    render(<DelegationSendModal {...PROPS} />)
    expect(screen.getByText(/Connect your account owner wallet/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
    // #3812: the way out is in the modal, not only in the header.
    expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeTruthy()
  })

  it('a ready (passkey) send offers no wallet connect (#3812)', () => {
    mockUseSend.mockReturnValue(base())
    render(<DelegationSendModal {...PROPS} />)
    expect(screen.queryByRole('button', { name: 'Connect wallet' })).toBeNull()
  })

  it('claims no blocker while the signer set is still loading', () => {
    mockUseSend.mockReturnValue(base({ loaded: false, ready: false }))
    render(<DelegationSendModal {...PROPS} />)
    expect(screen.queryByText(/Connect your account owner wallet/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Connect wallet' })).toBeNull()
  })

  it('a failed signer fetch is a retryable error, not owner-wallet advice', () => {
    const reload = vi.fn()
    mockUseSend.mockReturnValue(base({ loaded: false, loadError: true, ready: false, reload }))
    render(<DelegationSendModal {...PROPS} />)
    expect(screen.queryByText(/Connect your account owner wallet/)).toBeNull()
    expect(screen.getByText(/could not load/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(reload).toHaveBeenCalled()
  })

  it('shows the cross-device hint when ready but the passkey is elsewhere', () => {
    mockUseSend.mockReturnValue(base({ passkeyElsewhere: true }))
    render(<DelegationSendModal {...PROPS} />)
    expect(screen.getByText(/may be on another device/)).toBeTruthy()
    // The blocker copy must NOT show — this is a hint on a working send.
    expect(screen.queryByText(/Connect your account owner wallet/)).toBeNull()
  })

  it('copy is outcome language — no delegation/userop/treasury jargon', () => {
    mockUseSend.mockReturnValue(base())
    render(<DelegationSendModal {...PROPS} />)
    expect(document.body.textContent).not.toMatch(/delegation|userop|treasury|calldata|sponsor/i)
  })
})

// #4026: move funds between own accounts — other Haven accounts on the
// SENDING account's chain appear as one-tap recipients by name.
describe('DelegationSendModal — own-account recipients (#4026)', () => {
  // Base Sepolia (84532) is the sending chain of PROPS. Two own accounts on
  // it, one on a DIFFERENT chain (Ethereum Sepolia), and a duplicate
  // registration of the same address.
  const OWN_ON_CHAIN = {
    id: 'acc-b',
    account_address: '0x' + 'dd'.repeat(20),
    chain_id: 84532,
    name: 'Spending',
    is_default: false,
    created_at: '2026-10-16T00:00:00Z',
  }
  const OWN_SECOND_ON_CHAIN = {
    id: 'acc-d',
    account_address: '0x' + 'ff'.repeat(20),
    chain_id: 84532,
    name: 'Savings',
    is_default: false,
    created_at: '2026-10-16T00:00:00Z',
  }
  const OWN_OTHER_CHAIN = {
    id: 'acc-c',
    account_address: '0x' + 'ee'.repeat(20),
    chain_id: 11155111,
    name: 'Ethereum account',
    is_default: false,
    created_at: '2026-10-16T00:00:00Z',
  }

  it('offers other own accounts on the sending chain as one-tap recipients by name, never as raw addresses', () => {
    mockUseSend.mockReturnValue(base())
    mockUseAccounts.mockReturnValue({ accounts: [OWN_ON_CHAIN, OWN_OTHER_CHAIN], loading: false })
    render(<DelegationSendModal {...PROPS} />)
    const tap = screen.getByRole('button', { name: 'Send to Spending' })
    expect(tap.textContent).toBe('Spending') // the NAME is the affordance
    expect(tap.textContent).not.toContain(OWN_ON_CHAIN.account_address)
  })

  it('an own account on a different chain is never offered (two-chain fixture)', () => {
    mockUseSend.mockReturnValue(base())
    mockUseAccounts.mockReturnValue({ accounts: [OWN_ON_CHAIN, OWN_OTHER_CHAIN], loading: false })
    render(<DelegationSendModal {...PROPS} />)
    expect(screen.queryByRole('button', { name: 'Send to Ethereum account' })).toBeNull()
    expect(screen.queryByText('Ethereum account')).toBeNull()
  })

  it('tapping an own-account recipient fills the address input and the send targets it (Base Sepolia own→own)', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, txHash: '0xfeed' })
    mockUseSend.mockReturnValue(base({ send }))
    mockUseAccounts.mockReturnValue({ accounts: [OWN_ON_CHAIN], loading: false })
    render(<DelegationSendModal {...PROPS} />)
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send to Spending' }))
    // The exact address landed in the input — the user sends to what they see.
    expect((screen.getByLabelText('Recipient address') as HTMLInputElement).value).toBe(OWN_ON_CHAIN.account_address)
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(send).toHaveBeenCalled())
    expect(send.mock.calls[0][0]).toMatchObject({ to: OWN_ON_CHAIN.account_address, amountAtomic: '2000000' })
  })

  it('the same address registered twice on the chain is offered once (dedupe)', () => {
    mockUseSend.mockReturnValue(base())
    const duplicate = { ...OWN_ON_CHAIN, id: 'acc-b-2', name: 'Spending duplicate' }
    mockUseAccounts.mockReturnValue({ accounts: [OWN_ON_CHAIN, OWN_OTHER_CHAIN, duplicate, OWN_SECOND_ON_CHAIN], loading: false })
    render(<DelegationSendModal {...PROPS} />)
    expect(screen.getAllByRole('button', { name: 'Send to Spending' })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Send to Spending duplicate' })).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Send to Savings' })).toHaveLength(1)
  })

  it('the sending account itself is never offered as its own recipient', () => {
    mockUseSend.mockReturnValue(base())
    mockUseAccounts.mockReturnValue({ accounts: [OWN_ON_CHAIN], loading: false })
    render(<DelegationSendModal {...PROPS} accountAddress={OWN_ON_CHAIN.account_address} />)
    expect(screen.queryByRole('button', { name: 'Send to Spending' })).toBeNull()
  })

  // With one account the flow is UNCHANGED: no recipient section renders at
  // all — the pre-#4026 markup shape, byte for byte.
  it('with one account the send flow renders no recipient section at all', () => {
    mockUseSend.mockReturnValue(base())
    render(<DelegationSendModal {...PROPS} />)
    expect(screen.queryByText(/another Haven account/)).toBeNull()
    expect(screen.queryByRole('button', { name: /^Send to / })).toBeNull()
  })
})
