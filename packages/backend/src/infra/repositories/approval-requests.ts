/**
 * Data access for the `approval_requests` aggregate (#995, epic #980 M3).
 *
 * An approval request is the human circuit breaker: a payment that exceeds the
 * remaining on-chain allowance queues here for the owner instead of executing.
 * Extracted verbatim from `routes/payments.ts`, `routes/machine-payments.ts`
 * (/send), `routes/x402.ts`, `lib/machine-payments.ts` (moved to
 * `modules/mpp/` by #997) and `lib/agent-payment-status.ts`.
 *
 * Convention — see `README.md` in this directory. Executor last, defaulting to
 * the pool; `agentId` tenant scope is a required parameter; SQL lives in
 * exported constants so `scripts/db-schema-smoke.ts` can PREPARE it by import.
 *
 * **The SQL here is verbatim from the call sites.** Behaviour-preserving by
 * construction. The machine-approval insert keeps its `ON CONFLICT … DO
 * NOTHING` arbiter — the idempotency guard travels with the write it protects.
 */

import pool from '../../db.js'
import { type Executor } from '../transaction.js'

export type { Executor }

// ── Row shapes ───────────────────────────────────────────────────────────────

export interface ApprovalRequestSummaryRow {
  id: string
  status: string
  expires_at: string
}

export interface X402ApprovalRow {
  id: string
  status: string
  token_symbol: string
  amount_human: string
  expires_at: string
  machine_challenge_id: string | null
}

export interface SendApprovalReplayRow {
  id: string
  status: string
  expires_at: string
  token_symbol: string
  amount_human: string
  token_address: string
  to_address: string
  amount_raw: string
}

export interface MachineApprovalRow {
  id: string
  chain_id: number
  status: string
  token_symbol: string
  token_address: string | null
  amount_human: string
  amount_raw: string | null
  expires_at: string
  tx_hash: string | null
  machine_challenge_id: string | null
  payment_rail: string | null
  payment_resource_url: string | null
  merchant_address: string | null
  machine_idempotency_key: string | null
  machine_metadata: unknown
}

export interface ApprovalStatusRow {
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
  machine_challenge_id: string | null
  machine_idempotency_key: string | null
  machine_metadata: unknown
}

// ── Inserts ──────────────────────────────────────────────────────────────────

export const INSERT_PAYMENT_APPROVAL_SQL = `INSERT INTO approval_requests (
          agent_id, user_id, safe_address, chain_id, token_symbol, token_address,
          to_address, amount_raw, amount_human, reason, status, expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending',
          NOW() + interval '24 hours')
        RETURNING id, status, expires_at`

export interface NewApprovalRequest {
  agentId: string
  userId: string
  safeAddress: string
  chainId: number
  tokenSymbol: string
  tokenAddress: string
  toAddress: string
  amountRaw: string
  amountHuman: string
  reason: string
}

/** Over-allowance queue for the direct `POST /payments` flow. */
export async function insertPaymentApproval(
  input: NewApprovalRequest,
  db: Executor = pool,
): Promise<ApprovalRequestSummaryRow> {
  const result = await db.query<ApprovalRequestSummaryRow>(INSERT_PAYMENT_APPROVAL_SQL, [
    input.agentId,
    input.userId,
    input.safeAddress,
    input.chainId,
    input.tokenSymbol,
    input.tokenAddress,
    input.toAddress,
    input.amountRaw,
    input.amountHuman,
    input.reason,
  ])
  return result.rows[0]
}

export const INSERT_SEND_APPROVAL_SQL = `INSERT INTO approval_requests (
            agent_id, user_id, safe_address, chain_id, token_symbol, token_address,
            to_address, amount_raw, amount_human, reason, send_idempotency_key, status, expires_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending',
            NOW() + interval '24 hours')
          RETURNING id, status, expires_at`

/**
 * `/machine-payments/send` over-allowance queue. The `send_idempotency_key`
 * partial unique index makes a concurrent duplicate throw `23505`, which the
 * caller maps to an idempotent replay of the winner.
 */
export async function insertSendApproval(
  input: NewApprovalRequest & { sendIdempotencyKey: string | null },
  db: Executor = pool,
): Promise<ApprovalRequestSummaryRow> {
  const result = await db.query<ApprovalRequestSummaryRow>(INSERT_SEND_APPROVAL_SQL, [
    input.agentId,
    input.userId,
    input.safeAddress,
    input.chainId,
    input.tokenSymbol,
    input.tokenAddress,
    input.toAddress,
    input.amountRaw,
    input.amountHuman,
    input.reason,
    input.sendIdempotencyKey,
  ])
  return result.rows[0]
}

export const INSERT_MACHINE_APPROVAL_SQL = `INSERT INTO approval_requests (
      agent_id, user_id, safe_address, chain_id, token_symbol, token_address,
      to_address, amount_raw, amount_human, reason, source, x402_resource_url,
      payment_rail, payment_resource_url, merchant_address, machine_challenge_id,
      machine_idempotency_key, machine_metadata, status, expires_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
      $13, $14, $15, $16, $17, $18, 'pending', NOW() + interval '24 hours')
    ON CONFLICT (agent_id, machine_idempotency_key)
      WHERE machine_idempotency_key IS NOT NULL
        AND status NOT IN ('expired')
    DO NOTHING
    RETURNING id, chain_id, status, token_symbol, token_address, amount_human,
              amount_raw, expires_at, tx_hash, machine_challenge_id, payment_rail,
              payment_resource_url, merchant_address, machine_idempotency_key,
              machine_metadata`

export interface NewMachineApproval {
  agent: { id: string; user_id: string; safe_address: string; chain_id: number }
  rail: string
  payTo: string
  tokenSymbol: string
  tokenAddress: string
  amountRaw: bigint
  amountHuman: string
  reason: string
  resourceUrl: string
  merchantAddress: string | null
  challengeId: string | null
  idempotencyKey: string | null
  /** Plain object — serialised to JSON here; pass null to store SQL NULL. */
  metadata: unknown | null
}

/**
 * The single, rail-agnostic machine-approval writer (MPP rails + x402), so the
 * column set, ON CONFLICT target, and 'pending'/24h semantics cannot drift
 * between paths. Returns the inserted row, or `null` on an idempotent replay
 * (ON CONFLICT … DO NOTHING suppressed the insert) — callers own the reload.
 */
export async function insertMachineApproval(
  input: NewMachineApproval,
  db: Executor = pool,
): Promise<MachineApprovalRow | null> {
  const {
    agent, rail, payTo, tokenSymbol, tokenAddress, amountRaw, amountHuman,
    reason, resourceUrl, merchantAddress, challengeId, idempotencyKey, metadata,
  } = input
  const result = await db.query<MachineApprovalRow>(INSERT_MACHINE_APPROVAL_SQL, [
    agent.id, agent.user_id, agent.safe_address, agent.chain_id,
    tokenSymbol, tokenAddress, payTo.toLowerCase(),
    amountRaw.toString(), amountHuman, reason, rail,
    rail === 'x402' ? resourceUrl : null,
    rail, resourceUrl, merchantAddress?.toLowerCase() ?? null, challengeId ?? null,
    idempotencyKey ?? null, metadata != null ? JSON.stringify(metadata) : null,
  ])
  return result.rows[0] ?? null
}

// ── Idempotency lookups ──────────────────────────────────────────────────────

export const FIND_SEND_APPROVAL_BY_KEY_SQL = `SELECT id, status, expires_at, token_symbol, amount_human,
            token_address, to_address, amount_raw
     FROM approval_requests
     WHERE agent_id = $1 AND send_idempotency_key = $2
       AND status NOT IN ('rejected', 'expired')
     ORDER BY created_at DESC
     LIMIT 1`

export async function findSendApprovalByIdempotencyKey(
  agentId: string,
  idempotencyKey: string,
  db: Executor = pool,
): Promise<SendApprovalReplayRow | null> {
  const result = await db.query<SendApprovalReplayRow>(FIND_SEND_APPROVAL_BY_KEY_SQL, [
    agentId,
    idempotencyKey,
  ])
  return result.rows[0] ?? null
}

export const FIND_X402_APPROVAL_BY_KEY_SQL = `SELECT id, status, token_symbol, amount_human, expires_at,
                machine_challenge_id
         FROM approval_requests
         WHERE agent_id = $1
           AND machine_idempotency_key = $2
           AND COALESCE(payment_rail, source) = 'x402'
           AND status <> 'expired'
         ORDER BY created_at DESC
         LIMIT 1`

export async function findX402ApprovalByIdempotencyKey(
  agentId: string,
  idempotencyKey: string,
  db: Executor = pool,
): Promise<X402ApprovalRow | null> {
  const result = await db.query<X402ApprovalRow>(FIND_X402_APPROVAL_BY_KEY_SQL, [
    agentId,
    idempotencyKey,
  ])
  return result.rows[0] ?? null
}

export const FIND_MACHINE_APPROVAL_BY_KEY_OR_CHALLENGE_SQL = `SELECT id, chain_id, status, token_symbol, token_address, amount_human,
            amount_raw, expires_at, tx_hash, machine_challenge_id, payment_rail,
            payment_resource_url, merchant_address, machine_idempotency_key,
            machine_metadata
     FROM approval_requests
     WHERE agent_id = $1
       AND status <> 'expired'
       AND (
         ($2::TEXT IS NOT NULL AND machine_idempotency_key = $2)
         OR (
           $3::TEXT IS NOT NULL
           AND machine_challenge_id = $3
           AND payment_rail = $4
         )
       )
     ORDER BY created_at DESC
     LIMIT 1`

// #1987 (epic #1440): `findMachineApprovalByKeyOrChallenge` is DELETED — its
// only caller on `origin/dev` was `modules/mpp/authorize.ts`, removed by this
// slice. The three INSERT helpers below are equally uncalled but stay as one
// cluster for #1990; see the note in `payment-intents.ts` for why.


// ── Status (lib/agent-payment-status.ts) ─────────────────────────────────────

export const EXPIRE_OVERDUE_APPROVAL_SQL = `UPDATE approval_requests
     SET status = 'expired'
     WHERE id = $1 AND agent_id = $2 AND status IN ('pending', 'approved') AND expires_at < NOW()`

/** Lazy expiry before a status read. */
export async function expireOverdueApproval(
  approvalId: string,
  agentId: string,
  db: Executor = pool,
): Promise<void> {
  await db.query(EXPIRE_OVERDUE_APPROVAL_SQL, [approvalId, agentId])
}

export const FIND_APPROVAL_STATUS_ROW_SQL = `SELECT id, chain_id, token_symbol, token_address, amount_human, amount_raw,
            status, tx_hash, expires_at,
            source, payment_rail, payment_resource_url, x402_resource_url,
            merchant_address, machine_challenge_id, machine_idempotency_key, machine_metadata
     FROM approval_requests
     WHERE id = $1 AND agent_id = $2
     LIMIT 1`

export async function findApprovalStatusRow(
  approvalId: string,
  agentId: string,
  db: Executor = pool,
): Promise<ApprovalStatusRow | null> {
  const result = await db.query<ApprovalStatusRow>(FIND_APPROVAL_STATUS_ROW_SQL, [
    approvalId,
    agentId,
  ])
  return result.rows[0] ?? null
}

// ── Counters ─────────────────────────────────────────────────────────────────

/**
 * How many approvals is this owner expected to act on?
 *
 * `'approved'` is in the set deliberately: an approved request is not finished
 * — it has been authorised but not yet executed, so it still represents
 * outstanding work. Only terminal states (executed, rejected, expired) drop out.
 *
 * Converged from two byte-different copies of the same question (#1179): the
 * dashboard and the agent-activity surface each carried their own constant,
 * identical but for `AS`/`as` casing. They had drifted apart in spelling only,
 * which is the cheapest moment to converge them — the aggregate owns the
 * question, not the surfaces that ask it.
 */
export const COUNT_ACTIONABLE_APPROVALS_FOR_USER_SQL = `SELECT COUNT(*) AS count
         FROM approval_requests
         WHERE user_id = $1 AND status IN ('pending', 'approved')`

/** `userId` is REQUIRED — it is the tenant scope of the count. */
export async function countActionableApprovalsForUser(
  userId: string,
  db: Executor = pool,
): Promise<number> {
  const result = await db.query<{ count: string }>(COUNT_ACTIONABLE_APPROVALS_FOR_USER_SQL, [userId])
  // `COUNT(*)` always returns exactly one row; the fallback is belt-and-braces
  // for a caller that hands in a mock returning none.
  return Number(result.rows[0]?.count ?? '0')
}

/**
 * #1328 (review finding on #1339): the rail of an approval row, using the
 * SAME payment_rail-first derivation GET /approvals reports. Diagnostic read
 * only — the routes use it on an empty guarded-UPDATE result to distinguish
 * the mpp_demo retirement refusal (410) from plain not-found (404).
 */
export const GET_APPROVAL_RAIL_SQL = `SELECT payment_rail, source
         FROM approval_requests
         WHERE id = $1 AND user_id = $2`

/** `userId` is REQUIRED — tenant scope. Null when the row does not exist. */
export async function getApprovalRail(
  approvalId: string,
  userId: string,
  db: Executor = pool,
): Promise<string | null> {
  const result = await db.query<{ payment_rail: string | null; source: string | null }>(
    GET_APPROVAL_RAIL_SQL,
    [approvalId, userId],
  )
  const row = result.rows[0]
  return row ? (row.payment_rail ?? row.source) : null
}
