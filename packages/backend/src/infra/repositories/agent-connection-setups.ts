/**
 * Data access for the Connect Agent 2 setup flow (#985, epic #980 M3).
 *
 * Extracted from `routes/agent-connection-setups.ts`, which held 56 `.query`
 * call sites — the largest concentration of inline SQL in the backend. The
 * argument for moving it is testability, not tidiness: `scripts/db-schema-
 * smoke.ts` can only `PREPARE` a query it can **import**, so every statement
 * left inline in a route is one CI never checks against the real schema. That
 * is the #757 failure class (a join on a column that does not exist).
 *
 * Convention — see `README.md` in this directory. In short: the executor comes
 * last and defaults to the pool, tenant scoping is a required parameter, SQL
 * lives in exported constants so the smoke test can reach it, and returns are
 * row shapes this module owns.
 *
 * **The SQL here is verbatim from the route.** This extraction is behaviour-
 * preserving by construction; anything that looked improvable was left alone
 * and reported in the pull request instead.
 */

import pool from '../../db.js'
import { withTransaction, type Executor } from '../transaction.js'

export type { Executor }

/**
 * Run `fn` in a transaction against the app pool.
 *
 * Repositories own the pool; a route composing several writes atomically needs
 * a transaction but must NOT import `db.ts` to get one — that import is the
 * exact thing `pg-only-in-infra` forbids. So the pool-bound entry point lives
 * here, and `infra/transaction.ts` stays pure.
 */
export async function inTransaction<T>(
  fn: (tx: Executor) => Promise<T>,
  db: Executor = pool,
): Promise<T> {
  return withTransaction(db, fn)
}

export interface SetupRow {
  id: string
  user_id: string
  agent_id: string | null
  safe_id: string
  name: string
  description: string | null
  runtime: string | null
  status: string
  setup_token_expires_at: string
  setup_token_consumed_at: string | null
  challenge_id: string
  challenge_message: string
  challenge_expires_at: string
  delegate_address: string | null
  proof_signature: string | null
  api_key_prefix: string | null
  connector_version: string | null
  connector_context: Record<string, unknown>
  install_status: Record<string, unknown>
  approval_status: string
  safe_tx_hash: string | null
  tx_hash: string | null
  failure_reason: string | null
  safe_address: string
  safe_name: string
  safe_chain_id: number
  /** 'delegator_hybrid' = delegation rail (#1073); 'safe' = legacy AllowanceModule. */
  account_type: string | null
  /** Passport opt-in recorded at setup creation, acted on at /register (#1072). */
  issue_passport: boolean
}

export interface AllowanceRow {
  id?: string
  token_address: string
  token_symbol: string
  allowance_amount: string
  reset_period_min: number
}

export interface UserSafeRow {
  id: string
  safe_address: string
  name: string
  chain_id: number
  account_type: string | null
}

export interface ActiveDelegationRow {
  token_address: string
  budget_atomic: string
  period_seconds: number
}

/**
 * The setup projection every user- and connector-facing read returns, joined to
 * its Haven wallet. Parameterised by its WHERE clause so the projection cannot
 * drift between call sites — the concrete queries are the exported constants
 * below, which is what `db-schema-smoke.ts` imports.
 */
function setupSelectSql(where: string): string {
  return `SELECT s.id, s.user_id, s.agent_id, s.safe_id, s.name, s.description,
                 s.runtime, s.status, s.setup_token_expires_at,
                 s.setup_token_consumed_at, s.challenge_id, s.challenge_message,
                 s.challenge_expires_at, s.delegate_address, s.proof_signature,
                 s.api_key_prefix, s.connector_version, s.connector_context,
                 s.install_status, s.approval_status, s.safe_tx_hash, s.tx_hash,
                 s.failure_reason, s.issue_passport,
                 us.safe_address, us.name AS safe_name, us.chain_id AS safe_chain_id,
                 us.account_type
          FROM agent_connection_setups s
          JOIN user_safes us ON us.id = s.safe_id
          WHERE ${where}
          LIMIT 1`
}

export const FIND_SETUP_BY_TOKEN_HASH_SQL = setupSelectSql('s.setup_token_hash = $1')
export const FIND_SETUP_FOR_USER_SQL = setupSelectSql('s.id = $1 AND s.user_id = $2')
export const FIND_SETUP_BY_ID_AND_TOKEN_HASH_SQL = setupSelectSql(
  's.id = $1 AND s.setup_token_hash = $2',
)
export const LOCK_SETUP_BY_TOKEN_HASH_SQL = `${FIND_SETUP_BY_TOKEN_HASH_SQL} FOR UPDATE OF s`
export const LOCK_SETUP_FOR_USER_SQL = `${FIND_SETUP_FOR_USER_SQL} FOR UPDATE OF s`

/**
 * The install-status API-key lookup.
 *
 * Note this projection is NARROWER than `setupSelectSql`: it omits
 * `s.issue_passport` and `us.account_type`, so a `SetupRow` from this function
 * has those two fields undefined. That divergence is pre-existing and is
 * preserved deliberately rather than tidied — the caller (`POST
 * /:setupId/install-status`) reads neither field, and widening a query is a
 * behaviour change that belongs in its own change, not in an extraction.
 */
export const FIND_SETUP_BY_AGENT_API_KEY_SQL = `SELECT s.id, s.user_id, s.agent_id, s.safe_id, s.name, s.description,
            s.runtime, s.status, s.setup_token_expires_at,
            s.setup_token_consumed_at, s.challenge_id, s.challenge_message,
            s.challenge_expires_at, s.delegate_address, s.proof_signature,
            s.api_key_prefix, s.connector_version, s.connector_context,
            s.install_status, s.approval_status, s.safe_tx_hash, s.tx_hash,
            s.failure_reason,
            us.safe_address, us.name AS safe_name, us.chain_id AS safe_chain_id
     FROM agent_connection_setups s
     JOIN user_safes us ON us.id = s.safe_id
     JOIN agents a ON a.id = s.agent_id
     WHERE s.id = $1 AND a.api_key_hash = $2 AND a.status IN ($3, $4, $5)
     LIMIT 1`

export const FIND_USER_SAFE_BY_ID_SQL = `SELECT id, safe_address, name, chain_id, account_type
       FROM user_safes
       WHERE id = $1 AND user_id = $2
       LIMIT 1`

export const FIND_DEFAULT_USER_SAFE_SQL = `SELECT id, safe_address, name, chain_id, account_type
     FROM user_safes
     WHERE user_id = $1 AND is_default = true
     LIMIT 1`

export const LIST_SETUP_ALLOWANCES_SQL = `SELECT id, token_address, token_symbol, allowance_amount, reset_period_min
     FROM agent_connection_setup_allowances
     WHERE setup_id = $1
     ORDER BY created_at ASC`

export const LIST_ACTIVE_DELEGATIONS_SQL = `SELECT token_address, budget_atomic, period_seconds
       FROM agent_delegations
       WHERE agent_id = $1 AND status = 'active'`

export const FIND_ACTIVE_AGENT_BY_DELEGATE_SQL = `SELECT id FROM agents
         WHERE user_id = $1 AND lower(delegate_address) = $2 AND status != 'revoked'
         LIMIT 1`

export const FIND_AGENT_STATUS_SQL = `SELECT status FROM agents WHERE id = $1 AND user_id = $2`

// ── Reads ────────────────────────────────────────────────────────────────────

/** The token hash is the credential; the caller hashes before it gets here. */
export async function findSetupByTokenHash(
  tokenHash: string,
  db: Executor = pool,
): Promise<SetupRow | null> {
  const result = await db.query<SetupRow>(FIND_SETUP_BY_TOKEN_HASH_SQL, [tokenHash])
  return result.rows[0] ?? null
}

/** `userId` is REQUIRED — this is the tenant scope for every dashboard read. */
export async function findSetupForUser(
  setupId: string,
  userId: string,
  db: Executor = pool,
): Promise<SetupRow | null> {
  const result = await db.query<SetupRow>(FIND_SETUP_FOR_USER_SQL, [setupId, userId])
  return result.rows[0] ?? null
}

export async function findSetupByIdAndTokenHash(
  setupId: string,
  tokenHash: string,
  db: Executor = pool,
): Promise<SetupRow | null> {
  const result = await db.query<SetupRow>(FIND_SETUP_BY_ID_AND_TOKEN_HASH_SQL, [setupId, tokenHash])
  return result.rows[0] ?? null
}

/** Statuses whose agent may still report install progress. */
export const INSTALL_STATUS_AGENT_STATUSES = ['pending_approval', 'active', 'paused'] as const

export async function findSetupByAgentApiKeyHash(
  setupId: string,
  apiKeyHashValue: string,
  db: Executor = pool,
): Promise<SetupRow | null> {
  const result = await db.query<SetupRow>(FIND_SETUP_BY_AGENT_API_KEY_SQL, [
    setupId,
    apiKeyHashValue,
    ...INSTALL_STATUS_AGENT_STATUSES,
  ])
  return result.rows[0] ?? null
}

/** Lock a setup row for the duration of `tx`. Callers must be inside one. */
export async function lockSetupByTokenHash(
  tokenHash: string,
  tx: Executor,
): Promise<SetupRow | null> {
  const result = await tx.query<SetupRow>(LOCK_SETUP_BY_TOKEN_HASH_SQL, [tokenHash])
  return result.rows[0] ?? null
}

export async function lockSetupForUser(
  setupId: string,
  userId: string,
  tx: Executor,
): Promise<SetupRow | null> {
  const result = await tx.query<SetupRow>(LOCK_SETUP_FOR_USER_SQL, [setupId, userId])
  return result.rows[0] ?? null
}

export async function findUserSafe(
  userId: string,
  safeId: string | undefined,
  db: Executor = pool,
): Promise<UserSafeRow | null> {
  if (safeId) {
    const result = await db.query<UserSafeRow>(FIND_USER_SAFE_BY_ID_SQL, [safeId, userId])
    return result.rows[0] ?? null
  }
  const result = await db.query<UserSafeRow>(FIND_DEFAULT_USER_SAFE_SQL, [userId])
  return result.rows[0] ?? null
}

export async function listSetupAllowances(
  setupId: string,
  db: Executor = pool,
): Promise<AllowanceRow[]> {
  const result = await db.query<AllowanceRow>(LIST_SETUP_ALLOWANCES_SQL, [setupId])
  return result.rows
}

export async function listActiveDelegations(
  agentId: string | null,
  db: Executor = pool,
): Promise<ActiveDelegationRow[]> {
  const result = await db.query<ActiveDelegationRow>(LIST_ACTIVE_DELEGATIONS_SQL, [agentId])
  return result.rows
}

export async function findActiveAgentIdByDelegate(
  userId: string,
  delegateAddress: string,
  db: Executor = pool,
): Promise<string | null> {
  const result = await db.query<{ id: string }>(FIND_ACTIVE_AGENT_BY_DELEGATE_SQL, [
    userId,
    delegateAddress,
  ])
  return result.rows[0]?.id ?? null
}

export async function findAgentStatus(
  agentId: string,
  userId: string,
  db: Executor = pool,
): Promise<string | undefined> {
  const result = await db.query<{ status: string }>(FIND_AGENT_STATUS_SQL, [agentId, userId])
  return result.rows[0]?.status
}

// ── Writes ───────────────────────────────────────────────────────────────────

export const INSERT_SETUP_SQL = `INSERT INTO agent_connection_setups (
             id, user_id, safe_id, name, description, runtime, status,
             setup_token_hash, setup_token_prefix, setup_token_expires_at,
             challenge_id, challenge_message, challenge_expires_at, issue_passport
           )
           VALUES ($1, $2, $3, $4, $5, $6, 'awaiting_connection',
                   $7, $8, $9, $10, $11, $12, $13)`

export const INSERT_SETUP_ALLOWANCE_SQL = `INSERT INTO agent_connection_setup_allowances (
               setup_id, token_address, token_symbol, allowance_amount, reset_period_min
             )
             VALUES ($1, $2, $3, $4, $5)`

export interface NewSetup {
  id: string
  userId: string
  safeId: string
  name: string
  description: string | null
  runtime: string | null
  setupTokenHash: string
  setupTokenPrefix: string
  expiresAt: string
  challengeId: string
  challengeMessage: string
  issuePassport: boolean
}

/**
 * Insert the setup and its allowances as ONE unit. A setup row without its
 * allowances describes an agent the user never approved, so the two writes are
 * not separable — that is why this takes the allowances rather than exposing an
 * insert-allowance function a caller could forget to call.
 */
export async function insertSetupWithAllowances(
  setup: NewSetup,
  allowances: Array<{
    token_address: string
    token_symbol: string
    allowance_amount: string
    reset_period_min: number
  }>,
  db: Executor = pool,
): Promise<void> {
  await withTransaction(db, async (tx) => {
    await tx.query(INSERT_SETUP_SQL, [
      setup.id,
      setup.userId,
      setup.safeId,
      setup.name,
      setup.description,
      setup.runtime,
      setup.setupTokenHash,
      setup.setupTokenPrefix,
      setup.expiresAt,
      setup.challengeId,
      setup.challengeMessage,
      setup.expiresAt,
      setup.issuePassport,
    ])
    for (const allowance of allowances) {
      await tx.query(INSERT_SETUP_ALLOWANCE_SQL, [
        setup.id,
        allowance.token_address,
        allowance.token_symbol,
        allowance.allowance_amount,
        allowance.reset_period_min,
      ])
    }
  })
}

export const UPDATE_CONNECTOR_METADATA_SQL = `UPDATE agent_connection_setups
         SET connector_version = COALESCE($2, connector_version),
             runtime = COALESCE($3, runtime),
             updated_at = NOW()
         WHERE id = $1`

export async function updateConnectorMetadata(
  setupId: string,
  connectorVersion: string | null,
  runtime: string | null,
  db: Executor = pool,
): Promise<void> {
  await db.query(UPDATE_CONNECTOR_METADATA_SQL, [setupId, connectorVersion, runtime])
}

export const INSERT_AGENT_SQL = `INSERT INTO agents (
           user_id, name, description, delegate_address, api_key_hash,
           api_key_prefix, safe_id, status, mcp_server_name
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_approval', $8)
         RETURNING id`

export async function insertPendingAgent(
  input: {
    userId: string
    name: string
    description: string | null
    delegateAddress: string
    apiKeyHash: string
    apiKeyPrefix: string
    safeId: string
    /**
     * #1878: the MCP server name the connector reported wiring this agent as.
     * NULL for every connector older than #1878 — a display aid, never keyed
     * off, and never guessed at when absent.
     */
    mcpServerName?: string | null
  },
  tx: Executor,
): Promise<string> {
  const result = await tx.query<{ id: string }>(INSERT_AGENT_SQL, [
    input.userId,
    input.name,
    input.description,
    input.delegateAddress,
    input.apiKeyHash,
    input.apiKeyPrefix,
    input.safeId,
    input.mcpServerName ?? null,
  ])
  return result.rows[0].id
}

export const COPY_SETUP_ALLOWANCES_SQL = `INSERT INTO agent_allowances (
           agent_id, token_address, token_symbol, allowance_amount, reset_period_min
         )
         SELECT $1, token_address, token_symbol, allowance_amount, reset_period_min
         FROM agent_connection_setup_allowances
         WHERE setup_id = $2`

export async function copySetupAllowancesToAgent(
  agentId: string,
  setupId: string,
  tx: Executor,
): Promise<void> {
  await tx.query(COPY_SETUP_ALLOWANCES_SQL, [agentId, setupId])
}

export const MARK_SETUP_REGISTERED_SQL = `UPDATE agent_connection_setups
         SET agent_id = $2,
             status = 'connected_local',
             delegate_address = $3,
             proof_signature = $4,
             api_key_prefix = $5,
             connector_version = COALESCE($6, connector_version),
             runtime = COALESCE($7, runtime),
             connector_context = $8::jsonb,
             install_status = $9::jsonb,
             setup_token_consumed_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`

export async function markSetupRegistered(
  input: {
    setupId: string
    agentId: string
    delegateAddress: string
    proofSignature: string
    apiKeyPrefix: string
    connectorVersion: string | null
    runtime: string | null
    connectorContext: unknown
    installStatus: unknown
  },
  tx: Executor,
): Promise<void> {
  await tx.query(MARK_SETUP_REGISTERED_SQL, [
    input.setupId,
    input.agentId,
    input.delegateAddress,
    input.proofSignature,
    input.apiKeyPrefix,
    input.connectorVersion,
    input.runtime,
    JSON.stringify(input.connectorContext),
    JSON.stringify(input.installStatus),
  ])
}

export const MERGE_INSTALL_STATUS_SQL = `UPDATE agent_connection_setups
         SET install_status = install_status || $2::jsonb,
             connector_version = COALESCE($3, connector_version),
             runtime = COALESCE($4, runtime),
             updated_at = NOW()
         WHERE id = $1
         RETURNING install_status`

export async function mergeInstallStatus(
  setupId: string,
  installStatus: unknown,
  connectorVersion: string | null,
  runtime: string | null,
  db: Executor = pool,
): Promise<Record<string, unknown> | null> {
  const result = await db.query<SetupRow>(MERGE_INSTALL_STATUS_SQL, [
    setupId,
    JSON.stringify(installStatus),
    connectorVersion,
    runtime,
  ])
  return result.rows[0]?.install_status ?? null
}

export const CANCEL_SETUP_SQL = `UPDATE agent_connection_setups
           SET status = 'cancelled',
               setup_token_consumed_at = COALESCE(setup_token_consumed_at, NOW()),
               updated_at = NOW()
           WHERE id = $1
             AND user_id = $2
             AND status IN ('awaiting_connection', 'connected_local', 'awaiting_wallet_approval')
             AND safe_tx_hash IS NULL
             AND tx_hash IS NULL
           RETURNING id`

/**
 * Cancel under the row lock the caller already holds. Returns false when the
 * guarded UPDATE matched nothing — the state changed under us, and the caller
 * must abandon the transaction rather than report success.
 */
export async function cancelSetup(
  setupId: string,
  userId: string,
  tx: Executor,
): Promise<boolean> {
  const result = await tx.query<{ id: string }>(CANCEL_SETUP_SQL, [setupId, userId])
  return result.rows.length > 0
}

export const REVOKE_PENDING_AGENT_SQL = `UPDATE agents
             SET status = 'revoked',
                 api_key_hash = NULL,
                 api_key_prefix = NULL,
                 updated_at = NOW()
             WHERE id = $1 AND user_id = $2 AND status = 'pending_approval'`

export async function revokePendingAgent(
  agentId: string,
  userId: string,
  tx: Executor,
): Promise<void> {
  await tx.query(REVOKE_PENDING_AGENT_SQL, [agentId, userId])
}

export const UPDATE_APPROVAL_STATE_SQL = `UPDATE agent_connection_setups
       SET status = $3,
           approval_status = $4,
           tx_hash = $5,
           safe_tx_hash = $6,
           failure_reason = $7,
           updated_at = NOW()
       WHERE id = $1 AND user_id = $2`

export const ACTIVATE_AGENT_SQL = `UPDATE agents
         SET status = 'active',
             updated_at = NOW()
         WHERE id = $1 AND user_id = $2 AND status IN ('pending_approval', 'active')`

/** Signals "abandon this transaction and answer null" — never leaves this file. */
class AbandonTransaction extends Error {}

/**
 * The statuses from which a wallet/budget approval may still proceed.
 *
 * Exported because the route validates against the same set BEFORE taking the
 * lock, and `applyApprovalState` re-checks it under the lock. Two copies of a
 * state machine drift; the pre-check is an early, friendly refusal and the
 * locked check is the authority.
 */
export const WALLET_APPROVAL_STATES = new Set([
  'connected_local',
  'awaiting_wallet_approval',
  'approval_in_progress',
  'proposed',
  'active',
])

export interface ApprovalStateInput {
  status: 'approval_in_progress' | 'proposed' | 'active'
  approvalStatus: 'submitted' | 'proposed' | 'confirmed'
  txHash: string | null | undefined
  safeTxHash: string | null | undefined
  failureReason: string | null
  activateAgent: boolean
}

/**
 * Apply an approval-state transition under a row lock, or return null when the
 * setup moved underneath the caller.
 *
 * The guards and the UPDATE are ONE function on purpose: every guard here reads
 * the locked row, and a caller that could run the guards separately from the
 * write would be running them against a row nobody is holding. Splitting a
 * check from the write it protects is how a double-approval gets in.
 */
export async function applyApprovalState(
  setup: Pick<SetupRow, 'id' | 'user_id'>,
  input: ApprovalStateInput,
  db: Executor = pool,
): Promise<SetupRow | null> {
  try {
    return await withTransaction(db, async (tx) => {
      const locked = await lockSetupForUser(setup.id, setup.user_id, tx)
      if (!locked) throw new AbandonTransaction()
      if (locked.status === 'cancelled' || locked.status === 'expired' || locked.status === 'failed') {
        throw new AbandonTransaction()
      }
      // Already active: COMMIT (not rollback) and hand back the live row —
      // repeated approval evidence is idempotent, not a conflict.
      if (locked.status === 'active') return locked
      if (!WALLET_APPROVAL_STATES.has(locked.status)) throw new AbandonTransaction()
      if (
        locked.safe_tx_hash &&
        input.safeTxHash &&
        locked.safe_tx_hash.toLowerCase() !== input.safeTxHash.toLowerCase()
      ) {
        throw new AbandonTransaction()
      }
      if (
        locked.tx_hash &&
        input.txHash &&
        locked.tx_hash.toLowerCase() !== input.txHash.toLowerCase()
      ) {
        throw new AbandonTransaction()
      }

      const nextSetup: SetupRow = {
        ...locked,
        status: input.status,
        approval_status: input.approvalStatus,
        tx_hash: input.txHash ?? locked.tx_hash,
        safe_tx_hash: input.safeTxHash ?? locked.safe_tx_hash,
        failure_reason: input.failureReason,
      }
      await tx.query(UPDATE_APPROVAL_STATE_SQL, [
        setup.id,
        setup.user_id,
        input.status,
        input.approvalStatus,
        nextSetup.tx_hash,
        nextSetup.safe_tx_hash,
        input.failureReason,
      ])
      if (input.activateAgent && nextSetup.agent_id) {
        await tx.query(ACTIVATE_AGENT_SQL, [nextSetup.agent_id, nextSetup.user_id])
      }
      return nextSetup
    })
  } catch (err) {
    if (err instanceof AbandonTransaction) return null
    throw err
  }
}
