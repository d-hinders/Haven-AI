/**
 * The REAL chain readers for `GET /ops/users/:id/onchain` (#3513, epic
 * #3507) — the only file in the ops console allowed to touch `rails/` and
 * `infra/chain/`.
 *
 * It can live beside `modules/ops/onchain.ts` and still keep the ops
 * invariant-1 static walk green (`__tests__/ops.invariants.test.ts`): that
 * test walks the TRANSITIVE import graph starting at `routes/ops.ts`, and
 * nothing in the ops console imports THIS file — `index.ts` wires it into
 * the route options (`onchainReaders`), and `index.ts` is not in the walk.
 * The invariant is therefore enforced exactly as before: importing one of
 * these readers from any module the walk reaches fails the suite.
 *
 * Everything here is a READ: `getBytecode`, `readDisabledDelegationHashes`
 * (`rails/delegation-rail.ts:330`, which reads the pinned DelegationManager
 * at the finalized block with a double read and multicalls the per-hash
 * reads), and `readRemainingBudget`
 * (`infra/chain/delegation-budget-reader.ts:99`, bounded at 2 s total across
 * the failover legs). No `writeContract`, no `sendTransaction`, no signing
 * import. The bytecode check uses `dedicatedOnly: true` on purpose: a
 * lagging fallback node can answer `0x` for a freshly deployed account
 * (`rails/hybrid-provisioning.ts:195`), and the resulting "counterfactual"
 * flag would be false evidence.
 */
import { createPublicClient, type Address } from 'viem'
import type { Hex } from 'viem'
import { chainForId } from '../../rails/delegation-contracts.js'
import { getDelegationContracts } from '../../rails/delegation-contracts.js'
import { readDisabledDelegationHashes } from '../../rails/delegation-rail.js'
import { readRemainingBudget } from '../../infra/chain/delegation-budget-reader.js'
import { rpcTransport } from '../../infra/chain/rpc-transport.js'
import type { OpsOnchainReaders } from './onchain.js'

/**
 * The wired implementation for the ops on-chain view. Passed to
 * `registerOpsRoutes` in `index.ts`; never imported by `routes/ops.ts` or
 * anything it reaches.
 */
export const opsOnchainReaders: OpsOnchainReaders = {
  chainHasDelegationPins(chainId) {
    try {
      getDelegationContracts(chainId)
      return true
    } catch {
      return false
    }
  },

  async accountHasCode(chainId, accountAddress) {
    const client = createPublicClient({
      chain: chainForId(chainId),
      // Dedicated endpoint ONLY: a lagging fallback node can answer `0x` for
      // a deployed account, which would misreport it counterfactual
      // (rails/hybrid-provisioning.ts:195).
      transport: rpcTransport(chainId, { dedicatedOnly: true }),
    })
    const code = await client.getBytecode({ address: accountAddress as Address })
    return code !== undefined && code !== '0x'
  },

  readDisabledDelegationHashes(chainId, hashes) {
    return readDisabledDelegationHashes(chainId, hashes as Hex[])
  },

  readRemainingBudget(chainId, delegationJson, budgetAtomic) {
    return readRemainingBudget(chainId, delegationJson, budgetAtomic)
  },
}
