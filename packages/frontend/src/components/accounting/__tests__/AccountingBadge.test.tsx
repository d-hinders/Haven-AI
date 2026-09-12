/**
 * `AccountingBadge` (#2870): one label per feed status, the reason reachable
 * on the not-fed states, a link to `/accounting`, and — the contract's other
 * half — NOTHING when the row carries no `accounting`.
 *
 * Also pins the two integration points: the table row and the detail drawer
 * both render the badge from `tx.accounting`, and both render none without
 * it, so the "feature off / not connected / never fed" case the backend
 * expresses as an absent key is proven at the surface a user sees.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LocaleProvider } from '@/context/LocaleContext'
import { AccountingBadge, providerDisplayName } from '@/components/accounting/AccountingBadge'
import TransactionsTable from '@/components/transactions/TransactionsTable'
import TransactionDetailPanel from '@/components/transactions/TransactionDetailPanel'
import type { AggregatedTransaction } from '@/types/transactions'

vi.mock('@/hooks/useEscapeToClose', () => ({ useEscapeToClose: vi.fn() }))
vi.mock('@/hooks/useFocusTrap', () => ({ useFocusTrap: vi.fn() }))

type Accounting = NonNullable<AggregatedTransaction['accounting']>

function accounting(overrides: Partial<Accounting> = {}): Accounting {
  return {
    provider: 'fortnox',
    status: 'pushed',
    externalRef: 'fortnox:supplierinvoice:11',
    error: null,
    ...overrides,
  }
}

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
    tokenSymbol: 'USDC',
    chainId: 8453,
    safeId: 'safe-1',
    safeAddress: '0x4444444444444444444444444444444444444444',
    safeName: 'Main',
    source: 'x402',
    agentName: 'Research agent',
    paymentId: 'pay-1',
    ...overrides,
  }
}

function renderWithLocale(ui: React.ReactElement) {
  return render(<LocaleProvider>{ui}</LocaleProvider>)
}

describe('AccountingBadge', () => {
  it('renders NOTHING when the row carries no accounting object', () => {
    const { container } = renderWithLocale(<AccountingBadge accounting={undefined} />)
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByTestId('accounting-badge')).toBeNull()
  })

  it('pushed → "In <Provider>", named from the row, linking to /accounting', () => {
    renderWithLocale(<AccountingBadge accounting={accounting()} />)
    const link = screen.getByRole('link', { name: 'In Fortnox. Open accounting.' })
    expect(link).toHaveAttribute('href', '/accounting')
    expect(link).toHaveTextContent('In Fortnox')
    expect(link).toHaveAttribute('data-status', 'pushed')
  })

  it('names a different provider from the row rather than hard-coding Fortnox', () => {
    renderWithLocale(<AccountingBadge accounting={accounting({ provider: 'visma' })} />)
    expect(screen.getByRole('link')).toHaveTextContent('In Visma')
    expect(providerDisplayName('fortnox')).toBe('Fortnox')
    expect(providerDisplayName('bokio')).toBe('Bokio')
  })

  it('pending → "Feeding…"', () => {
    renderWithLocale(<AccountingBadge accounting={accounting({ status: 'pending', externalRef: null })} />)
    expect(screen.getByRole('link')).toHaveTextContent('Feeding…')
    expect(screen.getByRole('link')).toHaveAttribute('data-status', 'pending')
  })

  it.each(['failed', 'skipped'] as const)('%s → "Not fed", with the reason on hover', (status) => {
    renderWithLocale(
      <AccountingBadge accounting={accounting({ status, externalRef: null, error: 'Fortnox 502' })} />,
    )
    const link = screen.getByRole('link')
    expect(link).toHaveTextContent('Not fed')
    expect(link).toHaveAttribute('data-status', status)
    expect(screen.queryByRole('tooltip')).toBeNull()

    // The Tooltip primitive's trigger is the wrapper around the link.
    fireEvent.mouseEnter(link.parentElement as HTMLElement)
    expect(screen.getByRole('tooltip')).toHaveTextContent('Fortnox 502')
  })

  it('a pushed row with the #498 non-fatal note does NOT surface it as a failure reason', () => {
    renderWithLocale(<AccountingBadge accounting={accounting({ error: 'receipt attachment skipped' })} />)
    const link = screen.getByRole('link')
    expect(link).toHaveTextContent('In Fortnox')
    fireEvent.mouseEnter(link.parentElement as HTMLElement)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('does not let a click or Enter reach the row behind it', () => {
    const rowClick = vi.fn()
    const rowKeyDown = vi.fn()
    renderWithLocale(
      <div role="button" tabIndex={0} onClick={rowClick} onKeyDown={rowKeyDown}>
        <AccountingBadge accounting={accounting()} />
      </div>,
    )
    const link = screen.getByRole('link')
    fireEvent.click(link)
    fireEvent.keyDown(link, { key: 'Enter' })
    expect(rowClick).not.toHaveBeenCalled()
    expect(rowKeyDown).not.toHaveBeenCalled()
  })
})

describe('AccountingBadge in the Transactions table', () => {
  function renderTable(rows: AggregatedTransaction[]) {
    return renderWithLocale(
      <TransactionsTable
        transactions={rows}
        loading={false}
        error={null}
        onRefresh={vi.fn()}
        hasActiveFilters={false}
        onSelect={vi.fn()}
      />,
    )
  }

  it('renders the badge on a fed row and none on an unfed row', () => {
    renderTable([
      tx({ hash: '0xfed', paymentId: 'pay-fed', accounting: accounting() }),
      tx({ hash: '0xunfed', paymentId: 'pay-unfed' }),
    ])
    const badges = screen.getAllByTestId('accounting-badge')
    expect(badges).toHaveLength(1)
    expect(badges[0]).toHaveTextContent('In Fortnox')
  })

  it('renders no badge at all when no row carries accounting (feature off / not connected)', () => {
    renderTable([tx({ hash: '0xa' }), tx({ hash: '0xb', isError: true })])
    expect(screen.queryByTestId('accounting-badge')).toBeNull()
  })
})

describe('AccountingBadge in the detail drawer', () => {
  function renderPanel(t: AggregatedTransaction) {
    return renderWithLocale(<TransactionDetailPanel transaction={t} open onClose={vi.fn()} />)
  }

  it('shows an Accounting section with the badge when the row carries one', () => {
    renderPanel(tx({ accounting: accounting({ status: 'pending', externalRef: null }) }))
    expect(screen.getByText('Accounting')).toBeInTheDocument()
    expect(screen.getByTestId('accounting-badge')).toHaveTextContent('Feeding…')
  })

  it('shows no Accounting section without one', () => {
    renderPanel(tx())
    expect(screen.queryByText('Accounting')).toBeNull()
    expect(screen.queryByTestId('accounting-badge')).toBeNull()
  })
})
