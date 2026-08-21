/**
 * Storage for the re-key ledger (#1698). Storage access only — the ordering
 * rules live in `modules/agents/rekey-stages.ts` and the carry arithmetic in
 * `modules/agents/rekey-carry.ts`.
 *
 * Every stage advance here is a CONDITIONAL update predicated on the stage it
 * expects, and returns whether it flipped. That is what makes the ordering
 * safe under concurrency: two requests racing to advance the same re-key both
 * run the same `WHERE stage = <expected>`, exactly one flips, and the loser
 * learns it lost rather than proceeding on a stale read. A read-then-write
 * would let both proceed.
 */
import pool from '../../db.js'
import type { Executor } from '../transaction.js'
import type { RekeyStage } from '../../modules/agents/rekey-stages.js'

export interface AgentRekeyRow {
  id: string
  agent_id: string
  initiated_by_user_id: string
  stage: RekeyStage
  old_delegate_address: string
  new_delegate_address: string
  residual_atomic: string
  residual_token_address: string | null
  residual_disposition: string | null
  carry_snapshot: CarrySnapshotEntry[] | null
  metered_at: string | null
  revoke_tx_hash: string | null
  revoked_at: string | null
  completed_at: string | null
  abandoned_reason: string | null
  created_at: string
}

/**
 * One frozen measurement per revoked delegation. An agent may hold several
 * budgets (per token, per recipient pin) and each carries its own remainder
 * and its own boundary — which is why this is a list and not a column set.
 */
export interface CarrySnapshotEntry {
  delegation_hash: string
  token_address: string
  recipient_address: string | null
  /** The granted per-period budget of the delegation being replaced. */
  budget_atomic: string
  period_seconds: number
  start_date: number
  expires_at: number
  /** What the enforcer said AFTER the revoke froze it. */
  remaining_atomic: string
  /** False means the read fell back; the carry refuses these (see rekey-carry). */
  from_chain: boolean
}

export const INSERT_REKEY_SQL = `INSERT INTO agent_rekeys
     (agent_id, initiated_by_user_id, old_delegate_address, new_delegate_address,
      residual_atomic, residual_token_address, residual_disposition)
   VALUES ($1, $2, LOWER($3), LOWER($4), $5, LOWER($6), $7)
   RETURNING *`

/**
 * Open a re-key. The partial unique index on the in-flight stages is what
 * makes "at most one re-key per agent" true rather than merely checked — a
 * second concurrent open raises a unique violation instead of racing.
 */
export async function openRekey(
  input: {
    agentId: string
    userId: string
    oldDelegateAddress: string
    newDelegateAddress: string
    residualAtomic: string
    residualTokenAddress: string | null
    residualDisposition: string | null
  },
  db: Executor = pool,
): Promise<AgentRekeyRow> {
  const result = await db.query<AgentRekeyRow>(INSERT_REKEY_SQL, [
    input.agentId,
    input.userId,
    input.oldDelegateAddress,
    input.newDelegateAddress,
    input.residualAtomic,
    input.residualTokenAddress,
    input.residualDisposition,
  ])
  return result.rows[0]
}

export const FIND_REKEY_SQL = `SELECT * FROM agent_rekeys WHERE id = $1 AND agent_id = $2`

/** Scoped by agent so a re-key id from another agent resolves to nothing. */
export async function findRekey(
  rekeyId: string,
  agentId: string,
  db: Executor = pool,
): Promise<AgentRekeyRow | null> {
  const result = await db.query<AgentRekeyRow>(FIND_REKEY_SQL, [rekeyId, agentId])
  return result.rows[0] ?? null
}

export const FIND_IN_FLIGHT_REKEY_SQL = `SELECT * FROM agent_rekeys
     WHERE agent_id = $1 AND stage IN ('preflight', 'revoked', 'metered', 'issued')`

export async function findInFlightRekey(
  agentId: string,
  db: Executor = pool,
): Promise<AgentRekeyRow | null> {
  const result = await db.query<AgentRekeyRow>(FIND_IN_FLIGHT_REKEY_SQL, [agentId])
  return result.rows[0] ?? null
}

export const MARK_REVOKED_SQL = `UPDATE agent_rekeys
       SET stage = 'revoked', revoke_tx_hash = $1, revoked_at = NOW(), updated_at = NOW()
     WHERE id = $2 AND agent_id = $3 AND stage = 'preflight'
     RETURNING *`

/** `preflight → revoked`. Null when the row was not in `preflight`. */
export async function markRevoked(
  rekeyId: string,
  agentId: string,
  txHash: string,
  db: Executor = pool,
): Promise<AgentRekeyRow | null> {
  const result = await db.query<AgentRekeyRow>(MARK_REVOKED_SQL, [txHash, rekeyId, agentId])
  return result.rows[0] ?? null
}

/**
 * `revoked → metered`, writing the frozen measurement.
 *
 * The `stage = 'revoked'` predicate is the ordering guard, and the
 * migration's `agent_rekeys_meter_after_revoke_check` is the same rule
 * expressed where no code path can route around it: a snapshot written
 * without a `revoked_at`, or with a `metered_at` before it, is rejected by
 * Postgres. Two independent statements of one invariant, deliberately.
 */
export const MARK_METERED_SQL = `UPDATE agent_rekeys
       SET stage = 'metered', carry_snapshot = $1::jsonb, metered_at = NOW(), updated_at = NOW()
     WHERE id = $2 AND agent_id = $3 AND stage = 'revoked'
     RETURNING *`

export async function markMetered(
  rekeyId: string,
  agentId: string,
  snapshot: CarrySnapshotEntry[],
  db: Executor = pool,
): Promise<AgentRekeyRow | null> {
  const result = await db.query<AgentRekeyRow>(MARK_METERED_SQL, [
    JSON.stringify(snapshot),
    rekeyId,
    agentId,
  ])
  return result.rows[0] ?? null
}

export const MARK_ISSUED_SQL = `UPDATE agent_rekeys
       SET stage = 'issued', updated_at = NOW()
     WHERE id = $1 AND agent_id = $2 AND stage = 'metered'
     RETURNING *`

export async function markIssued(
  rekeyId: string,
  agentId: string,
  db: Executor = pool,
): Promise<AgentRekeyRow | null> {
  const result = await db.query<AgentRekeyRow>(MARK_ISSUED_SQL, [rekeyId, agentId])
  return result.rows[0] ?? null
}

export const MARK_COMPLETED_SQL = `UPDATE agent_rekeys
       SET stage = 'completed', completed_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND agent_id = $2 AND stage = 'issued'
     RETURNING *`

export async function markCompleted(
  rekeyId: string,
  agentId: string,
  db: Executor = pool,
): Promise<AgentRekeyRow | null> {
  const result = await db.query<AgentRekeyRow>(MARK_COMPLETED_SQL, [rekeyId, agentId])
  return result.rows[0] ?? null
}

export const ABANDON_REKEY_SQL = `UPDATE agent_rekeys
       SET stage = 'abandoned', abandoned_reason = $1, updated_at = NOW()
     WHERE id = $2 AND agent_id = $3
       AND stage IN ('preflight', 'revoked', 'metered', 'issued')
     RETURNING *`

export async function abandonRekey(
  rekeyId: string,
  agentId: string,
  reason: string,
  db: Executor = pool,
): Promise<AgentRekeyRow | null> {
  const result = await db.query<AgentRekeyRow>(ABANDON_REKEY_SQL, [reason, rekeyId, agentId])
  return result.rows[0] ?? null
}

/**
 * Swap the agent's delegate address and API key in ONE statement (#1698 step
 * 4). Both halves of the credential set retire together — the epic's
 * decision, and #1681's finding A is what a partial rotation looks like: a
 * long-lived host still authenticating as the old agent.
 *
 * Predicated on the OLD delegate so a concurrent change loses rather than
 * silently overwriting.
 */
export const ROTATE_AGENT_CREDENTIALS_SQL = `UPDATE agents
       SET delegate_address = LOWER($1), api_key_hash = $2, api_key_prefix = $3, updated_at = NOW()
     WHERE id = $4 AND user_id = $5 AND LOWER(delegate_address) = LOWER($6)
     RETURNING id`

export async function rotateAgentCredentials(
  input: {
    agentId: string
    userId: string
    oldDelegateAddress: string
    newDelegateAddress: string
    apiKeyHash: string
    apiKeyPrefix: string
  },
  db: Executor = pool,
): Promise<boolean> {
  const result = await db.query<{ id: string }>(ROTATE_AGENT_CREDENTIALS_SQL, [
    input.newDelegateAddress,
    input.apiKeyHash,
    input.apiKeyPrefix,
    input.agentId,
    input.userId,
    input.oldDelegateAddress,
  ])
  return result.rows.length > 0
}

/**
 * Invalidate every UNEXECUTED intent quoted against the old payer (#1698 step
 * 5).
 *
 * Precise on both axes, and both matter:
 *
 * - `status = 'pending_signature'` — an intent that already went to the
 *   merchant is history, not authority. Expiring a `submitted` or
 *   `confirmed` row would rewrite a settled payment's record.
 * - `LOWER(delegate_address) = LOWER($2)` — the payer stamp, not the agent.
 *   Scoping by agent alone would also kill intents quoted against a payer
 *   that is not being retired, which on a multi-budget agent is a working
 *   payment cancelled for no reason.
 *
 * #1690's signer-side payer guard would refuse these anyway; the epic is
 * explicit that it is a backstop and this is the primary defence. Closing
 * the window here also keeps #1690's refusal message truthful — otherwise a
 * legitimate re-key surfaces as the stale-host diagnosis.
 */
export const INVALIDATE_OLD_PAYER_INTENTS_SQL = `UPDATE payment_intents
       SET status = 'expired', error_message = $3
     WHERE agent_id = $1
       AND LOWER(delegate_address) = LOWER($2)
       AND status = 'pending_signature'
     RETURNING id`

export const REKEY_INTENT_INVALIDATION_REASON =
  'Invalidated by an agent re-key: this intent was quoted against the previous delegate key. Re-quote with the new credentials.'

export async function invalidateOldPayerIntents(
  agentId: string,
  oldDelegateAddress: string,
  db: Executor = pool,
): Promise<string[]> {
  const result = await db.query<{ id: string }>(INVALIDATE_OLD_PAYER_INTENTS_SQL, [
    agentId,
    oldDelegateAddress,
    REKEY_INTENT_INVALIDATION_REASON,
  ])
  return result.rows.map((r) => r.id)
}
