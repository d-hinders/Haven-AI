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
 * - The DELEGATE-BALANCE read is the one status-scoped read: it excludes
 *   `revoked` (`...ExcludingRevoked`), because a revoked agent's delegate is
 *   no longer the user's hot key to inspect.
 *
 * Collapsing these into one "find agent" query silently changes what each
 * caller sees. Keep the distinction, keep it named.
 *
 * **The SQL here is verbatim from the route.** Anything that looked improvable
 * was left alone and reported in the pull request instead.
 */

import pool from '../../db.js'
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
              a.api_key_prefix, a.status, a.created_at,
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
              a.api_key_prefix, a.status, a.created_at,
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
 * The one status-scoped agent read: excludes `revoked` — a revoked agent's
 * delegate EOA is no longer a hot key the dashboard should inspect.
 */
export const FIND_DELEGATE_AGENT_EXCLUDING_REVOKED_SQL = `SELECT a.delegate_address, us.chain_id AS safe_chain_id, us.safe_address, us.account_type
       FROM agents a
       LEFT JOIN user_safes us ON a.safe_id = us.id
       WHERE a.user_id = $1 AND a.id = $2 AND a.status != 'revoked'
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

export const FIND_USER_SAFE_ID_FOR_USER_SQL = 'SELECT id FROM user_safes WHERE id = $1 AND user_id = $2'

export const FIND_DEFAULT_USER_SAFE_ID_SQL = 'SELECT id FROM user_safes WHERE user_id = $1 AND is_default = true LIMIT 1'

export const FIND_NON_REVOKED_AGENT_BY_DELEGATE_SQL = 'SELECT id FROM agents WHERE user_id = $1 AND delegate_address = $2 AND status != $3'

export const FIND_AGENT_ID_FOR_USER_SQL = 'SELECT id FROM agents WHERE id = $1 AND user_id = $2'

export const FIND_AGENT_ID_STATUS_FOR_USER_SQL = 'SELECT id, status FROM agents WHERE id = $1 AND user_id = $2'

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

/** `userId` is REQUIRED. Excludes revoked agents — see the header invariant. */
export async function findDelegateAgentForUserExcludingRevoked(
  agentId: string,
  userId: string,
  db: Executor = pool,
): Promise<DelegateAgentRow | null> {
  const result = await db.query<DelegateAgentRow>(FIND_DELEGATE_AGENT_EXCLUDING_REVOKED_SQL, [
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

export const DELETE_REVOKED_AGENT_SQL = `DELETE FROM agents
       WHERE id = $1 AND user_id = $2 AND status = 'revoked'
       RETURNING id`

/** Returns false when nothing matched (missing, foreign, or not revoked). */
export async function deleteRevokedAgent(
  agentId: string,
  userId: string,
  db: Executor = pool,
): Promise<boolean> {
  const result = await db.query<{ id: string }>(DELETE_REVOKED_AGENT_SQL, [agentId, userId])
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
