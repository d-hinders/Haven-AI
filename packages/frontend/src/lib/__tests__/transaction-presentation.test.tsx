import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  counterpartyLabel,
  settlementSchemeLabel,
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

  it('CONTROL: the default mode still truncates — the shared screens are unchanged', () => {
    // The no-address mode is opt-in. TransactionsTable and
    // TransactionDetailPanel pass no options, so their counterparty fallback
    // stays `truncate(to)` until #3811 retires it.
    const label = counterpartyLabel(tx({ direction: 'out', to: UNKNOWN }))
    expect(label).toBe(truncate(UNKNOWN))
  })
})

/**
 * #3810 — shared screens unchanged. The presentation helpers are shared with
 * `TransactionsTable` and `TransactionDetailPanel`; rendering the SAME row
 * through both must still show the truncated address and the generic title —
 * byte-relevant output identical to pre-#3810.
 */
describe('shared screens render unchanged (#3810)', () => {
  const UNKNOWN = '0x9999999999999999999999999999999999999999'
  const TRUNCATED = truncate(UNKNOWN)

  const row = tx({ direction: 'out', source: 'direct', to: UNKNOWN, agentName: undefined })

  it('TransactionsTable keeps the truncated counterparty', () => {
    render(
      <TransactionsTable
        transactions={[row]}
        loading={false}
        error={null}
        onRefresh={() => {}}
        hasActiveFilters={false}
      />,
    )

    // The truncated counterparty renders in BOTH the desktop and the stacked
    // mobile layout of the same table — unchanged from pre-#3810.
    expect(screen.getAllByText(TRUNCATED).length).toBeGreaterThan(0)
    expect(screen.getByText('Payment sent')).toBeInTheDocument()
    expect(screen.queryByText('New recipient')).not.toBeInTheDocument()
  })

  it('TransactionDetailPanel keeps the truncated counterparty', () => {
    render(
      <TransactionDetailPanel
        transaction={row}
        open
        onClose={() => {}}
        resolveAddress={() => null}
      />,
    )

    expect(screen.getByText(TRUNCATED)).toBeInTheDocument()
    expect(screen.queryByText('New recipient')).not.toBeInTheDocument()
  })
})
