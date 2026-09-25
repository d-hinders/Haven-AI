import { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { findAccountOwnership } from '../infra/repositories/transaction-history.js'
import { getChain, isSupportedChain } from '../domain/chains.js'
import { getChainClient } from '../infra/chain/index.js'
import { formatTokenValue } from '../domain/tokens.js'
import { createCache } from '../platform/cache.js'
import { emitFunnelEvent } from '../infra/repositories/onboarding-funnel.js'
import {
  balanceFreshness,
  knownBalance,
  recordKnownBalance,
  type BalanceFreshness,
} from '../modules/accounts/index.js'

// Balance reads are RPC-standard and rail-agnostic (a `balanceOf`/native-balance
// read is identical regardless of which execution rail the Safe uses), and this
// route has no agent/rail context to resolve one from — it reads a Safe address
// directly. Kept on the existing ethers-backed implementation (#994) so this
// route's behavior is unchanged; there's no per-rail branch to make here.
const BALANCE_READ_IMPL = 'ethers'

const balanceCache = createCache<{ balances: BalanceItem[] }>(30_000)

/**
 * Results where a balance read failed. A failed leg is no longer a silent
 * zero (#3295): it serves the last-known balance, marked stale with its as-of
 * time, or stays '0' marked unavailable when nothing was ever read. Either
 * way it is never cached, so one RPC blip does not pin a degraded figure for
 * the whole TTL.
 */
const degradedResults = new WeakSet<{ balances: BalanceItem[] }>()

export interface BalanceItem {
  symbol: string
  address: string | null
  balance: string
  formatted: string
  decimals: number
  /**
   * Present only when this entry's balance read FAILED (#3295): 'stale' with
   * the last successful read's time, or 'unavailable' when no balance has
   * ever been read for this token. Absent on a clean read. Additive only —
   * `balance` stays a decimal string with its address and decimals, which the
   * published CLI's registry reads rely on.
   */
  balanceFreshness?: BalanceFreshness
}

/**
 * The spec (`chain_id: integer, minimum: 1`) is the shape check, enforced
 * before the handler since #3030; ajv has coerced the value to a number by
 * the time it arrives, so this only reads it. Whether the chain is one Haven
 * serves is not a shape question — `isSupportedChain` below stays.
 */
function parseChainId(value: unknown): number | null {
  if (value === undefined) return null
  return Number(value)
}

export default async function balanceRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  app.get<{ Params: { accountAddress: string }; Querystring: { chain_id?: string } }>(
    '/:accountAddress',
    async (request, reply) => {
      const { accountAddress } = request.params
      const requestedChainId = parseChainId(request.query.chain_id)
      const { sub } = request.user as { sub: string }

      if (requestedChainId !== null && !isSupportedChain(requestedChainId)) {
        return reply.code(400).send({ error: `Unsupported chain: ${requestedChainId}` })
      }

      // Verify ownership and get chain_id (repository query, #999 — the same
      // ownership check the transaction-history route runs).
      const ownedAccounts = await findAccountOwnership(sub, accountAddress, requestedChainId)
      if (ownedAccounts.length === 0) {
        return reply.code(403).send({ error: 'Not your Safe' })
      }
      if (requestedChainId === null && ownedAccounts.length > 1) {
        return reply.code(400).send({ error: 'chain_id required' })
      }

      const chainId = requestedChainId ?? ownedAccounts[0].chain_id
      const chain = getChain(chainId)

      const cacheKey = `bal:${chainId}:${accountAddress.toLowerCase()}`
      const result = await balanceCache.getOrFetch(cacheKey, async () => {
        const chainClient = getChainClient(BALANCE_READ_IMPL)
        const tokens = Object.values(chain.tokens)
        const nativeToken = tokens.find((t) => t.address === null)!
        const erc20Tokens = tokens.filter((t) => t.address !== null)

        const balances: BalanceItem[] = []

        const results = await Promise.allSettled([
          chainClient.getNativeBalance(chainId, accountAddress),
          ...erc20Tokens.map((token) => chainClient.getTokenBalance(chainId, token.address!, accountAddress)),
        ])

        const nativeResult = results[0]
        const nativeKnown = knownBalance(chainId, accountAddress, null)
        const nativeBalance =
          nativeResult.status === 'fulfilled'
            ? nativeResult.value.toString()
            : nativeKnown?.balance ?? '0'
        if (nativeResult.status === 'fulfilled') {
          recordKnownBalance(chainId, accountAddress, null, nativeBalance)
        }
        const nativeFreshness =
          nativeResult.status === 'rejected'
            ? balanceFreshness(true, nativeKnown)
            : null
        balances.push({
          symbol: nativeToken.symbol,
          address: null,
          balance: nativeBalance,
          formatted: formatTokenValue(nativeBalance, nativeToken.decimals),
          decimals: nativeToken.decimals,
          ...(nativeFreshness ? { balanceFreshness: nativeFreshness } : {}),
        })

        for (let i = 0; i < erc20Tokens.length; i++) {
          const token = erc20Tokens[i]
          const result = results[i + 1]
          const known = knownBalance(chainId, accountAddress, token.address)
          const rawBalance =
            result.status === 'fulfilled'
              ? result.value.toString()
              : known?.balance ?? '0'
          if (result.status === 'fulfilled') {
            recordKnownBalance(chainId, accountAddress, token.address, rawBalance)
          }
          const freshness =
            result.status === 'rejected' ? balanceFreshness(true, known) : null
          balances.push({
            symbol: token.symbol,
            address: token.address,
            balance: rawBalance,
            formatted: formatTokenValue(rawBalance, token.decimals),
            decimals: token.decimals,
            ...(freshness ? { balanceFreshness: freshness } : {}),
          })
        }

        const fetched = { balances }
        if (results.some((r) => r.status === 'rejected')) degradedResults.add(fetched)
        return fetched
      })
      if (degradedResults.has(result)) balanceCache.delete(cacheKey)

      // Emit safe_funded once when the account first receives any tokens.
      // The EVENT NAME is a stored enum value (migration 021) and is out of
      // scope for #2914, which carries no migration; only its payload key
      // moves to the account vocabulary.
      // Fire-and-forget; ON CONFLICT DO NOTHING in the insert deduplicates.
      if (result.balances.some((b) => BigInt(b.balance) > 0n)) {
        emitFunnelEvent(sub, 'safe_funded', { account_address: accountAddress, chain_id: chainId })
      }

      return result
    },
  )
}
