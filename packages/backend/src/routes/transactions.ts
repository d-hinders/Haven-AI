import { FastifyBaseLogger, FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import pool from '../db.js'
import {
  fetchNormalTransactions,
  fetchInternalTransactions,
  fetchERC20Transfers,
} from '../lib/explorer-api.js'
import { getChain } from '../lib/chains.js'
import { formatTokenValue } from '../lib/tokens.js'
import { createCache } from '../lib/cache.js'

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

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

interface UserSafeRow {
  id: string
  safe_address: string
  chain_id: number
  name: string
}

export interface EnrichedTransaction extends Transaction {
  chainId: number
  safeId: string
  safeAddress: string
  safeName: string
  agentId?: string
  agentName?: string
}

interface PaymentIntentAgentRow {
  tx_hash: string
  agent_id: string
  agent_name: string
}

interface FetchSafeTransactionsParams {
  safeId: string
  safeAddress: string
  chainId: number
  log: FastifyBaseLogger
  fresh?: boolean
}

interface FetchSafeTransactionsResult {
  transactions: Transaction[]
  hadFailures: boolean
}

interface ParsedTokenFilter {
  chainId: number
  address: string | null
}

const txCache = createCache<Transaction[]>(30_000)
const txInflight = new Map<string, Promise<FetchSafeTransactionsResult>>()

function parsePositiveInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number | null {
  if (value === undefined) return fallback
  const parsed = parseInt(value, 10)
  if (Number.isNaN(parsed) || parsed < min || parsed > max) {
    return null
  }
  return parsed
}

function parseFreshFlag(value: string | undefined): boolean {
  return value === '1' || value === 'true'
}

function parseTokenKey(tokenKey: string | undefined): ParsedTokenFilter | null {
  if (!tokenKey) return null

  const [chainPart, assetPart, ...rest] = tokenKey.split(':')
  if (!chainPart || !assetPart || rest.length > 0) return null

  const chainId = parseInt(chainPart, 10)
  if (Number.isNaN(chainId)) return null

  try {
    getChain(chainId)
  } catch {
    return null
  }

  if (assetPart === 'native') {
    return { chainId, address: null }
  }

  if (!ETH_ADDRESS_RE.test(assetPart)) {
    return null
  }

  return { chainId, address: assetPart.toLowerCase() }
}

export async function fetchSafeTransactions({
  safeId,
  safeAddress,
  chainId,
  log,
  fresh = false,
}: FetchSafeTransactionsParams): Promise<FetchSafeTransactionsResult> {
  const chain = getChain(chainId)
  const nativeToken = Object.values(chain.tokens).find((token) => token.address === null)!
  const cacheKey = `tx:${chainId}:${safeAddress.toLowerCase()}`

  if (fresh) {
    txCache.delete(cacheKey)
  }

  const cached = txCache.get(cacheKey)
  if (cached !== undefined) {
    return { transactions: cached, hadFailures: false }
  }

  const inflight = txInflight.get(cacheKey)
  if (inflight) {
    return inflight
  }

  const requestPromise = (async () => {
    const addrLower = safeAddress.toLowerCase()
    let hadFailures = false
    const logFail = (kind: string) => (err: unknown) => {
      hadFailures = true
      log.warn({ err, chainId, safeId, safeAddress, kind }, 'Explorer API fetch failed')
      return []
    }

    const normalTxs = await fetchNormalTransactions(chainId, safeAddress).catch(
      logFail('normal'),
    )
    const internalTxs = await fetchInternalTransactions(chainId, safeAddress).catch(
      logFail('internal'),
    )
    const erc20Txs = await fetchERC20Transfers(chainId, safeAddress).catch(
      logFail('erc20'),
    )

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

    transactions.sort(compareTransactions)

    const seen = new Set<string>()
    const deduped = transactions.filter((tx) => {
        const key = `${tx.hash}:${tx.type}:${tx.from}:${tx.to}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

    txCache.set(cacheKey, deduped)

    return {
      transactions: deduped,
      hadFailures,
    }
  })().finally(() => {
    txInflight.delete(cacheKey)
  })

  txInflight.set(cacheKey, requestPromise)
  return requestPromise
}

export function compareTransactions(a: Transaction, b: Transaction): number {
  return (
    b.timestamp - a.timestamp ||
    b.blockNumber - a.blockNumber ||
    a.hash.localeCompare(b.hash) ||
    a.type.localeCompare(b.type) ||
    a.from.localeCompare(b.from) ||
    a.to.localeCompare(b.to)
  )
}

function compareEnrichedTransactions(
  a: EnrichedTransaction,
  b: EnrichedTransaction,
): number {
  return compareTransactions(a, b) || a.safeAddress.localeCompare(b.safeAddress)
}

export async function enrichTransactionsWithAgents(
  userId: string,
  transactions: EnrichedTransaction[],
): Promise<EnrichedTransaction[]> {
  const txHashes = Array.from(
    new Set(transactions.map((tx) => tx.hash.toLowerCase())),
  )
  if (txHashes.length === 0) return transactions

  try {
    const piResult = await pool.query<PaymentIntentAgentRow>(
      `SELECT LOWER(pi.tx_hash) AS tx_hash, pi.agent_id, a.name AS agent_name
       FROM payment_intents pi
       JOIN agents a ON a.id = pi.agent_id
       WHERE LOWER(pi.tx_hash) = ANY($1)
         AND pi.user_id = $2
         AND pi.status = 'confirmed'`,
      [txHashes, userId],
    )

    const agentByTxHash = new Map<string, { id: string; name: string }>()
    for (const row of piResult.rows) {
      agentByTxHash.set(row.tx_hash, {
        id: row.agent_id,
        name: row.agent_name,
      })
    }

    return transactions.map((tx) => {
      const agent = agentByTxHash.get(tx.hash.toLowerCase())
      return {
        ...tx,
        agentId: agent?.id,
        agentName: agent?.name,
      }
    })
  } catch {
    return transactions
  }
}

export default async function transactionRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  app.get<{
    Querystring: {
      safeId?: string
      agentId?: string
      tokenKey?: string
      offset?: string
      limit?: string
      fresh?: string
    }
  }>('/', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const offset = parsePositiveInt(request.query.offset, 0, 0, Number.MAX_SAFE_INTEGER)
    const limit = parsePositiveInt(request.query.limit, 25, 1, 100)
    const fresh = parseFreshFlag(request.query.fresh)

    if (offset === null || limit === null) {
      return reply.code(400).send({ error: 'Invalid pagination params' })
    }

    if (request.query.safeId && !UUID_RE.test(request.query.safeId)) {
      return reply.code(400).send({ error: 'Invalid safeId' })
    }

    if (
      request.query.agentId &&
      request.query.agentId !== 'user' &&
      !UUID_RE.test(request.query.agentId)
    ) {
      return reply.code(400).send({ error: 'Invalid agentId' })
    }

    const tokenFilter = parseTokenKey(request.query.tokenKey)
    if (request.query.tokenKey && !tokenFilter) {
      return reply.code(400).send({ error: 'Invalid tokenKey' })
    }

    const safeResult = await pool.query<UserSafeRow>(
      `SELECT id, safe_address, chain_id, name
       FROM user_safes
       WHERE user_id = $1
       ORDER BY created_at ASC`,
      [sub],
    )

    let safes = safeResult.rows

    if (request.query.safeId) {
      safes = safes.filter((safe) => safe.id === request.query.safeId)
      if (safes.length === 0) {
        return reply.code(400).send({ error: 'Invalid safeId' })
      }
    }

    if (request.query.agentId && request.query.agentId !== 'user') {
      const agentResult = await pool.query<{ id: string }>(
        'SELECT id FROM agents WHERE id = $1 AND user_id = $2',
        [request.query.agentId, sub],
      )
      if (agentResult.rows.length === 0) {
        return reply.code(400).send({ error: 'Invalid agentId' })
      }
    }

    if (safes.length === 0) {
      return {
        transactions: [],
        total: 0,
        offset,
        limit,
        hasMore: false,
        partialFailure: false,
        failedSafeIds: [],
      }
    }

    const merged: EnrichedTransaction[] = []
    const failedSafeIds: string[] = []

    for (const safe of safes) {
      try {
        const { transactions, hadFailures } = await fetchSafeTransactions({
          safeId: safe.id,
          safeAddress: safe.safe_address,
          chainId: safe.chain_id,
          log: request.log,
          fresh,
        })

        if (hadFailures) {
          failedSafeIds.push(safe.id)
        }

        for (const tx of transactions) {
          merged.push({
            ...tx,
            chainId: safe.chain_id,
            safeId: safe.id,
            safeAddress: safe.safe_address,
            safeName: safe.name,
          })
        }
      } catch (err) {
        failedSafeIds.push(safe.id)
        request.log.warn(
          { err, safeId: safe.id, safeAddress: safe.safe_address, chainId: safe.chain_id },
          'Safe transaction aggregation failed',
        )
      }
    }

    merged.sort(compareEnrichedTransactions)

    const seen = new Set<string>()
    const deduped = merged.filter((tx) => {
      const key = `${tx.hash}:${tx.type}:${tx.from}:${tx.to}:${tx.safeAddress.toLowerCase()}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    const enriched = await enrichTransactionsWithAgents(sub, deduped)

    const filtered = enriched.filter((tx) => {
      if (request.query.agentId === 'user') {
        return tx.direction === 'out' && !tx.agentId
      }

      if (request.query.agentId && request.query.agentId !== 'user' && tx.agentId !== request.query.agentId) {
        return false
      }

      if (tokenFilter) {
        if (tx.chainId !== tokenFilter.chainId) return false
        if (tokenFilter.address === null) {
          if (tx.type === 'erc20') return false
        } else if (tx.type !== 'erc20' || tx.tokenAddress?.toLowerCase() !== tokenFilter.address) {
          return false
        }
      }

      return true
    })

    const paginated = filtered.slice(offset, offset + limit)

    return {
      transactions: paginated,
      total: filtered.length,
      offset,
      limit,
      hasMore: filtered.length > offset + paginated.length,
      partialFailure: failedSafeIds.length > 0,
      failedSafeIds: Array.from(new Set(failedSafeIds)),
    }
  })

  app.get<{ Querystring: { fresh?: string } }>('/filters', async (request) => {
    const { sub } = request.user as { sub: string }
    const fresh = parseFreshFlag(request.query.fresh)

    const [safeResult, agentResult] = await Promise.all([
      pool.query<UserSafeRow>(
        `SELECT id, safe_address, chain_id, name
         FROM user_safes
         WHERE user_id = $1
         ORDER BY created_at ASC`,
        [sub],
      ),
      pool.query<{ id: string; name: string; status: string }>(
        `SELECT id, name, status
         FROM agents
         WHERE user_id = $1
         ORDER BY
           CASE status
             WHEN 'active' THEN 0
             WHEN 'paused' THEN 1
             ELSE 2
           END,
           created_at DESC`,
        [sub],
      ),
    ])

    const tokenOptions = new Map<
      string,
      { key: string; symbol: string; address: string | null; chainId: number; isNative: boolean }
    >()

    for (const safe of safeResult.rows) {
      const chain = getChain(safe.chain_id)
      const nativeToken = Object.values(chain.tokens).find((token) => token.address === null)!
      const nativeKey = `${safe.chain_id}:native`
      tokenOptions.set(nativeKey, {
        key: nativeKey,
        symbol: nativeToken.symbol,
        address: null,
        chainId: safe.chain_id,
        isNative: true,
      })
    }

    const tokenResults = await Promise.all(
      safeResult.rows.map(async (safe) => {
        try {
          const { transactions } = await fetchSafeTransactions({
            safeId: safe.id,
            safeAddress: safe.safe_address,
            chainId: safe.chain_id,
            log: request.log,
            fresh,
          })

          return { safe, transactions }
        } catch (err) {
          request.log.warn(
            { err, safeId: safe.id, safeAddress: safe.safe_address, chainId: safe.chain_id },
            'Transaction filter token collection failed',
          )
          return { safe, transactions: [] as Transaction[] }
        }
      }),
    )

    for (const { safe, transactions } of tokenResults) {
      for (const tx of transactions) {
        if (tx.type !== 'erc20' || !tx.tokenAddress) continue
        const key = `${safe.chain_id}:${tx.tokenAddress.toLowerCase()}`
        if (tokenOptions.has(key)) continue

        tokenOptions.set(key, {
          key,
          symbol: tx.asset,
          address: tx.tokenAddress.toLowerCase(),
          chainId: safe.chain_id,
          isNative: false,
        })
      }
    }

    const tokens = Array.from(tokenOptions.values()).sort((a, b) => {
      if (a.chainId !== b.chainId) return a.chainId - b.chainId
      if (a.isNative !== b.isNative) return a.isNative ? -1 : 1
      return a.symbol.localeCompare(b.symbol)
    })

    return {
      safes: safeResult.rows.map((safe) => ({
        id: safe.id,
        name: safe.name,
        address: safe.safe_address,
        chainId: safe.chain_id,
      })),
      agents: agentResult.rows,
      tokens,
    }
  })

  app.get<{
    Params: { safeAddress: string }
    Querystring: { page?: string; limit?: string; fresh?: string }
  }>('/:safeAddress', async (request, reply) => {
    const { safeAddress } = request.params
    const { sub } = request.user as { sub: string }
    const page = parsePositiveInt(request.query.page, 1, 1, Number.MAX_SAFE_INTEGER)
    const limit = parsePositiveInt(request.query.limit, 25, 1, 100)
    const fresh = parseFreshFlag(request.query.fresh)

    if (page === null || limit === null) {
      return reply.code(400).send({ error: 'Invalid pagination params' })
    }

    if (!ETH_ADDRESS_RE.test(safeAddress)) {
      return reply.code(400).send({ error: 'Invalid address' })
    }

    const userResult = await pool.query<{ id: string; chain_id: number }>(
      'SELECT id, chain_id FROM user_safes WHERE user_id = $1 AND LOWER(safe_address) = LOWER($2)',
      [sub, safeAddress],
    )
    if (userResult.rows.length === 0) {
      return reply.code(403).send({ error: 'Not your Safe' })
    }

    const safeId = userResult.rows[0].id
    const chainId = userResult.rows[0].chain_id
    const { transactions: allTransactions } = await fetchSafeTransactions({
      safeId,
      safeAddress,
      chainId,
      log: request.log,
      fresh,
    })

    const total = allTransactions.length
    const start = (page - 1) * limit
    const paginated = allTransactions.slice(start, start + limit)

    const enriched = await enrichTransactionsWithAgents(
      sub,
      paginated.map((tx) => ({
        ...tx,
        chainId,
        safeId,
        safeAddress,
        // These aggregated-only fields are stripped back off before responding.
        safeName: '',
      })),
    )

    return {
      transactions: enriched.map(
        ({ chainId: _chainId, safeId: _safeId, safeAddress: _safeAddress, safeName: _safeName, agentId: _agentId, ...tx }) => tx,
      ),
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    }
  })
}
