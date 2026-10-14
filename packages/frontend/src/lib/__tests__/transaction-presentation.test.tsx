import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  activityCounterparty,
  counterpartyLabel,
  settlementSchemeLabel,
  transactionFiat,
  transactionInitiator,
  transactionMovement,
  transactionStatus,
  transactionTitle,
} from '../transaction-presentation'
import { truncate } from '@/lib/format'
import TransactionsTable from '@/components/transactions/TransactionsTable'
import TransactionDetailPanel from '@/components/transactions/TransactionDetailPanel'
import type { AggregatedTransaction } from '@/types/transactions'

vi.mock('@/hooks/useEscapeToClose', () => ({ useEscapeToClose: vi.fn() }))
vi.mock('@/hooks/useFocusTrap', () => ({ useFocusTrap: vi.fn() }))

function tx(overrides: Partial<AggregatedTransaction> = {}): AggregatedTransaction {
  return {
    hash: '0x' + '12'.repeat(32),
    type: 'erc20',
    from: '0xA87300000000000000000000000000000000DD35',
    to: '0x135a9215604711AC70d970e12Caa812c53537EF4',
    value: '40000',
    valueFormatted: '0.04',
    asset: 'USDC',
    decimals: 6,
    direction: 'in',
    timestamp: 1779436199,
    blockNumber: 45725826,
    isError: false,
    tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    tokenSymbol: 'USDC',
    chainId: 8453,
    accountId: 'safe-id',
    accountAddress: '0x135a9215604711AC70d970e12Caa812c53537EF4',
    accountName: 'Main Haven wallet',
    ...overrides,
  }
}

describe('transaction presentation', () => {
  it('labels delegate sweeps as recovered agent funds', () => {
    const sweep = tx({
      activityType: 'delegate_sweep',
      agentName: 'Research assistant',
      agentId: 'agent-id',
      paymentId: 'sweep-id',
    })

    expect(transactionTitle(sweep)).toBe('Agent funds swept back')
    expect(transactionInitiator(sweep)).toBe('Research assistant')
    expect(transactionStatus(sweep)).toEqual({ label: 'Recovered', tone: 'success' })

    render(transactionMovement(sweep))

    expect(screen.getByText('Research assistant')).toBeInTheDocument()
    expect(screen.getByText('Main Haven wallet')).toBeInTheDocument()
  })

  it('keeps ordinary incoming transfers generic', () => {
    const incoming = tx()

    expect(transactionTitle(incoming)).toBe('Received payment')
    expect(transactionInitiator(incoming)).toBe('')
    expect(transactionStatus(incoming)).toBeNull()
  })

  // #2097 — initiator attribution is scheme-agnostic and explicit. "You" is
  // reserved for human-initiated rows; agent rows render the agent identity;
  // missing attribution renders as "Unknown", never "You".
  it('attributes an eip3009 x402 row to its agent — never "You"', () => {
    const row = tx({
      direction: 'out',
      source: 'x402',
      settlementScheme: 'eip3009',
      initiatedBy: 'agent',
      agentName: 'Research assistant',
    })

    expect(transactionInitiator(row)).toBe('Research assistant')
    expect(transactionInitiator(row)).not.toBe('You')
    expect(transactionTitle(row)).toBe('Agent payment by Research assistant')
  })

  it('attributes an erc7710 x402 row to its agent — never "You"', () => {
    const row = tx({
      direction: 'out',
      source: 'x402',
      settlementScheme: 'erc7710',
      initiatedBy: 'agent',
      agentName: 'Research assistant',
    })

    expect(transactionInitiator(row)).toBe('Research assistant')
    expect(transactionInitiator(row)).not.toBe('You')
    expect(transactionTitle(row)).toBe('Agent payment by Research assistant')
  })

  it('renders "You" only for human-initiated rows', () => {
    const row = tx({ direction: 'out', source: 'direct', initiatedBy: 'human' })

    expect(transactionInitiator(row)).toBe('You')
    expect(transactionTitle(row)).toBe('Payment sent by you')
  })

  it('renders explicit "Unknown" for outbound rows with missing attribution — never "You"', () => {
    const row = tx({ direction: 'out', source: 'direct', agentName: undefined })

    expect(transactionInitiator(row)).toBe('Unknown')
    expect(transactionInitiator(row)).not.toBe('You')
    expect(transactionTitle(row)).toBe('Payment sent')
  })

  it('maps the settlement scheme to its display label, null-in null-out', () => {
    expect(settlementSchemeLabel('eip3009')).toBe('EIP-3009')
    expect(settlementSchemeLabel('erc7710')).toBe('ERC-7710')
    expect(settlementSchemeLabel(null)).toBeNull()
    expect(settlementSchemeLabel(undefined)).toBeNull()
  })
})

/**
 * #3129 made the backend emit EIP-55 checksummed addresses on transaction
 * rows where Etherscan previously gave lowercase. That is the GNOSIS leg:
 * `chains.ts` puts Gnosis (100) on `etherscan-v2` and Base (8453, the default
 * chain) on `blockscout-v2`, which already checksummed — the opposite of what
 * the provider names suggest, and pinned by a test in
 * `packages/backend/src/modules/transactions/__tests__/normalize.test.ts`.
 * Every rendered counterparty label resolves through `transactionTitle`, and
 * both lookups inside it lowercase before matching — so the change is inert.
 *
 * These pin that. The failure mode if the lowercasing is ever dropped is
 * severe and silent: a payment row's counterparty stops reading "Acme Ltd"
 * and starts reading `0xA873…DD35`, with nothing red anywhere.
 */
describe('counterparty name resolution is case-insensitive (#3129)', () => {
  const CHECKSUMMED = '0xA87300000000000000000000000000000000DD35'
  const LOWER = CHECKSUMMED.toLowerCase()

  it('resolves a contact stored lowercase from a checksummed row address', () => {
    const resolveAddress = (address: string) =>
      address.toLowerCase() === LOWER ? 'Acme Ltd' : null

    render(transactionMovement(tx({ direction: 'in', from: CHECKSUMMED }), resolveAddress))

    expect(screen.getByText('Acme Ltd')).toBeInTheDocument()
  })

  it('resolves an own-account name stored lowercase from a checksummed row address', () => {
    const accountNames = new Map([[`${LOWER}:8453`, 'Savings']])

    render(
      transactionMovement(
        tx({ direction: 'out', to: CHECKSUMMED, chainId: 8453 }),
        undefined,
        accountNames,
      ),
    )

    expect(screen.getByText('Savings')).toBeInTheDocument()
  })

  it('CONTROL: an unresolved checksummed address falls back to the truncated form', () => {
    // So the two assertions above are not passing on a coincidence — and so
    // the fixture's two forms really do differ.
    expect(CHECKSUMMED).not.toBe(LOWER)

    render(transactionMovement(tx({ direction: 'in', from: CHECKSUMMED })))

    expect(screen.queryByText('Acme Ltd')).not.toBeInTheDocument()
  })
})

/**
 * #3810 — the dashboard's no-address mode. The dashboard reads
 * `counterpartyLabel` DIRECTLY as the merchant-first row title, so the raw
 * address must never surface there: every `truncate()` fallback is replaced
 * by calm copy. The acceptance cases, verbatim from the issue:
 * an x402 row with no resource URL ("Agent payment"), an unknown address
 * ("New recipient"), a sweep ("Returned from <agent>"), and an x402 row with
 * a resource URL (its hostname).
 */
describe('counterpartyLabel no-address mode (#3810)', () => {
  const UNKNOWN = '0x9999999999999999999999999999999999999999'

  it('reads "Agent payment" for an x402 row with no resource URL', () => {
    const label = counterpartyLabel(
      tx({ direction: 'out', source: 'x402', x402ResourceUrl: undefined }),
      undefined,
      undefined,
      { noAddress: true },
    )
    expect(label).toBe('Agent payment')
    expect(label).not.toContain('…')
  })

  it('reads the hostname for an x402 row with a resource URL', () => {
    const label = counterpartyLabel(
      tx({
        direction: 'out',
        source: 'x402',
        x402ResourceUrl: 'https://api.vendor.com/data?q=1',
      }),
      undefined,
      undefined,
      { noAddress: true },
    )
    expect(label).toBe('api.vendor.com')
  })

  it('reads "New recipient" for an address nothing resolves — never a truncated address', () => {
    const label = counterpartyLabel(
      tx({ direction: 'out', source: undefined, to: UNKNOWN }),
      () => null,
      undefined,
      { noAddress: true },
    )
    expect(label).toBe('New recipient')
    expect(label).not.toContain('…')
    expect(label).not.toContain('0x')
  })

  it('reads "Returned from <agent>" for a sweep', () => {
    const label = counterpartyLabel(
      tx({
        direction: 'in',
        activityType: 'delegate_sweep',
        agentName: 'Research assistant',
      }),
      undefined,
      undefined,
      { noAddress: true },
    )
    expect(label).toBe('Returned from Research assistant')
    expect(label).not.toContain('…')
  })

  it('reads "Deposit" for an inbound row', () => {
    const label = counterpartyLabel(tx({ direction: 'in', from: UNKNOWN }), undefined, undefined, {
      noAddress: true,
    })
    expect(label).toBe('Deposit')
    expect(label).not.toContain('…')
  })

  it('prefers the server-resolved counterparty name, then the client lookups', () => {
    const resolved = counterpartyLabel(
      tx({ direction: 'out', source: 'direct', to: UNKNOWN }),
      () => null,
      undefined,
      { noAddress: true, resolvedName: 'Acme Ltd' },
    )
    expect(resolved).toBe('Acme Ltd')

    // Without a server-side name the own-account and contact lookups still
    // run — the same resolution order the default mode uses.
    const accounts = new Map([[`${UNKNOWN.toLowerCase()}:8453`, 'Savings']])
    const viaAccounts = counterpartyLabel(
      tx({ direction: 'out', source: 'direct', to: UNKNOWN, chainId: 8453 }),
      () => null,
      accounts,
      { noAddress: true },
    )
    expect(viaAccounts).toBe('Savings')
  })

  it('CONTROL: the default mode still truncates — the detail panel and other callers keep it', () => {
    // The no-address mode stays opt-in on the helper itself. #3811 flips the
    // LIST screens to pass `{ noAddress: true }` explicitly (below); the
    // default is unchanged so any caller that wants the raw form still can.
    const label = counterpartyLabel(tx({ direction: 'out', to: UNKNOWN }))
    expect(label).toBe(truncate(UNKNOWN))
  })
})

/**
 * #3811 — the shared list screens ADOPT the no-address rules. The
 * transactions table (and, through `activityCounterparty`, the agent detail
 * Activity table) never render a truncated address in a row; the detail
 * panel is where the address lives, in full, with a copy button.
 */
describe('shared screens adopt the no-address rules (#3811)', () => {
  const UNKNOWN = '0x9999999999999999999999999999999999999999'
  const TRUNCATED = truncate(UNKNOWN)

  const row = tx({ direction: 'out', source: 'direct', to: UNKNOWN, agentName: undefined })

  function renderTable() {
    return render(
      <TransactionsTable
        transactions={[row]}
        loading={false}
        error={null}
        onRefresh={() => {}}
        hasActiveFilters={false}
      />,
    )
  }

  it('TransactionsTable renders the calm counterparty — never a truncated address', () => {
    renderTable()

    // The counterparty falls back to calm copy in BOTH the desktop and the
    // stacked mobile layout of the same table.
    expect(screen.getAllByText('New recipient').length).toBeGreaterThan(0)
    expect(screen.queryByText(TRUNCATED)).not.toBeInTheDocument()
  })

  it('TransactionDetailPanel renders the FULL address with a copy affordance', () => {
    render(
      <TransactionDetailPanel
        transaction={row}
        open
        onClose={() => {}}
        resolveAddress={() => null}
      />,
    )

    // The full address is on the screen (not the truncated form)…
    expect(screen.getAllByText(UNKNOWN).length).toBeGreaterThan(0)
    expect(screen.queryByText(TRUNCATED)).not.toBeInTheDocument()
    // …and the copy affordance names the thing, not the widget (the fixture
    // carries token + account addresses too, so there are several).
    expect(screen.getAllByRole('button', { name: 'Copy address' }).length).toBeGreaterThan(0)
  })

  it('activityCounterparty feeds a PaymentActivityItem to the shared helper', () => {
    const label = counterpartyLabel(
      activityCounterparty({
        type: 'payment',
        id: 'payment-1',
        agent_name: 'Research agent',
        token: 'USDC',
        amount: '0.10',
        to: UNKNOWN,
        status: 'confirmed',
        tx_hash: null,
        source: 'x402',
        x402_resource_url: 'https://api.vendor.com/data',
        chain_id: 8453,
        explorer_url: null,
        created_at: '2026-05-08T11:49:00Z',
      }),
      undefined,
      undefined,
      { noAddress: true },
    )
    // The merchant's hostname, through the same mode the lists read.
    expect(label).toBe('api.vendor.com')
  })
})

/**
 * #3811 — the user's currency on the shared tables (#3805's currency mode,
 * #3824's amounts). The acceptance cases, verbatim from the issue: a sweep
 * row and a direct row with no book-time fiat render `≈`; a confirmed x402
 * row with `convertedAmount` renders without it; an unpriced row renders an
 * em dash, never 0. The agent Activity table feeds the SAME path through
 * `activityToTransaction` (covered in AgentDetailClient.test.tsx).
 */
describe('the transactions table renders the user currency (#3811)', () => {
  function renderTable(rows: AggregatedTransaction[]) {
    return render(
      <TransactionsTable
        transactions={rows}
        loading={false}
        error={null}
        onRefresh={() => {}}
        hasActiveFilters={false}
      />,
    )
  }

  it('renders "≈" on a sweep row priced serve-time (no book-time fiat)', () => {
    renderTable([
      tx({
        activityType: 'delegate_sweep',
        agentName: 'Research assistant',
        approxAmount: '10.50',
        approxCurrency: 'SEK',
      }),
    ])
    expect(screen.getAllByText('≈').length).toBeGreaterThan(0)
  })

  it('renders "≈" on a direct row with no book-time fiat', () => {
    renderTable([
      tx({ direction: 'out', source: 'direct', approxAmount: '10.50', approxCurrency: 'SEK' }),
    ])
    expect(screen.getAllByText('≈').length).toBeGreaterThan(0)
  })

  it('renders no "≈" on a confirmed x402 row with book-time convertedAmount', () => {
    renderTable([
      tx({
        direction: 'out',
        source: 'x402',
        agentName: 'Research assistant',
        convertedAmount: '10.50',
        convertedCurrency: 'SEK',
        approxAmount: null,
      }),
    ])
    expect(screen.queryByText('≈')).not.toBeInTheDocument()
    // The plain book-time figure renders in the preference currency (sv-SE
    // separates the suffix with an NBSP; the sign rides in front — matched
    // on normalized text, as the dashboard's own tests do).
    expect(
      screen.getAllByText((_, element) =>
        (element?.textContent ?? '').replace(/\u00a0/g, ' ').replace(/^[-+]/, '') === '10,50 kr',
      ).length,
    ).toBeGreaterThan(0)
  })

  it('renders an em dash — never 0 — for an unpriced row', () => {
    renderTable([tx({ direction: 'out', source: 'direct', approxAmount: null })])
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })
})

describe('transactionFiat (#3811)', () => {
  it('prefers book-time convertedAmount, plain', () => {
    expect(
      transactionFiat({
        convertedAmount: '134.5000',
        convertedCurrency: 'SEK',
        approxAmount: '99.00',
        approxCurrency: 'USD',
      }),
    ).toEqual({ amount: 134.5, currency: 'SEK', approx: false })
  })

  it('falls back to the serve-time approxAmount with the ≈ mark', () => {
    expect(
      transactionFiat({ convertedAmount: null, convertedCurrency: undefined, approxAmount: '12.25', approxCurrency: 'USD' }),
    ).toEqual({ amount: 12.25, currency: 'USD', approx: true })
  })

  it('prices an unknown valuation as null — never 0', () => {
    expect(transactionFiat({ convertedAmount: null, approxAmount: null })).toEqual({
      amount: null,
      currency: 'SEK',
      approx: true,
    })
  })
})
