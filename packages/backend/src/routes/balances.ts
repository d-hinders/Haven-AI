import { FastifyInstance } from 'fastify'
import { ethers } from 'ethers'
import { authMiddleware } from '../middleware/auth.js'
import pool from '../db.js'
import { getChain } from '../lib/chains.js'
import { getProvider } from '../lib/allowance-module.js'
import { formatTokenValue } from '../lib/tokens.js'
import { createCache } from '../lib/cache.js'

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

// Minimal ERC-20 ABI for balanceOf
const ERC20_ABI = ['function balanceOf(address account) view returns (uint256)']

const balanceCache = createCache<{ balances: BalanceItem[] }>(30_000)

export interface BalanceItem {
  symbol: string
  address: string | null
  balance: string
  formatted: string
  decimals: number
}

export default async function balanceRoutes(
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

      const cacheKey = `bal:${chainId}:${safeAddress.toLowerCase()}`
      return balanceCache.getOrFetch(cacheKey, async () => {
        const provider = getProvider(chainId)
        const tokens = Object.values(chain.tokens)
        const nativeToken = tokens.find((t) => t.address === null)!
        const erc20Tokens = tokens.filter((t) => t.address !== null)

        const balances: BalanceItem[] = []

        const results = await Promise.allSettled([
          provider.getBalance(safeAddress),
          ...erc20Tokens.map((token) => {
            const contract = new ethers.Contract(token.address!, ERC20_ABI, provider)
            return contract.balanceOf(safeAddress) as Promise<bigint>
          }),
        ])

        const nativeResult = results[0]
        const nativeBalance =
          nativeResult.status === 'fulfilled' ? nativeResult.value.toString() : '0'
        balances.push({
          symbol: nativeToken.symbol,
          address: null,
          balance: nativeBalance,
          formatted: formatTokenValue(nativeBalance, nativeToken.decimals),
          decimals: nativeToken.decimals,
        })

        for (let i = 0; i < erc20Tokens.length; i++) {
          const token = erc20Tokens[i]
          const result = results[i + 1]
          const rawBalance =
            result.status === 'fulfilled' ? result.value.toString() : '0'
          balances.push({
            symbol: token.symbol,
            address: token.address,
            balance: rawBalance,
            formatted: formatTokenValue(rawBalance, token.decimals),
            decimals: token.decimals,
          })
        }

        return { balances }
      })
    },
  )
}
