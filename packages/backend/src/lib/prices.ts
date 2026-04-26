/**
 * CoinGecko price fetching with in-memory cache.
 *
 * Chain-aware: collects all unique CoinGecko IDs across chains
 * and fetches prices in a single API call.
 */
import { getChain, SUPPORTED_CHAIN_IDS, type TokenConfig } from './chains.js'
import { config } from '../config.js'
import { createCache } from './cache.js'

type PriceMap = Record<string, { usd: number; eur: number }>

const priceCache = createCache<PriceMap>(60_000)
const CACHE_KEY = 'all'

/** Build a map of coingeckoId → { usd, eur } for all tokens across all chains */
export async function fetchTokenPrices(): Promise<PriceMap> {
  return priceCache.getOrFetch(CACHE_KEY, async () => {
    // Collect all unique CoinGecko IDs and map them back to symbols
    const idToSymbols = new Map<string, string[]>()
    for (const chainId of SUPPORTED_CHAIN_IDS) {
      const chain = getChain(chainId)
      for (const token of Object.values(chain.tokens)) {
        const existing = idToSymbols.get(token.coingeckoId) ?? []
        if (!existing.includes(token.symbol)) {
          existing.push(token.symbol)
        }
        idToSymbols.set(token.coingeckoId, existing)
      }
    }

    const ids = Array.from(idToSymbols.keys()).join(',')
    const apiKey = config.coingeckoApiKey

    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd,eur`

    const headers: Record<string, string> = { Accept: 'application/json' }
    if (apiKey) {
      headers['x-cg-demo-api-key'] = apiKey
    }

    const res = await fetch(url, { headers })

    if (!res.ok) {
      throw new Error(`CoinGecko API error: ${res.status}`)
    }

    const data = (await res.json()) as Record<string, { usd?: number; eur?: number }>

    const prices: PriceMap = {}
    for (const [geckoId, symbols] of idToSymbols.entries()) {
      const p = data[geckoId]
      for (const symbol of symbols) {
        prices[symbol] = {
          usd: p?.usd ?? 0,
          eur: p?.eur ?? 0,
        }
      }
    }

    return prices
  })
}

/** Get the price for a specific token by symbol */
export async function getTokenPrice(
  symbol: string,
): Promise<{ usd: number; eur: number }> {
  const prices = await fetchTokenPrices()
  return prices[symbol] ?? { usd: 0, eur: 0 }
}
