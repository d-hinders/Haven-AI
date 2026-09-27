/**
 * The off-ramp hand-off (#3333, epic #3328) — the third piece of the receive
 * side. NOT a "sweep": that word is the stranded-delegate-funds machinery
 * (`modules/mpp/sweep.ts`, agent-keyed). This is the OWNER's own transfer.
 *
 * What it is: the owner moves their own USDC from their own self-custody
 * account to their own saved off-ramp destination (a Safello/Coinbase deposit
 * address). Haven prepares the op, the OWNER signs it, Haven relays —
 * `prepareTransfer`/`submitTransfer` in `rails/hybrid-transfers.ts` unchanged.
 * Haven never holds the settlement key, never off-ramps, never settles for
 * third parties.
 *
 * What this file adds over the raw send:
 * - the destination is the OWNER-SAVED off-ramp address (`off_ramp_destinations`),
 *   looked up per account — the caller cannot hand an arbitrary `to`;
 * - the destination can only be SET by the owner (the route is behind
 *   `authMiddleware`, never agent-auth), and only REPLACED by the owner —
 *   an agent has no route to it at all;
 * - the USDC token address comes from the chain registry, not the request.
 *
 * Payment-adjacent SQL lives in `infra/repositories/` by rule — see the
 * boundary gates in `scripts/dep-lint.mjs`.
 */
import { getChain } from '../../domain/chains.js'
import {
  findOffRampDestinationRow,
  upsertOffRampDestinationRow,
  type OffRampDestinationRow,
} from '../../infra/repositories/inbound-transfers.js'

export type { OffRampDestinationRow } from '../../infra/repositories/inbound-transfers.js'

/** The owner's saved off-ramp destination for one account+chain, or null. */
export function findOffRampDestination(
  accountId: string,
  userId: string,
  chainId: number,
): Promise<OffRampDestinationRow | null> {
  return findOffRampDestinationRow(accountId, userId, chainId)
}

/**
 * Set (or replace) the owner's off-ramp destination. OWNER-only by caller
 * contract: every route that reaches this runs behind `authMiddleware`
 * (dashboard JWT), never agent-auth — an agent key cannot set or change a
 * destination, and no agent route exists for it.
 */
export function setOffRampDestination(input: {
  accountId: string
  userId: string
  chainId: number
  destinationAddress: string
  destinationKind: string
}): Promise<OffRampDestinationRow> {
  return upsertOffRampDestinationRow(input)
}

/** The chain registry's USDC contract for `chainId`, or null when the chain has none. */
export function usdcAddressForChain(chainId: number): string | null {
  const chain = getChain(chainId)
  const token = Object.values(chain.tokens).find(
    (candidate) => candidate.address !== null && candidate.symbol.toUpperCase().replace('.', '') === 'USDC',
  )
  return token?.address ?? null
}
