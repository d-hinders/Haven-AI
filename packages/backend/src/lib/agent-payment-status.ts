import pool from '../db.js'
import { type AgentContext } from '../middleware/agentAuth.js'

export type AgentPaymentKind = 'payment_intent' | 'approval_request'

export type AgentPaymentPhase =
  | 'agent_signature_required'
  | 'payment_submitted'
  | 'payment_confirmed'
  | 'user_approval_required'
  | 'user_execution_required'
  | 'waiting_for_additional_approvals'
  | 'funding_sent'
  | 'rejected'
  | 'expired'
  | 'failed'

export type AgentPaymentNextAction =
  | 'sign_and_submit_payment'
  | 'check_status_later'
  | 'none'
  | 'wait_for_user_approval'
  | 'wait_for_user_to_complete_payment'
  | 'retry_original_x402_request'
  | 'stop_and_tell_user'
  | 'request_again_if_user_still_wants_it'

export interface AgentPaymentStatus {
  payment_id: string
  kind: AgentPaymentKind
  rail: string
  status: string
  phase: AgentPaymentPhase
  next_action: AgentPaymentNextAction
  amount: string
  token: string
  resource_url: string | null
  merchant_address: string | null
  tx_hash: string | null
  expires_at: string
  chain_id: number
  message: string
}

interface PaymentIntentStatusRow {
  id: string
  chain_id: number
  token_symbol: string
  amount_human: string
  status: string
  tx_hash: string | null
  expires_at: string
  source: string | null
  payment_rail: string | null
  payment_resource_url: string | null
  x402_resource_url: string | null
  merchant_address: string | null
  x402_merchant_address: string | null
}

interface ApprovalStatusRow {
  id: string
  chain_id: number
  token_symbol: string
  amount_human: string
  status: string
  tx_hash: string | null
  expires_at: string
  source: string | null
  payment_rail: string | null
  payment_resource_url: string | null
  x402_resource_url: string | null
  merchant_address: string | null
}

function railFor(row: { payment_rail: string | null; source: string | null }): string {
  return row.payment_rail ?? row.source ?? 'direct'
}

function paymentIntentState(status: string): {
  phase: AgentPaymentPhase
  nextAction: AgentPaymentNextAction
  message: string
} {
  if (status === 'pending_signature') {
    return {
      phase: 'agent_signature_required',
      nextAction: 'sign_and_submit_payment',
      message: 'Haven is waiting for the agent to sign and submit this payment.',
    }
  }
  if (status === 'submitted') {
    return {
      phase: 'payment_submitted',
      nextAction: 'check_status_later',
      message: 'The payment was submitted and is waiting for confirmation.',
    }
  }
  if (status === 'confirmed') {
    return {
      phase: 'payment_confirmed',
      nextAction: 'none',
      message: 'The payment is confirmed.',
    }
  }
  if (status === 'expired') {
    return {
      phase: 'expired',
      nextAction: 'request_again_if_user_still_wants_it',
      message: 'The payment expired before it was completed.',
    }
  }
  if (status === 'failed') {
    return {
      phase: 'failed',
      nextAction: 'stop_and_tell_user',
      message: 'The payment failed.',
    }
  }

  return {
    phase: 'payment_submitted',
    nextAction: 'check_status_later',
    message: `The payment is ${status}.`,
  }
}

function approvalState(status: string): {
  phase: AgentPaymentPhase
  nextAction: AgentPaymentNextAction
  message: string
} {
  if (status === 'pending') {
    return {
      phase: 'user_approval_required',
      nextAction: 'wait_for_user_approval',
      message: 'This payment is above the remaining agent budget and is waiting for user approval in Haven.',
    }
  }
  if (status === 'approved') {
    return {
      phase: 'user_execution_required',
      nextAction: 'wait_for_user_to_complete_payment',
      message: 'The user approved this request, but the funding payment has not been sent yet.',
    }
  }
  if (status === 'proposed') {
    return {
      phase: 'waiting_for_additional_approvals',
      nextAction: 'wait_for_user_approval',
      message: 'The funding payment was submitted and is waiting for the remaining account approvals.',
    }
  }
  if (status === 'executed') {
    return {
      phase: 'funding_sent',
      nextAction: 'retry_original_x402_request',
      message: 'The user completed the funding payment. Retry the original x402 request so the agent can send the merchant payment header.',
    }
  }
  if (status === 'rejected') {
    return {
      phase: 'rejected',
      nextAction: 'stop_and_tell_user',
      message: 'The user rejected this payment request.',
    }
  }
  if (status === 'expired') {
    return {
      phase: 'expired',
      nextAction: 'request_again_if_user_still_wants_it',
      message: 'The approval request expired before it was completed.',
    }
  }

  return {
    phase: 'user_approval_required',
    nextAction: 'check_status_later',
    message: `The approval request is ${status}.`,
  }
}

export function agentPaymentStatusHttpCode(status: AgentPaymentStatus): number {
  if (status.kind === 'approval_request') {
    if (status.status === 'pending' || status.status === 'approved' || status.status === 'proposed') return 202
    if (status.status === 'executed') return 200
    if (status.status === 'rejected') return 409
    if (status.status === 'expired') return 410
  }

  if (status.status === 'confirmed') return 200
  if (status.status === 'pending_signature' || status.status === 'submitted') return 409
  if (status.status === 'expired') return 410
  if (status.status === 'failed') return 502
  return 200
}

export async function getAgentPaymentStatus(
  agent: AgentContext,
  paymentId: string,
): Promise<AgentPaymentStatus | null> {
  await pool.query(
    `UPDATE payment_intents
     SET status = 'expired'
     WHERE id = $1 AND agent_id = $2 AND status = 'pending_signature' AND expires_at < NOW()`,
    [paymentId, agent.id],
  )

  const paymentResult = await pool.query<PaymentIntentStatusRow>(
    `SELECT id, chain_id, token_symbol, amount_human, status, tx_hash, expires_at,
            source, payment_rail, payment_resource_url, x402_resource_url,
            merchant_address, x402_merchant_address
     FROM payment_intents
     WHERE id = $1 AND agent_id = $2
     LIMIT 1`,
    [paymentId, agent.id],
  )

  const payment = paymentResult.rows[0]
  if (payment) {
    const state = paymentIntentState(payment.status)
    return {
      payment_id: payment.id,
      kind: 'payment_intent',
      rail: railFor(payment),
      status: payment.status,
      phase: state.phase,
      next_action: state.nextAction,
      amount: payment.amount_human,
      token: payment.token_symbol,
      resource_url: payment.payment_resource_url ?? payment.x402_resource_url,
      merchant_address: payment.merchant_address ?? payment.x402_merchant_address,
      tx_hash: payment.tx_hash,
      expires_at: payment.expires_at,
      chain_id: payment.chain_id,
      message: state.message,
    }
  }

  await pool.query(
    `UPDATE approval_requests
     SET status = 'expired'
     WHERE id = $1 AND agent_id = $2 AND status IN ('pending', 'approved') AND expires_at < NOW()`,
    [paymentId, agent.id],
  )

  const approvalResult = await pool.query<ApprovalStatusRow>(
    `SELECT id, chain_id, token_symbol, amount_human, status, tx_hash, expires_at,
            source, payment_rail, payment_resource_url, x402_resource_url,
            merchant_address
     FROM approval_requests
     WHERE id = $1 AND agent_id = $2
     LIMIT 1`,
    [paymentId, agent.id],
  )

  const approval = approvalResult.rows[0]
  if (!approval) return null

  const state = approvalState(approval.status)
  return {
    payment_id: approval.id,
    kind: 'approval_request',
    rail: railFor(approval),
    status: approval.status,
    phase: state.phase,
    next_action: state.nextAction,
    amount: approval.amount_human,
    token: approval.token_symbol,
    resource_url: approval.payment_resource_url ?? approval.x402_resource_url,
    merchant_address: approval.merchant_address,
    tx_hash: approval.tx_hash,
    expires_at: approval.expires_at,
    chain_id: approval.chain_id,
    message: state.message,
  }
}
