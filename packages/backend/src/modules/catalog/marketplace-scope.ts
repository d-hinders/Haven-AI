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
 *  - whether the EXPLICIT marketplace list names a testnet — the second line
 *    of defence for prospects (decision 14, 2026-09-20): a copied env with the
 *    flag on cannot publish `coming_soon` rows on a deployment whose own list
 *    is mainnet-only, and prod's is `8453`. Until decision 14 the gate was
 *    the inverse ("no mainnet listed"), which made prospects and the mainnet
 *    merchants mutually exclusive on dev — the owner wants both standing
 *    (decision 11 beside decision 9), so the gate now keys on the testnet's
 *    presence rather than the mainnet's absence. The fallback to
 *    `HAVEN_DEPLOY_CHAIN_IDS` does NOT count: prod deploys `8453,84532`, so an
 *    unset marketplace list on prod would otherwise open the door with one
 *    mistake instead of two;
 *  - whether THIS caller may see prospects: an authenticated dashboard user,
 *    never an agent, never a credential-less read, and only when the flag is
 *    on and the explicit list names a testnet (decision 12, as amended by 14).
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

/**
 * True when the marketplace lists at least one mainnet chain (or every chain).
 * No production caller since decision 14 (the prospects gate keys on
 * `marketplaceListsTestnetExplicitly`); kept as a tested predicate for the
 * scope suite and any future rule that needs the mainnet side.
 */
export function marketplaceListsMainnet(): boolean {
  const ids = marketplaceChainIds()
  if (ids === null) return true
  return ids.some(isMainnetChain)
}

/**
 * True when `HAVEN_MARKETPLACE_CHAIN_IDS` itself names a testnet. The
 * fallback list and "every chain" both answer false on purpose (see the
 * module note): a prospect needs an operator who wrote a testnet into the
 * marketplace list, which on prod would already be leaking testnet merchants
 * to dashboard users — a loud misconfiguration, not a quiet one.
 */
export function marketplaceListsTestnetExplicitly(): boolean {
  return config.marketplaceChainIds.some((id) => !isMainnetChain(id))
}

/**
 * Whether `request` may see `coming_soon` merchants. The caller must be a
 * dashboard user (JWT set `request.user`; agent keys set `request.agent` —
 * an agent is never one), the flag must be on, and the explicit marketplace
 * list must name a testnet (decision 14).
 */
export function prospectsVisibleTo(request: FastifyRequest): boolean {
  if (!config.marketplaceProspectsEnabled) return false
  if (!marketplaceListsTestnetExplicitly()) return false
  if (request.agent) return false
  return Boolean(request.user)
}
