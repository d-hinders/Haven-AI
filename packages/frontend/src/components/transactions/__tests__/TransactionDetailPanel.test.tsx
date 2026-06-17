import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import TransactionDetailPanel from '@/components/transactions/TransactionDetailPanel'
import type { AggregatedTransaction } from '@/types/transactions'

vi.mock('@/hooks/useEscapeToClose', () => ({ useEscapeToClose: vi.fn() }))
vi.mock('@/hooks/useFocusTrap', () => ({ useFocusTrap: vi.fn() }))

function tx(overrides: Partial<AggregatedTransaction> = {}): AggregatedTransaction {
  return {
    hash: '0xhash',
    type: 'erc20',
    from: '0x1111111111111111111111111111111111111111',
    to: '0x2222222222222222222222222222222222222222',
    value: '1000000',
    valueFormatted: '1.00',
    asset: 'USDC',
    decimals: 6,
    direction: 'out',
    timestamp: 1_700_000_000,
    blockNumber: 1,
    isError: false,
    tokenAddress: '0x3333333333333333333333333333333333333333',
    tokenSymbol: 'USDC',
    chainId: 8453,
    safeId: 'safe-1',
    safeAddress: '0x4444444444444444444444444444444444444444',
    safeName: 'Main',
    ...overrides,
  }
}

function renderPanel(t: AggregatedTransaction, resolveAddress?: (a: string) => string | null) {
  return render(
    <TransactionDetailPanel
      transaction={t}
      open
      onClose={vi.fn()}
      resolveAddress={resolveAddress}
    />,
  )
}

describe('TransactionDetailPanel', () => {
  it('renders nothing when no transaction is selected', () => {
    const { container } = render(
      <TransactionDetailPanel transaction={null} open={false} onClose={vi.fn()} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the x402 body with resource, merchant, and payment id', () => {
    renderPanel(
      tx({
        source: 'x402',
        agentName: 'Research agent',
        x402ResourceUrl: 'https://api.example.com/data?q=1',
        x402MerchantAddress: '0x5555555555555555555555555555555555555555',
        paymentId: 'pay_abcdef123456',
      }),
    )
    expect(screen.getByText('Payment')).toBeInTheDocument()
    expect(screen.getByText('Resource')).toBeInTheDocument()
    expect(screen.getByText('api.example.com')).toBeInTheDocument() // hostname, not full URL
    expect(screen.getByText('Merchant')).toBeInTheDocument()
    expect(screen.getByText('Research agent')).toBeInTheDocument()
    expect(screen.getByText('Payment ID')).toBeInTheDocument()
  })

  it('shows the send body with recipient and initiator', () => {
    renderPanel(tx({ direction: 'out', source: 'direct', agentName: undefined }))
    expect(screen.getByText('Transfer')).toBeInTheDocument()
    expect(screen.getByText('To')).toBeInTheDocument()
    expect(screen.getByText('Initiator')).toBeInTheDocument()
    expect(screen.getByText('You')).toBeInTheDocument() // no agent → user-initiated
  })

  it('attributes the initiator to the agent when present', () => {
    renderPanel(tx({ direction: 'out', source: 'direct', agentName: 'Ops agent' }))
    expect(screen.getByText('Ops agent')).toBeInTheDocument()
  })

  it('shows the receive body with sender', () => {
    renderPanel(tx({ direction: 'in', source: 'direct' }))
    expect(screen.getByText('Transfer')).toBeInTheDocument()
    expect(screen.getByText('From')).toBeInTheDocument()
  })

  it('shows the allowance-funding body for delegate sweeps', () => {
    renderPanel(tx({ activityType: 'delegate_sweep' }))
    expect(screen.getByText('Allowance funding')).toBeInTheDocument()
  })

  it('resolves a counterparty name from the address book', () => {
    renderPanel(
      tx({ direction: 'in', source: 'direct' }),
      (a) => (a === '0x1111111111111111111111111111111111111111' ? 'Alice' : null),
    )
    expect(screen.getByText('Alice')).toBeInTheDocument()
  })

  it('always renders the on-chain section with a tx explorer link', () => {
    renderPanel(tx())
    expect(screen.getByText('On-chain')).toBeInTheDocument()
    const txLink = screen.getByRole('link', { name: /0xhash/i })
    expect(txLink).toHaveAttribute('href', expect.stringContaining('/tx/0xhash'))
  })

  it('signs the headline amount by direction', () => {
    const { rerender } = renderPanel(tx({ direction: 'out' }))
    expect(screen.getByText(/^-1\.00 USDC$/)).toBeInTheDocument()
    rerender(
      <TransactionDetailPanel transaction={tx({ direction: 'in' })} open onClose={vi.fn()} />,
    )
    expect(screen.getByText(/^\+1\.00 USDC$/)).toBeInTheDocument()
  })
})
