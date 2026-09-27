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
 */
import pool from '../../db.js'
import type { Executor } from '../../infra/transaction.js'
import { getChain } from '../../domain/chains.js'

export interface OffRampDestinationRow {
  id: string
  account_id: string
  chain_id: number
  destination_address: string
  destination_kind: string
  label: string | null
  created_at: Date
  updated_at: Date
}

const FIND_DESTINATION_SQL = `
  SELECT id, account_id, chain_id, destination_address, destination_kind,
         label, created_at, updated_at
    FROM off_ramp_destinations
   WHERE account_id = $1
     AND user_id = $2
     AND chain_id = $3
   LIMIT 1`

/** The owner's saved off-ramp destination for one account+chain, or null. */
export async function findOffRampDestination(
  accountId: string,
  userId: string,
  chainId: number,
  db: Executor = pool,
): Promise<OffRampDestinationRow | null> {
  const result = await db.query<OffRampDestinationRow>(FIND_DESTINATION_SQL, [
    accountId,
    userId,
    chainId,
  ])
  return result.rows[0] ?? null
}

const UPSERT_DESTINATION_SQL = `
  INSERT INTO off_ramp_destinations (account_id, user_id, chain_id, destination_address, destination_kind)
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (account_id, chain_id) DO UPDATE
     SET destination_address = EXCLUDED.destination_address,
         destination_kind = EXCLUDED.destination_kind,
         updated_at = NOW()
  RETURNING id, account_id, chain_id, destination_address, destination_kind,
            label, created_at, updated_at`

/**
 * Set (or replace) the owner's off-ramp destination. OWNER-only by caller
 * contract: every route that reaches this runs behind `authMiddleware`
 * (dashboard JWT), never agent-auth — an agent key cannot set or change a
 * destination, and no agent route exists for it.
 */
export async function setOffRampDestination(
  input: {
    accountId: string
    userId: string
    chainId: number
    destinationAddress: string
    destinationKind: string
  },
  db: Executor = pool,
): Promise<OffRampDestinationRow> {
  const result = await db.query<OffRampDestinationRow>(UPSERT_DESTINATION_SQL, [
    input.accountId,
    input.userId,
    input.chainId,
    input.destinationAddress.toLowerCase(),
    input.destinationKind,
  ])
  return result.rows[0]
}

/** The chain registry's USDC contract for `chainId`, or null when the chain has none. */
export function usdcAddressForChain(chainId: number): string | null {
  const chain = getChain(chainId)
  const token = Object.values(chain.tokens).find(
    (candidate) => candidate.address !== null && candidate.symbol.toUpperCase().replace('.', '') === 'USDC',
  )
  return token?.address ?? null
}
