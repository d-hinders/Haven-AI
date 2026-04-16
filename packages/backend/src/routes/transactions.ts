import { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import pool from '../db.js'
import {
  fetchNormalTransactions,
  fetchInternalTransactions,
  fetchERC20Transfers,
} from '../lib/explorer-api.js'
import { getChain } from '../lib/chains.js'
import { formatTokenValue } from '../lib/tokens.js'

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

export interface Transaction {
  hash: string
  type: 'native' | 'erc20' | 'internal'
  from: string
  to: string
  value: string
  valueFormatted: string
  asset: string
  decimals: number
  direction: 'in' | 'out'
  timestamp: number
  blockNumber: number
  isError: boolean
  tokenAddress?: string
  tokenSymbol?: string
}

// Simple in-memory cache
const cache = new Map<string, { data: unknown; ts: number }>()
const CACHE_TTL = 30_000 // 30 seconds

export default async function transactionRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  app.get<{
    Params: { safeAddress: string }
    Querystring: { page?: string; limit?: string }
  }>('/:safeAddress', async (request, reply) => {
    const { safeAddress } = request.params
    const { sub } = request.user as { sub: string }
    const page = Math.max(1, parseInt(request.query.page ?? '1', 10))
    const limit = Math.min(100, Math.max(1, parseInt(request.query.limit ?? '25', 10)))

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
    const nativeToken = Object.values(chain.tokens).find((t) => t.address === null)!

    // Check cache
    const cacheKey = `tx:${chainId}:${safeAddress.toLowerCase()}`
    const cached = cache.get(cacheKey)
    let allTransactions: Transaction[]

    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      allTransactions = cached.data as Transaction[]
    } else {
      // Fetch sequentially to avoid rate limits
      const addrLower = safeAddress.toLowerCase()
      const normalTxs = await fetchNormalTransactions(chainId, safeAddress).catch(() => [])
      const internalTxs = await fetchInternalTransactions(chainId, safeAddress).catch(() => [])
      const erc20Txs = await fetchERC20Transfers(chainId, safeAddress).catch(() => [])

      const transactions: Transaction[] = []

      for (const tx of normalTxs) {
        if (tx.value === '0' && tx.functionName) continue

        transactions.push({
          hash: tx.hash,
          type: 'native',
          from: tx.from,
          to: tx.to,
          value: tx.value,
          valueFormatted: formatTokenValue(tx.value, nativeToken.decimals),
          asset: nativeToken.symbol,
          decimals: nativeToken.decimals,
          direction: tx.to.toLowerCase() === addrLower ? 'in' : 'out',
          timestamp: parseInt(tx.timeStamp, 10),
          blockNumber: parseInt(tx.blockNumber, 10),
          isError: tx.isError === '1',
        })
      }

      for (const tx of internalTxs) {
        if (tx.value === '0') continue

        transactions.push({
          hash: tx.hash,
          type: 'internal',
          from: tx.from,
          to: tx.to,
          value: tx.value,
          valueFormatted: formatTokenValue(tx.value, nativeToken.decimals),
          asset: nativeToken.symbol,
          decimals: nativeToken.decimals,
          direction: tx.to.toLowerCase() === addrLower ? 'in' : 'out',
          timestamp: parseInt(tx.timeStamp, 10),
          blockNumber: parseInt(tx.blockNumber, 10),
          isError: tx.isError === '1',
        })
      }

      for (const tx of erc20Txs) {
        const knownToken = chain.tokenByAddress[tx.contractAddress.toLowerCase()]
        const symbol = knownToken?.symbol ?? tx.tokenSymbol ?? tx.contractAddress
        const decimals = knownToken?.decimals ?? (parseInt(tx.tokenDecimal, 10) || 18)

        transactions.push({
          hash: tx.hash,
          type: 'erc20',
          from: tx.from,
          to: tx.to,
          value: tx.value,
          valueFormatted: formatTokenValue(tx.value, decimals),
          asset: symbol,
          decimals,
          direction: tx.to.toLowerCase() === addrLower ? 'in' : 'out',
          timestamp: parseInt(tx.timeStamp, 10),
          blockNumber: parseInt(tx.blockNumber, 10),
          isError: false,
          tokenAddress: tx.contractAddress,
          tokenSymbol: symbol,
        })
      }

      transactions.sort((a, b) => b.timestamp - a.timestamp)

      const seen = new Set<string>()
      allTransactions = transactions.filter((tx) => {
        const key = `${tx.hash}:${tx.type}:${tx.from}:${tx.to}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

      cache.set(cacheKey, { data: allTransactions, ts: Date.now() })
    }

    // Paginate
    const total = allTransactions.length
    const start = (page - 1) * limit
    const paginated = allTransactions.slice(start, start + limit)

    // Enrich with agent info from payment_intents
    const txHashes = paginated.map((tx) => tx.hash.toLowerCase())
    let agentByTxHash = new Map<string, string>()

    if (txHashes.length > 0) {
      try {
        const piResult = await pool.query<{ tx_hash: string; agent_name: string }>(
          `SELECT LOWER(pi.tx_hash) as tx_hash, a.name as agent_name
           FROM payment_intents pi
           JOIN agents a ON a.id = pi.agent_id
           WHERE LOWER(pi.tx_hash) = ANY($1)
             AND pi.status = 'confirmed'`,
          [txHashes],
        )
        for (const row of piResult.rows) {
          agentByTxHash.set(row.tx_hash, row.agent_name)
        }
      } catch {
        // Non-critical — just skip agent enrichment
      }
    }

    const enriched = paginated.map((tx) => ({
      ...tx,
      agentName: agentByTxHash.get(tx.hash.toLowerCase()) ?? undefined,
    }))

    return {
      transactions: enriched,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    }
  })
}
