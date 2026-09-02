/**
 * Read side of the delegation budget view (#1090): the ACTIVE
 * `agent_delegations` rows a delegation-rail agent's displayed budget is
 * derived from. Storage access only — the shaping lives in
 * `lib/delegation-budget-view.ts`.
 */

import pool from '../../db.js'
import type { Executor } from '../transaction.js'

export interface ActiveDelegationRow {
  id: string
  agent_id: string
  chain_id: number
  token_address: string
  budget_atomic: string
  period_seconds: number
}

/**
 * The signed delegations for a set of delegation ids (#1145).
 *
 * Deliberately NOT folded into `listActiveDelegations` or the derived budget
 * view: a signed delegation is a capability, and those rows are spread
 * straight into JSON responses — carrying it there would put a redeemable
 * grant one careless spread away from the wire. Callers that genuinely need
 * it (the on-chain remaining-budget read) ask for it explicitly.
 */
export const LIST_DELEGATION_JSON_BY_IDS_SQL = `SELECT id, delegation_json
     FROM agent_delegations
     WHERE id = ANY($1)`

export async function listDelegationJsonByIds(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const result = await pool.query<{ id: string; delegation_json: string }>(
    LIST_DELEGATION_JSON_BY_IDS_SQL,
    [ids],
  )
  return new Map(result.rows.map((r) => [r.id, r.delegation_json]))
}

export async function listActiveDelegations(
  agentIds: string[],
): Promise<ActiveDelegationRow[]> {
  if (agentIds.length === 0) return []
  const result = await pool.query<ActiveDelegationRow>(
    `SELECT id, agent_id, chain_id, token_address, budget_atomic, period_seconds
     FROM agent_delegations
     WHERE agent_id = ANY($1) AND status = 'active'
     ORDER BY created_at ASC`,
    [agentIds],
  )
  return result.rows
}

// ── Payment authorization selection (moved from rails/delegation-authorization.ts, #999)

/**
 * The delegation that authorizes a payment: the ACTIVE row for (agent, token)
 * whose recipient matches, else the agent's ACTIVE open-budget row for that
 * token. A pinned delegation always wins over the open one — the tighter
 * grant is the one the owner meant for that recipient (#829).
 *
 * ## The time window (#1698, found by review)
 *
 * `status` used to be the only filter, and `created_at DESC` the only tie
 * break. That selected grants the chain would refuse: an ACTIVE row whose
 * `start_date` is still in the future (the period enforcer reverts before its
 * first period opens) or one already past `expires_at` (the timestamp caveat
 * refuses it). Both were unreachable while every grant anchored ~60 s in the
 * past — and #1698's carry makes the first one routine, because the "steady"
 * half of a carried budget is deliberately dormant until the old period
 * boundary and sits in the same (token, recipient) slot as the live "carry"
 * half. Under the old ordering the dormant grant, being newest, won every
 * payment for exactly the window the carry exists to cover.
 *
 * So the window is now part of the predicate. This can only ever narrow the
 * result to grants the chain would honour — it never admits a delegation that
 * was previously excluded, and never raises anyone's budget.
 *
 * ## Why soonest-expiring wins
 *
 * Among live grants, `expires_at ASC` prefers the one that dies first. For a
 * carried budget that is the carry grant, which is correct twice over: it is
 * the one holding the frozen remainder, and it is the one that becomes
 * worthless at the boundary. Spending the perishable grant before the
 * perpetual one is the same reasoning anywhere else. `created_at DESC` stays
 * as the final tie break so behaviour is unchanged for the ordinary case of
 * several grants sharing an expiry.
 *
 * `EXTRACT(EPOCH FROM NOW())` compares against the DATABASE clock rather than
 * the app's — the same choice the intent-expiry queries make, and for the
 * same reason: two app instances disagreeing about "now" must not disagree
 * about which grant authorizes a payment.
 */
export const SELECT_DELEGATION_FOR_PAYMENT_SQL = `SELECT delegation_hash, delegation_json, recipient_address
     FROM agent_delegations
     WHERE agent_id = $1
       AND token_address = LOWER($2)
       AND status = 'active'
       AND (recipient_address = LOWER($3) OR recipient_address IS NULL)
       AND start_date <= EXTRACT(EPOCH FROM NOW())
       AND expires_at > EXTRACT(EPOCH FROM NOW())
     ORDER BY (recipient_address IS NULL), expires_at ASC, created_at DESC`

export interface DelegationForPaymentRow {
  delegation_hash: string
  delegation_json: string
  recipient_address: string | null
}

/** `agentId` is the scope: delegations belong to exactly one agent. */
export async function selectDelegationForPayment(
  agentId: string,
  tokenAddress: string,
  toAddress: string,
): Promise<DelegationForPaymentRow | null> {
  const result = await pool.query<DelegationForPaymentRow>(SELECT_DELEGATION_FOR_PAYMENT_SQL, [
    agentId,
    tokenAddress,
    toAddress,
  ])
  return result.rows[0] ?? null
}

/**
 * #1400: everything the batch revocation must kill — pending AND active
 * (a pending grant is still a signed delegation that could activate).
 */
export const LIST_NON_REVOKED_DELEGATIONS_FOR_AGENT_SQL = `SELECT delegation_hash, delegation_json, status
       FROM agent_delegations
       WHERE agent_id = $1 AND status IN ('pending', 'active')
       ORDER BY created_at ASC`

export async function listNonRevokedDelegationsForAgent(
  agentId: string,
): Promise<Array<{ delegation_hash: string; delegation_json: string; status: string }>> {
  const result = await pool.query<{ delegation_hash: string; delegation_json: string; status: string }>(
    LIST_NON_REVOKED_DELEGATIONS_FOR_AGENT_SQL,
    [agentId],
  )
  return result.rows
}

/**
 * Activate exactly the pending grant that the caller just authenticated.
 * The conditional update is intentionally kept in the repository so the
 * lifecycle route cannot add another inline write while preserving the
 * transaction executor supplied by its dedicated client.
 */
export const ACTIVATE_PENDING_DELEGATION_SQL = `UPDATE agent_delegations
       SET status = 'active', delegation_json = $1, updated_at = NOW()
       WHERE id = $2 AND status = 'pending'
       RETURNING id`

export async function activatePendingDelegation(
  delegationId: string,
  signedDelegationJson: string,
  executor: Executor = pool,
): Promise<boolean> {
  const result = await executor.query<{ id: string }>(ACTIVATE_PENDING_DELEGATION_SQL, [
    signedDelegationJson,
    delegationId,
  ])
  return result.rows.length === 1
}

/**
 * Retire every OTHER active grant in the (agent, token, recipient) slot the
 * new grant is about to occupy (#2411). The on-chain kill of the old grant is
 * the revoke flow; this only stops Haven selecting it for payments.
 *
 * `AND id <> $4` is the load-bearing clause. #2331 reordered the activation
 * transaction so this sweep ran AFTER `activatePendingDelegation`, and the
 * sweep — then inlined in the route without an exclusion — flipped the row it
 * had just activated: every activation committed with ZERO active rows in
 * the slot and the first payment 403ed (qa-failure #2411, reproduced on real
 * Postgres). Excluding the row being activated by id makes the sweep correct
 * in EITHER order, so a future reorder cannot reintroduce the defect; the
 * order is restored as well, in `activatePendingDelegationInSlot`, because
 * both halves are cheap and the real-DB test proves each one separately.
 *
 * `recipient_address IS NOT DISTINCT FROM $3`: an open grant (NULL recipient)
 * and a recipient-pinned grant are different slots — a pinned grant never
 * retires the open one and vice versa (#829's selection order relies on both
 * coexisting). Returns the retired ids so a caller can report honestly.
 */
export const REPLACE_OTHER_ACTIVE_DELEGATIONS_IN_SLOT_SQL = `UPDATE agent_delegations
       SET status = 'replaced', updated_at = NOW()
       WHERE agent_id = $1
         AND token_address = $2
         AND recipient_address IS NOT DISTINCT FROM $3
         AND status = 'active'
         AND id <> $4
       RETURNING id`

export async function replaceOtherActiveDelegationsInSlot(
  agentId: string,
  tokenAddress: string,
  recipientAddress: string | null,
  exceptDelegationId: string,
  executor: Executor = pool,
): Promise<string[]> {
  const result = await executor.query<{ id: string }>(
    REPLACE_OTHER_ACTIVE_DELEGATIONS_IN_SLOT_SQL,
    [agentId, tokenAddress, recipientAddress, exceptDelegationId],
  )
  return result.rows.map((row) => row.id)
}

export interface ActivateDelegationInSlotInput {
  agentId: string
  /** The `agent_delegations.id` of the PENDING row being activated. */
  delegationId: string
  tokenAddress: string
  recipientAddress: string | null
  signedDelegationJson: string
}

/**
 * The activation sequence as ONE repository call (#2411): retire the slot's
 * other active grants FIRST, then flip exactly the pending row to active.
 * Owning the order here — rather than as two calls a route makes in whatever
 * order it happens to be edited into — is what lets the real-DB test in
 * `__tests__/delegation-budgets.test.ts` pin it: the test runs this function
 * and asserts the slot ends with exactly one active row, the new one.
 *
 * Returns `false` when the row is no longer pending (a concurrent revoke or a
 * repeated activate). MUST run on the caller's transaction client: the sweep
 * has already run by then, and only the caller's ROLLBACK undoes it — the
 * route (#1053 finding 4) rolls back and answers 409. It does not open its
 * own transaction because the route also locks the agent row and flips the
 * agent to active inside the same one.
 */
export async function activatePendingDelegationInSlot(
  input: ActivateDelegationInSlotInput,
  executor: Executor,
): Promise<boolean> {
  await replaceOtherActiveDelegationsInSlot(
    input.agentId,
    input.tokenAddress,
    input.recipientAddress,
    input.delegationId,
    executor,
  )
  return activatePendingDelegation(input.delegationId, input.signedDelegationJson, executor)
}

/**
 * #1400: ONE statement marks exactly the submitted batch revoked. Scoped by
 * agent_id so a stray hash from another agent flips nothing, and predicated
 * on status so an already-revoked row is not churned. Returns the hashes
 * actually flipped so the caller can report honestly.
 */
export const REVOKE_DELEGATIONS_BY_HASHES_SQL = `UPDATE agent_delegations
       SET status = 'revoked', updated_at = NOW()
       WHERE agent_id = $1 AND delegation_hash = ANY($2) AND status != 'revoked'
       RETURNING delegation_hash`

export async function revokeDelegationsByHashes(
  agentId: string,
  hashes: string[],
): Promise<string[]> {
  const result = await pool.query<{ delegation_hash: string }>(REVOKE_DELEGATIONS_BY_HASHES_SQL, [
    agentId,
    hashes,
  ])
  return result.rows.map((row) => row.delegation_hash)
}
