/**
 * Data access for `agent_passports` (#972, epic #970).
 *
 * First inhabitant of `infra/repositories/` — the home the module-boundary rules
 * already designate for SQL (`pg-only-in-infra`, see
 * `docs/architecture/10-module-boundaries.md` rule 3). The dependency gate
 * refused to let #972's new code reach the pool directly, which is the ratchet
 * working: existing debt stays baselined, new code complies.
 *
 * This adopts the convention #985 will generalise across the backend:
 *
 * - every function accepts an explicit `executor` LAST, so callers can compose
 *   within a transaction — but it DEFAULTS to the pool, because rule 3 says only this
 *   directory may import `db.ts`. Passing the pool in from a caller would have
 *   meant the caller importing it, which is the very thing the rule forbids;
 * - returns are domain-shaped, not raw `pg` rows;
 * - **tenant scoping is a required parameter, never defaulted.** A repository
 *   function callable without its scope is a privilege-escalation bug waiting
 *   for its first careless caller — see the ADR's "rules that are security
 *   properties, not style".
 */

import type { QueryResult, QueryResultRow } from 'pg'
import pool from '../../db.js'

/**
 * Anything that can run a query: the app's `db.ts` default export, a raw
 * `pg.Pool`, or a `PoolClient` inside a transaction.
 *
 * Structural rather than `Pool | PoolClient` because `db.ts` exports a thin
 * wrapper, not a `pg.Pool`. Typing the capability instead of the concrete class
 * is also what lets a caller pass a transaction client — the point of taking an
 * explicit executor in the first place.
 */
export interface Executor {
  query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>
}

export type PassportStatus = 'pending' | 'anchored' | 'failed'

/** Progress of the EAS ANCHOR only — never the authority on standing (#973). */
export type RevocationStatus = 'none' | 'pending' | 'confirmed'

export interface PassportRow {
  agent_id: string
  chain_id: number
  status: PassportStatus
  assurance_level: number
  attestation_uid: string | null
  tx_hash: string | null
  attempts: number
  last_error: string | null
  requested_at: Date
  anchored_at: Date | null
  revocation_status: RevocationStatus
  revocation_requested_at: Date | null
  revocation_confirmed_at: Date | null
  revocation_tx_hash: string | null
  revocation_attempts: number
  revocation_last_error: string | null
  revocation_next_attempt_at: Date | null
}

/** Facts the attestation claim is built from. Owner-scoped. */
export interface AgentPassportFacts {
  delegate_address: string | null
  chain_id: number | null
  /** The TREASURY the agent spends from — not the agent's own smart account. */
  safe_address: string | null
  account_type: string | null
  execution_rail: string | null
}

export async function findByAgent(agentId: string, db: Executor = pool): Promise<PassportRow | null> {
  const { rows } = await db.query<PassportRow>(
    `SELECT agent_id, chain_id, status, assurance_level, attestation_uid, tx_hash,
            attempts, last_error, requested_at, anchored_at,
            revocation_status, revocation_requested_at, revocation_confirmed_at,
            revocation_tx_hash, revocation_attempts, revocation_last_error,
            revocation_next_attempt_at
       FROM agent_passports WHERE agent_id = $1`,
    [agentId],
  )
  return rows[0] ?? null
}

/**
 * Agent facts for issuance. `userId` is REQUIRED — this is the tenant scope,
 * and an unscoped variant of this query must never exist.
 */
export async function findAgentFacts(
  agentId: string,
  userId: string,
  db: Executor = pool,
): Promise<AgentPassportFacts | null> {
  const { rows } = await db.query<AgentPassportFacts>(
    `SELECT a.delegate_address, s.chain_id, s.safe_address, s.account_type, s.execution_rail
       FROM agents a
       LEFT JOIN user_safes s ON s.id = a.safe_id
      WHERE a.id = $1 AND a.user_id = $2`,
    [agentId, userId],
  )
  return rows[0] ?? null
}

/**
 * Atomically claim the right to anchor. Returns true for exactly ONE caller.
 *
 * `ON CONFLICT DO NOTHING` on insert prevents a second passport ROW, but not a
 * second on-chain ATTESTATION — anchoring takes seconds (staticCall + attest +
 * wait), and a plain read-then-branch lets two callers both observe 'pending'
 * and both submit. The relayer would pay twice and we could track only one UID,
 * leaving a real, revocable attestation permanently invisible to Haven.
 *
 * A claim older than the stale window is reclaimable so a crashed attempt
 * recovers instead of wedging the passport forever.
 */
export async function claimForAnchoring(
  agentId: string,
  staleAfterSeconds = 600,
  db: Executor = pool,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE agent_passports
        SET anchoring_started_at = NOW(), attempts = attempts + 1, updated_at = NOW()
      WHERE agent_id = $1
        AND status <> 'anchored'
        AND (anchoring_started_at IS NULL
             OR anchoring_started_at < NOW() - MAKE_INTERVAL(secs => $2))`,
    [agentId, staleAfterSeconds],
  )
  return (rowCount ?? 0) > 0
}

/** The agent's bound chain, owner-scoped. Null row = not this user's agent. */
export async function findAgentChain(
  agentId: string,
  userId: string,
  db: Executor = pool,
): Promise<{ chain_id: number | null } | null> {
  const { rows } = await db.query<{ chain_id: number | null }>(
    `SELECT s.chain_id
       FROM agents a
       LEFT JOIN user_safes s ON s.id = a.safe_id
      WHERE a.id = $1 AND a.user_id = $2`,
    [agentId, userId],
  )
  return rows[0] ?? null
}

/** Record the intent. Returns false when a passport already exists (idempotent). */
export async function insertRequested(
  agentId: string,
  chainId: number,
  assuranceLevel: number,
  db: Executor = pool,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO agent_passports (agent_id, chain_id, status, assurance_level)
     VALUES ($1, $2, 'pending', $3)
     ON CONFLICT (agent_id) DO NOTHING`,
    [agentId, chainId, assuranceLevel],
  )
  return (rowCount ?? 0) > 0
}

export async function markAnchored(
  agentId: string,
  attestationUid: string,
  txHash: string,
  db: Executor = pool,
): Promise<void> {
  await db.query(
    `UPDATE agent_passports
        SET status = 'anchored', attestation_uid = $2, tx_hash = $3,
            last_error = NULL, anchored_at = NOW(), updated_at = NOW()
      WHERE agent_id = $1`,
    [agentId, attestationUid, txHash],
  )
}

export async function markFailed(agentId: string, error: string, db: Executor = pool): Promise<void> {
  // Truncated: a provider error can be enormous and this column is for humans.
  // `attempts` is incremented by claimForAnchoring, not here — otherwise a
  // pre-claim failure (no treasury, unregistered schema) would double-count.
  // Clearing the claim makes the passport immediately retryable.
  await db.query(
    `UPDATE agent_passports
        SET status = 'failed', anchoring_started_at = NULL,
            last_error = $2, updated_at = NOW()
      WHERE agent_id = $1`,
    [agentId, error.slice(0, 500)],
  )
}

/** Non-anchored passports with their owning user, oldest first — the retry sweep. */
export async function listRetryable(
  limit: number,
  db: Executor = pool,
): Promise<Array<{ agent_id: string; user_id: string }>> {
  const { rows } = await db.query<{ agent_id: string; user_id: string }>(
    `SELECT p.agent_id, a.user_id
       FROM agent_passports p
       JOIN agents a ON a.id = p.agent_id
      WHERE p.status <> 'anchored'
      ORDER BY p.requested_at ASC
      LIMIT $1`,
    [limit],
  )
  return rows
}


// ── Revocation (#973) ───────────────────────────────────────────────
//
// The DB is authoritative for standing; these functions track only how far the
// on-chain ANCHOR has got. Nothing here may gate the answer to "is this agent
// authorized right now?" — see `standingForAgent`.

/**
 * Agent standing, joined with anchor progress. The ONE query the verifier
 * (#974) reads, so the authority relationship is expressed in a single place:
 * `agent_status` decides, the passport columns merely describe the anchor.
 *
 * Deliberately NOT owner-scoped: a merchant verifying a passport is not the
 * agent's owner. It is keyed by the agent's own id and returns no PII, no
 * credentials, and no treasury detail — only what a verifier needs.
 */
export interface AgentStanding {
  agent_id: string
  agent_status: string
  passport_status: PassportStatus | null
  attestation_uid: string | null
  revocation_status: RevocationStatus | null
  revocation_confirmed_at: Date | null
}

export async function standingForAgent(
  agentId: string,
  db: Executor = pool,
): Promise<AgentStanding | null> {
  const { rows } = await db.query<AgentStanding>(
    `SELECT a.id AS agent_id, a.status AS agent_status,
            p.status AS passport_status, p.attestation_uid,
            p.revocation_status, p.revocation_confirmed_at
       FROM agents a
       LEFT JOIN agent_passports p ON p.agent_id = a.id
      WHERE a.id = $1`,
    [agentId],
  )
  return rows[0] ?? null
}

/**
 * Mark the anchor as needing revocation. Idempotent, and deliberately a no-op
 * unless the passport is actually anchored — there is nothing on-chain to
 * revoke otherwise, and inventing a pending revocation would make the
 * reconciliation sweep chase a row forever.
 */
export async function enqueueRevocation(agentId: string, db: Executor = pool): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE agent_passports
        SET revocation_status = 'pending',
            revocation_requested_at = COALESCE(revocation_requested_at, NOW()),
            revocation_next_attempt_at = NOW(),
            updated_at = NOW()
      WHERE agent_id = $1
        AND status = 'anchored'
        AND revocation_status = 'none'`,
    [agentId],
  )
  return (rowCount ?? 0) > 0
}

export async function markRevocationConfirmed(
  agentId: string,
  txHash: string,
  db: Executor = pool,
): Promise<void> {
  await db.query(
    `UPDATE agent_passports
        SET revocation_status = 'confirmed', revocation_tx_hash = $2,
            revocation_confirmed_at = NOW(), revocation_last_error = NULL,
            revocation_next_attempt_at = NULL, updated_at = NOW()
      WHERE agent_id = $1`,
    [agentId, txHash],
  )
}

/**
 * Record a failed anchor attempt and schedule the next one.
 *
 * Stays `pending` — never `failed`. The owner decision is that revocation
 * retries until the DB and chain agree, so there is no terminal failure state
 * to get stuck in; a struggling revoke stays visible and due instead.
 */
export async function scheduleRevocationRetry(
  agentId: string,
  error: string,
  backoffSeconds: number,
  db: Executor = pool,
): Promise<void> {
  await db.query(
    `UPDATE agent_passports
        SET revocation_attempts = revocation_attempts + 1,
            revocation_last_error = $2,
            revocation_next_attempt_at = NOW() + MAKE_INTERVAL(secs => $3),
            updated_at = NOW()
      WHERE agent_id = $1`,
    [agentId, error.slice(0, 500), backoffSeconds],
  )
}

/** Revocations due for another attempt. */
export async function listRevocationsDue(
  limit: number,
  db: Executor = pool,
): Promise<Array<{ agent_id: string; revocation_attempts: number }>> {
  const { rows } = await db.query<{ agent_id: string; revocation_attempts: number }>(
    `SELECT agent_id, revocation_attempts
       FROM agent_passports
      WHERE revocation_status = 'pending'
        AND (revocation_next_attempt_at IS NULL OR revocation_next_attempt_at <= NOW())
      ORDER BY revocation_requested_at ASC
      LIMIT $1`,
    [limit],
  )
  return rows
}

/**
 * Revocations unreconciled past a threshold — the stuck-revoke alarm.
 *
 * A revoked agent whose on-chain flag never flipped is an operational incident,
 * not a silent state. Merchants checking only the chain would still see it as
 * valid, which is precisely the divergence #973 exists to prevent.
 */
export async function listStuckRevocations(
  olderThanSeconds: number,
  db: Executor = pool,
): Promise<Array<{ agent_id: string; revocation_requested_at: Date; revocation_attempts: number; revocation_last_error: string | null }>> {
  const { rows } = await db.query<{
    agent_id: string
    revocation_requested_at: Date
    revocation_attempts: number
    revocation_last_error: string | null
  }>(
    `SELECT agent_id, revocation_requested_at, revocation_attempts, revocation_last_error
       FROM agent_passports
      WHERE revocation_status = 'pending'
        AND revocation_requested_at < NOW() - MAKE_INTERVAL(secs => $1)
      ORDER BY revocation_requested_at ASC`,
    [olderThanSeconds],
  )
  return rows
}
