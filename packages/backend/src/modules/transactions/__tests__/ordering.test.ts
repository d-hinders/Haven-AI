import { describe, expect, it } from 'vitest'
import {
  compareEnrichedTransactions,
  compareTransactions,
  enrichedTransactionIdentityKey,
  paymentAgentIdentityKey,
  transactionDedupKey,
} from '../ordering.js'
import type { EnrichedTransaction, Transaction } from '../types.js'

function tx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    hash: '0xaaa',
    type: 'native',
    from: '0xfrom',
    to: '0xto',
    value: '1000',
    valueFormatted: '0.001',
    asset: 'ETH',
    decimals: 18,
    direction: 'in',
    timestamp: 1000,
    timestampSource: 'block',
    blockNumber: 100,
    isError: false,
    ...overrides,
  }
}

function enriched(overrides: Partial<EnrichedTransaction> = {}): EnrichedTransaction {
  return {
    ...tx(),
    chainId: 8453,
    accountId: 'safe-1',
    accountAddress: '0xsafe',
    accountName: 'Main',
    ...overrides,
  }
}

describe('compareTransactions (module internals, no HTTP)', () => {
  it('sorts newest timestamp first', () => {
    const older = tx({ hash: '0x1', timestamp: 100 })
    const newer = tx({ hash: '0x2', timestamp: 200 })
    expect(compareTransactions(newer, older)).toBeLessThan(0)
    expect(compareTransactions(older, newer)).toBeGreaterThan(0)
  })

  it('breaks a timestamp tie on block number, then hash, then type, then addresses', () => {
    const a = tx({ hash: '0xaaa', timestamp: 100, blockNumber: 5 })
    const b = tx({ hash: '0xbbb', timestamp: 100, blockNumber: 5 })
    // Same timestamp and block: lexicographically smaller hash sorts first.
    expect(compareTransactions(a, b)).toBeLessThan(0)
  })
})

describe('compareEnrichedTransactions', () => {
  it('falls back to accountAddress when the underlying transaction is fully tied', () => {
    const a = enriched({ accountAddress: '0xaaaa' })
    const b = enriched({ accountAddress: '0xbbbb' })
    expect(compareEnrichedTransactions(a, b)).toBeLessThan(0)
  })
})

describe('transactionDedupKey / enrichedTransactionIdentityKey', () => {
  it('is case-insensitive on addresses and token address, but distinguishes native from a token', () => {
    const nativeTx = tx({ from: '0xABCD', to: '0xEF01' })
    const sameLowercased = tx({ from: '0xabcd', to: '0xef01' })
    expect(transactionDedupKey(nativeTx)).toBe(transactionDedupKey(sameLowercased))

    const tokenTx = tx({ tokenAddress: '0xTOKEN' })
    expect(transactionDedupKey(tokenTx)).not.toBe(transactionDedupKey(nativeTx))
  })

  it('scopes the identity key by chain and account, not just the transaction fields', () => {
    const onBase = enriched({ chainId: 8453, accountId: 'safe-base' })
    const onGnosis = enriched({ chainId: 100, accountId: 'safe-gnosis' })
    expect(enrichedTransactionIdentityKey(onBase)).not.toBe(
      enrichedTransactionIdentityKey(onGnosis),
    )
  })
})

describe('paymentAgentIdentityKey', () => {
  it('lowercases the tx hash but is exact on accountId and chainId', () => {
    expect(paymentAgentIdentityKey('0xABC', 'safe-1', 8453)).toBe('0xabc:safe-1:8453')
    expect(paymentAgentIdentityKey('0xabc', 'safe-1', 8453)).toBe(
      paymentAgentIdentityKey('0xABC', 'safe-1', 8453),
    )
    expect(paymentAgentIdentityKey('0xabc', 'safe-1', 8453)).not.toBe(
      paymentAgentIdentityKey('0xabc', 'safe-2', 8453),
    )
  })
})

describe('transactionDedupKey hash casing (#3129)', () => {
  it('collapses two rows that differ only in hash casing', () => {
    const lower = tx({ hash: '0x' + 'ab'.repeat(32) })
    const upper = tx({ hash: '0x' + 'AB'.repeat(32) })
    expect(transactionDedupKey(upper)).toBe(transactionDedupKey(lower))
  })

  it('agrees with paymentAgentIdentityKey, which already lowercased', () => {
    // The two identity keys used to disagree about whether hash casing
    // matters. Same input, same answer, is the invariant.
    const hash = '0x' + 'AB'.repeat(32)
    expect(transactionDedupKey(tx({ hash })).startsWith(hash.toLowerCase())).toBe(true)
    expect(paymentAgentIdentityKey(hash, 'acct', 8453).startsWith(hash.toLowerCase())).toBe(true)
  })
})
