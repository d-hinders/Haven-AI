import type {
  HavenPaymentReceipt,
  PaymentParties,
  PaymentResult,
  PaymentStatus,
  PaymentStatusResult,
  RawHavenPaymentReceipt,
  RawPaymentParties,
  RawPaymentStatusResult,
  RawStatusResponse,
} from './types.js'

/** #2960: one mapper, reused by every raw shape carrying `parties`. */
function mapParties(raw: RawPaymentParties | undefined): PaymentParties | undefined {
  if (!raw) return undefined
  return {
    treasuryAccount: raw.treasury_account,
    delegate: raw.delegate,
    delegateAccount: raw.delegate_account,
    merchant: raw.merchant,
  }
}

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
    parties: mapParties(raw.parties),
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

/**
 * #3134 (epic #3130, owner decision 1): the receipt surface converges on the
 * TRANSACTION feed's names for the four concepts the two surfaces share —
 * `paymentProofStatus`, `x402MerchantAddress`, `x402ResourceUrl`, `source` —
 * at this mapper only. The backend receipts wire stays snake_case and the
 * transactions wire is frozen, so the survivor is the transaction-side name
 * in every pair; the argument per pair is in `scripts/ci/vocabulary-map.json`.
 *
 * DUAL-EMIT, one full release. The old receipt names (`proofStatus`,
 * `merchantAddress`, `resourceUrl`, `rail`) are emitted beside the new ones so
 * a published client reading the old name keeps working. REMOVAL CONDITION,
 * written here where the twin is minted (precedent:
 * `packages/backend/src/middleware/retired-safe-names.ts`): delete the four
 * old keys — and their `singleSurface.receipt` rows in the vocabulary map,
 * and invert the tests that pin their presence — only when ALL THREE clocks
 * have moved past the release whose CHANGELOG names these twins:
 * `npm view @haven_ai/sdk dist-tags` reads a `latest` at or above it,
 * `npm view @haven_ai/mcp dist-tags` reads a `latest` at or above it, and the
 * hosted mcp-server deploy reports a `serverInfo.version` on MCP `initialize`
 * (`HOSTED_SERVER_VERSION` in `packages/mcp-server/src/server.ts`) at or past
 * the release that shipped them — each read against the registry / the live
 * server's handshake, never inferred from a green promotion (a promotion can
 * be half green; mcp-server is not on npm). Until then this comment is the
 * contract, and the guard's `singleSurface.receipt` rows are what keep the
 * twins from reading as undeclared divergence.
 */
export function mapPaymentReceipt(raw: RawHavenPaymentReceipt): HavenPaymentReceipt {
  const receipt: HavenPaymentReceipt = {
    id: raw.id,
    paymentId: raw.payment_id,
    source: raw.rail,
    rail: raw.rail,
    paymentProofStatus: raw.proof_status,
    proofStatus: raw.proof_status,
    txHash: raw.tx_hash,
    fundingTxHash: raw.funding_tx_hash ?? null,
    settlementTxHash: raw.settlement_tx_hash ?? null,
    chainId: raw.chain_id,
    x402ResourceUrl: raw.resource_url,
    resourceUrl: raw.resource_url,
    x402MerchantAddress: raw.merchant_address,
    merchantAddress: raw.merchant_address,
    payerAddress: raw.payer_address,
    parties: mapParties(raw.parties),
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
  // #3132: carried when the backend states it; the mapper otherwise drops
  // every key it does not name, which is why the declaration is per row.
  if (raw.scope) {
    receipt.scope = { source: raw.scope.source, filter: raw.scope.filter }
  }
  if ('approval_request_id' in raw) {
    receipt.approvalRequestId = raw.approval_request_id ?? null
  }

  return receipt
}
