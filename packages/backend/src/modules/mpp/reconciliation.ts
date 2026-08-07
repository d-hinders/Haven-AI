/**
 * `POST /reconciliation-events` orchestration (#997). Records a merchant-
 * retry rejection AFTER a payment already settled — a signal that the
 * merchant accepted funding but never delivered the resource — so it shows
 * up as `needs_attention` (`lib/machine-payment-lifecycle.ts`) instead of
 * silently reading as a normal success. Extracted verbatim from
 * `routes/machine-payments.ts`; the route keeps request-shape validation
 * (`paymentId`/`rail`/`eventType`/`txHash`/`reason`/`details` presence and
 * type checks).
 */
import {
  findReconciliationApproval,
  findReconciliationEvent,
  findReconciliationIntent,
  upsertReconciliationEvent,
} from '../../infra/repositories/machine-payments.js'
import type { MppHandlerResult } from './types.js'

interface ReconciliationPaymentRow {
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

export const RECONCILIATION_EVENT_TYPES = new Set([
  'merchant_retry_rejected_after_payment',
])

export async function handleReconciliationEvent(
  agentId: string,
  paymentId: string,
  rail: string,
  eventType: string,
  txHash: string | undefined,
  reason: string | undefined,
  details: Record<string, unknown> | undefined,
): Promise<MppHandlerResult> {
  let payment: ReconciliationPaymentRow | null = await findReconciliationIntent(
    paymentId,
    agentId,
  )
  if (!payment) {
    payment = await findReconciliationApproval(paymentId, agentId)
  }
  if (!payment) {
    return { statusCode: 404, body: { error: 'Payment not found' } }
  }

  const expectedStatus = payment.kind === 'approval_request' ? 'executed' : 'confirmed'
  if (payment.status !== expectedStatus || !payment.tx_hash) {
    return {
      statusCode: 409,
      body: {
        error: 'Reconciliation events require a confirmed payment',
        status: payment.status,
      },
    }
  }

  if (txHash && payment.tx_hash.toLowerCase() !== txHash.toLowerCase()) {
    return { statusCode: 409, body: { error: 'txHash does not match payment intent' } }
  }

  const paymentRail = payment.payment_rail ?? payment.source
  if (paymentRail !== rail) {
    return { statusCode: 409, body: { error: 'rail does not match payment intent' } }
  }

  const paymentIntentId = payment.kind === 'payment_intent' ? payment.id : null
  const approvalRequestId = payment.kind === 'approval_request' ? payment.id : null
  const conflictColumn = payment.kind === 'approval_request' ? 'approval_request_id' : 'payment_intent_id'

  let event = await upsertReconciliationEvent({
    conflictColumn,
    agentId,
    userId: payment.user_id,
    paymentIntentId,
    approvalRequestId,
    rail,
    eventType,
    txHash: payment.tx_hash.toLowerCase(),
    resourceUrl: payment.payment_resource_url ?? payment.x402_resource_url,
    merchantAddress: payment.merchant_address ?? payment.x402_merchant_address,
    machineChallengeId: payment.machine_challenge_id,
    machineIdempotencyKey: payment.machine_idempotency_key ?? payment.x402_idempotency_key,
    reason: reason ?? null,
    details: details ? JSON.stringify(details) : null,
  })
  if (!event) {
    event = await findReconciliationEvent(conflictColumn, payment.id, agentId, eventType)
  }
  if (!event) throw new Error('reconciliation_event_conflict_not_found')

  return {
    statusCode: 202,
    body: {
      event_id: event.id,
      status: event.status,
      payment_id: payment.id,
      rail,
      event_type: eventType,
      created_at: event.created_at,
    },
  }
}
