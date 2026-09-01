/**
 * Data access for the agents aggregate (#988, epic #980 M3).
 *
 * Extracted verbatim from `routes/agents.ts` (27 `.query` call sites) so
 * `scripts/db-schema-smoke.ts` can PREPARE every statement against the real
 * schema — the #757 failure class. Convention: `README.md` in this directory.
 *
 * Invariant a reader must not break — the #1069 status-scoping asymmetry:
 *
 * - The LIST and SINGLE reads carry NO status filter. `pending_approval`
 *   agents are deliberately SURFACED (an abandoned connect setup used to leave
 *   the user with "Agents 0" and no route back — #1069). The function names
 *   say so: `...AllStatuses`.
 * - The DELEGATE-BALANCE read is status-agnostic too since #1403: the old
 *   `ExcludingRevoked` filter removed the sweep page exactly when stranded
 *   delegate funds need recovering (post-revoke). It stays a separate, narrow
 *   projection (delegate + chain only) — do not collapse it into the full
 *   reads, but do not re-add a status filter either.
 *
 * **The SQL here is verbatim from the route.** Anything that looked improvable
 * was left alone and reported in the pull request instead.
 */

import pool from '../../db.js'
import { DEFAULT_CHAIN_ID } from '@haven_ai/core'
import { withTransaction, type Executor } from '../transaction.js'

export type { Executor }

// ── Row shapes ───────────────────────────────────────────────────────────────

export interface AgentRow {
  id: string
  name: string
  description: string | null
  delegate_address: string | null
  safe_id: string | null
  safe_address: string | null
  safe_name: string | null
  safe_chain_id: number | null
  account_type: string | null
  api_key_prefix: string | null
  status: string
  created_at: string
  archived_at: string | null
  mcp_last_seen_at: string | null
  /**
   * #1878: the MCP server name the connector reported for this agent
   * (`haven`, or `haven-<slug>`). NULL means never reported — an agent that
   * predates #1878 or a connector older than it — and must render as unknown
   * rather than being guessed at as the bare pair.
   */
  mcp_server_name: string | null
  has_stranded_funds: boolean
}

export interface AgentAllowanceRow {
  id: string
  agent_id: string
  token_address: string
  token_symbol: string
  allowance_amount: string
  reset_period_min: number
}

export interface SafeInfoRow {
  safe_address: string | null
  safe_name: string | null
  safe_chain_id: number | null
}

export interface DelegateAgentRow {
  delegate_address: string | null
  safe_chain_id: number | null
  safe_address: string | null
}

export interface AgentIdStatusRow {
  id: string
  status: string
}

/** Owner-scoped delegation lifecycle account read (#2025). */
export interface DelegationAgentRow {
  agent_id: string
  status: string
  delegate_address: string | null
  chain_id: number
  treasury_address: string | null
  account_type: string | null
}

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * Includes revoked agents deliberately: owner-facing reads and revocation must
 * remain available after credential revocation. Grant routes decide whether the
 * returned lifecycle status may receive a new budget.
 */
export async function loadOwnedDelegationAgent(
  agentId: string,
  userId: string,
  db: Executor = pool,
): Promise<DelegationAgentRow | null> {
  const result = await db.query<DelegationAgentRow>(
    `SELECT a.id AS agent_id, a.status, a.delegate_address, us.chain_id,
            us.safe_address AS treasury_address, us.account_type
     FROM agents a
     LEFT JOIN user_safes us ON us.id = a.safe_id
     WHERE a.id = $1 AND a.user_id = $2`,
    [agentId, userId],
  )
  return result.rows[0] ?? null
}

/**
 * Serializes an activation with agent credential revocation (#2025). The
 * caller supplies its transaction executor, so the row lock lasts through the
 * delegation status write rather than just this read.
 */
export async function lockOwnedNonRevokedDelegationAgent(
  agentId: string,
  userId: string,
  db: Executor,
): Promise<boolean> {
  const result = await db.query(
    `SELECT id FROM agents
     WHERE id = $1 AND user_id = $2 AND status <> 'revoked'
     FOR UPDATE`,
    [agentId, userId],
  )
  return result.rowCount !== 0
}

export interface PendingDelegationInsert {
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
}

/**
 * Locks the lifecycle row and inserts the pending grant in the same
 * transaction, so a credential revoke cannot commit between eligibility and
 * the fresh delegation record (#2025).
 */
export async function insertPendingDelegationForOwnedNonRevokedAgent(
  input: PendingDelegationInsert,
  db: Executor = pool,
): Promise<boolean> {
  return withTransaction(db, async (tx) => {
    if (!(await lockOwnedNonRevokedDelegationAgent(input.agentId, input.userId, tx))) return false
    await tx.query(
      `INSERT INTO agent_delegations (
         agent_id, chain_id, token_address, recipient_address, delegation_hash,
         delegation_json, version, status, budget_atomic, period_seconds,
         start_date, expires_at
       ) VALUES ($1, $2, LOWER($3), $4, $5, $6, $7, 'pending', $8, $9, $10, $11)
       ON CONFLICT (delegation_hash) DO NOTHING`,
      [
        input.agentId, input.chainId, input.tokenAddress, input.recipientAddress,
        input.delegationHash, input.delegationJson, input.version, input.budgetAtomic,
        input.periodSeconds, input.startDate, input.expiresAt,
      ],
    )
    return true
  })
}

/**
 * The list read: NO status filter (#1069 — pending_approval agents included).
 */
export const LIST_AGENTS_FOR_USER_ALL_STATUSES_SQL = `SELECT a.id, a.name, a.description, a.delegate_address,
              a.safe_id, us.safe_address, us.name as safe_name, us.chain_id AS safe_chain_id,
              us.account_type,
              a.api_key_prefix, a.status, a.created_at, a.archived_at, a.mcp_server_name,
              (SELECT MAX(ati.created_at) FROM agent_tool_invocations ati WHERE ati.agent_id = a.id) AS mcp_last_seen_at,
              EXISTS(
                SELECT 1 FROM machine_payment_reconciliation_events mpre
                JOIN payment_intents pi ON pi.id = mpre.payment_intent_id
                WHERE pi.agent_id = a.id
                  AND mpre.event_type = 'merchant_retry_rejected_after_payment'
                  AND mpre.status = 'open'
              ) AS has_stranded_funds
       FROM agents a
       LEFT JOIN user_safes us ON a.safe_id = us.id
       WHERE a.user_id = $1
       ORDER BY a.created_at DESC`

/**
 * The single read: NO status filter, same as the list (#1069).
 */
export const FIND_AGENT_FOR_USER_ALL_STATUSES_SQL = `SELECT a.id, a.name, a.description, a.delegate_address,
              a.safe_id, us.safe_address, us.name as safe_name, us.chain_id AS safe_chain_id,
              us.account_type,
              a.api_key_prefix, a.status, a.created_at, a.archived_at, a.mcp_server_name,
              (SELECT MAX(ati.created_at) FROM agent_tool_invocations ati WHERE ati.agent_id = a.id) AS mcp_last_seen_at,
              EXISTS(
                SELECT 1 FROM machine_payment_reconciliation_events mpre
                JOIN payment_intents pi ON pi.id = mpre.payment_intent_id
                WHERE pi.agent_id = a.id
                  AND mpre.event_type = 'merchant_retry_rejected_after_payment'
                  AND mpre.status = 'open'
              ) AS has_stranded_funds
       FROM agents a
       LEFT JOIN user_safes us ON a.safe_id = us.id
       WHERE a.user_id = $1 AND a.id = $2
       LIMIT 1`

/**
 * #1403 retired the old status filter (`a.status != 'revoked'`): this is an
 * owner-scoped read of a PUBLIC on-chain balance, and the exact sequence that
 * strands funds on the delegate EOA — agent misbehaving mid-x402, user
 * revokes it — is the sequence that needs the read to keep working. The old
 * exclusion made sweep reachable only while the agent was healthy, which is
 * when nobody needs it.
 */
export const FIND_DELEGATE_AGENT_FOR_USER_SQL = `SELECT a.delegate_address, us.chain_id AS safe_chain_id, us.safe_address, us.account_type
       FROM agents a
       LEFT JOIN user_safes us ON a.safe_id = us.id
       WHERE a.user_id = $1 AND a.id = $2
       LIMIT 1`

// #2020: the `agent_allowances` read surface is retired. The four LIST_* SQL
// constants that stood here (list/agent/unordered/config projections) died
// with their callers — GET /agents, GET /agents/:id, PUT /agents/:id and
// GET /machine-payments/allowances all serve the delegation-derived view or
// the 410 retirement answer now, so nothing reads the table. The table itself
// is dropped by #1990's follow-through once #2055 lands too.

export const FIND_AGENT_DELEGATE_ADDRESS_SQL = `SELECT delegate_address FROM agents WHERE id = $1`

export const FIND_USER_SAFE_ID_FOR_USER_SQL = 'SELECT id FROM user_safes WHERE id = $1 AND user_id = $2'

export const FIND_DEFAULT_USER_SAFE_ID_SQL = 'SELECT id FROM user_safes WHERE user_id = $1 AND is_default = true LIMIT 1'

export const FIND_NON_REVOKED_AGENT_BY_DELEGATE_SQL = 'SELECT id FROM agents WHERE user_id = $1 AND delegate_address = $2 AND status != $3'

export const FIND_AGENT_ID_FOR_USER_SQL = 'SELECT id FROM agents WHERE id = $1 AND user_id = $2'

export const FIND_AGENT_ID_STATUS_FOR_USER_SQL = 'SELECT id, status FROM agents WHERE id = $1 AND user_id = $2'

/**
 * The activity feed's agent-name map (moved from `routes/agent-activity.ts`,
 * #1167). ALL statuses — a revoked agent's past payments still need a name to
 * render against, so filtering here would relabel history "Unknown".
 *
 * Note there is no `user_safes` JOIN: this is a plain `agents` projection, so
 * it does not fall under the contract `agents.test.ts` pins on the joined
 * statements in this file (#999).
 */
export const LIST_AGENT_NAMES_FOR_USER_SQL = 'SELECT id, name FROM agents WHERE user_id = $1'

export interface AgentNameRow {
  id: string
  name: string
}

/** `userId` is REQUIRED — tenant scope for the feed's agent set. */
export async function listAgentNamesForUser(
  userId: string,
  db: Executor = pool,
): Promise<AgentNameRow[]> {
  const result = await db.query<AgentNameRow>(LIST_AGENT_NAMES_FOR_USER_SQL, [userId])
  return result.rows
}

/** `userId` is REQUIRED — tenant scope for the dashboard agent list. */
export async function listAgentsForUserAllStatuses(
  userId: string,
  db: Executor = pool,
): Promise<AgentRow[]> {
  const result = await db.query<AgentRow>(LIST_AGENTS_FOR_USER_ALL_STATUSES_SQL, [userId])
  return result.rows
}

/** `userId` is REQUIRED — tenant scope for the single-agent read. */
export async function findAgentForUserAllStatuses(
  agentId: string,
  userId: string,
  db: Executor = pool,
): Promise<AgentRow | null> {
  const result = await db.query<AgentRow>(FIND_AGENT_FOR_USER_ALL_STATUSES_SQL, [userId, agentId])
  return result.rows[0] ?? null
}

/** `userId` is REQUIRED. Status-agnostic since #1403 — see the SQL's note. */
export async function findDelegateAgentForUser(
  agentId: string,
  userId: string,
  db: Executor = pool,
): Promise<DelegateAgentRow | null> {
  const result = await db.query<DelegateAgentRow>(FIND_DELEGATE_AGENT_FOR_USER_SQL, [
    userId,
    agentId,
  ])
  return result.rows[0] ?? null
}


// #1987 (epic #1440): `FIND_TOKEN_ALLOWANCE_AMOUNT_SQL` and
// `hasTokenAllowanceConfigured` are gone with the AllowanceModule rail.
// #2020 finished the job: `LIST_ALLOWANCE_CONFIG_FOR_AGENT_SQL` /
// `listAllowanceConfigForAgent` — kept by #1987 because #1986 left
// `GET /machine-payments/allowances` readable — are gone too, on the recorded
// owner reversal (2026-08-25, on #2020): that endpoint now serves the
// delegation-derived view and answers 410 on the legacy rail.

/** The agent's delegate EOA, or null (#716 residue reconciliation read). */
export async function findAgentDelegateAddress(
  agentId: string,
  db: Executor = pool,
): Promise<string | null> {
  const result = await db.query<{ delegate_address: string | null }>(
    FIND_AGENT_DELEGATE_ADDRESS_SQL,
    [agentId],
  )
  return result.rows[0]?.delegate_address ?? null
}

/** `userId` is REQUIRED — validates the Safe belongs to the caller. */
export async function findUserSafeIdForUser(
  safeId: string,
  userId: string,
  db: Executor = pool,
): Promise<string | null> {
  const result = await db.query<{ id: string }>(FIND_USER_SAFE_ID_FOR_USER_SQL, [safeId, userId])
  return result.rows[0]?.id ?? null
}

export async function findDefaultUserSafeId(
  userId: string,
  db: Executor = pool,
): Promise<string | null> {
  const result = await db.query<{ id: string }>(FIND_DEFAULT_USER_SAFE_ID_SQL, [userId])
  return result.rows[0]?.id ?? null
}

/** `delegateAddress` must already be lowercased by the caller (verbatim move). */
export async function findNonRevokedAgentIdByDelegate(
  userId: string,
  delegateAddress: string,
  db: Executor = pool,
): Promise<string | null> {
  const result = await db.query<{ id: string }>(FIND_NON_REVOKED_AGENT_BY_DELEGATE_SQL, [
    userId,
    delegateAddress,
    'revoked',
  ])
  return result.rows[0]?.id ?? null
}

export async function agentExistsForUser(
  agentId: string,
  userId: string,
  db: Executor = pool,
): Promise<boolean> {
  const result = await db.query<{ id: string }>(FIND_AGENT_ID_FOR_USER_SQL, [agentId, userId])
  return result.rows.length > 0
}

export async function findAgentIdStatusForUser(
  agentId: string,
  userId: string,
  db: Executor = pool,
): Promise<AgentIdStatusRow | null> {
  const result = await db.query<AgentIdStatusRow>(FIND_AGENT_ID_STATUS_FOR_USER_SQL, [
    agentId,
    userId,
  ])
  return result.rows[0] ?? null
}

// ── Writes ───────────────────────────────────────────────────────────────────

export const INSERT_AGENT_WITH_KEY_SQL = `INSERT INTO agents (user_id, name, description, delegate_address, api_key_hash, api_key_prefix, safe_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, name, description, delegate_address, safe_id, api_key_prefix, status, created_at,
                   NULL::timestamptz AS mcp_last_seen_at,
                   -- #1878: an agent created straight through the API was never
                   -- wired by the connector, so it has no MCP server name. NULL
                   -- here is the honest answer, not a placeholder.
                   NULL::text AS mcp_server_name`

export const FIND_SAFE_INFO_SQL = `SELECT safe_address, name AS safe_name, chain_id AS safe_chain_id
             FROM user_safes WHERE id = $1`

export interface NewAgent {
  userId: string
  name: string
  description: string | null
  delegateAddress: string
  apiKeyHash: string
  apiKeyPrefix: string
  safeId: string | null
}

export interface CreatedAgent {
  agent: Pick<
    AgentRow,
    | 'id'
    | 'name'
    | 'description'
    | 'delegate_address'
    | 'safe_id'
    | 'api_key_prefix'
    | 'status'
    | 'created_at'
    | 'mcp_last_seen_at'
    // #1878: always NULL here — an agent created straight through the API was
    // never wired by the connector. Declared anyway, because the query DOES
    // return it and `tx.query<T>()`'s generic is a compile-time assertion
    // only: a Pick that omits it lets a future refactor rebuild this response
    // field-by-field and drop the column with neither tsc nor a test noticing.
    | 'mcp_server_name'
  >
  safeInfo: SafeInfoRow
}

/**
 * Insert the agent and read its Safe info as ONE unit. #2020 removed the
 * allowance-mirror inserts that used to ride in this transaction — the
 * `agent_allowances` write surface is retired with the Safe rail; an agent's
 * spend authority on the delegation rail is granted as a delegation, never as
 * a row here. A unique-delegate violation (23505 on
 * `idx_agents_user_delegate_non_revoked_unique`) rolls back and rethrows for
 * the route to map to its 409.
 */
export async function createAgent(
  input: NewAgent,
  db: Executor = pool,
): Promise<CreatedAgent> {
  return withTransaction(db, async (tx) => {
    const agentResult = await tx.query<CreatedAgent['agent']>(INSERT_AGENT_WITH_KEY_SQL, [
      input.userId,
      input.name,
      input.description,
      input.delegateAddress,
      input.apiKeyHash,
      input.apiKeyPrefix,
      input.safeId,
    ])
    const agent = agentResult.rows[0]
    const safeInfoResult = input.safeId
      ? await tx.query<SafeInfoRow>(FIND_SAFE_INFO_SQL, [input.safeId])
      : null
    const safeInfo = safeInfoResult?.rows[0] ?? {
      safe_address: null,
      safe_name: null,
      safe_chain_id: null,
    }

    return { agent, safeInfo }
  })
}

export const UPDATE_AGENT_PROFILE_SQL = `WITH updated AS (
           UPDATE agents
           SET name        = COALESCE($3, name),
               description = COALESCE($4, description),
               updated_at  = NOW()
           WHERE id = $1 AND user_id = $2
           RETURNING id, name, description, delegate_address, safe_id, api_key_prefix, status, created_at,
                     mcp_server_name
         )
         SELECT updated.id, updated.name, updated.description, updated.delegate_address,
                updated.safe_id, us.safe_address, us.name AS safe_name, us.chain_id AS safe_chain_id,
                us.account_type,
                updated.api_key_prefix, updated.status, updated.created_at,
                -- #1878/#1694: the display name is editable, the wiring name is
                -- not. This UPDATE never touches mcp_server_name; reading it
                -- back keeps the renamed agent's card showing the same pair.
                updated.mcp_server_name,
                (SELECT MAX(ati.created_at) FROM agent_tool_invocations ati WHERE ati.agent_id = updated.id) AS mcp_last_seen_at
         FROM updated
         LEFT JOIN user_safes us ON updated.safe_id = us.id`

/** `userId` is REQUIRED — the UPDATE is tenant-scoped in its WHERE clause. */
export async function updateAgentProfile(
  agentId: string,
  userId: string,
  name: string | null,
  description: string | null,
  db: Executor = pool,
): Promise<AgentRow | null> {
  const result = await db.query<AgentRow>(UPDATE_AGENT_PROFILE_SQL, [
    agentId,
    userId,
    name,
    description,
  ])
  return result.rows[0] ?? null
}

/**
 * #1401: archive replaces deletion. The row and every dependent audit row
 * stay; the agent just leaves the primary list. Requires `revoked` — archiving
 * is a filing action and must never be what stops spending. Idempotent
 * without timestamp churn: re-archiving keeps the ORIGINAL archived_at
 * (COALESCE keeps the first value; the WHERE still matches so the call
 * reports success).
 */
/**
 * #1436: archiving requires BOTH a revoked credential and dead budgets.
 *
 * `status = 'revoked'` alone was not enough. Revoking an agent only flips this
 * table's status — it never touches `agent_delegations` — so revoke+archive
 * through the API (no dashboard, no revoke-all) filed an agent under "Removed"
 * while its delegation stayed `active` and redeemable on-chain by whoever held
 * the delegate key. The Remove dialog's ordering (revoke-all first) made that
 * unreachable from the dashboard, but a safety property that lives only in
 * frontend orchestration is not enforced; "Removed" promises the agent cannot
 * spend, so the database is where that promise belongs.
 *
 * Legacy AllowanceModule agents have no rows here, so the NOT EXISTS passes
 * for them. Their Haven-side record may be unlinked at any status because
 * archiving it does not change the old Safe permission; the live delegation
 * rail remains revoke-first.
 * Crash-window orphans (#1423: disabled on-chain, still `active` here) DO
 * block archiving, correctly: revoke-all heals them, and that is the same
 * remedy this refusal names.
 */
export const ARCHIVE_AGENT_SQL = `UPDATE agents
       SET archived_at = COALESCE(archived_at, NOW()), updated_at = NOW()
       WHERE id = $1 AND user_id = $2
         AND (
           status = 'revoked'
           OR (
             status IN ('active', 'paused')
             AND EXISTS (
               SELECT 1 FROM user_safes us
               WHERE us.id = agents.safe_id AND us.account_type = 'safe'
             )
           )
         )
         AND NOT EXISTS (
           SELECT 1 FROM agent_delegations ad
           WHERE ad.agent_id = agents.id AND ad.status IN ('pending', 'active')
         )
       RETURNING id, archived_at`

/** True when the agent still holds budget authority that archiving must not hide. */
export const AGENT_HAS_LIVE_DELEGATIONS_SQL = `SELECT EXISTS (
         SELECT 1 FROM agent_delegations
         WHERE agent_id = $1 AND status IN ('pending', 'active')
       ) AS live`

export async function agentHasLiveDelegations(
  agentId: string,
  db: Executor = pool,
): Promise<boolean> {
  const result = await db.query<{ live: boolean }>(AGENT_HAS_LIVE_DELEGATIONS_SQL, [agentId])
  return result.rows[0]?.live === true
}

/** Returns null when nothing matched (missing, foreign, ineligible, or still holding live delegations). */
export async function archiveAgent(
  agentId: string,
  userId: string,
  db: Executor = pool,
): Promise<{ id: string; archived_at: Date } | null> {
  const result = await db.query<{ id: string; archived_at: Date }>(ARCHIVE_AGENT_SQL, [
    agentId,
    userId,
  ])
  return result.rows[0] ?? null
}

/**
 * Clears archived_at and nothing else — the agent returns to the primary
 * list still `revoked`. Un-archiving restores no authority of any kind.
 */
export const UNARCHIVE_AGENT_SQL = `UPDATE agents
       SET archived_at = NULL, updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND archived_at IS NOT NULL
       RETURNING id`

export async function unarchiveAgent(
  agentId: string,
  userId: string,
  db: Executor = pool,
): Promise<boolean> {
  const result = await db.query<{ id: string }>(UNARCHIVE_AGENT_SQL, [agentId, userId])
  return result.rows.length > 0
}

export const REVOKE_AGENT_SQL = `UPDATE agents SET status = 'revoked', updated_at = NOW()
         WHERE id = $1 AND user_id = $2 AND status IN ('active', 'paused')
         RETURNING id`

export async function revokeAgent(
  agentId: string,
  userId: string,
  db: Executor = pool,
): Promise<boolean> {
  const result = await db.query<{ id: string }>(REVOKE_AGENT_SQL, [agentId, userId])
  return result.rows.length > 0
}

export const ROTATE_AGENT_API_KEY_SQL = `UPDATE agents SET api_key_hash = $1, api_key_prefix = $2, updated_at = NOW()
         WHERE id = $3 AND user_id = $4 AND status = 'active'
         RETURNING id`

export async function rotateAgentApiKey(
  apiKeyHash: string,
  apiKeyPrefix: string,
  agentId: string,
  userId: string,
  db: Executor = pool,
): Promise<boolean> {
  const result = await db.query<{ id: string }>(ROTATE_AGENT_API_KEY_SQL, [
    apiKeyHash,
    apiKeyPrefix,
    agentId,
    userId,
  ])
  return result.rows.length > 0
}

export const PAUSE_AGENT_SQL = `UPDATE agents SET status = 'paused', updated_at = NOW()
         WHERE id = $1 AND user_id = $2 AND status = 'active'
         RETURNING id`

export async function pauseAgent(
  agentId: string,
  userId: string,
  db: Executor = pool,
): Promise<boolean> {
  const result = await db.query<{ id: string }>(PAUSE_AGENT_SQL, [agentId, userId])
  return result.rows.length > 0
}

export const RESUME_AGENT_SQL = `UPDATE agents SET status = 'active', updated_at = NOW()
         WHERE id = $1 AND user_id = $2 AND status = 'paused'
         RETURNING id`

export async function resumeAgent(
  agentId: string,
  userId: string,
  db: Executor = pool,
): Promise<boolean> {
  const result = await db.query<{ id: string }>(RESUME_AGENT_SQL, [agentId, userId])
  return result.rows.length > 0
}

// #2020: `UPSERT_AGENT_ALLOWANCE_SQL` / `DELETE_AGENT_ALLOWANCE_SQL` and their
// functions are gone — the PUT/DELETE allowance routes they backed are 410
// tombstones now; per-token spend authority is a delegation grant on the
// delegation rail, never a mirror row.

// ── Agent authentication (moved from middleware/agentAuth.ts, #999) ─────────

/**
 * The agent-authentication lookup — every authenticated agent request runs
 * this. Exported so `scripts/db-schema-smoke.ts` can PREPARE the REAL query
 * rather than a pasted copy.
 *
 * `chain_id` falls back to the shared default when an agent has no linked
 * `user_safes` row. This value is not cosmetic: it becomes `agent.chain_id`,
 * which the machine-payment path uses for asset resolution, sweep-chain checks
 * and inserts (#990).
 */
export const AGENT_BY_API_KEY_SQL = `
  SELECT a.id, a.user_id, a.name, a.delegate_address,
         a.status,
         COALESCE(us.safe_address, u.safe_address) as safe_address,
         COALESCE(us.chain_id, ${DEFAULT_CHAIN_ID}) as chain_id,
         us.execution_rail, us.account_type
  FROM agents a
  JOIN users u ON a.user_id = u.id
  LEFT JOIN user_safes us ON a.safe_id = us.id
  WHERE a.api_key_hash = $1`

export interface AgentAuthRow {
  id: string
  user_id: string
  name: string
  delegate_address: string | null
  safe_address: string | null
  chain_id: number
  status: string
  execution_rail: string | null
  account_type: string | null
}

/**
 * Keyed by the API-key HASH — the caller hashes, this function never sees the
 * secret. The hash IS the tenant scope: it selects exactly one agent row.
 */
export async function findAgentAuthRowByApiKeyHash(
  apiKeyHash: string,
  db: Executor = pool,
): Promise<AgentAuthRow | null> {
  const result = await db.query<AgentAuthRow>(AGENT_BY_API_KEY_SQL, [apiKeyHash])
  return result.rows[0] ?? null
}

/**
 * How recently an agent must have been seen before the liveness write is
 * skipped (moved with `TOUCH_AGENT_LAST_SEEN_SQL`; re-exported by
 * `middleware/agentAuth.ts`).
 */
export const LAST_SEEN_THROTTLE_SECONDS = 10

export const TOUCH_AGENT_LAST_SEEN_SQL = `UPDATE agents
         SET last_seen_at = NOW()
       WHERE id = $1
         AND (last_seen_at IS NULL
              OR last_seen_at < NOW() - INTERVAL '${LAST_SEEN_THROTTLE_SECONDS} seconds')`

/**
 * Record agent liveness, throttled in SQL. Not tenant-scoped beyond the agent
 * id: the caller (agent auth middleware) has already authenticated the agent
 * whose id it passes.
 */
export async function touchAgentLastSeenRow(agentId: string, db: Executor = pool): Promise<void> {
  await db.query(TOUCH_AGENT_LAST_SEEN_SQL, [agentId])
}

// NOTE: the execution-rail resolution and delegate-monitor reads deliberately
// live elsewhere (`user-safes.ts`, `delegate-monitoring.ts`): a guard test
// pins every `user_safes` JOIN in THIS file to select `account_type`, because
// every query here feeds an agent API payload the dashboard branches on
// (#1069/#1071). Those two reads return no payload, so they don't belong
// under that pin.
