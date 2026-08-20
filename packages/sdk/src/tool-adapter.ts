import { HavenApiError, HavenPaymentStateError } from './types.js'
import type { X402PaymentRequired, X402Receipt } from './types.js'

/**
 * The agent-tool adapter (#1620, epic #1613).
 *
 * `HavenClient.executeTool` exists so an agent framework can hand a tool call
 * straight through; these three functions are the translation layer it needs
 * — a 402 challenge built from flat tool arguments, a receipt flattened to
 * snake_case JSON, and an error rendered as a RESULT rather than thrown.
 *
 * That last one is the reason this is a distinct concern rather than
 * incidental formatting: a tool handler that throws loses the payment state
 * the model needs to decide what to do next, so `toolError` deliberately
 * preserves it (payment_id, phase, next_action) in a shape a model can read.
 *
 * Pure functions over their inputs — no client, no network, no state.
 */

export function toolX402PaymentRequired(input: {
  url: string
  payTo: string
  amount: string
  asset: string
  network: string
  description?: string
}): X402PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: input.url, description: input.description },
    accepts: [
      {
        scheme: 'exact',
        network: input.network,
        amount: input.amount,
        asset: input.asset,
        payTo: input.payTo,
        maxTimeoutSeconds: 30,
      },
    ],
  }
}

export function x402ToolReceipt(receipt: X402Receipt): Record<string, unknown> {
  return {
    success: true,
    payment_id: receipt.paymentId,
    tx_hash: receipt.txHash,
    token: receipt.token,
    amount: receipt.amount,
    to: receipt.to,
    resource_url: receipt.resourceUrl,
    explorer_url: receipt.explorerUrl,
    payment_header: receipt.paymentHeader,
    merchant_to: receipt.merchantTo,
    payer: receipt.payer,
    chain_id: receipt.chainId,
    haven: receipt.haven,
    merchant: receipt.merchant,
    x402: receipt.x402,
  }
}

export function toolError(err: unknown): Record<string, unknown> {
  if (err instanceof HavenPaymentStateError) {
    return {
      success: false,
      payment_id: err.state.paymentId,
      kind: err.state.kind,
      rail: err.state.rail,
      status: err.state.status,
      phase: err.state.phase,
      next_action: err.state.nextAction,
      tx_hash: err.state.txHash,
      token: err.state.token,
      amount: err.state.amount,
      resource_url: err.state.resourceUrl,
      merchant_address: err.state.merchantAddress,
      amount_atomic: err.state.amountAtomic,
      asset: err.state.asset,
      network: err.state.network,
      description: err.state.description,
      idempotency_key: err.state.idempotencyKey,
      x402: err.state.x402
        ? {
            amount_atomic: err.state.x402.amountAtomic,
            asset: err.state.x402.asset,
            network: err.state.x402.network,
            resource_url: err.state.x402.resourceUrl,
            merchant_address: err.state.x402.merchantAddress,
            description: err.state.x402.description,
            idempotency_key: err.state.x402.idempotencyKey,
          }
        : undefined,
      mpp: err.state.mpp
        ? {
            amount_atomic: err.state.mpp.amountAtomic,
            asset: err.state.mpp.asset,
            network: err.state.mpp.network,
            resource_url: err.state.mpp.resourceUrl,
            merchant_address: err.state.mpp.merchantAddress,
            description: err.state.mpp.description,
            idempotency_key: err.state.mpp.idempotencyKey,
            challenge_id: err.state.mpp.challengeId,
          }
        : undefined,
      resume_state: err.resumeState,
      expires_at: err.state.expiresAt,
      chain_id: err.state.chainId,
      message: err.state.message,
      error: err.message,
    }
  }

  if (err instanceof HavenApiError) {
    return {
      success: false,
      status_code: err.statusCode,
      error: err.message,
      body: err.body,
    }
  }

  return {
    success: false,
    error: err instanceof Error ? err.message : String(err),
  }
}
