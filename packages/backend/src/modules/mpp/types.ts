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

/**
 * `POST /machine-payments/budget-precheck` (#3054): the quote facts the
 * hosted MCP's guided prepare asks Haven to pre-check. camelCase like the
 * route family; `resourceUrl` is the merchant resource being bought — the
 * dedupe window's discriminating column — never the allowances read's URL.
 */
export interface BudgetPrecheckBody {
  chainId?: number
  token?: string
  amountAtomic?: string
  merchantTo?: string
  resourceUrl?: string
  /**
   * #3492: the x402 idempotency key of the quote this pre-check describes.
   * When present and it resolves to a SETTLED erc7710 replay (the same
   * predicate `delegationReplay` uses — `confirmed` + `tx_hash`, equal
   * task-budget/sub-budget pins, same payee and resource), the pre-check
   * answers sufficient without comparing against the (now-spent) remaining
   * budget and without a `refuse()` write — the payment already settled, so
   * re-refusing it as over-budget would be a false ledger row for money that
   * already moved. Absent, or any other row shape (no row, a pending child,
   * a key collision on a different payee/resource, an eip3009 row): today's
   * compare, unchanged.
   */
  idempotencyKey?: string
}

/** A generic handler result shape, mirroring `X402HandlerResult`. */
export interface MppHandlerResult {
  statusCode: number
  body: Record<string, unknown>
}
