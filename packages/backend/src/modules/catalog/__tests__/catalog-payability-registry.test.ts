import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * #4389: the catalog labels a payable asset from the chain registry, and an
 * asset the registry does not know is not payable — never "USDC" by default.
 * The SDK selector only accepts Base and Base Sepolia USDC, so through real
 * data the registry always knows the selected asset; these tests stand the
 * registry apart from the selector to prove the label is read from it and
 * that a drift between the two is a miss.
 */

const registry = vi.hoisted(() => ({ override: undefined as undefined | ((tokens: unknown[]) => unknown[]) }))

vi.mock('@haven_ai/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@haven_ai/core')>()
  return {
    ...actual,
    getChainData: (chainId: number) => {
      const chain = actual.getChainData(chainId)
      return registry.override ? { ...chain, tokens: registry.override(chain.tokens) } : chain
    },
  }
})

const { probeCatalogEntry, selectCatalogPaymentOption } = await import('../merchant-catalog.js')

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const BASE_OPTION = {
  scheme: 'exact',
  network: 'eip155:8453',
  asset: BASE_USDC,
  amount: '20000',
  payTo: '0x' + '22'.repeat(20),
  maxTimeoutSeconds: 300,
}

const ENTRY = {
  resource_url: 'https://api.merchant.example/paid',
  protocol: 'http' as const,
  tool_name: null,
  tool_arguments: null,
  rail: 'x402' as const,
}

function challenge(accepts: unknown[]): typeof fetch {
  const header = Buffer.from(JSON.stringify({ x402Version: 2, accepts }), 'utf8').toString('base64')
  return vi.fn().mockResolvedValue(new Response(null, { status: 402, headers: { 'PAYMENT-REQUIRED': header } })) as unknown as typeof fetch
}

afterEach(() => {
  registry.override = undefined
})

describe('catalog payability (#4389) — the asset label comes from the registry', () => {
  it('an asset the registry does not know is not payable, even when the SDK selector accepts it', async () => {
    registry.override = () => []
    expect(selectCatalogPaymentOption({ accepts: [BASE_OPTION] })).toBeNull()
    expect(await probeCatalogEntry(ENTRY, challenge([BASE_OPTION]))).toEqual({ ok: false })
  })

  it('records the registry symbol and scales the price by the registry decimals', async () => {
    registry.override = (tokens) => tokens.map((t) => {
      const token = t as { address: string | null }
      return token.address?.toLowerCase() === BASE_USDC.toLowerCase() ? { ...token, symbol: 'USDX', decimals: 4 } : token
    })
    expect(await probeCatalogEntry(ENTRY, challenge([BASE_OPTION]))).toMatchObject({
      ok: true,
      asset: 'USDX',
      priceAtomic: '20000',
      priceDisplay: '2.00 USDX',
    })
  })
})
