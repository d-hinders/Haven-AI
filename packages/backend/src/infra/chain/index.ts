/**
 * `getChainClient(rail)` — the ONE selection point between the two
 * `ChainClient` implementations (#994).
 *
 * Deliberately not a registry: #991 proposed one above the rail seam and it
 * was closed as unwarranted ("a rail registry is not warranted at 4 dispatch
 * sites across 2 files") — the seam `rails/execution-rail.ts` and the routes'
 * own `agent.execution_rail === 'delegation'` checks already resolve, this
 * factory just keys off. Routes call `getChainClient(impl)`; they never
 * import `ethers-client.js` / `viem-client.js` directly and never name an
 * SDK.
 */
import type { ChainClient, ChainClientImpl } from '../../domain/chain-client.js'
import { ethersChainClient } from './ethers-client.js'
import { viemChainClient } from './viem-client.js'

export function getChainClient(impl: ChainClientImpl): ChainClient {
  return impl === 'viem' ? viemChainClient : ethersChainClient
}

export type { ChainClient, ChainClientImpl } from '../../domain/chain-client.js'
