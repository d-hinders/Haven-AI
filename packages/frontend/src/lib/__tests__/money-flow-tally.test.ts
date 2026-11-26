/**
 * `tallyRow` (#4165, #4266): a folded move between the user's own accounts
 * left one account and entered another — it is neither money in nor money
 * out, priced or not.
 */
import { describe, expect, it } from 'vitest'
import { emptyFlowTally, flowFigures, tallyRow } from '@/lib/money-flow-tally'
import type { AggregatedTransaction } from '@/types/transactions'

function tx(overrides: Partial<AggregatedTransaction>): AggregatedTransaction {
  return {
    hash: '0xabc',
    type: 'erc20',
    from: '0x' + 'aa'.repeat(20),
    to: '0x' + 'bb'.repeat(20),
    value: '1000000',
    valueFormatted: '1.00',
    asset: 'USDC',
    tokenSymbol: 'USDC',
    decimals: 6,
    direction: 'out',
    timestamp: 1_778_240_999,
    blockNumber: 1,
    isError: false,
    chainId: 8453,
    accountId: 'safe-1',
    accountAddress: '0x' + 'aa'.repeat(20),
    accountName: 'Main',
    convertedAmount: '10.00',
    convertedCurrency: 'USD',
    ...overrides,
  } as AggregatedTransaction
}

const OWN = { toAccountId: 'safe-2', toAccountName: 'Reserve', toAccountAddress: '0x' + 'bb'.repeat(20) }

describe('tallyRow and own-account transfers (#4266)', () => {
  it('adds nothing for an ownTransfer row — priced or unpriced', () => {
    const tally = emptyFlowTally()
    tallyRow(tx({ ownTransfer: OWN }), 'USD', tally)
    tallyRow(tx({ ownTransfer: OWN, convertedAmount: null, approxAmount: null }), 'USD', tally)
    expect(tally).toEqual(emptyFlowTally())
  })

  it('CONTROL: the same row without ownTransfer is money out', () => {
    const tally = emptyFlowTally()
    tallyRow(tx({}), 'USD', tally)
    expect(tally.moneyOut).toBe(10)
    expect(tally.pricedOut).toBe(1)
  })
})

/**
 * #5001: the sales part of In. A sale is inbound money carrying #5000's
 * marker, so it counts in In AND in the part — the part is a subset, never a
 * third direction.
 */
describe('tallyRow and the sales part (#5001)', () => {
  const SALE = { productName: 'Haven Field Notes', receiptNumber: 'R-1', merchantReference: 'ref-1' }

  it('a sale row counts in In and in the sales part', () => {
    const tally = emptyFlowTally()
    tallyRow(tx({ direction: 'in', sale: SALE }), 'USD', tally)
    expect(tally.moneyIn).toBe(10)
    expect(tally.pricedIn).toBe(1)
    expect(tally.moneySales).toBe(10)
    expect(tally.pricedSales).toBe(1)
    expect(tally.unpricedSales).toBe(0)
  })

  it('a non-sale inbound row counts in In only', () => {
    const tally = emptyFlowTally()
    tallyRow(tx({ direction: 'in' }), 'USD', tally)
    expect(tally.moneyIn).toBe(10)
    expect(tally.moneySales).toBe(0)
    expect(tally.pricedSales).toBe(0)
  })

  it('an unpriced sale row is counted as present, and an all-unpriced part reads null ("—")', () => {
    const tally = emptyFlowTally()
    tallyRow(tx({ direction: 'in', sale: SALE, convertedAmount: null, approxAmount: null }), 'USD', tally)
    expect(tally.unpricedSales).toBe(1)
    expect(tally.pricedSales).toBe(0)
    const figures = flowFigures(tally)
    expect(figures.moneySales).toBeNull()
    // "Sales present" counts rows, unpriced ones included — never a sum test.
    expect(figures.salesPresent).toBe(true)
  })

  it('a re-priced sale row marks the sales part "≈" through its own flag', () => {
    const tally = emptyFlowTally()
    // USDC is pegged to USD; a SEK display makes the conversion change the
    // number, so `shouldMarkApprox` answers true for this row.
    tallyRow(
      tx({ direction: 'in', sale: SALE, convertedAmount: null, approxAmount: '107.60', approxCurrency: 'SEK' }),
      'SEK',
      tally,
    )
    const figures = flowFigures(tally)
    expect(figures.approxSales).toBe(true)
    expect(figures.moneySales).toBe(107.6)
  })

  it('a sale row that is not re-priced leaves the sales part unmarked', () => {
    const tally = emptyFlowTally()
    tallyRow(tx({ direction: 'in', sale: SALE }), 'USD', tally)
    expect(flowFigures(tally).approxSales).toBe(false)
  })

  it('no sale row means the part is absent, not zero-valued', () => {
    const tally = emptyFlowTally()
    tallyRow(tx({ direction: 'in' }), 'USD', tally)
    const figures = flowFigures(tally)
    expect(figures.salesPresent).toBe(false)
    expect(figures.moneySales).toBe(0)
  })
})
