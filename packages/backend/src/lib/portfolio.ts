import { ethers } from 'ethers'
import { getChain } from './chains.js'
import { getProvider } from './allowance-module.js'
import { formatTokenValue } from './tokens.js'
import { fetchTokenPrices } from './prices.js'
import { createCache } from './cache.js'

const ERC20_ABI = ['function balanceOf(address account) view returns (uint256)']

export interface PortfolioBreakdownItem {
  symbol: string
  balance: string
  formatted: string
  usdValue: number
  eurValue: number
}

export interface Portfolio {
  totalUsd: number
  totalEur: number
  breakdown: PortfolioBreakdownItem[]
}

const portfolioCache = createCache<Portfolio>(60_000)

export async function fetchPortfolioForSafe(
  chainId: number,
  safeAddress: string,
): Promise<Portfolio> {
  const chain = getChain(chainId)
  const cacheKey = `portfolio:${chainId}:${safeAddress.toLowerCase()}`

  return portfolioCache.getOrFetch(cacheKey, async () => {
    const provider = getProvider(chainId)
    const tokens = Object.values(chain.tokens)
    const nativeToken = tokens.find((token) => token.address === null)!
    const erc20Tokens = tokens.filter((token) => token.address !== null)

    const [pricesResult, nativeResult, ...erc20Results] =
      await Promise.allSettled([
        fetchTokenPrices(),
        provider.getBalance(safeAddress),
        ...erc20Tokens.map((token) => {
          const contract = new ethers.Contract(token.address!, ERC20_ABI, provider)
          return contract.balanceOf(safeAddress) as Promise<bigint>
        }),
      ])

    const prices = pricesResult.status === 'fulfilled' ? pricesResult.value : {}

    const breakdown: PortfolioBreakdownItem[] = []

    const nativeRaw =
      nativeResult.status === 'fulfilled' ? nativeResult.value.toString() : '0'
    const nativeFormatted = formatTokenValue(nativeRaw, nativeToken.decimals)
    const nativeNum = parseFloat(nativeFormatted)
    breakdown.push({
      symbol: nativeToken.symbol,
      balance: nativeRaw,
      formatted: nativeFormatted,
      usdValue: nativeNum * (prices[nativeToken.symbol]?.usd ?? 0),
      eurValue: nativeNum * (prices[nativeToken.symbol]?.eur ?? 0),
    })

    for (let i = 0; i < erc20Tokens.length; i++) {
      const token = erc20Tokens[i]
      const result = erc20Results[i]
      const rawBalance = result.status === 'fulfilled' ? result.value.toString() : '0'
      const formatted = formatTokenValue(rawBalance, token.decimals)
      const num = parseFloat(formatted)
      breakdown.push({
        symbol: token.symbol,
        balance: rawBalance,
        formatted,
        usdValue: num * (prices[token.symbol]?.usd ?? 0),
        eurValue: num * (prices[token.symbol]?.eur ?? 0),
      })
    }

    const totalUsd = breakdown.reduce((sum, item) => sum + item.usdValue, 0)
    const totalEur = breakdown.reduce((sum, item) => sum + item.eurValue, 0)

    return { totalUsd, totalEur, breakdown }
  })
}
