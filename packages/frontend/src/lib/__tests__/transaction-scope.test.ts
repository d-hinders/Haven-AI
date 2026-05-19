import { describe, expect, it } from 'vitest'
import { buildTransactionScopeSubtitle } from '@/lib/transaction-scope'

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
