/**
 * Data access for the Connect Agent 2 setup flow (#985).
 *
 * Every query that `routes/agent-connection-setups.ts` used to run inline
 * lives here, following the convention documented in `README.md`:
 *
 * - explicit `db: Executor = pool` LAST argument, so callers inside a
 *   transaction pass their client and the function composes;
 * - exported `*_SQL` constants so `scripts/db-schema-smoke.ts` can PREPARE
 *   each query against the real schema in CI;
 * - domain-shaped returns — never a raw `QueryResult`;
 * - tenant scoping (`user_id = $n`) is a REQUIRED parameter, never defaulted.
 *
 * The route keeps ALL validation, authorization decisions and orchestration —
 * including the #1074 single-allowance guard and the #1072/#1112
 * `issue_passport` threading. Only the SQL moved.
 *
 * SQL strings are kept VERBATIM from the route so the characterization tests
 * (which match on query text) pin identical behaviour.
 */

import pool from '../../db.js'
import { withTransaction, type Executor } from '../db.js'

export type { Executor } from '../db.js'

/**
 * Run `fn` in a transaction on the app pool. The route composes repository
 * calls (and its own validation decisions) inside `fn`; throwing rolls back.
 * Exists because rule 3 (`pg-only-in-infra`) means the route may not import
 * the pool to hand to `withTransaction` itself.
 */
export async function withSetupTransaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T> {
  return withTransaction(pool, fn)
}

// ── Row shapes ──────────────────────────────────────────────────────

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

// ── Haven wallet (user_safes) lookups — owner-scoped ────────────────

export const FIND_USER_SAFE_BY_ID_SQL = `SELECT id, safe_address, name, chain_id, account_type
       FROM user_safes
       WHERE id = $1 AND user_id = $2
       LIMIT 1`

export async function findUserSafeById(
  safeId: string,
  userId: string,
  db: Executor = pool,
): Promise<UserSafeRow | null> {
  const { rows } = await db.query<UserSafeRow>(FIND_USER_SAFE_BY_ID_SQL, [safeId, userId])
  return rows[0] ?? null
}

export const FIND_DEFAULT_USER_SAFE_SQL = `SELECT id, safe_address, name, chain_id, account_type
     FROM user_safes
     WHERE user_id = $1 AND is_default = true
     LIMIT 1`

export async function findDefaultUserSafe(
  userId: string,
  db: Executor = pool,
): Promise<UserSafeRow | null> {
  const { rows } = await db.query<UserSafeRow>(FIND_DEFAULT_USER_SAFE_SQL, [userId])
  return rows[0] ?? null
}

// ── Setup row selects ───────────────────────────────────────────────
//
// One SELECT list, five WHERE/locking variants — kept as composed constants
// so the smoke test can PREPARE each shape that actually runs.

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
export const LOCK_SETUP_BY_TOKEN_HASH_SQL = `${setupSelectSql('s.setup_token_hash = $1')} FOR UPDATE OF s`
export const FIND_SETUP_FOR_USER_SQL = setupSelectSql('s.id = $1 AND s.user_id = $2')
export const LOCK_SETUP_FOR_USER_SQL = `${setupSelectSql('s.id = $1 AND s.user_id = $2')} FOR UPDATE OF s`
export const FIND_SETUP_BY_ID_AND_TOKEN_HASH_SQL = setupSelectSql('s.id = $1 AND s.setup_token_hash = $2')

/** Token-authenticated: possession of the (hashed) setup token IS the authorization. */
export async function findSetupByTokenHash(
  setupTokenHash: string,
  db: Executor = pool,
): Promise<SetupRow | null> {
  const { rows } = await db.query<SetupRow>(FIND_SETUP_BY_TOKEN_HASH_SQL, [setupTokenHash])
  return rows[0] ?? null
}

/** Same lookup under FOR UPDATE — call inside `withSetupTransaction`. */
export async function lockSetupByTokenHash(
  setupTokenHash: string,
  db: Executor,
): Promise<SetupRow | null> {
  const { rows } = await db.query<SetupRow>(LOCK_SETUP_BY_TOKEN_HASH_SQL, [setupTokenHash])
  return rows[0] ?? null
}

export async function findSetupForUser(
  setupId: string,
  userId: string,
  db: Executor = pool,
): Promise<SetupRow | null> {
  const { rows } = await db.query<SetupRow>(FIND_SETUP_FOR_USER_SQL, [setupId, userId])
  return rows[0] ?? null
}

/** Owner-scoped lookup under FOR UPDATE — call inside `withSetupTransaction`. */
export async function lockSetupForUser(
  setupId: string,
  userId: string,
  db: Executor,
): Promise<SetupRow | null> {
  const { rows } = await db.query<SetupRow>(LOCK_SETUP_FOR_USER_SQL, [setupId, userId])
  return rows[0] ?? null
}

export async function findSetupByIdAndTokenHash(
  setupId: string,
  setupTokenHash: string,
  db: Executor = pool,
): Promise<SetupRow | null> {
  const { rows } = await db.query<SetupRow>(FIND_SETUP_BY_ID_AND_TOKEN_HASH_SQL, [
    setupId,
    setupTokenHash,
  ])
  return rows[0] ?? null
}

/**
 * Post-registration install-status auth: the setup resolved through the
 * AGENT's API-key hash. The narrower SELECT list (no `issue_passport`, no
 * `account_type`) is deliberate and kept verbatim — this credential only ever
 * feeds the install-status merge, which needs neither.
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

export async function findSetupByAgentApiKey(
  setupId: string,
  agentApiKeyHash: string,
  db: Executor = pool,
): Promise<SetupRow | null> {
  const { rows } = await db.query<SetupRow>(FIND_SETUP_BY_AGENT_API_KEY_SQL, [
    setupId,
    agentApiKeyHash,
    'pending_approval',
    'active',
    'paused',
  ])
  return rows[0] ?? null
}

// ── Setup creation ──────────────────────────────────────────────────

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

export interface CreateSetupInput {
  id: string
  userId: string
  safeId: string
  name: string
  description: string | null
  runtime: string | null
  setupTokenHash: string
  setupTokenPrefix: string
  /** ISO timestamp; the setup token and the challenge share one expiry. */
  expiresAt: string
  challengeId: string
  challengeMessage: string
  issuePassport: boolean
  allowances: Array<{
    token_address: string
    token_symbol: string
    allowance_amount: string
    reset_period_min: number
  }>
}

/**
 * Setup row + its allowance rows, atomically. This sequence was an explicit
 * BEGIN/COMMIT in the route and moves as a unit — a setup without its
 * allowances would present an approvable agent with no budget.
 */
export async function createSetupWithAllowances(
  input: CreateSetupInput,
  db: Executor = pool,
): Promise<void> {
  await withTransaction(db, async (tx) => {
    await tx.query(INSERT_SETUP_SQL, [
      input.id,
      input.userId,
      input.safeId,
      input.name,
      input.description,
      input.runtime,
      input.setupTokenHash,
      input.setupTokenPrefix,
      input.expiresAt,
      input.challengeId,
      input.challengeMessage,
      input.expiresAt,
      input.issuePassport,
    ])
    for (const allowance of input.allowances) {
      await tx.query(INSERT_SETUP_ALLOWANCE_SQL, [
        input.id,
        allowance.token_address,
        allowance.token_symbol,
        allowance.allowance_amount,
        allowance.reset_period_min,
      ])
    }
  })
}

// ── Connector metadata + install status ─────────────────────────────
//
// Token-authenticated writes: the caller proved possession of the setup token
// (or the agent API key) before reaching these, so the WHERE is by id alone —
// verbatim from the route.

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

export const MERGE_INSTALL_STATUS_SQL = `UPDATE agent_connection_setups
         SET install_status = install_status || $2::jsonb,
             connector_version = COALESCE($3, connector_version),
             runtime = COALESCE($4, runtime),
             updated_at = NOW()
         WHERE id = $1
         RETURNING install_status`

/** Merge (not replace) the sanitized install-status patch. Returns the merged value. */
export async function mergeInstallStatus(
  setupId: string,
  installStatus: Record<string, unknown>,
  connectorVersion: string | null,
  runtime: string | null,
  db: Executor = pool,
): Promise<Record<string, unknown> | null> {
  const { rows } = await db.query<{ install_status: Record<string, unknown> }>(
    MERGE_INSTALL_STATUS_SQL,
    [setupId, JSON.stringify(installStatus), connectorVersion, runtime],
  )
  return rows[0]?.install_status ?? null
}

// ── Setup allowances ────────────────────────────────────────────────

export const LIST_SETUP_ALLOWANCES_SQL = `SELECT id, token_address, token_symbol, allowance_amount, reset_period_min
     FROM agent_connection_setup_allowances
     WHERE setup_id = $1
     ORDER BY created_at ASC`

export async function listSetupAllowances(
  setupId: string,
  db: Executor = pool,
): Promise<AllowanceRow[]> {
  const { rows } = await db.query<AllowanceRow>(LIST_SETUP_ALLOWANCES_SQL, [setupId])
  return rows
}

// ── Registration (the /register transaction's data access) ──────────
//
// The route drives these inside ONE `withSetupTransaction`, interleaved with
// its own proof/challenge/credential validation — the decisions stay there,
// the queries live here.

export const FIND_NON_REVOKED_AGENT_BY_DELEGATE_SQL = `SELECT id FROM agents
         WHERE user_id = $1 AND lower(delegate_address) = $2 AND status != 'revoked'
         LIMIT 1`

export async function findNonRevokedAgentIdByDelegate(
  userId: string,
  delegateAddress: string,
  db: Executor = pool,
): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(FIND_NON_REVOKED_AGENT_BY_DELEGATE_SQL, [
    userId,
    delegateAddress,
  ])
  return rows[0]?.id ?? null
}

export const INSERT_AGENT_FROM_SETUP_SQL = `INSERT INTO agents (
           user_id, name, description, delegate_address, api_key_hash,
           api_key_prefix, safe_id, status
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_approval')
         RETURNING id`

export async function insertAgentForSetup(
  input: {
    userId: string
    name: string
    description: string | null
    delegateAddress: string
    apiKeyHash: string
    apiKeyPrefix: string
    safeId: string
  },
  db: Executor = pool,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(INSERT_AGENT_FROM_SETUP_SQL, [
    input.userId,
    input.name,
    input.description,
    input.delegateAddress,
    input.apiKeyHash,
    input.apiKeyPrefix,
    input.safeId,
  ])
  return rows[0].id
}

export const COPY_SETUP_ALLOWANCES_TO_AGENT_SQL = `INSERT INTO agent_allowances (
           agent_id, token_address, token_symbol, allowance_amount, reset_period_min
         )
         SELECT $1, token_address, token_symbol, allowance_amount, reset_period_min
         FROM agent_connection_setup_allowances
         WHERE setup_id = $2`

export async function copySetupAllowancesToAgent(
  agentId: string,
  setupId: string,
  db: Executor = pool,
): Promise<void> {
  await db.query(COPY_SETUP_ALLOWANCES_TO_AGENT_SQL, [agentId, setupId])
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
    connectorContext: Record<string, unknown>
    installStatus: Record<string, unknown>
  },
  db: Executor = pool,
): Promise<void> {
  await db.query(MARK_SETUP_REGISTERED_SQL, [
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

// ── Approval-state persistence ──────────────────────────────────────

export const UPDATE_WALLET_APPROVAL_STATE_SQL = `UPDATE agent_connection_setups
       SET status = $3,
           approval_status = $4,
           tx_hash = $5,
           safe_tx_hash = $6,
           failure_reason = $7,
           updated_at = NOW()
       WHERE id = $1 AND user_id = $2`

export async function updateWalletApprovalState(
  input: {
    setupId: string
    userId: string
    status: string
    approvalStatus: string
    txHash: string | null
    safeTxHash: string | null
    failureReason: string | null
  },
  db: Executor = pool,
): Promise<void> {
  await db.query(UPDATE_WALLET_APPROVAL_STATE_SQL, [
    input.setupId,
    input.userId,
    input.status,
    input.approvalStatus,
    input.txHash,
    input.safeTxHash,
    input.failureReason,
  ])
}

/**
 * Idempotent activation: scoped to ('pending_approval', 'active') so it can
 * never resurrect a paused or revoked agent — the #1069 lifecycle means the
 * agent may already be active when the setup record catches up.
 */
export const ACTIVATE_PENDING_AGENT_SQL = `UPDATE agents
         SET status = 'active',
             updated_at = NOW()
         WHERE id = $1 AND user_id = $2 AND status IN ('pending_approval', 'active')`

export async function activatePendingAgent(
  agentId: string,
  userId: string,
  db: Executor = pool,
): Promise<void> {
  await db.query(ACTIVATE_PENDING_AGENT_SQL, [agentId, userId])
}

// ── Delegation-rail authority read (#1073) ──────────────────────────

export const LIST_ACTIVE_DELEGATION_BUDGETS_SQL = `SELECT token_address, budget_atomic, period_seconds
       FROM agent_delegations
       WHERE agent_id = $1 AND status = 'active'`

export interface ActiveDelegationBudget {
  token_address: string
  budget_atomic: string
  period_seconds: number
}

/**
 * The signed, activated budgets on the setup's agent. The COMPARISON against
 * the setup's promised allowances (exact amount, exact period, recipient pin
 * deliberately ignored) is authorization logic and stays in the route.
 */
export async function listActiveDelegationBudgets(
  agentId: string,
  db: Executor = pool,
): Promise<ActiveDelegationBudget[]> {
  const { rows } = await db.query<ActiveDelegationBudget>(LIST_ACTIVE_DELEGATION_BUDGETS_SQL, [
    agentId,
  ])
  return rows
}

// ── Cancellation (the /cancel transaction's data access) ────────────

export const FIND_AGENT_STATUS_SQL = `SELECT status FROM agents WHERE id = $1 AND user_id = $2`

export async function findAgentStatus(
  agentId: string,
  userId: string,
  db: Executor = pool,
): Promise<string | null> {
  const { rows } = await db.query<{ status: string }>(FIND_AGENT_STATUS_SQL, [agentId, userId])
  return rows[0]?.status ?? null
}

/**
 * Guarded cancel: the WHERE re-states the route's preconditions so a
 * concurrent approval between read and write makes this a no-op (false)
 * instead of cancelling an approved setup.
 */
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

export async function cancelSetup(
  setupId: string,
  userId: string,
  db: Executor = pool,
): Promise<boolean> {
  const { rows } = await db.query<{ id: string }>(CANCEL_SETUP_SQL, [setupId, userId])
  return rows.length > 0
}

/** Scoped to 'pending_approval' — an activated agent is never revoked by cancel (#1073). */
export const REVOKE_PENDING_AGENT_SQL = `UPDATE agents
             SET status = 'revoked',
                 api_key_hash = NULL,
                 api_key_prefix = NULL,
                 updated_at = NOW()
             WHERE id = $1 AND user_id = $2 AND status = 'pending_approval'`

export async function revokePendingAgent(
  agentId: string,
  userId: string,
  db: Executor = pool,
): Promise<void> {
  await db.query(REVOKE_PENDING_AGENT_SQL, [agentId, userId])
}
