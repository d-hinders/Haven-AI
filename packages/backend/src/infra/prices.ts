/**
 * CoinGecko price fetching with in-memory cache.
 *
 * Chain-aware: collects all unique CoinGecko IDs across chains
 * and fetches prices in a single API call.
 */
import { getChain, SUPPORTED_CHAIN_IDS, type TokenConfig } from '../domain/chains.js'
import { SUPPORTED_LEDGER_CURRENCIES } from '../domain/ledger-currency.js'
import { config } from '../config.js'
import { createCache } from '../platform/cache.js'

/**
 * The vs-currencies quoted for every token: the ledger currencies a connected
 * accounting destination may book in (#2877). `usd`, `eur` and `sek` are part
 * of that list, so every pre-#2877 reader keeps the keys it already reads.
 */
const VS_CURRENCIES = SUPPORTED_LEDGER_CURRENCIES.map((c) => c.toLowerCase()) as readonly PriceCurrency[]

export type PriceCurrency = Lowercase<(typeof SUPPORTED_LEDGER_CURRENCIES)[number]>

/** A token's price in every quoted currency. Zero means "no usable quote". */
export type TokenPrice = Record<PriceCurrency, number>

type PriceMap = Record<string, TokenPrice>

/** Every quoted currency at zero — the shape a missing token resolves to. */
function zeroPrice(): TokenPrice {
  return Object.fromEntries(VS_CURRENCIES.map((c) => [c, 0])) as TokenPrice
}

const priceCache = createCache<PriceMap>(60_000)
const CACHE_KEY = 'all'

/** Build a map of symbol → price in every quoted currency, for all tokens across all chains */
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

    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=${VS_CURRENCIES.join(',')}`

    const headers: Record<string, string> = { Accept: 'application/json' }
    if (apiKey) {
      headers['x-cg-demo-api-key'] = apiKey
    }

    const res = await fetch(url, { headers })

    if (!res.ok) {
      throw new Error(`CoinGecko API error: ${res.status}`)
    }

    const data = (await res.json()) as Record<string, Partial<Record<PriceCurrency, number>>>

    const prices: PriceMap = {}
    let usable = 0
    for (const [geckoId, symbols] of idToSymbols.entries()) {
      const p = data[geckoId]
      for (const symbol of symbols) {
        const price = zeroPrice()
        for (const currency of VS_CURRENCIES) {
          price[currency] = p?.[currency] ?? 0
        }
        prices[symbol] = price
        // The same rule over a wider list: a token counts as usable when ANY
        // quoted currency came back positive. The list is wider than usd/eur/sek
        // now, so the rule's extension really does grow — a token quoted only in
        // DKK now counts, where before the response would have been treated as
        // unusable and not cached.
        if (VS_CURRENCIES.some((currency) => price[currency] > 0)) {
          usable += 1
        }
      }
    }

    // A 200 response that carries no usable price (empty/degraded upstream, e.g.
    // a soft rate-limit) must not be cached — that would pin every token to 0 for
    // the full TTL. Throw so getOrFetch skips the cache and callers fall back
    // safely (book-time SEK → null/backfillable, fiat display → caught → null).
    if (usable === 0) {
      throw new Error('CoinGecko returned no usable prices')
    }

    return prices
  })
}

/** Get the price for a specific token by symbol */
export async function getTokenPrice(symbol: string): Promise<TokenPrice> {
  const prices = await fetchTokenPrices()
  return prices[symbol] ?? zeroPrice()
}
