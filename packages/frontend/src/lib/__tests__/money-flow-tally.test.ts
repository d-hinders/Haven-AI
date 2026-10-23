/**
 * `tallyRow` (#4165, #4266): a folded move between the user's own accounts
 * left one account and entered another — it is neither money in nor money
 * out, priced or not.
 */
import { describe, expect, it } from 'vitest'
import { emptyFlowTally, tallyRow } from '@/lib/money-flow-tally'
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
