import {
  AgentPaymentNextAction,
  AgentPaymentPhase,
  AgentPaymentRail,
  type AgentPaymentNextAction as AgentPaymentNextActionValue,
  type AgentPaymentPhase as AgentPaymentPhaseValue,
} from './agent-payment-taxonomy.js'
import pool from '../db.js'
import { type AgentContext } from '../middleware/agentAuth.js'

export type AgentPaymentKind = 'payment_intent' | 'approval_request'

export interface AgentPaymentStatus {
  payment_id: string
  kind: AgentPaymentKind
  rail: string
  status: string
  phase: AgentPaymentPhaseValue
  next_action: AgentPaymentNextActionValue
  amount: string
  token: string
  resource_url: string | null
  merchant_address: string | null
  tx_hash: string | null
  expires_at: string
  chain_id: number
  message: string
  amount_atomic?: string | null
  asset?: string | null
  network?: string | null
  description?: string | null
  idempotency_key?: string | null
  x402?: {
    amount_atomic: string | null
    asset: string | null
    network: string | null
    resource_url: string | null
    merchant_address: string | null
    description: string | null
    idempotency_key: string | null
  }
}

interface PaymentIntentStatusRow {
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
  machine_idempotency_key: string | null
  machine_metadata: unknown
}

interface ApprovalStatusRow {
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
  machine_idempotency_key: string | null
  machine_metadata: unknown
}

interface MachinePaymentMetadata {
  network?: unknown
  description?: unknown
}

function railFor(row: { payment_rail: string | null; source: string | null }): string {
  return row.payment_rail ?? row.source ?? AgentPaymentRail.Direct
}

function metadataObject(value: unknown): MachinePaymentMetadata {
  if (!value) return {}
  if (typeof value === 'object' && !Array.isArray(value)) return value as MachinePaymentMetadata
  if (typeof value !== 'string') return {}

  try {
    const parsed = JSON.parse(value)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as MachinePaymentMetadata
    }
  } catch {
    return {}
  }

  return {}
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function x402Context(input: {
  rail: string
  amountRaw: string | null
  tokenAddress: string | null
  resourceUrl: string | null
  merchantAddress: string | null
  idempotencyKey: string | null
  machineMetadata: unknown
}) {
  if (input.rail !== 'x402') return {}

  const metadata = metadataObject(input.machineMetadata)
  const context = {
    amount_atomic: input.amountRaw,
    asset: input.tokenAddress,
    network: nullableString(metadata.network),
    description: nullableString(metadata.description),
    idempotency_key: input.idempotencyKey,
    x402: {
      amount_atomic: input.amountRaw,
      asset: input.tokenAddress,
      network: nullableString(metadata.network),
      resource_url: input.resourceUrl,
      merchant_address: input.merchantAddress,
      description: nullableString(metadata.description),
      idempotency_key: input.idempotencyKey,
    },
  }

  return context
}

function messageForRail(
  rail: string,
  status: string,
  fallback: string,
): string {
  if (rail !== AgentPaymentRail.X402) return fallback
  if (status === 'pending') {
    return 'This x402 funding payment is waiting for user approval in Haven. Do not start a new merchant session or create another payment; poll this payment id and resume the original x402 request after approval.'
  }
  if (status === 'approved') {
    return 'The user approved this x402 funding request, but the funding payment has not been sent yet. Keep the original merchant session and poll this payment id.'
  }
  if (status === 'proposed') {
    return 'The x402 funding payment was submitted and is waiting for the remaining account approvals. Keep the original merchant session and poll this payment id.'
  }
  if (status === 'executed') {
    return 'The user completed the Haven funding payment. Resume this payment id and retry the original x402 request with the merchant payment header; do not create a new merchant session.'
  }
  return fallback
}

function paymentIntentState(status: string): {
  phase: AgentPaymentPhaseValue
  nextAction: AgentPaymentNextActionValue
  message: string
} {
  if (status === 'pending_signature') {
    return {
      phase: AgentPaymentPhase.AgentSignatureRequired,
      nextAction: AgentPaymentNextAction.SignAndSubmitPayment,
      message: 'Haven is waiting for the agent to sign and submit this payment.',
    }
  }
  if (status === 'submitted') {
    return {
      phase: AgentPaymentPhase.PaymentSubmitted,
      nextAction: AgentPaymentNextAction.CheckStatusLater,
      message: 'The payment was submitted and is waiting for confirmation.',
    }
  }
  if (status === 'confirmed') {
    return {
      phase: AgentPaymentPhase.PaymentConfirmed,
      nextAction: AgentPaymentNextAction.None,
      message: 'The payment is confirmed.',
    }
  }
  if (status === 'expired') {
    return {
      phase: AgentPaymentPhase.Expired,
      nextAction: AgentPaymentNextAction.RequestAgainIfUserStillWantsIt,
      message: 'The payment expired before it was completed.',
    }
  }
  if (status === 'failed') {
    return {
      phase: AgentPaymentPhase.Failed,
      nextAction: AgentPaymentNextAction.StopAndTellUser,
      message: 'The payment failed.',
    }
  }

  return {
    phase: AgentPaymentPhase.PaymentSubmitted,
    nextAction: AgentPaymentNextAction.CheckStatusLater,
    message: `The payment is ${status}.`,
  }
}

function approvalState(status: string): {
  phase: AgentPaymentPhaseValue
  nextAction: AgentPaymentNextActionValue
  message: string
} {
  if (status === 'pending') {
    return {
      phase: AgentPaymentPhase.UserApprovalRequired,
      nextAction: AgentPaymentNextAction.WaitForUserApproval,
      message: 'This payment is above the remaining agent budget and is waiting for user approval in Haven.',
    }
  }
  if (status === 'approved') {
    return {
      phase: AgentPaymentPhase.UserExecutionRequired,
      nextAction: AgentPaymentNextAction.WaitForUserToCompletePayment,
      message: 'The user approved this request, but the funding payment has not been sent yet.',
    }
  }
  if (status === 'proposed') {
    return {
      phase: AgentPaymentPhase.WaitingForAdditionalApprovals,
      nextAction: AgentPaymentNextAction.WaitForUserApproval,
      message: 'The funding payment was submitted and is waiting for the remaining account approvals.',
    }
  }
  if (status === 'executed') {
    return {
      phase: AgentPaymentPhase.FundingSent,
      nextAction: AgentPaymentNextAction.RetryOriginalX402Request,
      message: 'The user completed the funding payment. Retry the original x402 request so the agent can send the merchant payment header.',
    }
  }
  if (status === 'rejected') {
    return {
      phase: AgentPaymentPhase.Rejected,
      nextAction: AgentPaymentNextAction.StopAndTellUser,
      message: 'The user rejected this payment request.',
    }
  }
  if (status === 'expired') {
    return {
      phase: AgentPaymentPhase.Expired,
      nextAction: AgentPaymentNextAction.RequestAgainIfUserStillWantsIt,
      message: 'The approval request expired before it was completed.',
    }
  }

  return {
    phase: AgentPaymentPhase.UserApprovalRequired,
    nextAction: AgentPaymentNextAction.CheckStatusLater,
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
    `SELECT id, chain_id, token_symbol, token_address, amount_human, amount_raw,
            status, tx_hash, expires_at,
            source, payment_rail, payment_resource_url, x402_resource_url,
            merchant_address, x402_merchant_address, x402_idempotency_key,
            machine_idempotency_key, machine_metadata
     FROM payment_intents
     WHERE id = $1 AND agent_id = $2
     LIMIT 1`,
    [paymentId, agent.id],
  )

  const payment = paymentResult.rows[0]
  if (payment) {
    const state = paymentIntentState(payment.status)
    const rail = railFor(payment)
    const resourceUrl = payment.payment_resource_url ?? payment.x402_resource_url
    const merchantAddress = payment.merchant_address ?? payment.x402_merchant_address
    return {
      payment_id: payment.id,
      kind: 'payment_intent',
      rail,
      status: payment.status,
      phase: state.phase,
      next_action: state.nextAction,
      amount: payment.amount_human,
      token: payment.token_symbol,
      resource_url: resourceUrl,
      merchant_address: merchantAddress,
      tx_hash: payment.tx_hash,
      expires_at: payment.expires_at,
      chain_id: payment.chain_id,
      message: messageForRail(rail, payment.status, state.message),
      ...x402Context({
        rail,
        amountRaw: payment.amount_raw,
        tokenAddress: payment.token_address,
        resourceUrl,
        merchantAddress,
        idempotencyKey: payment.machine_idempotency_key ?? payment.x402_idempotency_key,
        machineMetadata: payment.machine_metadata,
      }),
    }
  }

  await pool.query(
    `UPDATE approval_requests
     SET status = 'expired'
     WHERE id = $1 AND agent_id = $2 AND status IN ('pending', 'approved') AND expires_at < NOW()`,
    [paymentId, agent.id],
  )

  const approvalResult = await pool.query<ApprovalStatusRow>(
    `SELECT id, chain_id, token_symbol, token_address, amount_human, amount_raw,
            status, tx_hash, expires_at,
            source, payment_rail, payment_resource_url, x402_resource_url,
            merchant_address, machine_idempotency_key, machine_metadata
     FROM approval_requests
     WHERE id = $1 AND agent_id = $2
     LIMIT 1`,
    [paymentId, agent.id],
  )

  const approval = approvalResult.rows[0]
  if (!approval) return null

  const state = approvalState(approval.status)
  const rail = railFor(approval)
  const resourceUrl = approval.payment_resource_url ?? approval.x402_resource_url
  return {
    payment_id: approval.id,
    kind: 'approval_request',
    rail,
    status: approval.status,
    phase: state.phase,
    next_action: state.nextAction,
    amount: approval.amount_human,
    token: approval.token_symbol,
    resource_url: resourceUrl,
    merchant_address: approval.merchant_address,
    tx_hash: approval.tx_hash,
    expires_at: approval.expires_at,
    chain_id: approval.chain_id,
    message: messageForRail(rail, approval.status, state.message),
    ...x402Context({
      rail,
      amountRaw: approval.amount_raw,
      tokenAddress: approval.token_address,
      resourceUrl,
      merchantAddress: approval.merchant_address,
      idempotencyKey: approval.machine_idempotency_key,
      machineMetadata: approval.machine_metadata,
    }),
  }
}
