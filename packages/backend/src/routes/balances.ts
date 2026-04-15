import { FastifyInstance } from 'fastify'
import { ethers } from 'ethers'
import { authMiddleware } from '../middleware/auth.js'
import pool from '../db.js'
import { config } from '../config.js'
import { SUPPORTED_TOKENS, formatTokenValue } from '../lib/tokens.js'

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

// Minimal ERC-20 ABI for balanceOf
const ERC20_ABI = ['function balanceOf(address account) view returns (uint256)']

// Simple in-memory cache: address → { data, timestamp }
const cache = new Map<string, { data: unknown; ts: number }>()
const CACHE_TTL = 30_000 // 30 seconds

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

      // Verify ownership (multi-Safe)
      const userResult = await pool.query(
        'SELECT id FROM user_safes WHERE user_id = $1 AND LOWER(safe_address) = LOWER($2)',
        [sub, safeAddress],
      )
      if (userResult.rows.length === 0) {
        return reply.code(403).send({ error: 'Not your Safe' })
      }

      // Check cache
      const cacheKey = `bal:${safeAddress.toLowerCase()}`
      const cached = cache.get(cacheKey)
      if (cached && Date.now() - cached.ts < CACHE_TTL) {
        return cached.data
      }

      const provider = new ethers.JsonRpcProvider(config.rpcUrl)

      const balances: BalanceItem[] = []

      // Fetch all balances in parallel
      const results = await Promise.allSettled([
        // xDAI (native)
        provider.getBalance(safeAddress),
        // ERC-20 tokens
        ...Object.values(SUPPORTED_TOKENS)
          .filter((t) => t.address !== null)
          .map((token) => {
            const contract = new ethers.Contract(
              token.address!,
              ERC20_ABI,
              provider,
            )
            return contract.balanceOf(safeAddress) as Promise<bigint>
          }),
      ])

      // Process xDAI
      const xdaiResult = results[0]
      const xdaiBalance =
        xdaiResult.status === 'fulfilled' ? xdaiResult.value.toString() : '0'
      balances.push({
        symbol: SUPPORTED_TOKENS.XDAI.symbol,
        address: null,
        balance: xdaiBalance,
        formatted: formatTokenValue(xdaiBalance, 18),
        decimals: 18,
      })

      // Process ERC-20 tokens
      const erc20Tokens = Object.values(SUPPORTED_TOKENS).filter(
        (t) => t.address !== null,
      )
      for (let i = 0; i < erc20Tokens.length; i++) {
        const token = erc20Tokens[i]
        const result = results[i + 1] // +1 because index 0 is xDAI
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

      const responseData = { balances }

      // Update cache
      cache.set(cacheKey, { data: responseData, ts: Date.now() })

      return responseData
    },
  )
}
