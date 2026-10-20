import { describe, expect, it } from 'vitest'
import { shouldMarkApprox, type ApproxMarkInput } from './approx-mark.js'
import { CHAIN_REGISTRY, tokenPeg } from './chains.js'

const usdcInUsd: ApproxMarkInput = {
  repriced: true,
  chainId: 8453,
  tokenSymbol: 'USDC',
  displayCurrency: 'USD',
  kind: 'total',
}

describe('tokenPeg (#4165)', () => {
  it('marks every USDC asset in the registry as USD-pegged, and nothing that floats', () => {
    const pegged = Object.values(CHAIN_REGISTRY).flatMap((chain) =>
      chain.tokens.filter((token) => token.pegged === 'USD').map((token) => `${chain.chainId}:${token.symbol}`),
    )
    expect(pegged.sort()).toEqual(['100:USDC.e', '84532:USDC', '8453:USDC'])
    expect(tokenPeg(8453, 'ETH')).toBeNull()
    expect(tokenPeg(100, 'EURe')).toBeNull()
  })

  it('answers null, never throws, for an unknown chain, token or a missing fact', () => {
    expect(tokenPeg(999999, 'USDC')).toBeNull()
    expect(tokenPeg(8453, 'NOPE')).toBeNull()
    expect(tokenPeg(null, 'USDC')).toBeNull()
    expect(tokenPeg(8453, undefined)).toBeNull()
  })
})

describe('shouldMarkApprox (#4165)', () => {
  it('never marks USDC shown in USD — a total, the detail panel, or a row', () => {
    expect(shouldMarkApprox(usdcInUsd)).toBe(false)
    expect(shouldMarkApprox({ ...usdcInUsd, kind: 'detail' })).toBe(false)
    expect(shouldMarkApprox({ ...usdcInUsd, kind: 'row' })).toBe(false)
    expect(shouldMarkApprox({ ...usdcInUsd, chainId: 100, tokenSymbol: 'USDC.e' })).toBe(false)
  })

  it('marks a re-priced figure in another currency on totals and the detail panel, never on a row', () => {
    const sek = { ...usdcInUsd, displayCurrency: 'SEK' as const }
    expect(shouldMarkApprox(sek)).toBe(true)
    expect(shouldMarkApprox({ ...sek, kind: 'detail' })).toBe(true)
    expect(shouldMarkApprox({ ...sek, kind: 'row' })).toBe(false)
    expect(shouldMarkApprox({ ...usdcInUsd, displayCurrency: 'EUR' })).toBe(true)
  })

  it('marks a token that floats even in USD', () => {
    expect(shouldMarkApprox({ ...usdcInUsd, tokenSymbol: 'ETH' })).toBe(true)
    expect(shouldMarkApprox({ ...usdcInUsd, tokenSymbol: 'ETH', kind: 'row' })).toBe(false)
  })

  it('never marks a booked figure', () => {
    expect(shouldMarkApprox({ ...usdcInUsd, displayCurrency: 'SEK', repriced: false })).toBe(false)
    expect(shouldMarkApprox({ ...usdcInUsd, tokenSymbol: 'ETH', repriced: false, kind: 'detail' })).toBe(false)
  })

  it('keeps the mark when the token cannot be identified', () => {
    expect(shouldMarkApprox({ ...usdcInUsd, chainId: null })).toBe(true)
    expect(shouldMarkApprox({ ...usdcInUsd, chainId: 999999 })).toBe(true)
    expect(shouldMarkApprox({ ...usdcInUsd, tokenSymbol: undefined })).toBe(true)
  })
})
