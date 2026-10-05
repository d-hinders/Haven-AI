import { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { findAccountOwnership } from '../infra/repositories/transaction-history.js'
import { getChain, isSupportedChain } from '../domain/chains.js'
import { formatTokenValue } from '../domain/tokens.js'
import { emitFunnelEvent } from '../infra/repositories/onboarding-funnel.js'
import {
  balanceReadsDegraded,
  evictBalanceReads,
  fetchBalanceReads,
  resolveSettledBalance,
  type BalanceFreshness,
  type BalanceReads,
} from '../modules/accounts/index.js'

// #3460: the per-route 30 s cache is gone — this route and
// `fetchPortfolioForAccount` read the SAME (chainId, address)-keyed cache
// (`modules/accounts/balance-reads.ts`, TTL 60 s, the longer of the two it
// replaces), so one dashboard's two polls cause one set of on-chain reads
// within the TTL instead of two. Visible change: a served balance can lag
// the chain by up to 60 s (was 30 s), including the CLI's `/balances`
// reads. The poll interval is unchanged.

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

/**
 * Build the response entries from the shared read-set. Formerly inline in the
 * handler; the logic is untouched (it is `resolveSettledBalance` applied per
 * leg, native first, then ERC-20s in registry order).
 */
function balanceItems(
  chainId: number,
  accountAddress: string,
  symbols: string[],
  tokenAddresses: (string | null)[],
  decimals: number[],
  reads: BalanceReads,
): BalanceItem[] {
  const settled = [reads.native, ...reads.erc20]
  const items: BalanceItem[] = []
  for (let i = 0; i < settled.length; i++) {
    const tokenAddress = tokenAddresses[i]
    const read = resolveSettledBalance(chainId, accountAddress, tokenAddress, settled[i])
    items.push({
      symbol: symbols[i],
      address: tokenAddress,
      balance: read.raw,
      formatted: formatTokenValue(read.raw, decimals[i]),
      decimals: decimals[i],
      ...(read.freshness ? { balanceFreshness: read.freshness } : {}),
    })
  }
  return items
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

      const reads = await fetchBalanceReads(chainId, accountAddress)
      const tokens = Object.values(chain.tokens)
      const nativeToken = tokens.find((t) => t.address === null)!
      const erc20Tokens = tokens.filter((t) => t.address !== null)
      const tokenAddresses = [null, ...erc20Tokens.map((t) => t.address!)]
      const result = {
        balances: balanceItems(
          chainId,
          accountAddress,
          [nativeToken.symbol, ...erc20Tokens.map((t) => t.symbol)],
          tokenAddresses,
          [nativeToken.decimals, ...erc20Tokens.map((t) => t.decimals)],
          reads,
        ),
      }

      // #3295: a failed leg is never cached — the degraded result is served
      // once (concurrent callers already waiting on the same load share it)
      // and the key is dropped, so the next request re-reads the chain.
      if (balanceReadsDegraded(reads)) evictBalanceReads(chainId, accountAddress)

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
