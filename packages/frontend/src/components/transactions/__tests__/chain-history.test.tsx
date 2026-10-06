/**
 * #3670 (epic #3634): Gnosis (100) is history-only. A persisted chain-100 row
 * must render in the history table and its detail panel — network pill and
 * explorer link included — without throwing, and a row on a chain the registry
 * has never heard of must degrade (no link, generic label) instead of taking
 * the screen down.
 */
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LocaleProvider } from '@/context/LocaleContext'
import TransactionsTable from '@/components/transactions/TransactionsTable'
import TransactionDetailPanel from '@/components/transactions/TransactionDetailPanel'
import FilterBar from '@/components/transactions/FilterBar'
import NetworkPill from '@/components/NetworkPill'
import { getChainConfig } from '@/lib/chains'
import type { AggregatedTransaction } from '@/types/transactions'

vi.mock('@/hooks/useEscapeToClose', () => ({ useEscapeToClose: vi.fn() }))
vi.mock('@/hooks/useFocusTrap', () => ({ useFocusTrap: vi.fn() }))

function tx(chainId: number): AggregatedTransaction {
  return {
    hash: '0xabc123',
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
    chainId,
    accountId: 'a-1',
    accountAddress: '0x4444444444444444444444444444444444444444',
    accountName: 'Main',
  }
}

function renderTable(t: AggregatedTransaction) {
  return render(
    <LocaleProvider>
      <TransactionsTable
        transactions={[t]}
        loading={false}
        error={null}
        onRefresh={vi.fn()}
        hasActiveFilters={false}
      />
    </LocaleProvider>,
  )
}

describe('chain-100 history rows', () => {
  const gnosisName = getChainConfig(100).name

  it('table row links to the Gnosis explorer', () => {
    renderTable(tx(100))
    const row = screen.getAllByRole('row')[1]
    const link = within(row).getByRole('link', { name: 'Open externally' })
    expect(link.getAttribute('href')).toBe(`${getChainConfig(100).explorerUrl}/tx/0xabc123`)
  })

  it('detail panel shows the network pill and the Gnosis explorer link', () => {
    render(<TransactionDetailPanel transaction={tx(100)} open onClose={vi.fn()} />)
    expect(screen.getByText(gnosisName)).toBeTruthy()
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'))
    expect(hrefs).toContain(`${getChainConfig(100).explorerUrl}/tx/0xabc123`)
  })

  it('network pill names chain 100', () => {
    render(<NetworkPill chainId={100} />)
    expect(screen.getByText(gnosisName)).toBeTruthy()
  })
})

describe('rows on a chain the registry does not know', () => {
  it('table row renders with no explorer link', () => {
    renderTable(tx(999999))
    const row = screen.getAllByRole('row')[1]
    expect(within(row).queryByRole('link', { name: 'Open externally' })).toBeNull()
  })

  it('detail panel renders the transaction hash as plain text and a fallback pill', () => {
    render(<TransactionDetailPanel transaction={tx(999999)} open onClose={vi.fn()} />)
    expect(screen.getByText('Unknown network')).toBeTruthy()
    // Plain text, not a link: ExplorerLink also sets title= on its <a>.
    expect(screen.getByTitle('0xabc123').tagName).toBe('SPAN')
    expect(screen.queryByRole('link', { name: /0xabc123/ })).toBeNull()
  })

  it('filter bar names a selected token on an unknown chain generically', () => {
    render(
      <FilterBar
        filters={{ tokenKey: 't' }}
        onChange={vi.fn()}
        accounts={[]}
        agents={[]}
        tokens={[{ key: 't', symbol: 'FOO', chainId: 999999, isNative: false } as never]}
        loading={false}
        error={null}
      />,
    )
    expect(screen.getAllByText(/FOO \(Chain 999999\)/).length).toBeGreaterThan(0)
  })

  it('filter bar names a chain-100 token with the Gnosis name', () => {
    render(
      <FilterBar
        filters={{ tokenKey: 't' }}
        onChange={vi.fn()}
        accounts={[]}
        agents={[]}
        tokens={[{ key: 't', symbol: 'USDC.e', chainId: 100, isNative: false } as never]}
        loading={false}
        error={null}
      />,
    )
    expect(screen.getAllByText(/USDC\.e \(Gnosis\)/).length).toBeGreaterThan(0)
  })
})
