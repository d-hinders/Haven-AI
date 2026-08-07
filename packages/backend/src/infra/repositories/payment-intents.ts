/**
 * Data access for the `payment_intents` aggregate (#995, epic #980 M3).
 *
 * Extracted verbatim from `routes/payments.ts`, `routes/machine-payments.ts`
 * (/send), `lib/machine-payments.ts` (moved to `modules/mpp/` by #997),
 * `lib/agent-payment-status.ts` and
 * `lib/receipt.ts` — the money path's intent lifecycle: create (per rail),
 * claim, confirm, fail, expire, and the idempotency lookups that make a retry
 * resume instead of double-spend.
 *
 * Convention — see `README.md` in this directory. Executor last, defaulting to
 * the pool; tenant scoping (`agentId`) is a required parameter; SQL lives in
 * exported constants so `scripts/db-schema-smoke.ts` can PREPARE it by import.
 *
 * **The SQL here is verbatim from the call sites.** This extraction is
 * behaviour-preserving by construction; anything that looked improvable was
 * left alone and reported in the pull request instead. In particular the
 * status-guarded compare-and-swap UPDATEs (claim → confirm/fail) are the
 * concurrency control on this table — each write carries its own guard in its
 * WHERE clause, which is why none of these functions needs a transaction.
 */

import pool from '../../db.js'
import { withTransaction, type Executor } from '../transaction.js'

export type { Executor }

/**
 * Run `fn` in a transaction against the app pool. Present for parity with the
 * other repositories (routes must not import `db.ts` to get a transaction);
 * the current payment flow is CAS-guarded rather than transactional, so no
 * caller uses this yet.
 */
export async function inTransaction<T>(
  fn: (tx: Executor) => Promise<T>,
  db: Executor = pool,
): Promise<T> {
  return withTransaction(db, fn)
}

// ── Row shapes ───────────────────────────────────────────────────────────────

/**
 * The full `payment_intents` row as the money path reads it (`SELECT *`).
 * Kept permissive on the machine/x402 columns because the legacy direct-send
 * flow and the machine rails share the table.
 */
export interface PaymentIntentRow {
  id: string
  agent_id: string
  user_id: string
  safe_address: string
  chain_id: number
  token_symbol: string
  token_address: string
  to_address: string
  amount_raw: string
  amount_human: string
  delegate_address: string
  allowance_nonce: number
  sign_hash: string
  signature: string | null
  tx_hash: string | null
  status: string
  error_message: string | null
  source: string | null
  x402_resource_url: string | null
  x402_category: string | null
  x402_merchant_address: string | null
  x402_idempotency_key: string | null
  payment_rail: string | null
  payment_resource_url: string | null
  merchant_address: string | null
  machine_challenge_id: string | null
  machine_idempotency_key: string | null
  machine_metadata: unknown
  created_at: string
  signed_at: string | null
  submitted_at: string | null
  confirmed_at: string | null
  expires_at: string
  /** Execution rail pinned at authorize time; null = legacy AllowanceModule (#745). */
  execution_rail?: string | null
  /** Smart Sessions permissionId pinned at authorize time (retired rail, #834). */
  session_permission_id?: string | null
  /** Serialized prepared UserOperation for session-rail intents. */
  session_user_op?: unknown
  /** Which delegation authorized a delegation-rail intent (#829). */
  delegation_hash?: string | null
  /** The metering budget, uniform across schemes (#1059). */
  budget_delegation_hash?: string | null
  /** Serialized prepared redemption UserOperation for delegation intents. */
  prepared_user_op?: unknown
}

// ── Reads ────────────────────────────────────────────────────────────────────

export const FIND_INTENT_FOR_AGENT_SQL = `SELECT * FROM payment_intents WHERE id = $1 AND agent_id = $2`

/** `agentId` is the tenant scope — an agent can only read its own intents. */
export async function findIntentForAgent(
  intentId: string,
  agentId: string,
  db: Executor = pool,
): Promise<PaymentIntentRow | null> {
  const result = await db.query<PaymentIntentRow>(FIND_INTENT_FOR_AGENT_SQL, [intentId, agentId])
  return result.rows[0] ?? null
}

export const GET_INTENT_STATUS_SQL = `SELECT status FROM payment_intents WHERE id = $1 AND agent_id = $2`

/** The current status, or `'unknown'` — the shape every 409 responder wants. */
export async function getIntentStatus(
  intentId: string,
  agentId: string,
  db: Executor = pool,
): Promise<string> {
  const current = await db.query<{ status: string }>(GET_INTENT_STATUS_SQL, [intentId, agentId])
  return current.rows[0]?.status ?? 'unknown'
}

export const LIST_INTENTS_FOR_AGENT_SQL = `SELECT * FROM payment_intents WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 50`

export async function listIntentsForAgent(
  agentId: string,
  db: Executor = pool,
): Promise<PaymentIntentRow[]> {
  const result = await db.query<PaymentIntentRow>(LIST_INTENTS_FOR_AGENT_SQL, [agentId])
  return result.rows
}

// ── Inserts (one per rail shape) ─────────────────────────────────────────────

export const INSERT_DELEGATION_INTENT_SQL = `INSERT INTO payment_intents (
          agent_id, user_id, safe_address, chain_id, token_symbol, token_address,
          to_address, amount_raw, amount_human, delegate_address,
          allowance_nonce, sign_hash,
          execution_rail, delegation_hash, budget_delegation_hash, prepared_user_op,
          status, expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
          'pending_signature', NOW() + interval '10 minutes')
        RETURNING *`

export interface NewDelegationIntent {
  agentId: string
  userId: string
  safeAddress: string
  chainId: number
  tokenSymbol: string
  tokenAddress: string
  toAddress: string
  amountRaw: string
  amountHuman: string
  delegateAddress: string
  allowanceNonce: number
  signHash: string
  executionRail: 'delegation'
  delegationHash: string
  /** #1059: the metering budget — same value as delegationHash on direct transfers. */
  budgetDelegationHash: string
  preparedUserOp: string
}

/** Direct delegation-rail transfer intent (`POST /payments`, #829). */
export async function insertDelegationIntent(
  input: NewDelegationIntent,
  db: Executor = pool,
): Promise<PaymentIntentRow> {
  const result = await db.query<PaymentIntentRow>(INSERT_DELEGATION_INTENT_SQL, [
    input.agentId, input.userId, input.safeAddress, input.chainId,
    input.tokenSymbol, input.tokenAddress, input.toAddress,
    input.amountRaw, input.amountHuman, input.delegateAddress,
    input.allowanceNonce,
    input.signHash,
    input.executionRail,
    input.delegationHash,
    input.budgetDelegationHash,
    input.preparedUserOp,
  ])
  return result.rows[0]
}

export const INSERT_LEGACY_INTENT_SQL = `INSERT INTO payment_intents (
        agent_id, user_id, safe_address, chain_id, token_symbol, token_address,
        to_address, amount_raw, amount_human, delegate_address,
        allowance_nonce, sign_hash, status, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending_signature',
        NOW() + interval '10 minutes')
      RETURNING *`

export interface NewLegacyIntent {
  agentId: string
  userId: string
  safeAddress: string
  chainId: number
  tokenSymbol: string
  tokenAddress: string
  toAddress: string
  amountRaw: string
  amountHuman: string
  delegateAddress: string
  allowanceNonce: number
  signHash: string
}

/** Legacy AllowanceModule transfer intent (`POST /payments`). */
export async function insertLegacyIntent(
  input: NewLegacyIntent,
  db: Executor = pool,
): Promise<PaymentIntentRow> {
  const result = await db.query<PaymentIntentRow>(INSERT_LEGACY_INTENT_SQL, [
    input.agentId,
    input.userId,
    input.safeAddress,
    input.chainId,
    input.tokenSymbol,
    input.tokenAddress,
    input.toAddress,
    input.amountRaw,
    input.amountHuman,
    input.delegateAddress,
    input.allowanceNonce,
    input.signHash,
  ])
  return result.rows[0]
}

export const INSERT_SEND_INTENT_SQL = `INSERT INTO payment_intents (
          agent_id, user_id, safe_address, chain_id, token_symbol, token_address,
          to_address, amount_raw, amount_human, delegate_address,
          allowance_nonce, sign_hash, send_idempotency_key, status, expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'pending_signature',
          NOW() + interval '10 minutes')
        RETURNING id, status, expires_at`

export interface SendIntentRow {
  id: string
  status: string
  expires_at: string
}

/**
 * `/machine-payments/send` intent. The `send_idempotency_key` column carries a
 * partial unique index (migration 020) — a concurrent duplicate throws
 * `23505`, which the caller maps to an idempotent replay. The guard is the
 * index, so the insert and its conflict semantics travel together here.
 */
export async function insertSendIntent(
  input: NewLegacyIntent & { sendIdempotencyKey: string | null },
  db: Executor = pool,
): Promise<SendIntentRow> {
  const result = await db.query<SendIntentRow>(INSERT_SEND_INTENT_SQL, [
    input.agentId,
    input.userId,
    input.safeAddress,
    input.chainId,
    input.tokenSymbol,
    input.tokenAddress,
    input.toAddress,
    input.amountRaw,
    input.amountHuman,
    input.delegateAddress,
    input.allowanceNonce,
    input.signHash,
    input.sendIdempotencyKey,
  ])
  return result.rows[0]
}

/**
 * The machine-rail intent insert, called directly by both `modules/mpp/` and
 * `modules/x402/` (#997 removed the `lib/machine-payments.createPaymentIntent`
 * pass-through — it added no logic over this function, and kept x402 coupled
 * to a private mpp file once mpp's orchestration moved into its module).
 * Parameterised by its ON CONFLICT arbiter so x402 and the MPP rails keep
 * their exact dedup semantics; the two concrete statements are the exported
 * constants below (what the smoke test PREPAREs). `conflictColumn` is a strict
 * union mapped through this template — never raw input — so the interpolation
 * is injection-safe.
 */
function machineIntentInsertSql(
  conflictColumn: 'machine_idempotency_key' | 'x402_idempotency_key',
): string {
  return `INSERT INTO payment_intents (
      agent_id, user_id, safe_address, chain_id, token_symbol, token_address,
      to_address, amount_raw, amount_human, delegate_address,
      allowance_nonce, sign_hash, status, source, x402_resource_url, x402_category,
      x402_merchant_address, x402_idempotency_key,
      payment_rail, payment_resource_url, merchant_address, machine_challenge_id,
      machine_idempotency_key, machine_metadata,
      execution_rail, session_permission_id, session_user_op,
      delegation_hash, budget_delegation_hash, prepared_user_op, expires_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
      'pending_signature', $13, $14, $15, $16, $17,
      $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, NOW() + interval '10 minutes')
    ON CONFLICT (agent_id, ${conflictColumn})
      WHERE ${conflictColumn} IS NOT NULL
        AND status NOT IN ('failed', 'expired')
    DO NOTHING
    RETURNING *`
}

export const INSERT_MACHINE_INTENT_MACHINE_KEY_SQL = machineIntentInsertSql('machine_idempotency_key')
export const INSERT_MACHINE_INTENT_X402_KEY_SQL = machineIntentInsertSql('x402_idempotency_key')

export interface NewMachineIntent {
  agent: { id: string; user_id: string; safe_address: string; chain_id: number; delegate_address: string }
  rail: string
  payTo: string
  tokenSymbol: string
  tokenAddress: string
  amountRaw: bigint
  amountHuman: string
  allowanceNonce: number
  signHash: string
  resourceUrl: string
  category: string | null
  merchantAddress: string | null
  challengeId: string | null
  idempotencyKey: string | null
  /** Plain object — serialised to JSON here; pass null to store SQL NULL. */
  metadata: unknown | null
  executionRail?: 'delegation'
  sessionPermissionId?: string
  sessionUserOp?: string
  delegationHash?: string
  budgetDelegationHash?: string
  preparedUserOp?: string
  conflictTarget: 'machine_idempotency_key' | 'x402_idempotency_key'
}

/**
 * Returns the inserted row, or `null` when ON CONFLICT … DO NOTHING suppressed
 * the insert (an idempotent replay won the race). Callers own the reload of
 * the pre-existing row. The x402-only column mapping (`x402_resource_url`,
 * `x402_merchant_address`, `x402_idempotency_key` filled only when the rail is
 * x402) is part of the write's semantics and lives here with it.
 */
export async function insertMachineIntent(
  input: NewMachineIntent,
  db: Executor = pool,
): Promise<PaymentIntentRow | null> {
  const {
    agent, rail, payTo, tokenSymbol, tokenAddress, amountRaw, amountHuman,
    allowanceNonce, signHash, resourceUrl, category, merchantAddress,
    challengeId, idempotencyKey, metadata,
    executionRail, sessionPermissionId, sessionUserOp,
    delegationHash, budgetDelegationHash, preparedUserOp, conflictTarget,
  } = input
  const sql =
    conflictTarget === 'x402_idempotency_key'
      ? INSERT_MACHINE_INTENT_X402_KEY_SQL
      : INSERT_MACHINE_INTENT_MACHINE_KEY_SQL
  const result = await db.query<PaymentIntentRow>(sql, [
    agent.id, agent.user_id, agent.safe_address, agent.chain_id,
    tokenSymbol, tokenAddress, payTo.toLowerCase(),
    amountRaw.toString(), amountHuman, agent.delegate_address,
    allowanceNonce, signHash,
    rail, rail === 'x402' ? resourceUrl : null, category ?? null,
    rail === 'x402' ? merchantAddress?.toLowerCase() ?? null : null,
    rail === 'x402' ? idempotencyKey ?? null : null,
    rail, resourceUrl, merchantAddress?.toLowerCase() ?? null, challengeId ?? null,
    idempotencyKey ?? null, metadata != null ? JSON.stringify(metadata) : null,
    executionRail ?? null, sessionPermissionId ?? null, sessionUserOp ?? null,
    delegationHash ?? null, budgetDelegationHash ?? null, preparedUserOp ?? null,
  ])
  return result.rows[0] ?? null
}

// ── Idempotency lookups ──────────────────────────────────────────────────────

export const FIND_SEND_INTENT_BY_KEY_SQL = `SELECT id, status, expires_at, token_address, to_address,
            amount_raw, amount_human, allowance_nonce, sign_hash
     FROM payment_intents
     WHERE agent_id = $1 AND send_idempotency_key = $2
       AND status NOT IN ('failed', 'expired')
     ORDER BY created_at DESC
     LIMIT 1`

export interface SendIntentReplayRow {
  id: string
  status: string
  expires_at: string
  token_address: string
  to_address: string
  amount_raw: string
  amount_human: string
  allowance_nonce: number
  sign_hash: string
}

export async function findSendIntentByIdempotencyKey(
  agentId: string,
  idempotencyKey: string,
  db: Executor = pool,
): Promise<SendIntentReplayRow | null> {
  const result = await db.query<SendIntentReplayRow>(FIND_SEND_INTENT_BY_KEY_SQL, [
    agentId,
    idempotencyKey,
  ])
  return result.rows[0] ?? null
}

export const FIND_MACHINE_INTENT_BY_KEY_OR_CHALLENGE_SQL = `SELECT *
     FROM payment_intents
     WHERE agent_id = $1
       AND status NOT IN ('failed', 'expired')
       AND COALESCE(payment_rail, source) = $4
       AND (
         ($2::TEXT IS NOT NULL AND (
           machine_idempotency_key = $2
           OR x402_idempotency_key = $2
         ))
         OR (
           $3::TEXT IS NOT NULL
           AND machine_challenge_id = $3
           AND payment_rail = $4
         )
       )
     ORDER BY created_at DESC
     LIMIT 1`

export async function findMachineIntentByKeyOrChallenge(
  agentId: string,
  idempotencyKey: string | null,
  challengeId: string | null,
  rail: string,
  db: Executor = pool,
): Promise<PaymentIntentRow | null> {
  const result = await db.query<PaymentIntentRow>(FIND_MACHINE_INTENT_BY_KEY_OR_CHALLENGE_SQL, [
    agentId,
    idempotencyKey,
    challengeId,
    rail,
  ])
  return result.rows[0] ?? null
}

// ── Status transitions (each carries its guard in its WHERE clause) ─────────

export const EXPIRE_PENDING_INTENT_SQL = `UPDATE payment_intents
           SET status = 'expired'
           WHERE id = $1 AND agent_id = $2 AND status = 'pending_signature'`

/** Flip an intent the caller has already judged expired. Guarded, no read-back. */
export async function expirePendingIntent(
  intentId: string,
  agentId: string,
  db: Executor = pool,
): Promise<void> {
  await db.query(EXPIRE_PENDING_INTENT_SQL, [intentId, agentId])
}

export const EXPIRE_PENDING_INTENT_RETURNING_STATUS_SQL = `UPDATE payment_intents
         SET status = 'expired'
         WHERE id = $1 AND agent_id = $2 AND status = 'pending_signature'
         RETURNING status`

/** Same flip, but reports the resulting status (GET /payments/:id read path). */
export async function expirePendingIntentReturningStatus(
  intentId: string,
  agentId: string,
  db: Executor = pool,
): Promise<string | null> {
  const result = await db.query<{ status: string }>(EXPIRE_PENDING_INTENT_RETURNING_STATUS_SQL, [
    intentId,
    agentId,
  ])
  return result.rows[0]?.status ?? null
}

export const EXPIRE_OVERDUE_INTENT_RETURNING_STATUS_SQL = `UPDATE payment_intents
           SET status = 'expired'
           WHERE id = $1
             AND agent_id = $2
             AND status = 'pending_signature'
             AND expires_at <= NOW()
           RETURNING status`

/**
 * Expire an intent only if the database clock agrees it is overdue. True when
 * the flip happened — the losing branch of the claim CAS uses this to tell
 * "expired" apart from "someone else claimed it".
 */
export async function expireOverdueIntent(
  intentId: string,
  agentId: string,
  db: Executor = pool,
): Promise<boolean> {
  const result = await db.query<{ status: string }>(EXPIRE_OVERDUE_INTENT_RETURNING_STATUS_SQL, [
    intentId,
    agentId,
  ])
  return result.rows.length > 0
}

export const EXPIRE_OVERDUE_INTENT_BY_ID_SQL = `UPDATE payment_intents
     SET status = 'expired'
     WHERE id = $1 AND agent_id = $2 AND status = 'pending_signature' AND expires_at < NOW()`

/** Lazy expiry before a status read (`lib/agent-payment-status.ts`). */
export async function expireOverdueIntentById(
  intentId: string,
  agentId: string,
  db: Executor = pool,
): Promise<void> {
  await db.query(EXPIRE_OVERDUE_INTENT_BY_ID_SQL, [intentId, agentId])
}

export const EXPIRE_OVERDUE_INTENTS_FOR_AGENT_SQL = `UPDATE payment_intents
       SET status = 'expired'
       WHERE agent_id = $1 AND status = 'pending_signature' AND expires_at < NOW()`

/** Lazy expiry sweep before the agent's intent list (GET /payments). */
export async function expireOverdueIntentsForAgent(
  agentId: string,
  db: Executor = pool,
): Promise<void> {
  await db.query(EXPIRE_OVERDUE_INTENTS_FOR_AGENT_SQL, [agentId])
}

export const CLAIM_INTENT_FOR_SUBMISSION_SQL = `UPDATE payment_intents
         SET signature = $1, signed_at = NOW(), status = 'submitted', submitted_at = NOW()
         WHERE id = $2
           AND agent_id = $3
           AND status = 'pending_signature'
           AND expires_at > NOW()
         RETURNING id`

/**
 * Atomically claim a pending intent before any on-chain execution
 * (`POST /payments/:id/sign`). The WHERE clause is the whole double-spend
 * guard: two concurrent signs race this CAS and exactly one proceeds. False
 * when the claim was lost — caller distinguishes expired vs already-claimed.
 */
export async function claimIntentForSubmission(
  signature: string,
  intentId: string,
  agentId: string,
  db: Executor = pool,
): Promise<boolean> {
  const result = await db.query<{ id: string }>(CLAIM_INTENT_FOR_SUBMISSION_SQL, [
    signature,
    intentId,
    agentId,
  ])
  return result.rows.length > 0
}

export const CONFIRM_SUBMITTED_INTENT_SQL = `UPDATE payment_intents
         SET status = 'confirmed',
             tx_hash = $1,
             confirmed_at = NOW(),
             usd_value = $3,
             eur_value = $4
         WHERE id = $2 AND agent_id = $5 AND status = 'submitted'
         RETURNING id`

/** Confirm a claimed (`submitted`) intent after on-chain success. */
export async function confirmSubmittedIntent(
  input: {
    txHash: string
    intentId: string
    usdValue: number | string | null
    eurValue: number | string | null
    agentId: string
  },
  db: Executor = pool,
): Promise<boolean> {
  const result = await db.query<{ id: string }>(CONFIRM_SUBMITTED_INTENT_SQL, [
    input.txHash,
    input.intentId,
    input.usdValue,
    input.eurValue,
    input.agentId,
  ])
  return result.rows.length > 0
}

export const RELEASE_SUBMITTED_CLAIM_SQL = `UPDATE payment_intents SET status = 'pending_signature'
           WHERE id = $1 AND status = 'submitted' AND tx_hash IS NULL`

/**
 * #717/#1119: a relayer-budget refusal happens BEFORE any broadcast, but the
 * sign route claims the intent first — release the claim or the row is stuck
 * unretryable forever. `tx_hash IS NULL` keeps this from ever un-confirming a
 * broadcast payment.
 */
export async function releaseSubmittedClaim(intentId: string, db: Executor = pool): Promise<void> {
  await db.query(RELEASE_SUBMITTED_CLAIM_SQL, [intentId])
}

export const FAIL_SUBMITTED_INTENT_SQL = `UPDATE payment_intents
         SET status = 'failed', error_message = $1
         WHERE id = $2 AND agent_id = $3 AND status = 'submitted'`

/** Record an execution failure on a claimed intent (error message pre-redacted). */
export async function failSubmittedIntent(
  errorMessage: string,
  intentId: string,
  agentId: string,
  db: Executor = pool,
): Promise<void> {
  await db.query(FAIL_SUBMITTED_INTENT_SQL, [errorMessage, intentId, agentId])
}

// ── Machine-rail transitions (rail-scoped guards, modules/mpp/authorize.ts) ──

export const REFRESH_MACHINE_INTENT_NONCE_SQL = `UPDATE payment_intents
         SET allowance_nonce = $1,
             sign_hash = $2,
             expires_at = NOW() + interval '10 minutes'
         WHERE id = $3
           AND agent_id = $4
           AND COALESCE(payment_rail, source) = $5
           AND status = 'pending_signature'
           AND tx_hash IS NULL
         RETURNING id`

/**
 * Refresh a pending machine intent whose AllowanceModule nonce moved under it.
 * False when the row progressed meanwhile — the caller must 409, not sign.
 */
export async function refreshMachineIntentNonce(
  input: { allowanceNonce: number; signHash: string; intentId: string; agentId: string; rail: string },
  db: Executor = pool,
): Promise<boolean> {
  const result = await db.query<{ id: string }>(REFRESH_MACHINE_INTENT_NONCE_SQL, [
    input.allowanceNonce,
    input.signHash,
    input.intentId,
    input.agentId,
    input.rail,
  ])
  return result.rows.length > 0
}

export const RECORD_MACHINE_INTENT_SIGNATURE_SQL = `UPDATE payment_intents
     SET signature = $1, signed_at = NOW()
     WHERE id = $2
       AND agent_id = $3
       AND payment_rail = $4
       AND status = 'pending_signature'
       AND tx_hash IS NULL
     RETURNING id`

/**
 * One-shot mode records the signature WITHOUT claiming to 'submitted' — the
 * intent stays 'pending_signature' until execution succeeds, so a crash
 * between here and the RPC call cannot strand it (see the caller's comment).
 */
export async function recordMachineIntentSignature(
  signature: string,
  intentId: string,
  agentId: string,
  rail: string,
  db: Executor = pool,
): Promise<boolean> {
  const result = await db.query<{ id: string }>(RECORD_MACHINE_INTENT_SIGNATURE_SQL, [
    signature,
    intentId,
    agentId,
    rail,
  ])
  return result.rows.length > 0
}

export const CONFIRM_MACHINE_INTENT_SQL = `UPDATE payment_intents
       SET status = 'confirmed',
           tx_hash = $1,
           submitted_at = NOW(),
           confirmed_at = NOW(),
           usd_value = $3,
           eur_value = $4
       WHERE id = $2
         AND agent_id = $5
         AND payment_rail = $6
         AND status = 'pending_signature'
         AND tx_hash IS NULL
       RETURNING id`

/** One-shot confirm: 'pending_signature' → 'confirmed' in one guarded write. */
export async function confirmMachineIntent(
  input: {
    txHash: string
    intentId: string
    usdValue: number | string | null
    eurValue: number | string | null
    agentId: string
    rail: string
  },
  db: Executor = pool,
): Promise<boolean> {
  const result = await db.query<{ id: string }>(CONFIRM_MACHINE_INTENT_SQL, [
    input.txHash,
    input.intentId,
    input.usdValue,
    input.eurValue,
    input.agentId,
    input.rail,
  ])
  return result.rows.length > 0
}

export const FAIL_MACHINE_INTENT_SQL = `UPDATE payment_intents
       SET status = 'failed', error_message = $1
       WHERE id = $2
         AND agent_id = $3
         AND payment_rail = $4
         AND status = 'pending_signature'
         AND tx_hash IS NULL`

export async function failMachineIntent(
  errorMessage: string,
  intentId: string,
  agentId: string,
  rail: string,
  db: Executor = pool,
): Promise<void> {
  await db.query(FAIL_MACHINE_INTENT_SQL, [errorMessage, intentId, agentId, rail])
}

// ── Status projection (lib/agent-payment-status.ts) ──────────────────────────

export const FIND_INTENT_STATUS_ROW_SQL = `SELECT pi.id, pi.chain_id, pi.token_symbol, pi.token_address, pi.amount_human, pi.amount_raw,
            pi.status, pi.tx_hash, pi.expires_at,
            pi.source, pi.payment_rail, pi.payment_resource_url, pi.x402_resource_url,
            pi.merchant_address, pi.x402_merchant_address, pi.x402_idempotency_key,
            pi.machine_challenge_id, pi.machine_idempotency_key, pi.machine_metadata,
            (mpre.id IS NOT NULL) AS funded_but_unsettled
     FROM payment_intents pi
     LEFT JOIN machine_payment_reconciliation_events mpre
       ON mpre.payment_intent_id = pi.id
      AND mpre.event_type = 'merchant_retry_rejected_after_payment'
      AND mpre.status = 'open'
     WHERE pi.id = $1 AND pi.agent_id = $2
     LIMIT 1`

export interface PaymentIntentStatusRow {
  id: string
  chain_id: number
  token_symbol: string
  token_address: string | null
  amount_human: string
  amount_raw: string | null
  status: string
  tx_hash: string | null
  expires_at: string
  source: string | null
  payment_rail: string | null
  payment_resource_url: string | null
  x402_resource_url: string | null
  merchant_address: string | null
  x402_merchant_address: string | null
  x402_idempotency_key: string | null
  machine_challenge_id: string | null
  machine_idempotency_key: string | null
  machine_metadata: unknown
  /** True when an open merchant_retry_rejected_after_payment reconciliation event exists. */
  funded_but_unsettled: boolean
}

export async function findIntentStatusRow(
  intentId: string,
  agentId: string,
  db: Executor = pool,
): Promise<PaymentIntentStatusRow | null> {
  const result = await db.query<PaymentIntentStatusRow>(FIND_INTENT_STATUS_ROW_SQL, [
    intentId,
    agentId,
  ])
  return result.rows[0] ?? null
}

// ── Receipt assembly (lib/receipt.ts) ────────────────────────────────────────

export const FIND_SETTLED_PAYMENT_RECEIPT_SQL = `SELECT pi.id, pi.safe_address, pi.chain_id, pi.token_symbol, pi.token_address,
            pi.to_address, pi.amount_human, pi.delegate_address, pi.sign_hash,
            pi.signature, pi.tx_hash, pi.confirmed_at,
            mpe.resource_url AS resource_url,
            mpe.amount_sek AS amount_sek
     FROM payment_intents pi
     LEFT JOIN machine_payment_evidence mpe ON mpe.payment_intent_id = pi.id
     WHERE pi.id = $1 AND pi.agent_id = $2 AND pi.status = 'confirmed'`

export interface PaymentReceiptRow {
  id: string
  safe_address: string
  chain_id: number
  token_symbol: string
  token_address: string
  to_address: string
  amount_human: string
  delegate_address: string
  sign_hash: string
  signature: string | null
  tx_hash: string | null
  confirmed_at: string | null
  resource_url: string | null
  amount_sek: string | null
}

export async function findSettledPaymentReceiptRow(
  paymentId: string,
  agentId: string,
  db: Executor = pool,
): Promise<PaymentReceiptRow | null> {
  const result = await db.query<PaymentReceiptRow>(FIND_SETTLED_PAYMENT_RECEIPT_SQL, [
    paymentId,
    agentId,
  ])
  return result.rows[0] ?? null
}
