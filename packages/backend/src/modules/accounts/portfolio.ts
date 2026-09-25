import { ethers } from 'ethers'
import { getChain } from '../../domain/chains.js'
import { getProvider } from '../../infra/chain/relayer-reads.js'
import { formatTokenValue } from '../../domain/tokens.js'
import { fetchTokenPrices } from '../../infra/prices.js'
import { createCache } from '../../platform/cache.js'
import {
  balanceFreshness,
  knownBalance,
  recordKnownBalance,
  type BalanceFreshness,
} from './balance-freshness.js'

const ERC20_ABI = ['function balanceOf(address account) view returns (uint256)']

export interface PortfolioBreakdownItem {
  symbol: string
  balance: string
  formatted: string
  usdValue: number
  eurValue: number
  /** Same one price read as usd/eur — the display default currency (#3127 round 2). */
  sekValue: number
  /**
   * Present only when this entry's balance read FAILED (#3295): 'stale' with
   * the last successful read's time, or 'unavailable' when no balance has
   * ever been read for this token. Absent on a clean read, so the wire shape
   * stays additive and every `balance` remains a decimal string — the token
   * registry the CLI reads keeps its shape either way.
   */
  balanceFreshness?: BalanceFreshness
}

export interface Portfolio {
  totalUsd: number
  totalEur: number
  totalSek: number
  breakdown: PortfolioBreakdownItem[]
}

const portfolioCache = createCache<Portfolio>(60_000)

/**
 * Results where a balance read failed. A failed leg is no longer a silent
 * zero (#3295): it serves the last-known balance, marked stale with its as-of
 * time, or stays '0' marked unavailable when nothing was ever read. Either
 * way it is never cached: one RPC blip must not pin a degraded figure on the
 * dashboard for the whole TTL.
 */
const degradedResults = new WeakSet<Portfolio>()

/**
 * Resolve one read to its raw base-unit string and wire marker. A fulfilled
 * read is recorded as the token's last-known balance and carries no marker;
 * a rejected one substitutes the last-known value and is marked stale with
 * its as-of time, or stays '0' marked unavailable when nothing was ever read.
 */
function resolveBalanceRead(
  chainId: number,
  accountAddress: string,
  tokenAddress: string | null,
  result: PromiseSettledResult<bigint>,
): { raw: string; freshness: BalanceFreshness | null } {
  if (result.status === 'fulfilled') {
    const raw = result.value.toString()
    recordKnownBalance(chainId, accountAddress, tokenAddress, raw)
    return { raw, freshness: null }
  }
  const known = knownBalance(chainId, accountAddress, tokenAddress)
  return { raw: known?.balance ?? '0', freshness: balanceFreshness(true, known) }
}

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
        fetchTokenPrices(),
        provider.getBalance(accountAddress),
        ...erc20Tokens.map((token) => {
          const contract = new ethers.Contract(token.address!, ERC20_ABI, provider)
          return contract.balanceOf(accountAddress) as Promise<bigint>
        }),
      ])

    const prices = pricesResult.status === 'fulfilled' ? pricesResult.value : {}

    const breakdown: PortfolioBreakdownItem[] = []

    const nativeRead = resolveBalanceRead(chainId, accountAddress, null, nativeResult)
    const nativeFormatted = formatTokenValue(nativeRead.raw, nativeToken.decimals)
    const nativeNum = parseFloat(nativeFormatted)
    breakdown.push({
      symbol: nativeToken.symbol,
      balance: nativeRead.raw,
      formatted: nativeFormatted,
      usdValue: nativeNum * (prices[nativeToken.symbol]?.usd ?? 0),
      eurValue: nativeNum * (prices[nativeToken.symbol]?.eur ?? 0),
      sekValue: nativeNum * (prices[nativeToken.symbol]?.sek ?? 0),
      ...(nativeRead.freshness ? { balanceFreshness: nativeRead.freshness } : {}),
    })

    for (let i = 0; i < erc20Tokens.length; i++) {
      const token = erc20Tokens[i]
      const read = resolveBalanceRead(
        chainId,
        accountAddress,
        token.address,
        erc20Results[i],
      )
      const formatted = formatTokenValue(read.raw, token.decimals)
      const num = parseFloat(formatted)
      breakdown.push({
        symbol: token.symbol,
        balance: read.raw,
        formatted,
        usdValue: num * (prices[token.symbol]?.usd ?? 0),
        eurValue: num * (prices[token.symbol]?.eur ?? 0),
        sekValue: num * (prices[token.symbol]?.sek ?? 0),
        ...(read.freshness ? { balanceFreshness: read.freshness } : {}),
      })
    }

    const totalUsd = breakdown.reduce((sum, item) => sum + item.usdValue, 0)
    const totalEur = breakdown.reduce((sum, item) => sum + item.eurValue, 0)
    const totalSek = breakdown.reduce((sum, item) => sum + item.sekValue, 0)

    const result = { totalUsd, totalEur, totalSek, breakdown }
    if ([nativeResult, ...erc20Results].some((r) => r.status === 'rejected')) {
      degradedResults.add(result)
    }
    return result
  })
  if (degradedResults.has(portfolio)) portfolioCache.delete(cacheKey)
  return portfolio
}
