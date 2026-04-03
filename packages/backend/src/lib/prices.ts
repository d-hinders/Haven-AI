// CoinGecko price fetching with in-memory cache

const COINGECKO_IDS: Record<string, string> = {
  xDAI: 'xdai',
  EURe: 'monerium-eur-money',
  'USDC.e': 'usd-coin',
}

interface PriceCache {
  prices: Record<string, { usd: number; eur: number }>
  ts: number
}

let cache: PriceCache | null = null
const CACHE_TTL = 60_000 // 60 seconds

export async function fetchTokenPrices(): Promise<
  Record<string, { usd: number; eur: number }>
> {
  if (cache && Date.now() - cache.ts < CACHE_TTL) {
    return cache.prices
  }

  const ids = Object.values(COINGECKO_IDS).join(',')
  const apiKey = process.env.COINGECKO_API_KEY ?? ''
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd,eur`

  const headers: Record<string, string> = {
    Accept: 'application/json',
  }
  if (apiKey) {
    headers['x-cg-demo-api-key'] = apiKey
  }

  const res = await fetch(url, { headers })

  if (!res.ok) {
    throw new Error(`CoinGecko API error: ${res.status}`)
  }

  const data = (await res.json()) as Record<
    string,
    { usd?: number; eur?: number }
  >

  // Map CoinGecko IDs back to token symbols
  const prices: Record<string, { usd: number; eur: number }> = {}
  for (const [symbol, geckoId] of Object.entries(COINGECKO_IDS)) {
    const p = data[geckoId]
    prices[symbol] = {
      usd: p?.usd ?? 0,
      eur: p?.eur ?? 0,
    }
  }

  cache = { prices, ts: Date.now() }
  return prices
}
