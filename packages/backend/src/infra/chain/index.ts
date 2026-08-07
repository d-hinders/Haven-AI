/**
 * `getChainClient(rail)` — the ONE selection point between the two
 * `ChainClient` implementations (#994).
 *
 * Deliberately not a registry: #991 proposed one above the rail seam and it
 * was closed as unwarranted ("a rail registry is not warranted at 4 dispatch
 * sites across 2 files") — the seam `lib/execution-rail.ts` and the routes'
 * own `agent.execution_rail === 'delegation'` checks already resolve, this
 * factory just keys off. Routes call `getChainClient(rail)`; they never
 * import `ethers-client.js` / `viem-client.js` directly and never name an
 * SDK.
 */
import type { ChainClient, ChainRail } from '../../domain/chain-client.js'
import { ethersChainClient } from './ethers-client.js'
import { viemChainClient } from './viem-client.js'

export function getChainClient(rail: ChainRail): ChainClient {
  return rail === 'delegation' ? viemChainClient : ethersChainClient
}

export type { ChainClient, ChainRail } from '../../domain/chain-client.js'
