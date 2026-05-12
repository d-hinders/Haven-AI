import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UserSafe } from '@/context/AuthContext'

vi.mock('qrcode', () => ({
  default: {
    toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,qr'),
  },
}))

vi.mock('@/hooks/useEscapeToClose', () => ({
  useEscapeToClose: vi.fn(),
}))

import ReceiveFundsModal from '@/components/ReceiveFundsModal'
import ComingSoonModal from '@/components/ComingSoonModal'
import AddFundsModal from '@/components/AddFundsModal'

const SAFE: UserSafe = {
  id: 'safe-id',
  safe_address: '0xa0e99A227fc546017Fd68D49711C1857208F0eB9',
  chain_id: 8453,
  name: 'Based',
  is_default: true,
  created_at: '2026-05-11T00:00:00Z',
}

describe('ReceiveFundsModal', () => {
  const originalClipboard = navigator.clipboard
  let writeText: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
  })

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: originalClipboard,
    })
  })

  it('shows the on-chain receive context, network, address, and supported tokens', () => {
    const onClose = vi.fn()

    render(<ReceiveFundsModal open safe={SAFE} onClose={onClose} />)

    expect(screen.getByRole('heading', { name: 'Receive funds' })).toBeInTheDocument()
    expect(screen.getByText('Based')).toBeInTheDocument()
    expect(screen.getAllByText('Base').length).toBeGreaterThan(0)
    expect(screen.getByText(SAFE.safe_address)).toBeInTheDocument()
    expect(screen.getByText('ETH')).toBeInTheDocument()
    expect(screen.getByText('USDC')).toBeInTheDocument()
    expect(screen.getByText('Before you send')).toBeInTheDocument()
    expect(screen.getByText('Use the Base network.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View on explorer' })).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('copies the receive address and can reveal a QR code', async () => {
    render(<ReceiveFundsModal open safe={SAFE} onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Copy address' }))

    expect(writeText).toHaveBeenCalledWith(SAFE.safe_address)
    expect(screen.getByRole('button', { name: 'Address copied' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Show QR code' }))

    await waitFor(() => {
      expect(screen.getByAltText('QR code for Based on Base')).toBeInTheDocument()
    })
  })
})

describe('ComingSoonModal', () => {
  it('explains Add funds is future on-ramp work and can route users to Receive', () => {
    const onClose = vi.fn()
    const onReceive = vi.fn()

    render(<ComingSoonModal open onClose={onClose} onReceive={onReceive} />)

    expect(screen.getByRole('heading', { name: 'Add funds is coming soon' })).toBeInTheDocument()
    expect(screen.getByText('A guided fiat on-ramp is planned after the POC.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Receive instead' }))

    expect(onClose).toHaveBeenCalledOnce()
    expect(onReceive).toHaveBeenCalledOnce()
  })

  it('keeps the Receive handoff when rendered through AddFundsModal', () => {
    const onClose = vi.fn()
    const onReceive = vi.fn()

    render(<AddFundsModal open onClose={onClose} onReceive={onReceive} />)

    fireEvent.click(screen.getByRole('button', { name: 'Receive instead' }))

    expect(onClose).toHaveBeenCalledOnce()
    expect(onReceive).toHaveBeenCalledOnce()
  })
})
