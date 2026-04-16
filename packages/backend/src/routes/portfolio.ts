import { FastifyInstance } from 'fastify'
import { ethers } from 'ethers'
import { authMiddleware } from '../middleware/auth.js'
import pool from '../db.js'
import { getChain } from '../lib/chains.js'
import { getProvider } from '../lib/allowance-module.js'
import { formatTokenValue } from '../lib/tokens.js'
import { fetchTokenPrices } from '../lib/prices.js'

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const ERC20_ABI = ['function balanceOf(address account) view returns (uint256)']

// Cache portfolio data for 60 seconds
const cache = new Map<string, { data: unknown; ts: number }>()
const CACHE_TTL = 60_000

export default async function portfolioRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  app.get<{ Params: { safeAddress: string } }>(
    '/:safeAddress',
    async (request, reply) => {
      const { safeAddress } = request.params
      const { sub } = request.user as { sub: string }

      if (!ETH_ADDRESS_RE.test(safeAddress)) {
        return reply.code(400).send({ error: 'Invalid address' })
      }

      // Verify ownership and get chain_id
      const userResult = await pool.query<{ id: string; chain_id: number }>(
        'SELECT id, chain_id FROM user_safes WHERE user_id = $1 AND LOWER(safe_address) = LOWER($2)',
        [sub, safeAddress],
      )
      if (userResult.rows.length === 0) {
        return reply.code(403).send({ error: 'Not your Safe' })
      }

      const chainId = userResult.rows[0].chain_id
      const chain = getChain(chainId)

      // Check cache
      const cacheKey = `portfolio:${chainId}:${safeAddress.toLowerCase()}`
      const cached = cache.get(cacheKey)
      if (cached && Date.now() - cached.ts < CACHE_TTL) {
        return cached.data
      }

      const provider = getProvider(chainId)
      const tokens = Object.values(chain.tokens)
      const nativeToken = tokens.find((t) => t.address === null)!
      const erc20Tokens = tokens.filter((t) => t.address !== null)

      // Fetch balances + prices in parallel
      const [pricesResult, nativeResult, ...erc20Results] =
        await Promise.allSettled([
          fetchTokenPrices(),
          provider.getBalance(safeAddress),
          ...erc20Tokens.map((token) => {
            const contract = new ethers.Contract(token.address!, ERC20_ABI, provider)
            return contract.balanceOf(safeAddress) as Promise<bigint>
          }),
        ])

      const prices =
        pricesResult.status === 'fulfilled' ? pricesResult.value : {}

      const breakdown: {
        symbol: string
        balance: string
        formatted: string
        usdValue: number
        eurValue: number
      }[] = []

      // Native token
      const nativeRaw =
        nativeResult.status === 'fulfilled'
          ? nativeResult.value.toString()
          : '0'
      const nativeFormatted = formatTokenValue(nativeRaw, nativeToken.decimals)
      const nativeNum = parseFloat(nativeFormatted)
      breakdown.push({
        symbol: nativeToken.symbol,
        balance: nativeRaw,
        formatted: nativeFormatted,
        usdValue: nativeNum * (prices[nativeToken.symbol]?.usd ?? 0),
        eurValue: nativeNum * (prices[nativeToken.symbol]?.eur ?? 0),
      })

      // ERC-20 tokens
      for (let i = 0; i < erc20Tokens.length; i++) {
        const token = erc20Tokens[i]
        const result = erc20Results[i]
        const rawBalance =
          result.status === 'fulfilled' ? result.value.toString() : '0'
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

      const totalUsd = breakdown.reduce((sum, b) => sum + b.usdValue, 0)
      const totalEur = breakdown.reduce((sum, b) => sum + b.eurValue, 0)

      const responseData = { totalUsd, totalEur, breakdown }
      cache.set(cacheKey, { data: responseData, ts: Date.now() })

      return responseData
    },
  )
}
