import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  settlementSchemeLabel,
  transactionInitiator,
  transactionMovement,
  transactionStatus,
  transactionTitle,
} from '../transaction-presentation'
import type { AggregatedTransaction } from '@/types/transactions'

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
