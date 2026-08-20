import type {
  PaymentNextAction,
  PaymentPhase,
  PaymentStatusResult,
  RawSignResponse,
  RawX402AuthorizeResponse,
} from './types.js'
import {
  AgentPaymentNextAction,
  AgentPaymentPhase,
  HavenApiError,
  HavenPaymentStateError,
} from './types.js'

const PAYMENT_STATE_STATUS_CODES: Record<string, number> = {
  pending: 202,
  pending_approval: 202,
  approved: 202,
  proposed: 202,
  executed: 200,
  pending_signature: 409,
  submitted: 409,
  expired: 410,
  failed: 502,
  rejected: 409,
}

export function paymentStateStatusCode(status: string, fallback = 502): number {
  return PAYMENT_STATE_STATUS_CODES[status] ?? fallback
}

function phaseForStatus(status: string): PaymentPhase | null {
  if (status === 'pending_signature') return AgentPaymentPhase.AgentSignatureRequired
  if (status === 'submitted') return AgentPaymentPhase.PaymentSubmitted
  if (status === 'confirmed') return AgentPaymentPhase.PaymentConfirmed
  if (status === 'pending' || status === 'pending_approval') return AgentPaymentPhase.UserApprovalRequired
  if (status === 'approved') return AgentPaymentPhase.UserExecutionRequired
  if (status === 'proposed') return AgentPaymentPhase.WaitingForAdditionalApprovals
  if (status === 'executed') return AgentPaymentPhase.FundingSent
  if (status === 'rejected') return AgentPaymentPhase.Rejected
  if (status === 'expired') return AgentPaymentPhase.Expired
  if (status === 'failed') return AgentPaymentPhase.Failed
  return null
}

function nextActionForStatus(status: string): PaymentNextAction | null {
  if (status === 'pending_signature') return AgentPaymentNextAction.SignAndSubmitPayment
  if (status === 'submitted') return AgentPaymentNextAction.CheckStatusLater
  if (status === 'confirmed') return AgentPaymentNextAction.None
  if (status === 'pending' || status === 'pending_approval') return AgentPaymentNextAction.WaitForUserApproval
  if (status === 'approved') return AgentPaymentNextAction.WaitForUserToCompletePayment
  if (status === 'proposed') return AgentPaymentNextAction.WaitForUserApproval
  if (status === 'executed') return AgentPaymentNextAction.RetryOriginalX402Request
  if (status === 'rejected') return AgentPaymentNextAction.StopAndTellUser
  if (status === 'expired') return AgentPaymentNextAction.RequestAgainIfUserStillWantsIt
  if (status === 'failed') return AgentPaymentNextAction.StopAndTellUser
  return null
}

function messageForState(
  label: string,
  status: string,
  paymentId: string,
  nextAction: PaymentNextAction,
): string {
  if (status === 'pending' || status === 'pending_approval') {
    return `${label} is above the remaining agent budget and is waiting for user approval in Haven (payment_id: ${paymentId}).`
  }
  if (status === 'executed') {
    return 'The user completed the funding payment. Retry the original x402 request.'
  }
  if (status === 'rejected') {
    return `The user rejected this payment request (payment_id: ${paymentId}).`
  }
  if (status === 'expired') {
    return `This payment request expired (payment_id: ${paymentId}).`
  }
  return `${label} is ${status}; next_action=${nextAction} (payment_id: ${paymentId}).`
}

export function paymentStateFromRaw(
  label: string,
  raw: RawX402AuthorizeResponse | RawSignResponse,
): PaymentStatusResult | null {
  if (!raw.payment_id || !raw.status) return null

  const phase = (raw.phase as PaymentPhase | undefined) ?? phaseForStatus(raw.status)
  const nextAction = (raw.next_action as PaymentNextAction | undefined) ?? nextActionForStatus(raw.status)
  if (!phase || !nextAction) return null

  const amount = raw.amount ?? raw.requested ?? ''
  const token = raw.token ?? ''
  const message =
    raw.message ??
    raw.error ??
    messageForState(label, raw.status, raw.payment_id, nextAction)

  return {
    paymentId: raw.payment_id,
    kind: raw.kind === 'payment_intent' ? 'payment_intent' : 'approval_request',
    rail: raw.rail ?? 'direct',
    status: raw.status === 'pending' ? 'pending_approval' : raw.status,
    phase,
    nextAction,
    amount,
    token,
    resourceUrl: raw.resource_url ?? null,
    merchantAddress: raw.merchant_address ?? raw.merchant_to ?? null,
    txHash: raw.tx_hash ?? null,
    expiresAt: raw.expires_at ?? '',
    chainId: raw.chain_id ?? 0,
    message,
    amountAtomic: raw.amount_atomic ?? raw.x402?.amount_atomic ?? raw.mpp?.amount_atomic ?? null,
    asset: raw.asset ?? raw.x402?.asset ?? raw.mpp?.asset ?? null,
    network: raw.network ?? raw.x402?.network ?? raw.mpp?.network ?? null,
    description: raw.description ?? raw.x402?.description ?? raw.mpp?.description ?? null,
    idempotencyKey: raw.idempotency_key ?? raw.x402?.idempotency_key ?? raw.mpp?.idempotency_key ?? null,
    x402: raw.x402
      ? {
          amountAtomic: raw.x402.amount_atomic ?? raw.amount_atomic ?? null,
          asset: raw.x402.asset ?? raw.asset ?? null,
          network: raw.x402.network ?? raw.network ?? null,
          resourceUrl: raw.x402.resource_url ?? raw.resource_url ?? null,
          merchantAddress: raw.x402.merchant_address ?? raw.merchant_address ?? raw.merchant_to ?? null,
          description: raw.x402.description ?? raw.description ?? null,
          idempotencyKey: raw.x402.idempotency_key ?? raw.idempotency_key ?? null,
        }
      : undefined,
    mpp: raw.mpp
      ? {
          amountAtomic: raw.mpp.amount_atomic ?? raw.amount_atomic ?? null,
          asset: raw.mpp.asset ?? raw.asset ?? null,
          network: raw.mpp.network ?? raw.network ?? null,
          resourceUrl: raw.mpp.resource_url ?? raw.resource_url ?? null,
          merchantAddress: raw.mpp.merchant_address ?? raw.merchant_address ?? raw.merchant_to ?? null,
          description: raw.mpp.description ?? raw.description ?? null,
          idempotencyKey: raw.mpp.idempotency_key ?? raw.idempotency_key ?? null,
          challengeId: raw.mpp.challenge_id ?? raw.challenge_id ?? null,
        }
      : undefined,
  }
}

export function throwPaymentStateError(
  label: string,
  raw: RawX402AuthorizeResponse | RawSignResponse,
): never {
  const statusCode = paymentStateStatusCode(raw.status)
  const state = paymentStateFromRaw(label, raw)

  if (state) {
    throw new HavenPaymentStateError(state.message, statusCode, state, raw)
  }

  if (raw.status === 'pending_approval') {
    throw new HavenApiError(
      `${label} exceeds the on-chain allowance and was queued for owner approval (payment_id: ${raw.payment_id}).`,
      statusCode,
      raw,
    )
  }

  if (raw.status === 'expired') {
    throw new HavenApiError(
      `${label} expired before it could be completed (payment_id: ${raw.payment_id}).`,
      statusCode,
      raw,
    )
  }

  const paymentId = raw.payment_id ? ` (payment_id: ${raw.payment_id})` : ''
  const message = raw.error ?? `${label} ${raw.status}${paymentId}`
  throw new HavenApiError(message, statusCode, raw)
}
