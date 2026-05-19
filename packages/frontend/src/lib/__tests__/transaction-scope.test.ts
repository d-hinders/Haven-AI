import { describe, expect, it } from 'vitest'
import {
  buildTransactionScopeSubtitle,
  buildTransactionSummary,
} from '@/lib/transaction-scope'
import type { AggregatedTransaction } from '@/types/transactions'

const lookups = {
  accountNamesById: new Map([
    ['saf_1', 'Main account'],
    ['saf_2', 'Operations'],
  ]),
  agentNamesById: new Map([
    ['agt_1', 'Research agent'],
  ]),
  tokenSymbolsByKey: new Map([
    ['100:USDC.e', 'USDC.e'],
    ['8453:USDC', 'USDC'],
  ]),
}

describe('buildTransactionScopeSubtitle', () => {
  it('returns the default subtitle when no filters are set', () => {
    expect(buildTransactionScopeSubtitle({}, lookups)).toBe(
      'All activity across your accounts.',
    )
  })

  it('builds an account-only subtitle', () => {
    expect(
      buildTransactionScopeSubtitle({ safeId: 'saf_1' }, lookups),
    ).toBe('Transactions for Main account')
  })

  it('builds an agent-only subtitle', () => {
    expect(
      buildTransactionScopeSubtitle({ agentId: 'agt_1' }, lookups),
    ).toBe('Payments by Research agent')
  })

  it('combines account + agent', () => {
    expect(
      buildTransactionScopeSubtitle(
        { safeId: 'saf_1', agentId: 'agt_1' },
        lookups,
      ),
    ).toBe('Payments by Research agent from Main account')
  })

  it('appends the token symbol on a scoped subtitle', () => {
    expect(
      buildTransactionScopeSubtitle(
        { safeId: 'saf_1', tokenKey: '100:USDC.e' },
        lookups,
      ),
    ).toBe('Transactions for Main account · USDC.e')
  })

  it('appends the token symbol on the default subtitle (no other filters)', () => {
    expect(
      buildTransactionScopeSubtitle({ tokenKey: '8453:USDC' }, lookups),
    ).toBe('All activity across your accounts · USDC')
  })

  it('ignores unknown ids gracefully and falls back to defaults', () => {
    expect(
      buildTransactionScopeSubtitle({ safeId: 'saf_missing' }, lookups),
    ).toBe('All activity across your accounts.')
  })

  it('ignores the direction filter (communicated by the chip instead)', () => {
    expect(
      buildTransactionScopeSubtitle(
        { safeId: 'saf_2', direction: 'out' },
        lookups,
      ),
    ).toBe('Transactions for Operations')
  })
})

// Minimal stand-in for AggregatedTransaction — only the fields the summary
// reads are populated. Cast through `unknown` so we don't have to mock
// blockchain-shaped fields irrelevant to this helper.
function tx(direction: 'in' | 'out', isError = false): AggregatedTransaction {
  return {
    hash: '0xhash',
    type: 'native',
    from: '0xfrom',
    to: '0xto',
    value: '0',
    valueFormatted: '0',
    asset: 'USDC',
    decimals: 6,
    direction,
    timestamp: 0,
    blockNumber: 0,
    isError,
    chainId: 100,
    safeId: 'saf_1',
    safeAddress: '0xsafe',
    safeName: 'Main account',
  }
}

describe('buildTransactionSummary', () => {
  it('counts received and sent for successful transactions', () => {
    const result = buildTransactionSummary([
      tx('in'),
      tx('in'),
      tx('out'),
    ])
    expect(result).toEqual({ received: 2, sent: 1, failed: 0 })
  })

  it('puts failed transactions in the failed bucket, NOT also in sent', () => {
    // Regression: previously a failed outgoing tx incremented both `sent`
    // AND `failed`, so the user saw "1 sent · 1 failed" for a single
    // failed-send event. Buckets are now mutually exclusive.
    const result = buildTransactionSummary([
      tx('in'),
      tx('out'),
      tx('out', true), // failed outgoing
      tx('out', true), // failed outgoing
    ])
    expect(result).toEqual({ received: 1, sent: 1, failed: 2 })
    // Total adds up to the input length.
    expect(result.received + result.sent + result.failed).toBe(4)
  })

  it('returns zeros for an empty list', () => {
    expect(buildTransactionSummary([])).toEqual({
      received: 0,
      sent: 0,
      failed: 0,
    })
  })

  it('counts a failed incoming tx as failed only', () => {
    // Rare but possible — an inbound transfer that reverted. Same
    // mutually-exclusive rule applies.
    const result = buildTransactionSummary([tx('in', true), tx('in')])
    expect(result).toEqual({ received: 1, sent: 0, failed: 1 })
  })
})
