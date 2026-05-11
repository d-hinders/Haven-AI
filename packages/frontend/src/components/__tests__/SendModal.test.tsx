import type { ReactNode } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'

const mockUseSendTransaction = vi.fn()
const mockUseActiveSigner = vi.fn()
const mockUseSafeOperationGate = vi.fn()

vi.mock('@/hooks/useSendTransaction', () => ({
  useSendTransaction: (args: unknown) => mockUseSendTransaction(args),
}))

vi.mock('@/lib/signer', () => ({
  useActiveSigner: (args: unknown) => mockUseActiveSigner(args),
}))

vi.mock('@/hooks/useSafeOperationGate', () => ({
  useSafeOperationGate: (args: unknown) => mockUseSafeOperationGate(args),
}))

vi.mock('@/hooks/useEscapeToClose', () => ({
  useEscapeToClose: vi.fn(),
}))

vi.mock('@/components/NetworkGate', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

import SendModal from '@/components/SendModal'

const SAFE_ADDRESS = '0x1111111111111111111111111111111111111111'
const RECIPIENT = '0x2222222222222222222222222222222222222222'

const defaultProps = {
  open: true,
  onClose: vi.fn(),
  safeAddress: SAFE_ADDRESS,
  safeName: 'Operating wallet',
  safeDetails: {
    address: SAFE_ADDRESS,
    threshold: 1,
    owners: ['0xowner'],
    nonce: 1,
  },
  balances: [
    {
      symbol: 'ETH',
      name: 'ETH',
      address: null,
      balance: '5000000000000000000',
      formatted: '5',
      decimals: 18,
      usdValue: 0,
      eurValue: 0,
    },
  ],
  chainId: 8453,
  contacts: [],
  resolveAddress: vi.fn(),
}

describe('SendModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseSendTransaction.mockReturnValue({
      status: 'idle',
      txHash: null,
      error: null,
      send: vi.fn().mockResolvedValue(undefined),
      reset: vi.fn(),
    })
    mockUseActiveSigner.mockReturnValue({
      type: 'eoa',
      address: '0x3333333333333333333333333333333333333333' as Address,
      walletClient: {},
    })
    mockUseSafeOperationGate.mockReturnValue({ kind: 'ready' })
  })

  it('shows a money-first review with the selected Haven wallet and recipient', () => {
    const resolveAddress = vi.fn().mockReturnValue('Alice')
    render(<SendModal {...defaultProps} resolveAddress={resolveAddress} />)

    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '2' } })
    fireEvent.change(screen.getByPlaceholderText('0x...'), { target: { value: RECIPIENT } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(screen.getByRole('heading', { name: 'Review payment' })).toBeInTheDocument()
    expect(screen.getByText('2 ETH')).toBeInTheDocument()
    expect(screen.getByText('From')).toBeInTheDocument()
    expect(screen.getAllByText('Operating wallet').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Alice').length).toBeGreaterThan(0)
    expect(screen.getByText('0x2222...2222')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy recipient address' })).toBeInTheDocument()
    expect(screen.getByText('Approve with')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Approve and send' })).toBeInTheDocument()
  })

  it('keeps wallet approval blocked when no approval method is connected', () => {
    mockUseSafeOperationGate.mockReturnValue({ kind: 'no_signer' })
    mockUseActiveSigner.mockReturnValue(null)

    render(<SendModal {...defaultProps} />)

    expect(screen.getByText('Connect wallet to send from this account.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
  })

  it('sends from the selected Haven wallet and chain', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    mockUseSendTransaction.mockReturnValue({
      status: 'idle',
      txHash: null,
      error: null,
      send,
      reset: vi.fn(),
    })

    render(<SendModal {...defaultProps} />)

    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '1.5' } })
    fireEvent.change(screen.getByPlaceholderText('0x...'), { target: { value: RECIPIENT } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(screen.getByRole('button', { name: 'Approve and send' }))

    await waitFor(() => {
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          token: 'ETH',
          amount: '1.5',
          recipient: RECIPIENT,
        }),
        SAFE_ADDRESS,
        1,
        '0x3333333333333333333333333333333333333333',
        8453,
      )
    })
  })

  it('refreshes data when a completed payment is closed from the header', async () => {
    const onClose = vi.fn()
    const onSuccess = vi.fn()
    mockUseSendTransaction.mockReturnValue({
      status: 'confirmed',
      txHash: '0xhash',
      error: null,
      send: vi.fn().mockResolvedValue(undefined),
      reset: vi.fn(),
    })

    render(<SendModal {...defaultProps} onClose={onClose} onSuccess={onSuccess} />)

    expect(await screen.findByText('Payment sent')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    expect(onSuccess).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('shows submitted copy for multi-approval payments and refreshes on done', async () => {
    const onClose = vi.fn()
    const onSuccess = vi.fn()
    mockUseSendTransaction.mockReturnValue({
      status: 'proposed',
      txHash: '0xsafetx',
      error: null,
      send: vi.fn().mockResolvedValue(undefined),
      reset: vi.fn(),
    })

    render(
      <SendModal
        {...defaultProps}
        onClose={onClose}
        onSuccess={onSuccess}
        safeDetails={{
          ...defaultProps.safeDetails,
          threshold: 2,
          owners: ['0xowner1', '0xowner2'],
        }}
      />,
    )

    expect(await screen.findByText('Payment submitted')).toBeInTheDocument()
    expect(screen.getByText(/No money has moved yet/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))

    expect(onSuccess).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('shows a friendly error result and lets the user try again', async () => {
    const reset = vi.fn()
    mockUseSendTransaction.mockReturnValue({
      status: 'error',
      txHash: null,
      error: 'We could not send this payment. Check your approval method, then try again.',
      send: vi.fn().mockResolvedValue(undefined),
      reset,
    })

    render(<SendModal {...defaultProps} />)

    expect(await screen.findByText('Payment was not sent')).toBeInTheDocument()
    expect(screen.getByText('We could not send this payment. Check your approval method, then try again.')).toBeInTheDocument()

    reset.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(reset).toHaveBeenCalledOnce()
    expect(screen.getByRole('heading', { name: 'Send payment' })).toBeInTheDocument()
  })
})
