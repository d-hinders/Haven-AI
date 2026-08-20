import type {
  HavenPaymentReceipt,
  PaymentResult,
  PaymentStatus,
  PaymentStatusResult,
  RawHavenPaymentReceipt,
  RawPaymentStatusResult,
  RawStatusResponse,
} from './types.js'

export type ExplorerUrlBuilder = (chainId: number | undefined, txHash: string) => string

export function mapPaymentResult(
  raw: RawStatusResponse,
  buildExplorerUrl: ExplorerUrlBuilder,
): PaymentResult {
  return {
    paymentId: raw.payment_id,
    status: raw.status as PaymentStatus,
    token: raw.token,
    amount: raw.amount,
    to: raw.to,
    txHash: raw.tx_hash,
    errorMessage: raw.error_message,
    explorerUrl: raw.explorer_url ?? (raw.tx_hash ? buildExplorerUrl(raw.chain_id, raw.tx_hash) : null),
    fee: raw.fee
      ? {
          amount: raw.fee.amount,
          token: raw.fee.token,
          basisPoints: raw.fee.basis_points,
          applied: raw.fee.applied,
        }
      : null,
    createdAt: raw.created_at,
    signedAt: raw.signed_at,
    submittedAt: raw.submitted_at,
    confirmedAt: raw.confirmed_at,
    expiresAt: raw.expires_at,
  }
}

export function mapPaymentStatusResult(raw: RawPaymentStatusResult): PaymentStatusResult {
  return {
    paymentId: raw.payment_id,
    kind: raw.kind,
    rail: raw.rail,
    status: raw.status,
    phase: raw.phase,
    nextAction: raw.next_action,
    amount: raw.amount,
    token: raw.token,
    resourceUrl: raw.resource_url,
    merchantAddress: raw.merchant_address,
    payerAddress: raw.payer_address ?? null,
    txHash: raw.tx_hash,
    expiresAt: raw.expires_at,
    chainId: raw.chain_id,
    message: raw.message,
    fee: raw.fee
      ? {
          amount: raw.fee.amount,
          token: raw.fee.token,
          basisPoints: raw.fee.basis_points,
          applied: raw.fee.applied,
        }
      : null,
    amountAtomic: raw.amount_atomic ?? raw.x402?.amount_atomic ?? null,
    asset: raw.asset ?? raw.x402?.asset ?? null,
    network: raw.network ?? raw.x402?.network ?? null,
    description: raw.description ?? raw.x402?.description ?? null,
    idempotencyKey: raw.idempotency_key ?? raw.x402?.idempotency_key ?? null,
    x402: raw.x402
      ? {
          amountAtomic: raw.x402.amount_atomic ?? raw.amount_atomic ?? null,
          asset: raw.x402.asset ?? raw.asset ?? null,
          network: raw.x402.network ?? raw.network ?? null,
          resourceUrl: raw.x402.resource_url ?? raw.resource_url,
          merchantAddress: raw.x402.merchant_address ?? raw.merchant_address,
          description: raw.x402.description ?? raw.description ?? null,
          idempotencyKey: raw.x402.idempotency_key ?? raw.idempotency_key ?? null,
        }
      : undefined,
  }
}

export function mapPaymentReceipt(raw: RawHavenPaymentReceipt): HavenPaymentReceipt {
  const receipt: HavenPaymentReceipt = {
    id: raw.id,
    paymentId: raw.payment_id,
    rail: raw.rail,
    proofStatus: raw.proof_status,
    txHash: raw.tx_hash,
    chainId: raw.chain_id,
    resourceUrl: raw.resource_url,
    merchantAddress: raw.merchant_address,
    payerAddress: raw.payer_address,
    settlementAddress: raw.settlement_address,
    tokenSymbol: raw.token_symbol,
    tokenAddress: raw.token_address,
    amountRaw: raw.amount_raw,
    amount: raw.amount_human,
    challengeId: raw.challenge_id,
    idempotencyKey: raw.idempotency_key,
    challengePayload: raw.challenge_payload,
    selectedPayment: raw.selected_payment,
    paymentProofHeaderName: raw.payment_proof_header_name,
    protocolReceiptHeaderName: raw.protocol_receipt_header_name,
    protocolReceiptPayload: raw.protocol_receipt_payload,
    merchantStatus: raw.merchant_status,
    confirmedAt: raw.confirmed_at,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  }

  if ('payment_intent_id' in raw) {
    receipt.paymentIntentId = raw.payment_intent_id ?? null
  }
  if ('approval_request_id' in raw) {
    receipt.approvalRequestId = raw.approval_request_id ?? null
  }

  return receipt
}
