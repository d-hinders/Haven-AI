import pool from '../db.js'

const PROTOCOL_RAILS = new Set(['x402', 'mpp_demo', 'mpp_crypto', 'spt'])
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/

export type PaymentProofStatus =
  | 'payment_confirmed'
  | 'merchant_response_observed'
  | 'protocol_receipt_attached'

export interface MachinePaymentEvidenceSource {
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
  source?: string | null
  payment_rail?: string | null
  payment_resource_url?: string | null
  x402_resource_url?: string | null
  merchant_address?: string | null
  x402_merchant_address?: string | null
  machine_challenge_id?: string | null
  machine_idempotency_key?: string | null
  x402_idempotency_key?: string | null
  machine_metadata?: Record<string, unknown> | string | null
  confirmed_at?: string | null
}

export interface AttachMachinePaymentEvidenceInput {
  agentId: string
  paymentId: string
  rail: string
  txHash: string
  resourceUrl?: string
  merchantStatus?: number
  challengePayload?: Record<string, unknown>
  selectedPayment?: Record<string, unknown>
  paymentProofHeaderName?: string
  paymentProofHeader?: string
  protocolReceiptHeaderName?: string
  protocolReceiptHeader?: string
  protocolReceiptPayload?: Record<string, unknown>
}

export interface MachinePaymentEvidenceRow {
  id: string
  payment_intent_id: string
  agent_id: string
  user_id: string
  rail: string
  proof_status: PaymentProofStatus
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

interface PaymentIntentEvidenceRow extends MachinePaymentEvidenceSource {
  tx_hash: string
}

interface EvidenceLogger {
  warn: (payload: Record<string, unknown>, message: string) => void
}

export function isProtocolPaymentRail(rail: string | null | undefined): boolean {
  return Boolean(rail && PROTOCOL_RAILS.has(rail))
}

function railForPayment(intent: MachinePaymentEvidenceSource): string | null {
  return intent.payment_rail ?? intent.source ?? null
}

function resourceUrlForPayment(intent: MachinePaymentEvidenceSource): string | null {
  return intent.payment_resource_url ?? intent.x402_resource_url ?? null
}

function merchantAddressForPayment(intent: MachinePaymentEvidenceSource): string | null {
  return intent.merchant_address ?? intent.x402_merchant_address ?? null
}

function idempotencyKeyForPayment(intent: MachinePaymentEvidenceSource): string | null {
  return intent.machine_idempotency_key ?? intent.x402_idempotency_key ?? null
}

function normalizeJson(value: Record<string, unknown> | string | null | undefined): string | null {
  if (!value) return null
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

function cleanHeaderName(value: string | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 128) return null
  return trimmed
}

function cleanHeaderValue(value: string | undefined): string | null {
  if (!value) return null
  return value.length > 16384 ? value.slice(0, 16384) : value
}

function proofStatusForAttach(input: AttachMachinePaymentEvidenceInput): PaymentProofStatus {
  if (input.protocolReceiptHeader || input.protocolReceiptPayload) {
    return 'protocol_receipt_attached'
  }
  return 'merchant_response_observed'
}

export async function recordMachinePaymentEvidenceBase(
  intent: MachinePaymentEvidenceSource,
): Promise<void> {
  const rail = railForPayment(intent)
  if (!isProtocolPaymentRail(rail)) return
  if (intent.status !== 'confirmed' || !intent.tx_hash) return

  const resourceUrl = resourceUrlForPayment(intent)
  if (!resourceUrl) return

  await pool.query(
    `INSERT INTO machine_payment_evidence (
      payment_intent_id, agent_id, user_id, rail, proof_status, tx_hash,
      chain_id, resource_url, merchant_address, payer_address, settlement_address,
      token_symbol, token_address, amount_raw, amount_human, challenge_id,
      idempotency_key, challenge_payload, confirmed_at
    ) VALUES (
      $1, $2, $3, $4, 'payment_confirmed', LOWER($5::TEXT),
      $6, $7, LOWER($8::TEXT), LOWER($9::TEXT), LOWER($10::TEXT),
      $11, LOWER($12::TEXT), $13, $14, $15,
      $16, $17, $18
    )
    ON CONFLICT (payment_intent_id)
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
      updated_at = NOW()`,
    [
      intent.id,
      intent.agent_id,
      intent.user_id,
      rail,
      intent.tx_hash,
      intent.chain_id,
      resourceUrl,
      merchantAddressForPayment(intent),
      intent.safe_address,
      intent.to_address,
      intent.token_symbol,
      intent.token_address,
      intent.amount_raw,
      intent.amount_human,
      intent.machine_challenge_id ?? null,
      idempotencyKeyForPayment(intent),
      normalizeJson(intent.machine_metadata),
      intent.confirmed_at ?? null,
    ],
  )
}

export async function recordMachinePaymentEvidenceBaseById(
  paymentIntentId: string,
  agentId?: string,
): Promise<void> {
  const result = await pool.query<MachinePaymentEvidenceSource>(
    `SELECT id, agent_id, user_id, safe_address, chain_id, token_symbol, token_address,
            to_address, amount_raw, amount_human, tx_hash, status, source,
            x402_resource_url, x402_merchant_address, x402_idempotency_key,
            payment_rail, payment_resource_url, merchant_address,
            machine_challenge_id, machine_idempotency_key, machine_metadata,
            confirmed_at
     FROM payment_intents
     WHERE id = $1
       AND ($2::UUID IS NULL OR agent_id = $2)
     LIMIT 1`,
    [paymentIntentId, agentId ?? null],
  )

  const intent = result.rows[0]
  if (intent) await recordMachinePaymentEvidenceBase(intent)
}

export async function tryRecordMachinePaymentEvidenceBaseById(
  paymentIntentId: string,
  agentId?: string,
  log?: EvidenceLogger,
): Promise<void> {
  try {
    await recordMachinePaymentEvidenceBaseById(paymentIntentId, agentId)
  } catch (err) {
    if (log) {
      log.warn(
        { err, paymentIntentId, agentId },
        'Machine payment evidence recording failed after confirmed payment',
      )
      return
    }

    console.warn(
      'Machine payment evidence recording failed after confirmed payment',
      { paymentIntentId, agentId, err },
    )
  }
}

export async function attachMachinePaymentEvidence(
  input: AttachMachinePaymentEvidenceInput,
): Promise<MachinePaymentEvidenceRow | null> {
  if (!TX_HASH_RE.test(input.txHash)) {
    throw new Error('tx_hash_invalid')
  }
  if (!isProtocolPaymentRail(input.rail)) {
    throw new Error('unsupported_rail')
  }
  if (
    input.merchantStatus !== undefined &&
    (!Number.isInteger(input.merchantStatus) || input.merchantStatus < 100 || input.merchantStatus > 599)
  ) {
    throw new Error('merchant_status_invalid')
  }

  const paymentResult = await pool.query<PaymentIntentEvidenceRow>(
    `SELECT id, agent_id, user_id, safe_address, chain_id, token_symbol, token_address,
            to_address, amount_raw, amount_human, tx_hash, status, source,
            x402_resource_url, x402_merchant_address, x402_idempotency_key,
            payment_rail, payment_resource_url, merchant_address,
            machine_challenge_id, machine_idempotency_key, machine_metadata,
            confirmed_at
     FROM payment_intents
     WHERE id = $1 AND agent_id = $2
     LIMIT 1`,
    [input.paymentId, input.agentId],
  )

  const payment = paymentResult.rows[0]
  if (!payment) return null
  if (payment.status !== 'confirmed' || !payment.tx_hash) {
    throw new Error('payment_not_confirmed')
  }
  if (payment.tx_hash.toLowerCase() !== input.txHash.toLowerCase()) {
    throw new Error('tx_hash_mismatch')
  }

  const rail = railForPayment(payment)
  if (rail !== input.rail) {
    throw new Error('rail_mismatch')
  }

  const resourceUrl = resourceUrlForPayment(payment)
  if (!resourceUrl) {
    throw new Error('resource_missing')
  }
  if (input.resourceUrl && input.resourceUrl !== resourceUrl) {
    throw new Error('resource_mismatch')
  }

  await recordMachinePaymentEvidenceBase(payment)

  const proofStatus = proofStatusForAttach(input)
  const result = await pool.query<MachinePaymentEvidenceRow>(
    `UPDATE machine_payment_evidence
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
     WHERE payment_intent_id = $1
       AND agent_id = $2
     RETURNING *`,
    [
      payment.id,
      input.agentId,
      proofStatus,
      normalizeJson(input.challengePayload),
      normalizeJson(input.selectedPayment),
      cleanHeaderName(input.paymentProofHeaderName),
      cleanHeaderValue(input.paymentProofHeader),
      cleanHeaderName(input.protocolReceiptHeaderName),
      cleanHeaderValue(input.protocolReceiptHeader),
      normalizeJson(input.protocolReceiptPayload),
      input.merchantStatus ?? null,
    ],
  )

  return result.rows[0] ?? null
}
