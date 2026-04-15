import { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import pool from '../db.js'
import {
  fetchNormalTransactions,
  fetchInternalTransactions,
  fetchERC20Transfers,
} from '../lib/gnosisscan.js'
import {
  TOKEN_BY_ADDRESS,
  SUPPORTED_TOKENS,
  formatTokenValue,
} from '../lib/tokens.js'

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

    // Verify ownership (multi-Safe)
    const userResult = await pool.query(
      'SELECT id FROM user_safes WHERE user_id = $1 AND LOWER(safe_address) = LOWER($2)',
      [sub, safeAddress],
    )
    if (userResult.rows.length === 0) {
      return reply.code(403).send({ error: 'Not your Safe' })
    }

    // Check cache
    const cacheKey = `tx:${safeAddress.toLowerCase()}`
    const cached = cache.get(cacheKey)
    let allTransactions: Transaction[]

    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      allTransactions = cached.data as Transaction[]
    } else {
      // Fetch sequentially to avoid gnosisscan rate limits
      const addrLower = safeAddress.toLowerCase()
      const normalTxs = await fetchNormalTransactions(safeAddress).catch(() => [])
      const internalTxs = await fetchInternalTransactions(safeAddress).catch(() => [])
      const erc20Txs = await fetchERC20Transfers(safeAddress).catch(() => [])

      const transactions: Transaction[] = []

      // Normalize native transactions
      for (const tx of normalTxs) {
        // Skip zero-value contract calls (these are just function calls, not transfers)
        if (tx.value === '0' && tx.functionName) continue

        transactions.push({
          hash: tx.hash,
          type: 'native',
          from: tx.from,
          to: tx.to,
          value: tx.value,
          valueFormatted: formatTokenValue(tx.value, 18),
          asset: SUPPORTED_TOKENS.XDAI.symbol,
          decimals: 18,
          direction: tx.to.toLowerCase() === addrLower ? 'in' : 'out',
          timestamp: parseInt(tx.timeStamp, 10),
          blockNumber: parseInt(tx.blockNumber, 10),
          isError: tx.isError === '1',
        })
      }

      // Normalize internal transactions
      for (const tx of internalTxs) {
        if (tx.value === '0') continue

        transactions.push({
          hash: tx.hash,
          type: 'internal',
          from: tx.from,
          to: tx.to,
          value: tx.value,
          valueFormatted: formatTokenValue(tx.value, 18),
          asset: SUPPORTED_TOKENS.XDAI.symbol,
          decimals: 18,
          direction: tx.to.toLowerCase() === addrLower ? 'in' : 'out',
          timestamp: parseInt(tx.timeStamp, 10),
          blockNumber: parseInt(tx.blockNumber, 10),
          isError: tx.isError === '1',
        })
      }

      // Normalize ERC-20 transfers
      for (const tx of erc20Txs) {
        const knownToken =
          TOKEN_BY_ADDRESS[tx.contractAddress.toLowerCase()]
        const symbol =
          knownToken?.symbol ?? tx.tokenSymbol ?? tx.contractAddress
        const decimals =
          knownToken?.decimals ?? (parseInt(tx.tokenDecimal, 10) || 18)

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

      // Sort by timestamp descending (most recent first)
      transactions.sort((a, b) => b.timestamp - a.timestamp)

      // Deduplicate: a hash+type pair should be unique
      const seen = new Set<string>()
      allTransactions = transactions.filter((tx) => {
        const key = `${tx.hash}:${tx.type}:${tx.from}:${tx.to}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

      // Update cache
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
