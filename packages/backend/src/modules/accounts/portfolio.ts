import { ethers } from 'ethers'
import { getChain } from '../../domain/chains.js'
import { getProvider } from '../../infra/chain/relayer-reads.js'
import { formatTokenValue } from '../../domain/tokens.js'
import { fetchTokenPrices } from '../../infra/prices.js'
import { createCache } from '../../platform/cache.js'

const ERC20_ABI = ['function balanceOf(address account) view returns (uint256)']

export interface PortfolioBreakdownItem {
  symbol: string
  balance: string
  formatted: string
  usdValue: number
  eurValue: number
  /** Same one price read as usd/eur — the display default currency (#3127 round 2). */
  sekValue: number
}

export interface Portfolio {
  totalUsd: number
  totalEur: number
  totalSek: number
  breakdown: PortfolioBreakdownItem[]
}

const portfolioCache = createCache<Portfolio>(60_000)

type PriceMap = Awaited<ReturnType<typeof fetchTokenPrices>>
type TokenPrice = PriceMap[string]

/**
 * #3297: display prices survive a CoinGecko outage. A failed or partial price
 * fetch used to value every affected token at 0 and cache that total for the
 * TTL, so a single 429 showed `0,00 kr` on the dashboard although every
 * balance read was fine.
 *
 * DISPLAY ONLY, by construction. Everything here lives in this module and is
 * read only by `fetchPortfolioForAccount`. `fetchTokenPrices` / `getTokenPrice`
 * in `infra/prices.ts` are untouched, because they also feed book-time fiat
 * valuation of payments (`infra/fiat-values.ts`), where a pricing outage must
 * stay "null, backfillable" and a stale rate must never be stamped as spot.
 *
 * - `lastGoodPrices`: the last usable quote per symbol (usable = any currency
 *   positive, the same rule `prices.ts` uses). Per replica and in-process, so
 *   it resets on deploy; no age cap (#3297 "Decided here": a stale price is
 *   closer to the truth than zero for a display total).
 * - `priceFetchBlockedUntil`: after a THROWN price fetch, no new CoinGecko
 *   request for the backoff window. `prices.ts` caches nothing on a throw, so
 *   without this every portfolio key would hit CoinGecko again during a 429.
 */
const lastGoodPrices = new Map<string, TokenPrice>()
const PRICE_FAILURE_BACKOFF_MS = 60_000
let priceFetchBlockedUntil = 0

function isUsablePrice(price: TokenPrice | undefined): price is TokenPrice {
  return price !== undefined && Object.values(price).some((v) => v > 0)
}

/** The display price map: fresh when CoinGecko answers, `{}` during backoff. Never throws. */
async function readDisplayPrices(): Promise<PriceMap> {
  if (Date.now() < priceFetchBlockedUntil) return {}
  try {
    const fresh = await fetchTokenPrices()
    for (const [symbol, price] of Object.entries(fresh)) {
      if (isUsablePrice(price)) lastGoodPrices.set(symbol, price)
    }
    return fresh
  } catch {
    priceFetchBlockedUntil = Date.now() + PRICE_FAILURE_BACKOFF_MS
    return {}
  }
}

/** A fresh usable quote, else the last good one, else nothing (unpriceable). */
function displayPrice(prices: PriceMap, symbol: string): TokenPrice | undefined {
  const fresh = prices[symbol]
  return isUsablePrice(fresh) ? fresh : lastGoodPrices.get(symbol)
}

/**
 * Results where a balance read failed — or (#3297) a held token has no price at
 * all, fresh or last-good. Such a leg still reads as zero in the response, but
 * the result is never cached: one RPC blip or one pricing outage must not pin a
 * zero on the dashboard for the whole TTL. The repeat request is still bounded
 * by the price-fetch backoff above.
 */
const degradedResults = new WeakSet<Portfolio>()

export async function fetchPortfolioForAccount(
  chainId: number,
  accountAddress: string,
): Promise<Portfolio> {
  const chain = getChain(chainId)
  const cacheKey = `portfolio:${chainId}:${accountAddress.toLowerCase()}`

  const portfolio = await portfolioCache.getOrFetch(cacheKey, async () => {
    const provider = getProvider(chainId)
    const tokens = Object.values(chain.tokens)
    const nativeToken = tokens.find((token) => token.address === null)!
    const erc20Tokens = tokens.filter((token) => token.address !== null)

    const [pricesResult, nativeResult, ...erc20Results] =
      await Promise.allSettled([
        readDisplayPrices(),
        provider.getBalance(accountAddress),
        ...erc20Tokens.map((token) => {
          const contract = new ethers.Contract(token.address!, ERC20_ABI, provider)
          return contract.balanceOf(accountAddress) as Promise<bigint>
        }),
      ])

    const prices = pricesResult.status === 'fulfilled' ? pricesResult.value : {}

    const breakdown: PortfolioBreakdownItem[] = []
    let unpriceable = false
    const priceHeld = (symbol: string, amount: number): TokenPrice | undefined => {
      const price = displayPrice(prices, symbol)
      if (!price && amount > 0) unpriceable = true
      return price
    }

    const nativeRaw =
      nativeResult.status === 'fulfilled' ? nativeResult.value.toString() : '0'
    const nativeFormatted = formatTokenValue(nativeRaw, nativeToken.decimals)
    const nativeNum = parseFloat(nativeFormatted)
    const nativePrice = priceHeld(nativeToken.symbol, nativeNum)
    breakdown.push({
      symbol: nativeToken.symbol,
      balance: nativeRaw,
      formatted: nativeFormatted,
      usdValue: nativeNum * (nativePrice?.usd ?? 0),
      eurValue: nativeNum * (nativePrice?.eur ?? 0),
      sekValue: nativeNum * (nativePrice?.sek ?? 0),
    })

    for (let i = 0; i < erc20Tokens.length; i++) {
      const token = erc20Tokens[i]
      const result = erc20Results[i]
      const rawBalance = result.status === 'fulfilled' ? result.value.toString() : '0'
      const formatted = formatTokenValue(rawBalance, token.decimals)
      const num = parseFloat(formatted)
      const price = priceHeld(token.symbol, num)
      breakdown.push({
        symbol: token.symbol,
        balance: rawBalance,
        formatted,
        usdValue: num * (price?.usd ?? 0),
        eurValue: num * (price?.eur ?? 0),
        sekValue: num * (price?.sek ?? 0),
      })
    }

    const totalUsd = breakdown.reduce((sum, item) => sum + item.usdValue, 0)
    const totalEur = breakdown.reduce((sum, item) => sum + item.eurValue, 0)
    const totalSek = breakdown.reduce((sum, item) => sum + item.sekValue, 0)

    const result = { totalUsd, totalEur, totalSek, breakdown }
    if (unpriceable || [nativeResult, ...erc20Results].some((r) => r.status === 'rejected')) {
      degradedResults.add(result)
    }
    return result
  })
  if (degradedResults.has(portfolio)) portfolioCache.delete(cacheKey)
  return portfolio
}
