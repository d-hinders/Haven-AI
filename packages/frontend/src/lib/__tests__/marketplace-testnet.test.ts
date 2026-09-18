import { describe, expect, it, vi } from 'vitest'

/**
 * `isTestnetChain` is DERIVED from core's faucet field, not a chain-id list
 * (#3079 finding 7). Core registers one testnet today, so a hard-coded
 * `=== 84532` is an equivalent mutant on the real registry; this file gives a
 * second chain a faucet to prove the derivation is what runs.
 */
vi.mock('@haven_ai/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@haven_ai/core')>()
  return {
    ...actual,
    getFaucetUrl: (chainId: number) =>
      chainId === 8453 ? 'https://faucet.example' : actual.getFaucetUrl(chainId),
  }
})

import { isTestnetChain, listsTestnet } from '@/lib/marketplace'

describe('isTestnetChain derives from the faucet field', () => {
  it('follows the faucet, whichever chain carries one', () => {
    expect(isTestnetChain(8453)).toBe(true)
    expect(isTestnetChain(84532)).toBe(true)
    expect(isTestnetChain(100)).toBe(false)
    expect(listsTestnet([{ networks: ['eip155:8453'] }])).toBe(true)
  })
})
