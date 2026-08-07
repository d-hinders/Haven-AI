/**
 * Data access for the transaction-history read model (#992, epic #980 M4):
 * the Safe list and agent list that drive aggregation, the machine-payment
 * agent-attribution lookups (`payment_intents` / `approval_requests` /
 * `delegate_sweeps`), the confirmed x402 funding lookups, the Safe-ownership
 * check behind `/transactions/:safeAddress`, and the single-evidence-row
 * lookup behind `/transactions/payment-intents/:paymentId/evidence`.
 *
 * This is NOT the `user_safes` or `agents` aggregate owner — those already
 * have their own repositories (`user-safes.ts` #988, `agents.ts` #988) with
 * a wider column set for their own routes. `transactions.ts` (the route)
 * only ever needed a 4-column safe projection and a 3-column agent
 * projection, so this file keeps that projection rather than pulling in the
 * wider rows, matching the "verbatim, not improved" extraction rule.
 *
 * Extracted verbatim from `routes/transactions.ts` (11 `.query` call sites,
 * per the #992 issue's July count) so `scripts/db-schema-smoke.ts` can
 * PREPARE every statement against the real schema. Convention: `README.md`
 * in this directory.
 *
 * Invariants a reader must not break:
 *
 * - Every machine-payment agent-attribution query joins through `user_safes
 *   us` scoped by `us.id = ANY($3)` (the caller's own Safe ids) AND matches
 *   chain — that double join is what stops a same-hash collision on another
 *   chain or another tenant's Safe from attributing an agent to the wrong
 *   transaction. Do not simplify it to a plain `tx_hash` match.
 * - `findSafeOwnership` has two SQL shapes (with/without `chain_id`) because
 *   the route decides, based on how many rows come back, whether a
 *   `chain_id` disambiguator was required — collapsing them changes that
 *   behavior.
 *
 * **The SQL here is verbatim from the route.** Anything that looked
 * improvable was left alone and reported in the pull request instead.
 */

import pool from '../../db.js'
import type { Executor } from '../transaction.js'

export type { Executor }

// ── Row shapes ───────────────────────────────────────────────────────────────

export interface TransactionSafeRow {
  id: string
  safe_address: string
  chain_id: number
  name: string
}

export interface TransactionFilterAgentRow {
  id: string
  name: string
  status: string
}

export interface SafeOwnershipRow {
  id: string
  chain_id: number
}

export interface PaymentIntentAgentRow {
  id: string
  tx_hash: string
  safe_id: string
  chain_id: number
  agent_id: string
  agent_name: string
  source: string | null
  payment_resource_url: string | null
  merchant_address: string | null
  payment_proof_status: string | null
  payment_reconciliation_event_type: string | null
  amount_sek: string | null
}

export interface ApprovalRequestAgentRow {
  id: string
  tx_hash: string
  safe_id: string
  chain_id: number
  agent_id: string
  agent_name: string
  source: string | null
  payment_resource_url: string | null
  merchant_address: string | null
  payment_proof_status: string | null
  payment_reconciliation_event_type: string | null
  amount_sek: string | null
}

export interface DelegateSweepAgentRow {
  id: string
  tx_hash: string
  safe_id: string
  chain_id: number
  agent_id: string
  agent_name: string
  from_address: string
  to_address: string
}

export interface X402PaymentIntentRow {
  id: string
  tx_hash: string
  agent_id: string
  agent_name: string
  safe_id: string
  safe_address: string
  safe_name: string
  chain_id: number
  token_symbol: string
  token_address: string
  to_address: string
  amount_raw: string
  amount_human: string
  x402_merchant_address: string | null
  x402_resource_url: string | null
  payment_proof_status: string | null
  payment_reconciliation_event_type: string | null
  amount_sek: string | null
  confirmed_at: string | null
  created_at: string
}

export interface X402ApprovalRequestRow {
  id: string
  tx_hash: string
  agent_id: string
  agent_name: string
  safe_id: string
  safe_address: string
  safe_name: string
  chain_id: number
  token_symbol: string
  token_address: string
  to_address: string
  amount_raw: string
  amount_human: string
  merchant_address: string | null
  payment_resource_url: string | null
  payment_proof_status: string | null
  payment_reconciliation_event_type: string | null
  amount_sek: string | null
  executed_at: string | null
  created_at: string
}

export interface MachinePaymentEvidenceDetailRow {
  id: string
  payment_intent_id: string | null
  approval_request_id: string | null
  rail: string
  proof_status: string
  tx_hash: string
  chain_id: number
  resource_url: string
  merchant_address: string | null
  payer_address: string
  settlement_address: string
  token_symbol: string
  token_address: string
  amount_raw: string
  amount_human: string
  challenge_id: string | null
  idempotency_key: string | null
  challenge_payload: Record<string, unknown> | null
  selected_payment: Record<string, unknown> | null
  payment_proof_header_name: string | null
  payment_proof_header: string | null
  protocol_receipt_header_name: string | null
  protocol_receipt_header: string | null
  protocol_receipt_payload: Record<string, unknown> | null
  merchant_status: number | null
  confirmed_at: string | null
  created_at: string
  updated_at: string
}

// ── Safe / agent lists that drive aggregation ───────────────────────────────

export const LIST_BASIC_SAFES_FOR_USER_SQL = `SELECT id, safe_address, chain_id, name
       FROM user_safes
       WHERE user_id = $1
       ORDER BY created_at ASC`

/** `userId` is REQUIRED — the Safe set aggregation runs over is per-tenant. */
export async function listBasicSafesForUser(
  userId: string,
  db: Executor = pool,
): Promise<TransactionSafeRow[]> {
  const result = await db.query<TransactionSafeRow>(LIST_BASIC_SAFES_FOR_USER_SQL, [userId])
  return result.rows
}

export const LIST_AGENTS_FOR_TRANSACTION_FILTERS_SQL = `SELECT id, name, status
         FROM agents
         WHERE user_id = $1
         ORDER BY
           CASE status
             WHEN 'active' THEN 0
             WHEN 'paused' THEN 1
             ELSE 2
           END,
           created_at DESC`

/** `userId` is REQUIRED — the agent picklist on the filters endpoint is per-tenant. */
export async function listAgentsForTransactionFilters(
  userId: string,
  db: Executor = pool,
): Promise<TransactionFilterAgentRow[]> {
  const result = await db.query<TransactionFilterAgentRow>(
    LIST_AGENTS_FOR_TRANSACTION_FILTERS_SQL,
    [userId],
  )
  return result.rows
}

// ── Safe ownership (GET /:safeAddress) ──────────────────────────────────────

export const FIND_SAFE_OWNERSHIP_ANY_CHAIN_SQL =
  'SELECT id, chain_id FROM user_safes WHERE user_id = $1 AND LOWER(safe_address) = LOWER($2)'

export const FIND_SAFE_OWNERSHIP_FOR_CHAIN_SQL =
  'SELECT id, chain_id FROM user_safes WHERE user_id = $1 AND LOWER(safe_address) = LOWER($2) AND chain_id = $3'

/**
 * `userId` is REQUIRED — this is the ownership check `/:safeAddress` runs
 * before ever touching an explorer API. `chainId === null` returns every
 * chain the address is owned on (the route then decides whether that's
 * ambiguous); the two SQL shapes are preserved separately per the header note.
 */
export async function findSafeOwnership(
  userId: string,
  safeAddress: string,
  chainId: number | null,
  db: Executor = pool,
): Promise<SafeOwnershipRow[]> {
  const result =
    chainId === null
      ? await db.query<SafeOwnershipRow>(FIND_SAFE_OWNERSHIP_ANY_CHAIN_SQL, [userId, safeAddress])
      : await db.query<SafeOwnershipRow>(FIND_SAFE_OWNERSHIP_FOR_CHAIN_SQL, [
          userId,
          safeAddress,
          chainId,
        ])
  return result.rows
}

// ── Machine-payment agent attribution (enrichTransactionsWithAgents) ───────

export const FIND_PAYMENT_INTENT_AGENT_MATCHES_SQL = `SELECT pi.id,
              LOWER(pi.tx_hash) AS tx_hash,
              us.id AS safe_id,
              us.chain_id AS chain_id,
              pi.agent_id,
              a.name AS agent_name,
              COALESCE(pi.payment_rail, pi.source, 'direct') AS source,
              COALESCE(pi.payment_resource_url, pi.x402_resource_url) AS payment_resource_url,
              COALESCE(pi.merchant_address, pi.x402_merchant_address) AS merchant_address,
              mpe.proof_status AS payment_proof_status,
              mpe.amount_sek AS amount_sek,
              mpre.event_type AS payment_reconciliation_event_type
       FROM payment_intents pi
       JOIN agents a ON a.id = pi.agent_id
       LEFT JOIN machine_payment_evidence mpe ON mpe.payment_intent_id = pi.id
       LEFT JOIN machine_payment_reconciliation_events mpre
         ON mpre.payment_intent_id = pi.id
        AND mpre.status = 'open'
        AND mpre.event_type = 'merchant_retry_rejected_after_payment'
       JOIN user_safes us
         ON us.user_id = pi.user_id
        AND us.id = ANY($3)
        AND LOWER(us.safe_address) = LOWER(pi.safe_address)
        AND pi.chain_id IS NOT NULL
        AND us.chain_id = pi.chain_id
       WHERE LOWER(pi.tx_hash) = ANY($1)
         AND pi.user_id = $2
         AND pi.status = 'confirmed'`

/**
 * `userId` is REQUIRED — `pi.user_id = $2`. `safeIds` further scopes the
 * join to Safes the caller actually owns (`us.id = ANY($3)`); both together
 * are what stop a same-hash collision on another tenant's payment intent.
 */
export async function findPaymentIntentAgentMatches(
  txHashes: string[],
  userId: string,
  safeIds: string[],
  db: Executor = pool,
): Promise<PaymentIntentAgentRow[]> {
  const result = await db.query<PaymentIntentAgentRow>(FIND_PAYMENT_INTENT_AGENT_MATCHES_SQL, [
    txHashes,
    userId,
    safeIds,
  ])
  return result.rows
}

export const FIND_APPROVAL_REQUEST_AGENT_MATCHES_SQL = `SELECT ar.id,
              LOWER(ar.tx_hash) AS tx_hash,
              us.id AS safe_id,
              us.chain_id AS chain_id,
              ar.agent_id,
              a.name AS agent_name,
              COALESCE(ar.payment_rail, ar.source, 'direct') AS source,
              COALESCE(ar.payment_resource_url, ar.x402_resource_url) AS payment_resource_url,
              ar.merchant_address,
              mpe.proof_status AS payment_proof_status,
              mpe.amount_sek AS amount_sek,
              mpre.event_type AS payment_reconciliation_event_type
       FROM approval_requests ar
       JOIN agents a ON a.id = ar.agent_id
       LEFT JOIN machine_payment_evidence mpe ON mpe.approval_request_id = ar.id
       LEFT JOIN machine_payment_reconciliation_events mpre
         ON mpre.approval_request_id = ar.id
        AND mpre.status = 'open'
        AND mpre.event_type = 'merchant_retry_rejected_after_payment'
       JOIN user_safes us
         ON us.user_id = ar.user_id
        AND us.id = ANY($3)
        AND LOWER(us.safe_address) = LOWER(ar.safe_address)
        AND ar.chain_id IS NOT NULL
        AND us.chain_id = ar.chain_id
       WHERE LOWER(ar.tx_hash) = ANY($1)
         AND ar.user_id = $2
         AND COALESCE(ar.payment_rail, ar.source) = 'x402'
         AND ar.status = 'executed'`

/** Same tenant-scoping contract as `findPaymentIntentAgentMatches`. */
export async function findApprovalRequestAgentMatches(
  txHashes: string[],
  userId: string,
  safeIds: string[],
  db: Executor = pool,
): Promise<ApprovalRequestAgentRow[]> {
  const result = await db.query<ApprovalRequestAgentRow>(
    FIND_APPROVAL_REQUEST_AGENT_MATCHES_SQL,
    [txHashes, userId, safeIds],
  )
  return result.rows
}

export const FIND_DELEGATE_SWEEP_AGENT_MATCHES_SQL = `SELECT ds.id,
              LOWER(ds.tx_hash) AS tx_hash,
              us.id AS safe_id,
              us.chain_id AS chain_id,
              ds.agent_id,
              a.name AS agent_name,
              ds.from_address,
              ds.to_address
       FROM delegate_sweeps ds
       JOIN agents a ON a.id = ds.agent_id
       JOIN user_safes us
         ON us.user_id = ds.user_id
        AND us.id = ANY($3)
        AND LOWER(us.safe_address) = LOWER(ds.to_address)
        AND us.chain_id = ds.chain_id
       WHERE LOWER(ds.tx_hash) = ANY($1)
         AND ds.user_id = $2
         AND ds.status = 'submitted'
         AND ds.tx_hash IS NOT NULL`

/** Same tenant-scoping contract as `findPaymentIntentAgentMatches`. */
export async function findDelegateSweepAgentMatches(
  txHashes: string[],
  userId: string,
  safeIds: string[],
  db: Executor = pool,
): Promise<DelegateSweepAgentRow[]> {
  const result = await db.query<DelegateSweepAgentRow>(FIND_DELEGATE_SWEEP_AGENT_MATCHES_SQL, [
    txHashes,
    userId,
    safeIds,
  ])
  return result.rows
}

// ── Confirmed x402 funding (fetchConfirmedX402Transactions) ────────────────

export const FIND_CONFIRMED_X402_PAYMENT_INTENTS_SQL = `SELECT pi.id,
            pi.tx_hash,
            pi.agent_id,
            a.name AS agent_name,
            us.id AS safe_id,
            us.safe_address,
            us.name AS safe_name,
            COALESCE(pi.chain_id, us.chain_id) AS chain_id,
            pi.token_symbol,
            pi.token_address,
            pi.to_address,
            pi.amount_raw,
            pi.amount_human,
            pi.x402_merchant_address,
            pi.x402_resource_url,
            mpe.proof_status AS payment_proof_status,
            mpe.amount_sek AS amount_sek,
            mpre.event_type AS payment_reconciliation_event_type,
            pi.confirmed_at,
            pi.created_at
     FROM payment_intents pi
     JOIN agents a ON a.id = pi.agent_id
     LEFT JOIN machine_payment_evidence mpe ON mpe.payment_intent_id = pi.id
     LEFT JOIN machine_payment_reconciliation_events mpre
       ON mpre.payment_intent_id = pi.id
      AND mpre.status = 'open'
      AND mpre.event_type = 'merchant_retry_rejected_after_payment'
     JOIN user_safes us
       ON us.user_id = pi.user_id
      AND us.id = ANY($2)
      AND LOWER(us.safe_address) = LOWER(pi.safe_address)
      AND pi.chain_id IS NOT NULL
      AND us.chain_id = pi.chain_id
     WHERE pi.user_id = $1
       AND pi.source = 'x402'
       AND pi.status = 'confirmed'
       AND pi.tx_hash IS NOT NULL
     ORDER BY COALESCE(pi.confirmed_at, pi.created_at) DESC`

/** `userId` is REQUIRED — `pi.user_id = $1`, further scoped to `safeIds`. */
export async function findConfirmedX402PaymentIntents(
  userId: string,
  safeIds: string[],
  db: Executor = pool,
): Promise<X402PaymentIntentRow[]> {
  const result = await db.query<X402PaymentIntentRow>(
    FIND_CONFIRMED_X402_PAYMENT_INTENTS_SQL,
    [userId, safeIds],
  )
  return result.rows
}

export const FIND_CONFIRMED_X402_APPROVAL_REQUESTS_SQL = `SELECT ar.id,
            ar.tx_hash,
            ar.agent_id,
            a.name AS agent_name,
            us.id AS safe_id,
            us.safe_address,
            us.name AS safe_name,
            COALESCE(ar.chain_id, us.chain_id) AS chain_id,
            ar.token_symbol,
            ar.token_address,
            ar.to_address,
            ar.amount_raw,
            ar.amount_human,
            ar.merchant_address,
            COALESCE(ar.payment_resource_url, ar.x402_resource_url) AS payment_resource_url,
            mpe.proof_status AS payment_proof_status,
            mpe.amount_sek AS amount_sek,
            mpre.event_type AS payment_reconciliation_event_type,
            ar.executed_at,
            ar.created_at
     FROM approval_requests ar
     JOIN agents a ON a.id = ar.agent_id
     LEFT JOIN machine_payment_evidence mpe ON mpe.approval_request_id = ar.id
     LEFT JOIN machine_payment_reconciliation_events mpre
       ON mpre.approval_request_id = ar.id
      AND mpre.status = 'open'
      AND mpre.event_type = 'merchant_retry_rejected_after_payment'
     JOIN user_safes us
       ON us.user_id = ar.user_id
      AND us.id = ANY($2)
      AND LOWER(us.safe_address) = LOWER(ar.safe_address)
      AND ar.chain_id IS NOT NULL
      AND us.chain_id = ar.chain_id
     WHERE ar.user_id = $1
       AND COALESCE(ar.payment_rail, ar.source) = 'x402'
       AND ar.status = 'executed'
       AND ar.tx_hash IS NOT NULL
     ORDER BY COALESCE(ar.executed_at, ar.created_at) DESC`

/** Same tenant-scoping contract as `findConfirmedX402PaymentIntents`. */
export async function findConfirmedX402ApprovalRequests(
  userId: string,
  safeIds: string[],
  db: Executor = pool,
): Promise<X402ApprovalRequestRow[]> {
  const result = await db.query<X402ApprovalRequestRow>(
    FIND_CONFIRMED_X402_APPROVAL_REQUESTS_SQL,
    [userId, safeIds],
  )
  return result.rows
}

// ── Machine-payment evidence detail ─────────────────────────────────────────

export const FIND_MACHINE_PAYMENT_EVIDENCE_DETAIL_SQL = `SELECT mpe.id,
                mpe.payment_intent_id,
                mpe.approval_request_id,
                mpe.rail,
                mpe.proof_status,
                mpe.tx_hash,
                mpe.chain_id,
                mpe.resource_url,
                mpe.merchant_address,
                mpe.payer_address,
                mpe.settlement_address,
                mpe.token_symbol,
                mpe.token_address,
                mpe.amount_raw,
                mpe.amount_human,
                mpe.challenge_id,
                mpe.idempotency_key,
                mpe.challenge_payload,
                mpe.selected_payment,
                mpe.payment_proof_header_name,
                mpe.payment_proof_header,
                mpe.protocol_receipt_header_name,
                mpe.protocol_receipt_header,
                mpe.protocol_receipt_payload,
                mpe.merchant_status,
                mpe.confirmed_at,
                mpe.created_at,
                mpe.updated_at
         FROM machine_payment_evidence mpe
         LEFT JOIN payment_intents pi ON pi.id = mpe.payment_intent_id
         LEFT JOIN approval_requests ar ON ar.id = mpe.approval_request_id
         WHERE (mpe.payment_intent_id = $1 OR mpe.approval_request_id = $1)
           AND COALESCE(pi.user_id, ar.user_id) = $2
         LIMIT 1`

/**
 * `userId` is REQUIRED — the evidence row belongs to whichever of
 * `payment_intents` / `approval_requests` it's anchored on, and that row's
 * `user_id` is the tenant scope.
 */
export async function findMachinePaymentEvidenceDetail(
  paymentId: string,
  userId: string,
  db: Executor = pool,
): Promise<MachinePaymentEvidenceDetailRow | null> {
  const result = await db.query<MachinePaymentEvidenceDetailRow>(
    FIND_MACHINE_PAYMENT_EVIDENCE_DETAIL_SQL,
    [paymentId, userId],
  )
  return result.rows[0] ?? null
}
