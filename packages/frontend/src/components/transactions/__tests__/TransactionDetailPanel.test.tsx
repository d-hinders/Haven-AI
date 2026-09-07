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
    // #2357: the section heading names the protocol, because the drawer is the
    // advanced surface — the primary row title no longer does.
    expect(screen.getByText('x402 payment')).toBeInTheDocument()
    expect(screen.getByText('Resource')).toBeInTheDocument()
    expect(screen.getByText('api.example.com')).toBeInTheDocument() // hostname, not full URL
    expect(screen.getByText('Merchant')).toBeInTheDocument()
    expect(screen.getByText('Research agent')).toBeInTheDocument()
    expect(screen.getByText('Payment ID')).toBeInTheDocument()
  })

  it('shows the settlement scheme for an eip3009 x402 payment', () => {
    renderPanel(
      tx({
        source: 'x402',
        settlementScheme: 'eip3009',
      }),
    )
    expect(screen.getByText('Settlement')).toBeInTheDocument()
    expect(screen.getByText('EIP-3009')).toBeInTheDocument()
  })

  it('shows the settlement scheme for an erc7710 x402 payment', () => {
    renderPanel(
      tx({
        source: 'x402',
        settlementScheme: 'erc7710',
      }),
    )
    expect(screen.getByText('Settlement')).toBeInTheDocument()
    expect(screen.getByText('ERC-7710')).toBeInTheDocument()
  })

  it('renders no settlement row for x402 rows without a recorded scheme', () => {
    renderPanel(tx({ source: 'x402' }))
    expect(screen.queryByText('Settlement')).not.toBeInTheDocument()
  })

  it('renders no settlement row for non-x402 kinds even when a scheme is present', () => {
    renderPanel(
      tx({
        direction: 'out',
        source: 'direct',
        settlementScheme: 'eip3009',
      }),
    )
    expect(screen.queryByText('Settlement')).not.toBeInTheDocument()
  })

  it('shows the send body with recipient and initiator', () => {
    renderPanel(
      tx({ direction: 'out', source: 'direct', agentName: undefined, initiatedBy: 'human' }),
    )
    expect(screen.getByText('Transfer')).toBeInTheDocument()
    expect(screen.getByText('To')).toBeInTheDocument()
    expect(screen.getByText('Initiator')).toBeInTheDocument()
    expect(screen.getByText('You')).toBeInTheDocument() // "You" only for human-initiated (#2097)
  })

  it('renders explicit "Unknown" — never "You" — when an outbound row has missing attribution', () => {
    renderPanel(tx({ direction: 'out', source: 'direct', agentName: undefined }))
    expect(screen.getByText('Transfer')).toBeInTheDocument()
    expect(screen.getByText('Initiator')).toBeInTheDocument()
    expect(screen.getByText('Unknown')).toBeInTheDocument()
    expect(screen.queryByText('You')).not.toBeInTheDocument()
  })

  it('attributes the initiator to the agent when present', () => {
    renderPanel(
      tx({ direction: 'out', source: 'direct', agentName: 'Ops agent', initiatedBy: 'agent' }),
    )
    expect(screen.getByText('Ops agent')).toBeInTheDocument()
    expect(screen.queryByText('You')).not.toBeInTheDocument()
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
