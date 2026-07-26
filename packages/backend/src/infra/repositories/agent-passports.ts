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
            attempts, last_error, requested_at, anchored_at
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
