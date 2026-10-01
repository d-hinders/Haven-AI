/**
 * #3554: the Transactions row is a native row, the accessible path is a real
 * `<button>` around the title, and the accounting badge and explorer link are
 * its SIBLINGS. Real `useFocusTrap` / `useEscapeToClose` on purpose — focus
 * return is the contract under test, and a mocked trap proves nothing.
 */
import { useState } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { LocaleProvider } from '@/context/LocaleContext'
import TransactionsTable from '@/components/transactions/TransactionsTable'
import TransactionDetailPanel from '@/components/transactions/TransactionDetailPanel'
import type { AggregatedTransaction } from '@/types/transactions'

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
    accountId: 'safe-1',
    accountAddress: '0x4444444444444444444444444444444444444444',
    accountName: 'Main',
    source: 'x402',
    agentName: 'Research agent',
    paymentId: 'pay-1',
    accounting: {
      provider: 'fortnox',
      status: 'pushed',
      externalRef: 'fortnox:supplierinvoice:11',
      error: null,
    },
    ...overrides,
  }
}

const ROWS = [tx({ hash: '0xaaa' }), tx({ hash: '0xbbb', paymentId: 'pay-2' })]

function Harness({
  onSelect,
  rows = ROWS,
}: {
  onSelect: (t: AggregatedTransaction) => void
  rows?: AggregatedTransaction[]
}) {
  const [selected, setSelected] = useState<AggregatedTransaction | null>(null)
  return (
    <LocaleProvider>
      <TransactionsTable
        transactions={rows}
        loading={false}
        error={null}
        onRefresh={vi.fn()}
        hasActiveFilters={false}
        onSelect={(t) => {
          onSelect(t)
          setSelected(t)
        }}
      />
      <TransactionDetailPanel
        transaction={selected}
        open={selected !== null}
        onClose={() => setSelected(null)}
      />
    </LocaleProvider>
  )
}

const viewButtons = () => screen.getAllByRole('button', { name: /^View details for/ })

describe('Transactions row structure', () => {
  it('has no interactive descendant under a role="button" and no <tr role="button">', () => {
    render(<Harness onSelect={vi.fn()} />)
    for (const el of document.querySelectorAll('[role="button"]')) {
      expect(el.querySelector('a, button, [role="button"]')).toBeNull()
    }
    expect(document.querySelector('tr[role="button"]')).toBeNull()
    expect(viewButtons()).toHaveLength(ROWS.length)
  })

  it('keeps the badge and explorer link as siblings of the title button', () => {
    render(<Harness onSelect={vi.fn()} />)
    const row = screen.getAllByRole('row')[1]
    const button = within(row).getByRole('button', { name: /^View details for/ })
    expect(button.contains(within(row).getByTestId('accounting-badge'))).toBe(false)
    expect(button.contains(within(row).getByRole('link', { name: 'Open externally' }))).toBe(false)
  })

  it('non-selectable rows render no View details button and keep <p title>', () => {
    render(
      <LocaleProvider>
        <TransactionsTable
          transactions={ROWS}
          loading={false}
          error={null}
          onRefresh={vi.fn()}
          hasActiveFilters={false}
          variant="card"
        />
      </LocaleProvider>,
    )
    expect(screen.queryByRole('button', { name: /View details for/ })).toBeNull()
    expect(document.querySelectorAll('tbody p[title]')).toHaveLength(ROWS.length)
  })
})

describe('Transactions row keyboard', () => {
  it('Tab reaches each row button; Enter and Space open the drawer with one onSelect', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<Harness onSelect={onSelect} />)
    const buttons = viewButtons()

    // Sortable headers come first in tab order; Tab through them.
    for (let i = 0; i < 10 && document.activeElement !== buttons[0]; i += 1) await user.tab()
    expect(buttons[0]).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()

    expect(buttons[0]).toHaveFocus()
    await user.keyboard(' ')
    expect(onSelect).toHaveBeenCalledTimes(2)
    await user.keyboard('{Escape}')

    // Tab order inside a row: title button, then badge link, then explorer.
    await user.tab()
    expect(screen.getAllByTestId('accounting-badge')[0]).toHaveFocus()
    await user.tab()
    expect(screen.getAllByRole('link', { name: 'Open externally' })[0]).toHaveFocus()
    await user.tab()
    expect(buttons[1]).toHaveFocus()
  })

  it('Enter on the badge link activates the link and does not call onSelect', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<Harness onSelect={onSelect} />)
    const badge = screen.getAllByTestId('accounting-badge')[0]
    const clicked = vi.fn()
    badge.addEventListener('click', clicked)
    badge.focus()
    await user.keyboard('{Enter}')
    expect(clicked).toHaveBeenCalledTimes(1)
    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Enter on the explorer link does not call onSelect', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    // jsdom has no navigation; the click is what matters here.
    render(<Harness onSelect={onSelect} />)
    const link = screen.getAllByRole('link', { name: 'Open externally' })[0]
    link.addEventListener('click', (e) => e.preventDefault())
    link.focus()
    await user.keyboard('{Enter}')
    expect(onSelect).not.toHaveBeenCalled()
  })
})

describe('Transactions row focus return', () => {
  it('returns focus to the row button after keyboard open + Escape', async () => {
    const user = userEvent.setup()
    render(<Harness onSelect={vi.fn()} />)
    const buttons = viewButtons()
    buttons[1].focus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(buttons[1]).toHaveFocus()
  })

  it('returns focus to the same button after a mouse click on blank row area', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<Harness onSelect={onSelect} />)
    const buttons = viewButtons()
    const row = screen.getAllByRole('row')[2]
    await user.click(row.querySelector('td') as HTMLElement)
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(buttons[1]).toHaveFocus()
  })

  it('a click on the title button calls onSelect exactly once', () => {
    const onSelect = vi.fn()
    render(<Harness onSelect={onSelect} />)
    fireEvent.click(viewButtons()[0])
    expect(onSelect).toHaveBeenCalledTimes(1)
  })
})
