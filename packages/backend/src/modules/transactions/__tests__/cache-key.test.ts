import { describe, expect, it } from 'vitest'
import { buildTransactionCacheKey } from '../cache-key.js'

describe('buildTransactionCacheKey (module internals, no HTTP)', () => {
  it('is `tx:<chainId>:<lowercased safe address>`', () => {
    expect(buildTransactionCacheKey(8453, '0xAbCd')).toBe('tx:8453:0xabcd')
  })

  it('is independent of input casing', () => {
    expect(buildTransactionCacheKey(100, '0xAAAA')).toBe(
      buildTransactionCacheKey(100, '0xaaaa'),
    )
  })

  it('differs by chain even for the same address', () => {
    expect(buildTransactionCacheKey(8453, '0xaaaa')).not.toBe(
      buildTransactionCacheKey(100, '0xaaaa'),
    )
  })
})
