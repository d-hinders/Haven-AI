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

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * The list read: NO status filter (#1069 — pending_approval agents included).
 */
export const LIST_AGENTS_FOR_USER_ALL_STATUSES_SQL = `SELECT a.id, a.name, a.description, a.delegate_address,
              a.safe_id, us.safe_address, us.name as safe_name, us.chain_id AS safe_chain_id,
              us.account_type,
              a.api_key_prefix, a.status, a.created_at, a.archived_at,
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
              a.api_key_prefix, a.status, a.created_at, a.archived_at,
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

export const LIST_ALLOWANCES_FOR_AGENTS_SQL = `SELECT id, agent_id, token_address, token_symbol, allowance_amount, reset_period_min
       FROM agent_allowances WHERE agent_id = ANY($1) ORDER BY created_at ASC`

export const LIST_ALLOWANCES_FOR_AGENT_SQL = `SELECT id, agent_id, token_address, token_symbol, allowance_amount, reset_period_min
       FROM agent_allowances WHERE agent_id = $1 ORDER BY created_at ASC`

/**
 * The PUT-path allowance read. Unlike `LIST_ALLOWANCES_FOR_AGENT_SQL` it has
 * no ORDER BY — pre-existing divergence, preserved verbatim rather than tidied
 * (an extraction is behaviour-preserving; see the header).
 */
export const LIST_ALLOWANCES_FOR_AGENT_UNORDERED_SQL = `SELECT id, agent_id, token_address, token_symbol, allowance_amount, reset_period_min
         FROM agent_allowances WHERE agent_id = $1`

/**
 * The money-path policy gate (#995): does this agent carry an AllowanceModule
 * config row for the token? Session/legacy rails treat a missing row as "not
 * configured" (403); the delegation rail never consults it. The projection
 * (`allowance_amount`) is verbatim from the routes even though every caller
 * only checks existence.
 */
export const FIND_TOKEN_ALLOWANCE_AMOUNT_SQL = `SELECT allowance_amount FROM agent_allowances
         WHERE agent_id = $1 AND LOWER(token_address) = LOWER($2)`

/**
 * The `/machine-payments/allowances` projection — narrower than
 * `LIST_ALLOWANCES_FOR_AGENT_SQL` (no `agent_id` column). Pre-existing
 * divergence, preserved verbatim rather than widened (#995).
 */
export const LIST_ALLOWANCE_CONFIG_FOR_AGENT_SQL = `SELECT id, token_address, token_symbol, allowance_amount, reset_period_min
       FROM agent_allowances
       WHERE agent_id = $1
       ORDER BY created_at ASC`

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

/** Scoped by the caller: `agentIds` must come from a tenant-scoped read. */
export async function listAllowancesForAgents(
  agentIds: string[],
  db: Executor = pool,
): Promise<AgentAllowanceRow[]> {
  const result = await db.query<AgentAllowanceRow>(LIST_ALLOWANCES_FOR_AGENTS_SQL, [agentIds])
  return result.rows
}

export async function listAllowancesForAgent(
  agentId: string,
  db: Executor = pool,
): Promise<AgentAllowanceRow[]> {
  const result = await db.query<AgentAllowanceRow>(LIST_ALLOWANCES_FOR_AGENT_SQL, [agentId])
  return result.rows
}

export async function listAllowancesForAgentUnordered(
  agentId: string,
  db: Executor = pool,
): Promise<AgentAllowanceRow[]> {
  const result = await db.query<AgentAllowanceRow>(LIST_ALLOWANCES_FOR_AGENT_UNORDERED_SQL, [
    agentId,
  ])
  return result.rows
}

/** True when the agent has an AllowanceModule config row for this token (#995). */
export async function hasTokenAllowanceConfigured(
  agentId: string,
  tokenAddress: string,
  db: Executor = pool,
): Promise<boolean> {
  const result = await db.query<{ allowance_amount: string }>(FIND_TOKEN_ALLOWANCE_AMOUNT_SQL, [
    agentId,
    tokenAddress,
  ])
  return result.rows.length > 0
}

export interface AllowanceConfigRow {
  id: string
  token_address: string
  token_symbol: string
  allowance_amount: string
  reset_period_min: number
}

export async function listAllowanceConfigForAgent(
  agentId: string,
  db: Executor = pool,
): Promise<AllowanceConfigRow[]> {
  const result = await db.query<AllowanceConfigRow>(LIST_ALLOWANCE_CONFIG_FOR_AGENT_SQL, [agentId])
  return result.rows
}

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
                   NULL::timestamptz AS mcp_last_seen_at`

export const FIND_SAFE_INFO_SQL = `SELECT safe_address, name AS safe_name, chain_id AS safe_chain_id
             FROM user_safes WHERE id = $1`

export const INSERT_AGENT_ALLOWANCE_SQL = `INSERT INTO agent_allowances (agent_id, token_address, token_symbol, allowance_amount, reset_period_min)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, agent_id, token_address, token_symbol, allowance_amount, reset_period_min`

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
  >
  safeInfo: SafeInfoRow
  savedAllowances: AgentAllowanceRow[]
}

/**
 * Insert the agent and its allowance mirror rows as ONE unit, exactly as the
 * route's BEGIN/COMMIT block did. An agent row without the allowances the user
 * configured describes authority the user never granted, so the writes are not
 * separable. A unique-delegate violation (23505 on
 * `idx_agents_user_delegate_non_revoked_unique`) rolls back and rethrows for
 * the route to map to its 409.
 */
export async function createAgentWithAllowances(
  input: NewAgent,
  allowances: Array<{
    token_address: string
    token_symbol: string
    allowance_amount: string
    reset_period_min: number
  }>,
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

    const savedAllowances: AgentAllowanceRow[] = []
    for (const a of allowances) {
      const res = await tx.query<AgentAllowanceRow>(INSERT_AGENT_ALLOWANCE_SQL, [
        agent.id,
        a.token_address,
        a.token_symbol,
        a.allowance_amount,
        a.reset_period_min,
      ])
      savedAllowances.push(res.rows[0])
    }

    return { agent, safeInfo, savedAllowances }
  })
}

export const UPDATE_AGENT_PROFILE_SQL = `WITH updated AS (
           UPDATE agents
           SET name        = COALESCE($3, name),
               description = COALESCE($4, description),
               updated_at  = NOW()
           WHERE id = $1 AND user_id = $2
           RETURNING id, name, description, delegate_address, safe_id, api_key_prefix, status, created_at
         )
         SELECT updated.id, updated.name, updated.description, updated.delegate_address,
                updated.safe_id, us.safe_address, us.name AS safe_name, us.chain_id AS safe_chain_id,
                us.account_type,
                updated.api_key_prefix, updated.status, updated.created_at,
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
export const ARCHIVE_AGENT_SQL = `UPDATE agents
       SET archived_at = COALESCE(archived_at, NOW()), updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND status = 'revoked'
       RETURNING id, archived_at`

/** Returns null when nothing matched (missing, foreign, or not revoked). */
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

export const UPSERT_AGENT_ALLOWANCE_SQL = `INSERT INTO agent_allowances (agent_id, token_address, token_symbol, allowance_amount, reset_period_min)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (agent_id, token_address)
       DO UPDATE SET allowance_amount = $4, reset_period_min = $5, token_symbol = $3, updated_at = NOW()
       RETURNING id, agent_id, token_address, token_symbol, allowance_amount, reset_period_min`

/**
 * Not tenant-scoped in SQL: the route gates on `findAgentIdStatusForUser`
 * (ownership + status) before calling this — authorization stays in the route
 * per #988. Callers outside that route must gate the same way.
 */
export async function upsertAgentAllowance(
  agentId: string,
  allowance: {
    token_address: string
    token_symbol: string
    allowance_amount: string
    reset_period_min: number
  },
  db: Executor = pool,
): Promise<AgentAllowanceRow> {
  const result = await db.query<AgentAllowanceRow>(UPSERT_AGENT_ALLOWANCE_SQL, [
    agentId,
    allowance.token_address,
    allowance.token_symbol,
    allowance.allowance_amount,
    allowance.reset_period_min,
  ])
  return result.rows[0]
}

export const DELETE_AGENT_ALLOWANCE_SQL = 'DELETE FROM agent_allowances WHERE agent_id = $1 AND token_address = $2 RETURNING id'

/** Same gating contract as `upsertAgentAllowance`. */
export async function deleteAgentAllowance(
  agentId: string,
  tokenAddress: string,
  db: Executor = pool,
): Promise<boolean> {
  const result = await db.query<{ id: string }>(DELETE_AGENT_ALLOWANCE_SQL, [agentId, tokenAddress])
  return result.rows.length > 0
}

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
