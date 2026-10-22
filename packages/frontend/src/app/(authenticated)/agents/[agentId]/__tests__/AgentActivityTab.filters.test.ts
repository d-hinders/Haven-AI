import { describe, expect, it } from 'vitest'
import type { ListState } from '@/components/ui/list-url-codec'
import { agentPaymentTokenOptions, listStateToFilters } from '../AgentActivityTab'

/**
 * #4249 (#4246 review B2): the Token facet's two pure halves. A selected
 * token must never reach the reader as "no filter" — that rendered a
 * "Token: …" chip over EVERY payment and a count claiming they all matched.
 */
const USDC = {
  key: '8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  symbol: 'USDC',
  address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  chainId: 8453,
  isNative: false,
}
const ETH = { key: '8453:native', symbol: 'ETH', address: null, chainId: 8453, isNative: true }
const GNOSIS_EURE = {
  key: '100:0xcb444e90d8198415266c6a2724b7900fb12fc56e',
  symbol: 'EURe',
  address: '0xcB444e90D8198415266c6a2724b7900fb12FC56E',
  chainId: 100,
  isNative: false,
}

function state(tokenKey?: string): ListState {
  const facets: Record<string, string[]> = tokenKey ? { tokenKey: [tokenKey] } : {}
  return { q: '', facets }
}

describe('agentPaymentTokenOptions', () => {
  it('drops native tokens: an agent payment is always an ERC-20', () => {
    expect(agentPaymentTokenOptions([USDC, ETH] as never, undefined).map((t) => t.key)).toEqual([USDC.key])
  })

  it('scopes to the agent chain when the page knows it', () => {
    expect(agentPaymentTokenOptions([USDC, GNOSIS_EURE] as never, 8453).map((t) => t.key)).toEqual([USDC.key])
  })

  it('keeps every chain when the chain is unknown — never a guessed one', () => {
    expect(agentPaymentTokenOptions([USDC, GNOSIS_EURE] as never, undefined)).toHaveLength(2)
  })
})

describe('listStateToFilters — the token half', () => {
  const byKey = new Map([[USDC.key, USDC.address]])

  it('no token selected: no token filter, nothing pending', () => {
    expect(listStateToFilters(state(), byKey, false)).toMatchObject({
      filters: { token: undefined },
      tokenPending: false,
    })
  })

  it('a resolved key goes out as its contract address', () => {
    expect(listStateToFilters(state(USDC.key), byKey, false)).toMatchObject({
      filters: { token: USDC.address },
      tokenPending: false,
    })
  })

  it('no key while the registry loads holds nothing (#4249 review M1)', () => {
    expect(listStateToFilters(state(), new Map(), true).tokenPending).toBe(false)
  })

  it('an unresolved key while the registry loads holds the read', () => {
    expect(listStateToFilters(state('8453:0xdeadbeef'), new Map(), true).tokenPending).toBe(true)
  })

  it('an unresolved key after the registry loaded goes out verbatim — matches nothing, never dropped', () => {
    expect(listStateToFilters(state(ETH.key), byKey, false)).toEqual({
      filters: expect.objectContaining({ token: ETH.key }),
      tokenPending: false,
    })
  })
})
