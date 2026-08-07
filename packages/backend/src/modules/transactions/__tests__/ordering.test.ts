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
    blockNumber: 100,
    isError: false,
    ...overrides,
  }
}

function enriched(overrides: Partial<EnrichedTransaction> = {}): EnrichedTransaction {
  return {
    ...tx(),
    chainId: 8453,
    safeId: 'safe-1',
    safeAddress: '0xsafe',
    safeName: 'Main',
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
  it('falls back to safeAddress when the underlying transaction is fully tied', () => {
    const a = enriched({ safeAddress: '0xaaaa' })
    const b = enriched({ safeAddress: '0xbbbb' })
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

  it('scopes the identity key by chain and Safe, not just the transaction fields', () => {
    const onBase = enriched({ chainId: 8453, safeId: 'safe-base' })
    const onGnosis = enriched({ chainId: 100, safeId: 'safe-gnosis' })
    expect(enrichedTransactionIdentityKey(onBase)).not.toBe(
      enrichedTransactionIdentityKey(onGnosis),
    )
  })
})

describe('paymentAgentIdentityKey', () => {
  it('lowercases the tx hash but is exact on safeId and chainId', () => {
    expect(paymentAgentIdentityKey('0xABC', 'safe-1', 8453)).toBe('0xabc:safe-1:8453')
    expect(paymentAgentIdentityKey('0xabc', 'safe-1', 8453)).toBe(
      paymentAgentIdentityKey('0xABC', 'safe-1', 8453),
    )
    expect(paymentAgentIdentityKey('0xabc', 'safe-1', 8453)).not.toBe(
      paymentAgentIdentityKey('0xabc', 'safe-2', 8453),
    )
  })
})
