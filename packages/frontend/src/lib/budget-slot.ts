import type { DelegationBudget } from '@/hooks/useDelegationBudget'

/**
 * #3933: row-level budget-slot predicates, read from `GET /agents/:id/delegations`
 * (which returns every status). One module so the agent page's budget card and
 * the marketplace's fund-merchant modal cannot disagree about which row occupies
 * a slot, or which old budget is still enabled.
 *
 * Both predicates read Haven's DATABASE status, not the chain. A `replaced` row
 * that was disabled out-of-band stays `replaced` until a per-hash revoke prepare
 * updates it; the finish action is safe there, because that revoke answers
 * "Already revoked". So the copy built on {@link isReplacedButEnabled} says the
 * old budget "can still be spent outside Haven until it is stopped" and never
 * claims to have read the chain.
 */

type SlotRow = Pick<DelegationBudget, 'status' | 'expires_at'>

/**
 * An old budget that a replace retired in Haven's mirror but that has not been
 * stopped on-chain: `status === 'replaced'` and unexpired. Haven no longer
 * selects it for payments, but whoever holds the agent's key (or a sub-budget
 * grantee's key) can still redeem it outside Haven until the owner's Stop lands.
 *
 * NOT `live_delegation_count` (`lib/half-revoked.ts`): that count also includes
 * unsigned `pending` rows and expired rows, and would flag the wrong agents.
 */
export function isReplacedButEnabled(row: SlotRow, nowSec: number): boolean {
  return row.status === 'replaced' && row.expires_at > nowSec
}

/** Every replaced-but-enabled row in a delegations list. Empty for `null` (not loaded). */
export function replacedButEnabledBudgets<T extends SlotRow>(rows: T[] | null | undefined, nowSec: number): T[] {
  return (rows ?? []).filter((row) => isReplacedButEnabled(row, nowSec))
}

/**
 * Whether a row OCCUPIES its (token, recipient) slot: `active` and unexpired.
 * The same rule the backend applies before it refuses a plain grant with
 * `BUDGET_SLOT_OCCUPIED` (`findOccupyingDelegationsInSlot`, #3933). A dormant
 * re-key "steady" row whose period has not started still occupies.
 */
export function occupiesSlot(row: SlotRow, nowSec: number): boolean {
  return row.status === 'active' && row.expires_at > nowSec
}

/**
 * The live budget a new grant for (token, recipient) would collide with, or
 * null for an empty slot. Addresses compare case-insensitively; a null or empty
 * recipient is the open slot, and only matches another open row. When a slot
 * holds several live rows (a re-key's carry and steady pair), the newest wins,
 * as the backend's `existing_delegation_hash` does.
 */
export function findOccupyingBudget<T extends SlotRow & Pick<DelegationBudget, 'token_address' | 'recipient_address' | 'created_at'>>(
  rows: T[] | null | undefined,
  slot: { tokenAddress: string; recipientAddress?: string | null },
  nowSec: number,
): T | null {
  const token = slot.tokenAddress.toLowerCase()
  const recipient = (slot.recipientAddress ?? '').toLowerCase()
  const matches = (rows ?? []).filter(
    (row) =>
      occupiesSlot(row, nowSec) &&
      row.token_address.toLowerCase() === token &&
      (row.recipient_address ?? '').toLowerCase() === recipient,
  )
  if (matches.length === 0) return null
  return matches.reduce((newest, row) =>
    Date.parse(row.created_at) > Date.parse(newest.created_at) ? row : newest,
  )
}
