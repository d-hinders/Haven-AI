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
import { withTransaction, type Executor } from '../transaction.js'
import type { RekeyStage } from '../../modules/agents/index.js'
import { lockOwnedAgentForRekeyDelegation } from './agents.js'

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

// ── Reads the re-key route needs, kept out of the route (#1698 review) ────
//
// `dep-lint`'s inline-SQL gauge is shrink-only and it was right to fire: an
// orchestration route is exactly where SQL accretes, and every statement left
// there is one the real-DB harness cannot reach without standing up Fastify.
// These live here so the route reads as a sequence of decisions.

export interface RekeyAgentRow {
  agent_id: string
  delegate_address: string | null
  chain_id: number
  treasury_address: string | null
  account_type: string | null
  execution_rail: string | null
  status: string
}

export const FIND_OWNED_REKEY_AGENT_SQL = `SELECT a.id AS agent_id, a.delegate_address, a.status, us.chain_id,
            us.safe_address AS treasury_address, us.account_type, us.execution_rail
     FROM agents a
     LEFT JOIN user_safes us ON us.id = a.safe_id
     WHERE a.id = $1 AND a.user_id = $2`

/** The agent joined to its account — owner-scoped, so another user's id misses. */
export async function findOwnedRekeyAgent(
  agentId: string,
  userId: string,
  db: Executor = pool,
): Promise<RekeyAgentRow | null> {
  const result = await db.query<RekeyAgentRow>(FIND_OWNED_REKEY_AGENT_SQL, [agentId, userId])
  return result.rows[0] ?? null
}

/**
 * Another LIVE agent of the same user already holding this delegate address.
 *
 * The uniqueness rule multi-agent rests on: a user may hold many agents, just
 * not two non-revoked ones sharing a delegate address (#1694,
 * `017_agent_connection_setups.ts`). Excludes the agent being re-keyed, whose
 * own row still carries the OLD address at this point.
 */
export const FIND_LIVE_AGENT_BY_DELEGATE_SQL = `SELECT id FROM agents
      WHERE user_id = $1 AND LOWER(delegate_address) = LOWER($2)
        AND status <> 'revoked' AND id <> $3`

export async function findLiveAgentByDelegate(
  userId: string,
  delegateAddress: string,
  excludingAgentId: string,
  db: Executor = pool,
): Promise<string | null> {
  const result = await db.query<{ id: string }>(FIND_LIVE_AGENT_BY_DELEGATE_SQL, [
    userId,
    delegateAddress,
    excludingAgentId,
  ])
  return result.rows[0]?.id ?? null
}

export interface DelegationTermsRow {
  token_address: string
  recipient_address: string | null
  budget_atomic: string
  period_seconds: number
  start_date: string
  expires_at: string
}

export const FIND_DELEGATION_TERMS_SQL = `SELECT token_address, recipient_address, budget_atomic, period_seconds,
            start_date, expires_at
       FROM agent_delegations WHERE agent_id = $1 AND delegation_hash = $2`

export async function findDelegationTerms(
  agentId: string,
  delegationHash: string,
  db: Executor = pool,
): Promise<DelegationTermsRow | null> {
  const result = await db.query<DelegationTermsRow>(FIND_DELEGATION_TERMS_SQL, [
    agentId,
    delegationHash,
  ])
  return result.rows[0] ?? null
}

export const NEXT_DELEGATION_VERSION_SQL = `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
       FROM agent_delegations
      WHERE agent_id = $1 AND token_address = LOWER($2)
        AND recipient_address IS NOT DISTINCT FROM LOWER($3)`

/** Fresh identity per replacement (#827/#813) — same rule as the grant route. */
export async function nextDelegationVersion(
  agentId: string,
  tokenAddress: string,
  recipientAddress: string | null,
  db: Executor = pool,
): Promise<number> {
  const result = await db.query<{ next_version: number }>(NEXT_DELEGATION_VERSION_SQL, [
    agentId,
    tokenAddress,
    recipientAddress,
  ])
  return result.rows[0].next_version
}

export const INSERT_REKEY_DELEGATION_SQL = `INSERT INTO agent_delegations (
         agent_id, chain_id, token_address, recipient_address, delegation_hash,
         delegation_json, version, status, budget_atomic, period_seconds,
         start_date, expires_at, rekey_id, carry_role
       ) VALUES ($1, $2, LOWER($3), $4, $5, $6, $7, 'pending', $8, $9, $10, $11, $12, $13)
       ON CONFLICT (delegation_hash) DO NOTHING`

export async function insertRekeyDelegation(
  row: {
    agentId: string
    userId: string
    chainId: number
    tokenAddress: string
    recipientAddress: string | null
    delegationHash: string
    delegationJson: string
    version: number
    budgetAtomic: string
    periodSeconds: number
    startDate: number
    expiresAt: number
    rekeyId: string
    carryRole: string
  },
  db: Executor = pool,
): Promise<boolean> {
  return withTransaction(db, async (tx) => {
    // Safe unlink locks this same agent row before orphaning it. Holding the
    // lock through the insert makes the race deterministic: either the
    // pending replacement exists and unlink refuses, or the unlinked agent
    // fails the delegation-rail eligibility check and no row is created.
    if (!(await lockOwnedAgentForRekeyDelegation(row.agentId, row.userId, tx))) return false
    await tx.query(INSERT_REKEY_DELEGATION_SQL, [
      row.agentId,
      row.chainId,
      row.tokenAddress,
      row.recipientAddress ? row.recipientAddress.toLowerCase() : null,
      row.delegationHash,
      row.delegationJson,
      row.version,
      row.budgetAtomic,
      row.periodSeconds,
      row.startDate,
      row.expiresAt,
      row.rekeyId,
      row.carryRole,
    ])
    return true
  })
}

export const LIST_PENDING_REKEY_DELEGATIONS_SQL = `SELECT id, delegation_hash, delegation_json FROM agent_delegations
        WHERE agent_id = $1 AND rekey_id = $2 AND status = 'pending'`

export async function listPendingRekeyDelegations(
  agentId: string,
  rekeyId: string,
  db: Executor = pool,
): Promise<Array<{ id: string; delegation_hash: string; delegation_json: string }>> {
  const result = await db.query<{ id: string; delegation_hash: string; delegation_json: string }>(
    LIST_PENDING_REKEY_DELEGATIONS_SQL,
    [agentId, rekeyId],
  )
  return result.rows
}

export const ACTIVATE_REKEY_DELEGATION_SQL = `UPDATE agent_delegations
          SET status = 'active', delegation_json = $1, updated_at = NOW()
        WHERE id = $2 AND status = 'pending'
        RETURNING id`

export async function activateRekeyDelegation(
  delegationId: string,
  signedDelegationJson: string,
  db: Executor = pool,
): Promise<boolean> {
  const result = await db.query<{ id: string }>(ACTIVATE_REKEY_DELEGATION_SQL, [signedDelegationJson, delegationId])
  return result.rows.length === 1
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

/**
 * Adopt an abandoned predecessor's frozen carry into a fresh re-key (#1868).
 *
 * The wedge this exists for: a re-key abandoned AFTER the revoke has already
 * retired the agent's delegations on-chain, so a fresh re-key finds nothing
 * to revoke and — before this — walked to `metered` with an EMPTY snapshot.
 * The abandoned row's measurement was taken after that on-chain revoke, per
 * the #1694 ordering, and the chain cannot have moved for a revoked
 * delegation since: the frozen remainder is still exactly true. Adopting it
 * is what lets "abandon, then start again with a fresh key" restore the
 * agent's authority with the period boundary intact, instead of forfeiting
 * the remainder and requiring a manual owner re-grant.
 *
 * ## The abandonment signal
 *
 * `p.stage = 'abandoned'` — the owner's explicit abandon call, never elapsed
 * time. A merely slow re-key is still in flight, still holds the
 * `idx_agent_rekeys_one_in_flight` slot, and is therefore structurally
 * unreachable here: a fresh re-key cannot even open while it lives, so
 * nothing can adopt out from under it. There is deliberately no
 * `NOW() - metered_at` anywhere in this predicate — a timeout that guessed
 * wrong on a live re-key would fail OPEN on a money path, where the wedge at
 * least failed closed.
 *
 * ## The timestamps are INHERITED, not re-stamped
 *
 * `metered_at` anchors every piece of the carry arithmetic to the period the
 * remainder was measured in (#1849). Stamping adoption time over it would
 * attribute the remainder to whatever period the owner's SECOND attempt fell
 * in — the exact defect #1849 closed, re-created through a side door. So the
 * row inherits the predecessor's `revoked_at`, `metered_at` and
 * `revoke_tx_hash` wholesale: they describe the one revoke that actually
 * happened on-chain, which this fresh row is the continuation of. The
 * inherited pair satisfies `agent_rekeys_meter_after_revoke_check` because
 * the predecessor's did.
 *
 * ## The over-grant guard
 *
 * Adoption is REFUSED when any delegation was granted to the agent after the
 * predecessor's revoke, other than the inert `pending` rows an abandoned
 * re-key's own issue step left behind (those can never activate — completion
 * requires stage `issued`, and `abandoned` is terminal). Without this, the
 * sequence "abandon at metered → owner manually re-grants → agent spends →
 * owner revokes → re-key again" would hand the agent the OLD remainder on
 * top of a full budget already spent in the same period. A refusal here
 * falls back to today's empty walk: authority stays lost until the owner
 * re-grants, which is the fail-closed direction.
 *
 * `stage = 'abandoned'` is also what keeps a COMPLETED re-key's snapshot out:
 * its carry was already issued and possibly spent, so adopting it would be
 * the same over-grant. And requiring `r.stage = 'preflight'` on the row being
 * advanced makes the whole thing idempotent — a second call finds `metered`
 * and matches nothing.
 */
export const ADOPT_ABANDONED_CARRY_SQL = `UPDATE agent_rekeys r
       SET stage = 'metered',
           carry_snapshot = p.carry_snapshot,
           metered_at = p.metered_at,
           revoked_at = p.revoked_at,
           revoke_tx_hash = p.revoke_tx_hash,
           updated_at = NOW()
      FROM (
        SELECT a.id, a.carry_snapshot, a.metered_at, a.revoked_at, a.revoke_tx_hash
          FROM agent_rekeys a
         WHERE a.agent_id = $2
           AND a.stage = 'abandoned'
           AND a.carry_snapshot IS NOT NULL
           AND jsonb_array_length(a.carry_snapshot) > 0
           AND NOT EXISTS (
             SELECT 1 FROM agent_delegations d
              WHERE d.agent_id = $2
                AND d.created_at > a.revoked_at
                AND NOT (d.status = 'pending' AND d.rekey_id IS NOT NULL)
           )
         ORDER BY a.metered_at DESC, a.created_at DESC
         LIMIT 1
      ) p
     WHERE r.id = $1 AND r.agent_id = $2 AND r.stage = 'preflight'
     RETURNING r.*, p.id AS inherited_from_rekey_id`

export async function adoptAbandonedCarry(
  rekeyId: string,
  agentId: string,
  db: Executor = pool,
): Promise<(AgentRekeyRow & { inherited_from_rekey_id: string }) | null> {
  const result = await db.query<AgentRekeyRow & { inherited_from_rekey_id: string }>(
    ADOPT_ABANDONED_CARRY_SQL,
    [rekeyId, agentId],
  )
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
 * Retire any grant still ACTIVE in a slot this re-key is about to fill.
 *
 * The ordinary grant path does the same thing (`routes/agent-delegations.ts`,
 * activate): a new grant marks the previous active one for its (token,
 * recipient) slot `replaced`. Re-key needs it too, and the `rekey_id`
 * exclusion is the part that is specific here — a carry and a steady grant
 * from THIS re-key share a slot by construction and must not retire each
 * other. Excluding the re-key's own rows says that precisely, where
 * "everything active before now" would say it by accident.
 *
 * In the normal flow this matches nothing: the revoke step already flipped
 * every prior grant to `revoked`. It matters for the grant an owner makes
 * between the revoke and the completion, which is otherwise left active
 * alongside the carried pair in the same slot.
 */
export const REPLACE_SUPERSEDED_SIBLINGS_SQL = `UPDATE agent_delegations
       SET status = 'replaced', updated_at = NOW()
     WHERE agent_id = $1
       AND status = 'active'
       AND (rekey_id IS NULL OR rekey_id <> $2)
       AND (token_address, COALESCE(recipient_address, '')) IN (
         SELECT token_address, COALESCE(recipient_address, '')
           FROM agent_delegations
          WHERE agent_id = $1 AND rekey_id = $2
       )
     RETURNING delegation_hash`

export async function replaceSupersededSiblings(
  agentId: string,
  rekeyId: string,
  db: Executor = pool,
): Promise<string[]> {
  const result = await db.query<{ delegation_hash: string }>(REPLACE_SUPERSEDED_SIBLINGS_SQL, [
    agentId,
    rekeyId,
  ])
  return result.rows.map((r) => r.delegation_hash)
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

/**
 * The completion, as ONE transaction (#1698 steps 4 + 5).
 *
 * Lives here rather than in the route for the reason the whole re-key exists:
 * these five writes are only correct together. Half of them applied means an
 * agent whose delegate address moved but whose replacement grants are still
 * `pending`, or whose old API key still authenticates against a new delegate
 * — the two-live-credentials shapes this epic is made of. Either all of it
 * commits or none of it does, and the route should not be able to express
 * anything else.
 *
 * Throws on any inconsistency it finds, so the caller reports a failure
 * rather than a partial success. On a throw nothing survives: the delegations
 * stay `pending`, the credentials stay as they were, and the re-key stays at
 * `issued` — so the owner retries with the signatures already in hand.
 */
export async function completeRekey(
  input: {
    agentId: string
    userId: string
    rekeyId: string
    oldDelegateAddress: string
    newDelegateAddress: string
    apiKeyHash: string
    apiKeyPrefix: string
    /** The signed delegation JSON to activate, by row id. */
    signedDelegations: Array<{ id: string; delegationJson: string }>
  },
  db: Executor = pool,
): Promise<{ superseded: string[]; invalidatedIntents: string[] }> {
  return withTransaction(db, async (tx) => {
    if (!(await lockOwnedAgentForRekeyDelegation(input.agentId, input.userId, tx))) {
      throw new Error('re-key agent is no longer linked to a delegation account')
    }

    // Retire any grant still ACTIVE in a slot this re-key is about to fill,
    // excluding this re-key's OWN rows — a carry and its steady partner share
    // a slot by construction and must not retire each other (#1698 review).
    const superseded = await replaceSupersededSiblings(input.agentId, input.rekeyId, tx)

    for (const row of input.signedDelegations) {
      if (!(await activateRekeyDelegation(row.id, row.delegationJson, tx))) {
        throw new Error('replacement delegation is no longer pending')
      }
    }

    // Both halves of the credential set retire together (#1694): the delegate
    // key and the API key, in one statement, inside the same transaction as
    // the grants that replace them. A stale API key is its own hazard
    // (#1681's finding A) — rotating only one half is how the payer/signer
    // mismatch arose in the first place.
    const rotated = await rotateAgentCredentials(
      {
        agentId: input.agentId,
        userId: input.userId,
        oldDelegateAddress: input.oldDelegateAddress,
        newDelegateAddress: input.newDelegateAddress,
        apiKeyHash: input.apiKeyHash,
        apiKeyPrefix: input.apiKeyPrefix,
      },
      tx,
    )
    if (!rotated) throw new Error('delegate address changed underneath the re-key')

    // In-flight intents quoted against the OLD payer die here, in the same
    // transaction as the rotation. #1690's signer guard is a backstop.
    const invalidatedIntents = await invalidateOldPayerIntents(
      input.agentId,
      input.oldDelegateAddress,
      tx,
    )

    const completed = await markCompleted(input.rekeyId, input.agentId, tx)
    if (!completed) throw new Error('rekey stage moved underneath the completion')

    return { superseded, invalidatedIntents }
  })
}

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
