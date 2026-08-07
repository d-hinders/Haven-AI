/**
 * Shared wire-shape and row types for the mpp module (#997, epic #980 M4).
 * `routes/machine-payments.ts` uses these for Fastify's generic type params;
 * module files use them for orchestration. Mirrors `modules/x402/types.ts`.
 */

export type MachinePaymentRail =
  | 'x402'
  | 'mpp_demo'
  | 'mpp_crypto'
  | 'stripe_deposit'
  | 'spt'

export interface MachinePaymentChallengeBody {
  rail: MachinePaymentRail
  version: string
  challengeId: string
  resource: string
  description: string
  network: {
    chainId: number
    name: 'base'
  }
  asset: {
    symbol: 'USDC'
    address: string
    decimals: 6
  }
  amount: {
    display: string
    atomic: string
  }
  recipient: string
  expiresAt: string
  metadata?: Record<string, unknown>
}

export interface AuthorizeBody {
  challenge: MachinePaymentChallengeBody
  idempotencyKey?: string
  signature?: string
}

export interface ReconciliationEventBody {
  paymentId?: string
  rail?: MachinePaymentRail
  eventType?: string
  txHash?: string
  reason?: string
  details?: Record<string, unknown>
}

export interface EvidenceBody {
  paymentId?: string
  rail?: MachinePaymentRail
  txHash?: string
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

export const SUPPORTED_ASSETS = ['ETH', 'USDC'] as const
export type SendAsset = (typeof SUPPORTED_ASSETS)[number]

export interface SendBody {
  asset: SendAsset
  recipient: string
  amount: string
  idempotency_key?: string
}

export interface SweepSubmitBody {
  authorization?: { nonce?: string }
  signature?: string
}

/** A generic handler result shape, mirroring `X402HandlerResult`. */
export interface MppHandlerResult {
  statusCode: number
  body: Record<string, unknown>
}
