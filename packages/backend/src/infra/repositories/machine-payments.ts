/**
 * Data access for the machine-payment settlement-evidence aggregate (#995,
 * epic #980 M3): `machine_payment_evidence`, `merchant_receipts`,
 * `machine_payment_reconciliation_events` and `delegate_sweeps`, plus the
 * evidence-flow projections of `payment_intents` / `approval_requests` that
 * feed them. Extracted verbatim from `lib/machine-payment-evidence.ts`,
 * `lib/merchant-receipt.ts` and `routes/machine-payments.ts`.
 *
 * Invariant a reader must not break (#956, #995 invariant 3): the evidence
 * upsert is keyed on the payment reference (`payment_intent_id` /
 * `approval_request_id`) and is idempotent, so recording evidence after a
 * settlement can never race itself into a duplicate — and a settled payment's
 * evidence row is created from the SETTLED row's own fields, never from
 * request input. Merchant receipts are first-write-wins (`ON CONFLICT DO
 * NOTHING`): a merchant's receipt is immutable source material.
 *
 * Convention — see `README.md` in this directory. Executor last, defaulting to
 * the pool; tenant scope (`agentId`) required; SQL in exported constants so
 * `scripts/db-schema-smoke.ts` can PREPARE it by import. The statements that
 * interpolate a reference/conflict column do so through a two-value union
 * mapped to exported concrete constants — never raw input.
 *
 * **The SQL here is verbatim from the call sites.**
 */

import pool from '../../db.js'
import { type Executor, type QueryRow } from '../transaction.js'

export type { Executor }

export type EvidenceReferenceColumn = 'payment_intent_id' | 'approval_request_id'

// ── Evidence base upsert (lib/machine-payment-evidence.ts) ───────────────────

/**
 * Parameterised by its conflict clause so the intent- and approval-anchored
 * writes cannot drift; the concrete statements are the exported constants
 * below. FX columns COALESCE so book-time values freeze at settlement.
 */
function evidenceBaseUpsertSql(conflictClause: string): string {
  return `INSERT INTO machine_payment_evidence (
      payment_intent_id, approval_request_id, agent_id, user_id, rail, proof_status, tx_hash,
      chain_id, resource_url, merchant_address, payer_address, settlement_address,
      token_symbol, token_address, amount_raw, amount_human, challenge_id,
      idempotency_key, challenge_payload, confirmed_at,
      amount_sek, fx_rate_sek, fx_source, fx_at
    ) VALUES (
      $1, $2, $3, $4, $5, 'payment_confirmed', LOWER($6::TEXT),
      $7, $8, LOWER($9::TEXT), LOWER($10::TEXT), LOWER($11::TEXT),
      $12, LOWER($13::TEXT), $14, $15, $16,
      $17, $18, $19,
      $20, $21, $22, $23
    )
    ${conflictClause}
    DO UPDATE SET
      rail = EXCLUDED.rail,
      tx_hash = EXCLUDED.tx_hash,
      chain_id = EXCLUDED.chain_id,
      resource_url = EXCLUDED.resource_url,
      merchant_address = EXCLUDED.merchant_address,
      payer_address = EXCLUDED.payer_address,
      settlement_address = EXCLUDED.settlement_address,
      token_symbol = EXCLUDED.token_symbol,
      token_address = EXCLUDED.token_address,
      amount_raw = EXCLUDED.amount_raw,
      amount_human = EXCLUDED.amount_human,
      challenge_id = EXCLUDED.challenge_id,
      idempotency_key = EXCLUDED.idempotency_key,
      challenge_payload = COALESCE(machine_payment_evidence.challenge_payload, EXCLUDED.challenge_payload),
      confirmed_at = EXCLUDED.confirmed_at,
      amount_sek = COALESCE(machine_payment_evidence.amount_sek, EXCLUDED.amount_sek),
      fx_rate_sek = COALESCE(machine_payment_evidence.fx_rate_sek, EXCLUDED.fx_rate_sek),
      fx_source = COALESCE(machine_payment_evidence.fx_source, EXCLUDED.fx_source),
      fx_at = COALESCE(machine_payment_evidence.fx_at, EXCLUDED.fx_at),
      updated_at = NOW()`
}

export const UPSERT_EVIDENCE_BASE_FOR_INTENT_SQL = evidenceBaseUpsertSql(
  'ON CONFLICT (payment_intent_id)',
)
export const UPSERT_EVIDENCE_BASE_FOR_APPROVAL_SQL = evidenceBaseUpsertSql(
  'ON CONFLICT (approval_request_id) WHERE approval_request_id IS NOT NULL',
)

export interface EvidenceBaseInput {
  referenceColumn: EvidenceReferenceColumn
  paymentIntentId: string | null
  approvalRequestId: string | null
  agentId: string
  userId: string
  rail: string
  txHash: string
  chainId: number
  resourceUrl: string
  merchantAddress: string | null
  payerAddress: string
  settlementAddress: string
  tokenSymbol: string
  tokenAddress: string
  amountRaw: string
  amountHuman: string
  challengeId: string | null
  idempotencyKey: string | null
  challengePayload: string | null
  confirmedAt: string | null
  amountSek: number | string | null
  fxRateSek: number | string | null
  fxSource: string | null
  fxAt: string | null
}

export async function upsertEvidenceBase(
  input: EvidenceBaseInput,
  db: Executor = pool,
): Promise<void> {
  const sql =
    input.referenceColumn === 'payment_intent_id'
      ? UPSERT_EVIDENCE_BASE_FOR_INTENT_SQL
      : UPSERT_EVIDENCE_BASE_FOR_APPROVAL_SQL
  await db.query(sql, [
    input.paymentIntentId,
    input.approvalRequestId,
    input.agentId,
    input.userId,
    input.rail,
    input.txHash,
    input.chainId,
    input.resourceUrl,
    input.merchantAddress,
    input.payerAddress,
    input.settlementAddress,
    input.tokenSymbol,
    input.tokenAddress,
    input.amountRaw,
    input.amountHuman,
    input.challengeId,
    input.idempotencyKey,
    input.challengePayload,
    input.confirmedAt,
    input.amountSek,
    input.fxRateSek,
    input.fxSource,
    input.fxAt,
  ])
}

// ── Evidence source reads (payment_intents / approval_requests projections) ──

export const FIND_INTENT_EVIDENCE_SOURCE_SQL = `SELECT 'payment_intent'::TEXT AS kind,
            id, agent_id, user_id, safe_address, chain_id, token_symbol, token_address,
            to_address, amount_raw, amount_human, tx_hash, status, source,
            x402_resource_url, x402_merchant_address, x402_idempotency_key,
            payment_rail, payment_resource_url, merchant_address,
            machine_challenge_id, machine_idempotency_key, machine_metadata,
            confirmed_at
     FROM payment_intents
     WHERE id = $1
       AND ($2::UUID IS NULL OR agent_id = $2)
     LIMIT 1`

export interface EvidenceSourceRow {
  kind: 'payment_intent' | 'approval_request'
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
  tx_hash: string | null
  status: string
  source: string | null
  x402_resource_url: string | null
  x402_merchant_address: string | null
  x402_idempotency_key: string | null
  payment_rail: string | null
  payment_resource_url: string | null
  merchant_address: string | null
  machine_challenge_id: string | null
  machine_idempotency_key: string | null
  machine_metadata: Record<string, unknown> | string | null
  confirmed_at: string | null
}

/**
 * Evidence-source read used by the by-id recorder: `agentId` here is an
 * OPTIONAL narrowing (the caller may already be trusted, e.g. an internal
 * post-confirm hook), which the SQL expresses as `$2 IS NULL OR agent_id = $2`.
 */
export async function findIntentEvidenceSource(
  paymentIntentId: string,
  agentId: string | null,
  db: Executor = pool,
): Promise<EvidenceSourceRow | null> {
  const result = await db.query<EvidenceSourceRow>(FIND_INTENT_EVIDENCE_SOURCE_SQL, [
    paymentIntentId,
    agentId,
  ])
  return result.rows[0] ?? null
}

export const FIND_INTENT_FOR_EVIDENCE_SQL = `SELECT 'payment_intent'::TEXT AS kind,
            id, agent_id, user_id, safe_address, chain_id, token_symbol, token_address,
            to_address, amount_raw, amount_human, tx_hash, status, source,
            x402_resource_url, x402_merchant_address, x402_idempotency_key,
            payment_rail, payment_resource_url, merchant_address,
            machine_challenge_id, machine_idempotency_key, machine_metadata,
            confirmed_at
     FROM payment_intents
     WHERE id = $1 AND agent_id = $2
     LIMIT 1`

export const FIND_APPROVAL_FOR_EVIDENCE_SQL = `SELECT 'approval_request'::TEXT AS kind,
            id, agent_id, user_id, safe_address, chain_id, token_symbol, token_address,
            to_address, amount_raw, amount_human, tx_hash, status, source,
            x402_resource_url, NULL::TEXT AS x402_merchant_address, NULL::TEXT AS x402_idempotency_key,
            payment_rail, payment_resource_url, merchant_address,
            machine_challenge_id, machine_idempotency_key, machine_metadata,
            executed_at AS confirmed_at
     FROM approval_requests
     WHERE id = $1 AND agent_id = $2
     LIMIT 1`

export async function findIntentForEvidenceScoped(
  paymentId: string,
  agentId: string,
  db: Executor = pool,
): Promise<EvidenceSourceRow | null> {
  const result = await db.query<EvidenceSourceRow>(FIND_INTENT_FOR_EVIDENCE_SQL, [
    paymentId,
    agentId,
  ])
  return result.rows[0] ?? null
}

export async function findApprovalForEvidenceScoped(
  paymentId: string,
  agentId: string,
  db: Executor = pool,
): Promise<EvidenceSourceRow | null> {
  const result = await db.query<EvidenceSourceRow>(FIND_APPROVAL_FOR_EVIDENCE_SQL, [
    paymentId,
    agentId,
  ])
  return result.rows[0] ?? null
}

// ── Evidence attach (proof upgrade, lib/machine-payment-evidence.ts) ─────────

function evidenceAttachSql(referenceColumn: EvidenceReferenceColumn): string {
  return `UPDATE machine_payment_evidence
     SET proof_status = CASE
           WHEN $3 = 'protocol_receipt_attached' THEN $3
           WHEN proof_status = 'protocol_receipt_attached' THEN proof_status
           ELSE $3
         END,
         challenge_payload = COALESCE($4::JSONB, challenge_payload),
         selected_payment = COALESCE($5::JSONB, selected_payment),
         payment_proof_header_name = COALESCE($6, payment_proof_header_name),
         payment_proof_header = COALESCE($7, payment_proof_header),
         protocol_receipt_header_name = COALESCE($8, protocol_receipt_header_name),
         protocol_receipt_header = COALESCE($9, protocol_receipt_header),
         protocol_receipt_payload = COALESCE($10::JSONB, protocol_receipt_payload),
         merchant_status = COALESCE($11, merchant_status),
         updated_at = NOW()
     WHERE ${referenceColumn} = $1
       AND agent_id = $2
     RETURNING *`
}

export const ATTACH_EVIDENCE_FOR_INTENT_SQL = evidenceAttachSql('payment_intent_id')
export const ATTACH_EVIDENCE_FOR_APPROVAL_SQL = evidenceAttachSql('approval_request_id')

export interface AttachEvidenceParams {
  referenceColumn: EvidenceReferenceColumn
  paymentId: string
  agentId: string
  proofStatus: string
  challengePayload: string | null
  selectedPayment: string | null
  paymentProofHeaderName: string | null
  paymentProofHeader: string | null
  protocolReceiptHeaderName: string | null
  protocolReceiptHeader: string | null
  protocolReceiptPayload: string | null
  merchantStatus: number | null
}

export async function attachEvidenceProof<R extends QueryRow>(
  input: AttachEvidenceParams,
  db: Executor = pool,
): Promise<R | null> {
  const sql =
    input.referenceColumn === 'payment_intent_id'
      ? ATTACH_EVIDENCE_FOR_INTENT_SQL
      : ATTACH_EVIDENCE_FOR_APPROVAL_SQL
  const result = await db.query<R>(sql, [
    input.paymentId,
    input.agentId,
    input.proofStatus,
    input.challengePayload,
    input.selectedPayment,
    input.paymentProofHeaderName,
    input.paymentProofHeader,
    input.protocolReceiptHeaderName,
    input.protocolReceiptHeader,
    input.protocolReceiptPayload,
    input.merchantStatus,
  ])
  return result.rows[0] ?? null
}

// ── Receipts list + evidence echo (routes/machine-payments.ts) ───────────────

export const LIST_EVIDENCE_RECEIPTS_SQL = `SELECT e.*, pi.machine_metadata->>'settlement_scheme' AS settlement_scheme,
              pi.budget_delegation_hash
       FROM machine_payment_evidence e
       LEFT JOIN payment_intents pi ON pi.id = e.payment_intent_id
       WHERE e.agent_id = $1
       ORDER BY e.created_at DESC
       LIMIT $2`

export async function listEvidenceReceiptsForAgent<R extends QueryRow>(
  agentId: string,
  limit: number,
  db: Executor = pool,
): Promise<R[]> {
  const result = await db.query<R>(LIST_EVIDENCE_RECEIPTS_SQL, [agentId, limit])
  return result.rows
}

export const GET_INTENT_SETTLEMENT_FIELDS_SQL = `SELECT machine_metadata->>'settlement_scheme' AS settlement_scheme, budget_delegation_hash
             FROM payment_intents WHERE id = $1`

export interface IntentSettlementFields {
  settlement_scheme: string | null
  budget_delegation_hash: string | null
}

/** Echo enrichment for the evidence 202 (#1118 review NB2). */
export async function getIntentSettlementFields(
  paymentIntentId: string,
  db: Executor = pool,
): Promise<IntentSettlementFields | null> {
  const result = await db.query<IntentSettlementFields>(GET_INTENT_SETTLEMENT_FIELDS_SQL, [
    paymentIntentId,
  ])
  return result.rows[0] ?? null
}

// ── Reconciliation events ────────────────────────────────────────────────────

export interface ReconciliationPaymentRow {
  id: string
  kind: 'payment_intent' | 'approval_request'
  user_id: string
  tx_hash: string | null
  status: string
  payment_rail: string | null
  source: string | null
  payment_resource_url: string | null
  x402_resource_url: string | null
  merchant_address: string | null
  x402_merchant_address: string | null
  machine_challenge_id: string | null
  machine_idempotency_key: string | null
  x402_idempotency_key: string | null
}

export const FIND_RECONCILIATION_INTENT_SQL = `SELECT 'payment_intent'::TEXT AS kind,
              id, user_id, tx_hash, status, payment_rail, source,
              payment_resource_url, x402_resource_url,
              merchant_address, x402_merchant_address,
              machine_challenge_id, machine_idempotency_key, x402_idempotency_key
       FROM payment_intents
       WHERE id = $1 AND agent_id = $2
       LIMIT 1`

export const FIND_RECONCILIATION_APPROVAL_SQL = `SELECT 'approval_request'::TEXT AS kind,
                id, user_id, tx_hash, status, payment_rail, source,
                payment_resource_url, x402_resource_url,
                merchant_address, NULL::TEXT AS x402_merchant_address,
                machine_challenge_id, machine_idempotency_key, NULL::TEXT AS x402_idempotency_key
         FROM approval_requests
         WHERE id = $1 AND agent_id = $2
         LIMIT 1`

export async function findReconciliationIntent(
  paymentId: string,
  agentId: string,
  db: Executor = pool,
): Promise<ReconciliationPaymentRow | null> {
  const result = await db.query<ReconciliationPaymentRow>(FIND_RECONCILIATION_INTENT_SQL, [
    paymentId,
    agentId,
  ])
  return result.rows[0] ?? null
}

export async function findReconciliationApproval(
  paymentId: string,
  agentId: string,
  db: Executor = pool,
): Promise<ReconciliationPaymentRow | null> {
  const result = await db.query<ReconciliationPaymentRow>(FIND_RECONCILIATION_APPROVAL_SQL, [
    paymentId,
    agentId,
  ])
  return result.rows[0] ?? null
}

function reconciliationEventUpsertSql(conflictColumn: EvidenceReferenceColumn): string {
  return `INSERT INTO machine_payment_reconciliation_events (
        agent_id, user_id, payment_intent_id, approval_request_id, rail, event_type, tx_hash,
        resource_url, merchant_address, machine_challenge_id, machine_idempotency_key,
        reason, details
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (${conflictColumn}, event_type)
        WHERE ${conflictColumn} IS NOT NULL
      DO UPDATE SET
        tx_hash = EXCLUDED.tx_hash,
        resource_url = EXCLUDED.resource_url,
        merchant_address = EXCLUDED.merchant_address,
        machine_challenge_id = EXCLUDED.machine_challenge_id,
        machine_idempotency_key = EXCLUDED.machine_idempotency_key,
        reason = EXCLUDED.reason,
        details = EXCLUDED.details,
        status = 'open',
        updated_at = NOW()
      WHERE machine_payment_reconciliation_events.status <> 'resolved'
      RETURNING id, status, created_at`
}

export const UPSERT_RECONCILIATION_EVENT_FOR_INTENT_SQL =
  reconciliationEventUpsertSql('payment_intent_id')
export const UPSERT_RECONCILIATION_EVENT_FOR_APPROVAL_SQL =
  reconciliationEventUpsertSql('approval_request_id')

export interface ReconciliationEventRow {
  id: string
  status: string
  created_at: string
}

export interface UpsertReconciliationEventInput {
  conflictColumn: EvidenceReferenceColumn
  agentId: string
  userId: string
  paymentIntentId: string | null
  approvalRequestId: string | null
  rail: string
  eventType: string
  txHash: string
  resourceUrl: string | null
  merchantAddress: string | null
  machineChallengeId: string | null
  machineIdempotencyKey: string | null
  reason: string | null
  details: string | null
}

/**
 * Upsert an agent-reported reconciliation event, re-opening a non-resolved
 * one. Returns `null` when the guarded upsert matched nothing (the existing
 * event is already resolved) — callers reload with `findReconciliationEvent`.
 */
export async function upsertReconciliationEvent(
  input: UpsertReconciliationEventInput,
  db: Executor = pool,
): Promise<ReconciliationEventRow | null> {
  const sql =
    input.conflictColumn === 'approval_request_id'
      ? UPSERT_RECONCILIATION_EVENT_FOR_APPROVAL_SQL
      : UPSERT_RECONCILIATION_EVENT_FOR_INTENT_SQL
  const result = await db.query<ReconciliationEventRow>(sql, [
    input.agentId,
    input.userId,
    input.paymentIntentId,
    input.approvalRequestId,
    input.rail,
    input.eventType,
    input.txHash,
    input.resourceUrl,
    input.merchantAddress,
    input.machineChallengeId,
    input.machineIdempotencyKey,
    input.reason,
    input.details,
  ])
  return result.rows[0] ?? null
}

function reconciliationEventFindSql(conflictColumn: EvidenceReferenceColumn): string {
  return `SELECT id, status, created_at
         FROM machine_payment_reconciliation_events
         WHERE ${conflictColumn} = $1
           AND agent_id = $2
           AND event_type = $3
         LIMIT 1`
}

export const FIND_RECONCILIATION_EVENT_FOR_INTENT_SQL =
  reconciliationEventFindSql('payment_intent_id')
export const FIND_RECONCILIATION_EVENT_FOR_APPROVAL_SQL =
  reconciliationEventFindSql('approval_request_id')

export async function findReconciliationEvent(
  conflictColumn: EvidenceReferenceColumn,
  paymentId: string,
  agentId: string,
  eventType: string,
  db: Executor = pool,
): Promise<ReconciliationEventRow | null> {
  const sql =
    conflictColumn === 'approval_request_id'
      ? FIND_RECONCILIATION_EVENT_FOR_APPROVAL_SQL
      : FIND_RECONCILIATION_EVENT_FOR_INTENT_SQL
  const result = await db.query<ReconciliationEventRow>(sql, [paymentId, agentId, eventType])
  return result.rows[0] ?? null
}

function resolveReconciliationForPaymentSql(referenceColumn: EvidenceReferenceColumn): string {
  return `UPDATE machine_payment_reconciliation_events
       SET status = 'resolved',
           updated_at = NOW()
       WHERE ${referenceColumn} = $1
         AND agent_id = $2
         AND status = 'open'
         AND event_type = 'merchant_retry_rejected_after_payment'`
}

export const RESOLVE_RECONCILIATION_FOR_INTENT_SQL =
  resolveReconciliationForPaymentSql('payment_intent_id')
export const RESOLVE_RECONCILIATION_FOR_APPROVAL_SQL =
  resolveReconciliationForPaymentSql('approval_request_id')

/** A settle proof arrived for this payment — close its stranded-funds flag. */
export async function resolveReconciliationForPayment(
  referenceColumn: EvidenceReferenceColumn,
  paymentId: string,
  agentId: string,
  db: Executor = pool,
): Promise<void> {
  const sql =
    referenceColumn === 'approval_request_id'
      ? RESOLVE_RECONCILIATION_FOR_APPROVAL_SQL
      : RESOLVE_RECONCILIATION_FOR_INTENT_SQL
  await db.query(sql, [paymentId, agentId])
}

export const RESOLVE_STRANDED_EVENTS_FOR_AGENT_SQL = `UPDATE machine_payment_reconciliation_events
       SET status = 'resolved', updated_at = NOW()
       WHERE agent_id = $1
         AND status <> 'resolved'
         AND event_type = 'merchant_retry_rejected_after_payment'`

/** A successful sweep recovered the stranded funds — close the open flags. */
export async function resolveStrandedEventsForAgent(
  agentId: string,
  db: Executor = pool,
): Promise<void> {
  await db.query(RESOLVE_STRANDED_EVENTS_FOR_AGENT_SQL, [agentId])
}

export const INSERT_RESIDUE_EVENT_SQL = `INSERT INTO machine_payment_reconciliation_events (
      agent_id, user_id, payment_intent_id, rail, event_type, tx_hash,
      resource_url, merchant_address, reason, details
    ) VALUES ($1, $2, $3, $4, 'delegate_residue_after_settlement', $5, $6, $7, $8, $9)
    ON CONFLICT (payment_intent_id, event_type)
      WHERE payment_intent_id IS NOT NULL
    DO UPDATE SET details = EXCLUDED.details, updated_at = NOW()`

export interface ResidueEventInput {
  agentId: string
  userId: string
  paymentIntentId: string
  rail: string
  txHash: string | null
  resourceUrl: string | null
  merchantAddress: string | null
  reason: string
  details: string
}

/** #716: flag funds still on the delegate right after a settle proof. */
export async function insertResidueEvent(
  input: ResidueEventInput,
  db: Executor = pool,
): Promise<void> {
  await db.query(INSERT_RESIDUE_EVENT_SQL, [
    input.agentId,
    input.userId,
    input.paymentIntentId,
    input.rail,
    input.txHash,
    input.resourceUrl,
    input.merchantAddress,
    input.reason,
    input.details,
  ])
}

// ── Delegate sweeps (routes/machine-payments.ts) ─────────────────────────────

export interface DelegateSweepRow {
  id: string
  chain_id: number
  token_address: string
  from_address: string
  to_address: string
  value_atomic: string
  valid_after: string
  valid_before: string
  nonce: string
  status: string
  tx_hash: string | null
}

export const INSERT_PREPARED_SWEEP_SQL = `INSERT INTO delegate_sweeps (
        agent_id, user_id, chain_id, token_address, from_address, to_address,
        value_atomic, valid_after, valid_before, nonce, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'prepared')`

export interface NewPreparedSweep {
  agentId: string
  userId: string
  chainId: number
  tokenAddress: string
  fromAddress: string
  toAddress: string
  valueAtomic: string
  validAfter: string
  validBefore: string
  nonce: string
}

export async function insertPreparedSweep(
  input: NewPreparedSweep,
  db: Executor = pool,
): Promise<void> {
  await db.query(INSERT_PREPARED_SWEEP_SQL, [
    input.agentId,
    input.userId,
    input.chainId,
    input.tokenAddress,
    input.fromAddress,
    input.toAddress,
    input.valueAtomic,
    input.validAfter,
    input.validBefore,
    input.nonce,
  ])
}

export const FIND_SWEEP_BY_NONCE_SQL = `SELECT id, chain_id, token_address, from_address, to_address, value_atomic,
              valid_after, valid_before, nonce, status, tx_hash
       FROM delegate_sweeps
       WHERE nonce = $1 AND agent_id = $2
       LIMIT 1`

export async function findSweepByNonce(
  nonce: string,
  agentId: string,
  db: Executor = pool,
): Promise<DelegateSweepRow | null> {
  const result = await db.query<DelegateSweepRow>(FIND_SWEEP_BY_NONCE_SQL, [nonce, agentId])
  return result.rows[0] ?? null
}

export const FIND_SWEEP_BY_ID_SQL = `SELECT id, chain_id, token_address, from_address, to_address, value_atomic,
                valid_after, valid_before, nonce, status, tx_hash
         FROM delegate_sweeps WHERE id = $1 LIMIT 1`

/** Reload after a lost claim CAS — reports whether the winner already relayed. */
export async function findSweepById(
  sweepId: string,
  db: Executor = pool,
): Promise<DelegateSweepRow | null> {
  const result = await db.query<DelegateSweepRow>(FIND_SWEEP_BY_ID_SQL, [sweepId])
  return result.rows[0] ?? null
}

export const EXPIRE_PREPARED_SWEEP_SQL = `UPDATE delegate_sweeps SET status = 'expired' WHERE id = $1 AND status = 'prepared'`

export async function expirePreparedSweep(sweepId: string, db: Executor = pool): Promise<void> {
  await db.query(EXPIRE_PREPARED_SWEEP_SQL, [sweepId])
}

export const CLAIM_PREPARED_SWEEP_SQL = `UPDATE delegate_sweeps SET status = 'submitting'
       WHERE id = $1 AND status = 'prepared'
       RETURNING id`

/**
 * Atomically claim the prepared sweep before relaying. Two concurrent submits
 * can otherwise both broadcast — this compare-and-swap is the guard; the loser
 * re-reads and replays instead of relaying. False when the claim was lost.
 */
export async function claimPreparedSweep(sweepId: string, db: Executor = pool): Promise<boolean> {
  const result = await db.query<{ id: string }>(CLAIM_PREPARED_SWEEP_SQL, [sweepId])
  return result.rows.length > 0
}

export const RELEASE_SWEEP_CLAIM_SQL = `UPDATE delegate_sweeps SET status = 'prepared' WHERE id = $1 AND status = 'submitting'`

/** #717: a relayer-budget refusal releases the claim so the sweep stays retryable. */
export async function releaseSweepClaim(sweepId: string, db: Executor = pool): Promise<void> {
  await db.query(RELEASE_SWEEP_CLAIM_SQL, [sweepId])
}

export const MARK_SWEEP_FAILED_SQL = `UPDATE delegate_sweeps SET status = 'failed', error_message = $1 WHERE id = $2 AND status = 'submitting'`

export async function markSweepFailed(
  errorMessage: string,
  sweepId: string,
  db: Executor = pool,
): Promise<void> {
  await db.query(MARK_SWEEP_FAILED_SQL, [errorMessage, sweepId])
}

export const MARK_SWEEP_SUBMITTED_SQL = `UPDATE delegate_sweeps SET status = 'submitted', tx_hash = $1, submitted_at = NOW()
       WHERE id = $2 AND status = 'submitting'`

export async function markSweepSubmitted(
  txHash: string,
  sweepId: string,
  db: Executor = pool,
): Promise<void> {
  await db.query(MARK_SWEEP_SUBMITTED_SQL, [txHash, sweepId])
}

// ── Merchant receipts (#956, lib/merchant-receipt.ts) ────────────────────────

export const FIND_EVIDENCE_ANCHOR_FOR_AGENT_SQL = `SELECT mpe.id, mpe.user_id
     FROM machine_payment_evidence mpe
     LEFT JOIN payment_intents pi ON pi.id = mpe.payment_intent_id
     LEFT JOIN approval_requests ar ON ar.id = mpe.approval_request_id
     WHERE COALESCE(mpe.payment_intent_id::TEXT, mpe.approval_request_id::TEXT) = $1
       AND COALESCE(pi.agent_id, ar.agent_id) = $2`

export interface EvidenceAnchorRow {
  id: string
  user_id: string
}

/**
 * The evidence row is the anchor (#498's receiptRef) — agent-scoped via the
 * intent/approval join so an agent can only annotate its own payments.
 */
export async function findEvidenceAnchorForAgent(
  paymentId: string,
  agentId: string,
  db: Executor = pool,
): Promise<EvidenceAnchorRow | null> {
  const result = await db.query<EvidenceAnchorRow>(FIND_EVIDENCE_ANCHOR_FOR_AGENT_SQL, [
    paymentId,
    agentId,
  ])
  return result.rows[0] ?? null
}

export const INSERT_MERCHANT_RECEIPT_SQL = `INSERT INTO merchant_receipts (evidence_id, url, inline_json)
     VALUES ($1, $2, $3)
     ON CONFLICT (evidence_id) DO NOTHING
     RETURNING evidence_id`

/**
 * First write wins — a merchant's receipt for a settled payment is immutable
 * source material; duplicates are dropped, never replaced. True when stored.
 */
export async function insertMerchantReceiptOnce(
  evidenceId: string,
  url: string | null,
  inlineJson: string | null,
  db: Executor = pool,
): Promise<boolean> {
  const inserted = await db.query(INSERT_MERCHANT_RECEIPT_SQL, [evidenceId, url, inlineJson])
  return inserted.rows.length > 0
}

export const GET_MERCHANT_RECEIPT_SQL = `SELECT url, inline_json FROM merchant_receipts WHERE evidence_id = $1`

export interface MerchantReceiptRow {
  url: string | null
  inline_json: unknown
}

export async function getMerchantReceiptRow(
  evidenceId: string,
  db: Executor = pool,
): Promise<MerchantReceiptRow | null> {
  const result = await db.query<MerchantReceiptRow>(GET_MERCHANT_RECEIPT_SQL, [evidenceId])
  return result.rows[0] ?? null
}
