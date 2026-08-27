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
  findReconciliationEvent,
  findReconciliationIntent,
  upsertReconciliationEvent,
  type ReconciliationPaymentRow,
} from '../../infra/repositories/machine-payments.js'
import type { MppHandlerResult } from './types.js'
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
  // #2055: the approval_requests fallback is gone with the table — a payment
  // id either resolves as an intent or is unknown.
  const payment: ReconciliationPaymentRow | null = await findReconciliationIntent(
    paymentId,
    agentId,
  )
  if (!payment) {
    return { statusCode: 404, body: { error: 'Payment not found' } }
  }

  if (payment.status !== 'confirmed' || !payment.tx_hash) {
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

  // #2085: a NEW reconciliation event is always anchored to a payment intent.
  // The repository still accepts `approvalRequestId` and the column still
  // exists — migration 070 dropped the `approval_requests` TABLE with CASCADE
  // and deliberately left historical evidence and reconciliation rows holding
  // their `approval_request_id` values, so the READ side stays. Only the write
  // branch is gone, because it could not be taken.
  let event = await upsertReconciliationEvent({
    conflictColumn: 'payment_intent_id',
    agentId,
    userId: payment.user_id,
    paymentIntentId: payment.id,
    approvalRequestId: null,
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
    event = await findReconciliationEvent('payment_intent_id', payment.id, agentId, eventType)
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
