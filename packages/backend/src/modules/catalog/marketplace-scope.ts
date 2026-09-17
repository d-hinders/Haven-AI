/**
 * Marketplace scoping (#3078, epic #3077 decisions 4, 11, 12).
 *
 * Three questions the catalog and merchants routes ask, answered in one
 * place so the two routes cannot drift:
 *
 *  - which chains a NON-AGENT reader (dashboard user, credential-less
 *    caller) sees operator offers on — `HAVEN_MARKETPLACE_CHAIN_IDS`, else
 *    `HAVEN_DEPLOY_CHAIN_IDS`, else every chain (`null`). An agent read never
 *    asks: its own chain clause stands alone (routes/catalog.ts), because an
 *    agent on a chain is entitled to that chain's offers whatever the
 *    deployment lists for browsers;
 *  - whether the listed chains include a mainnet — the second line of
 *    defence for prospects: a copied env with the flag on cannot publish
 *    `coming_soon` rows on a deployment that lists Base;
 *  - whether THIS caller may see prospects: an authenticated dashboard user,
 *    never an agent, never a credential-less read, and only when the flag is
 *    on and no mainnet is listed (decision 12).
 */
import type { FastifyRequest } from 'fastify'
import { getChainData, isRegisteredChain } from '@haven_ai/core'
import { config } from '../../config.js'
import type { ChainScope } from '../../infra/repositories/merchants.js'

/** The chain list non-agent reads are scoped to; `null` = every chain. */
export function marketplaceChainIds(): ChainScope {
  const listed = config.marketplaceChainIds.length > 0 ? config.marketplaceChainIds : config.deployChainIds
  return listed.length > 0 ? listed : null
}

/**
 * A mainnet is any registered chain without a faucet (`faucetUrl` is the
 * TESTNET-ONLY field, #2534). An unregistered id is treated as mainnet —
 * fail closed for the prospects gate.
 */
export function isMainnetChain(chainId: number): boolean {
  if (!isRegisteredChain(chainId)) return true
  return getChainData(chainId).faucetUrl === undefined
}

/** True when the marketplace lists at least one mainnet chain (or every chain). */
export function marketplaceListsMainnet(): boolean {
  const ids = marketplaceChainIds()
  if (ids === null) return true
  return ids.some(isMainnetChain)
}

/**
 * Whether `request` may see `coming_soon` merchants. The caller must be a
 * dashboard user (JWT set `request.user`; agent keys set `request.agent` —
 * an agent is never one), the flag must be on, and no mainnet may be listed.
 */
export function prospectsVisibleTo(request: FastifyRequest): boolean {
  if (!config.marketplaceProspectsEnabled) return false
  if (marketplaceListsMainnet()) return false
  if (request.agent) return false
  return Boolean(request.user)
}
