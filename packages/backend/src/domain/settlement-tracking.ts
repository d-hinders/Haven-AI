/**
 * What Haven knows about an EIP-3009 merchant settlement, told to the
 * frontend (#4319 → #4320). Computed from STORED state only — the read path
 * never touches the chain — so the two wire shapes (camelCase on the
 * transactions feed, snake_case on the agent activity read) are the same
 * derivation with different field names.
 *
 * ## `settlementTracking`
 *
 * | Value | When |
 * |---|---|
 * | `verified` | A settlement hash is recorded. |
 * | `checking` | No hash, and a source can still produce one: the payment's nonce is derivable (or a stored header exists) and it is inside the 24-hour window, or a receipt verdict is `retryable`. |
 * | `untracked` | Everything else: a random-nonce payment with no header and no usable receipt, a refused verdict, outside the window, or Tier 2 disabled with nothing else possible. |
 *
 * A random-nonce client (pre-#3888 signers) cannot be distinguished from a
 * deriving one by stored state alone when no header was reported — the honest
 * state for such a row is `checking` while its 24-hour sweep window is open
 * and `untracked` once it closes, because the tick's derived-nonce scan is
 * the only remaining source and it cannot match a random nonce. That bound
 * IS the stored-state derivation the issue asks for.
 *
 * ## `settlementProof` (from the recorded flags, S3)
 *
 * | Flags | `settlementProof` |
 * |---|---|
 * | `nonce_derived` | `nonce` |
 * | `nonce_bound` only | `signed_header` |
 * | `receipt` | `receipt` |
 * | none (records from 2026-09-29 to 10-14) | `legacy` |
 *
 * Precedence note (#4319): a row with `merchant_retry_rejected_after_payment`
 * or a funded-but-unsettled status keeps its existing "needs attention"
 * presentation — `settlementTracking` never overrides it. The lifecycle
 * fields are computed beside this, not by it.
 */
import { SWEEP_RECOVERY_HORIZON_SECONDS } from './x402-sweep-window.js'

export type SettlementTracking = 'verified' | 'checking' | 'untracked'
export type SettlementProof = 'nonce' | 'signed_header' | 'receipt' | 'legacy'

/** The final verdicts — a refused receipt attribution is never re-checked. */
const REFUSED_VERDICTS = new Set(['refused_ambiguous', 'refused_mismatch'])

export interface SettlementTrackingInput {
  /** `machine_metadata.merchant_settlement_tx_hash` — a recorded settlement. */
  settlementTxHash: string | null
  /** `machine_metadata.merchant_settlement_proof` — the Tier 2 label. */
  settlementProofLabel: string | null
  /** `machine_metadata.merchant_settlement_nonce_bound` (#3925 check 9). */
  nonceBound: boolean | null
  /** `machine_metadata.merchant_settlement_nonce_derived` (#3888). */
  nonceDerived: boolean | null
  /** `machine_metadata.merchant_settlement_receipt_verdict` (#4319 limit 7). */
  receiptVerdict: string | null
  /** A `machine_payment_evidence.payment_proof_header` exists for the payment. */
  hasStoredHeader: boolean
  /** The funding confirmation time — the 24-hour window's anchor. */
  confirmedAt: string | null
  nowMs?: number
}

export interface SettlementTrackingDerived {
  settlementTracking: SettlementTracking
  settlementProof: SettlementProof | null
}

export function deriveSettlementTracking(input: SettlementTrackingInput): SettlementTrackingDerived {
  // Proof first — it exists exactly when a hash does, but the precedence is
  // the flags', not the hash's presence.
  const settlementProof: SettlementProof | null = input.nonceDerived
    ? 'nonce'
    : input.nonceBound
      ? 'signed_header'
      : input.settlementProofLabel === 'receipt'
        ? 'receipt'
        : input.settlementTxHash
          ? 'legacy'
          : null

  if (input.settlementTxHash) return { settlementTracking: 'verified', settlementProof }
  if (input.receiptVerdict && REFUSED_VERDICTS.has(input.receiptVerdict)) {
    return { settlementTracking: 'untracked', settlementProof }
  }
  if (input.receiptVerdict === 'retryable') {
    return { settlementTracking: 'checking', settlementProof }
  }
  const confirmedMs = input.confirmedAt ? new Date(input.confirmedAt).getTime() : NaN
  const withinWindow =
    Number.isFinite(confirmedMs) && (input.nowMs ?? Date.now()) < confirmedMs + SWEEP_RECOVERY_HORIZON_SECONDS * 1000
  if (withinWindow) {
    // A source can still produce a hash: the derived-nonce sweep runs for
    // every eip3009 delegation payment inside its horizon, and a stored
    // header names a nonce of its own (Tier 1). Tier 2 disabled with nothing
    // else possible is exactly the outside-the-window case here — stored
    // state cannot say more.
    return { settlementTracking: 'checking', settlementProof }
  }
  return { settlementTracking: 'untracked', settlementProof }
}
