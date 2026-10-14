/**
 * Reported-or-chain-detected merchant settlement for the eip3009 funding leg
 * (#3475, #3888).
 *
 * ## The gap this closes
 *
 * On the EIP-3009 bridge Haven submits the FUNDING transaction (treasury →
 * the agent's delegate EOA) and records its hash, so the intent is `confirmed`
 * the moment funding lands. The merchant's SETTLEMENT (delegate → merchant,
 * the facilitator redeeming the agent's EIP-3009 authorization) is a second
 * transaction Haven never submits. On a paid MCP tool Haven calls the merchant
 * itself and keeps the merchant's `PAYMENT-RESPONSE`; on the plain-HTTP path
 * the agent calls the merchant (#2292) and nothing carried that transaction
 * back, so every such receipt showed the funds reaching the agent's own
 * delegate and never the merchant being paid.
 *
 * ## Shape
 *
 * The settlement reaches this seam two ways. The agent reports the hash
 * through the same door as erc7710, `POST /machine-payments/evidence`
 * (`haven_report_settlement_evidence`), per the owner decision on #3475. And
 * since #3888 the passive settlement sweep finds the transaction the chain
 * itself names — `AuthorizationUsed(delegate, derived nonce)`, the nonce the
 * signer derived from the payment id — and hands it here. Nothing about the
 * intent's lifecycle changes: it is already `confirmed` with Haven's funding
 * hash, and that hash stays. The verified settlement is recorded beside it,
 * and the receipt read prefers it over the merchant's unverified echo.
 *
 * ## Trust
 *
 * The hash is CLIENT INPUT that ends in the user's receipts, so it is verified
 * against the chain first (`verifySettlementTransferTx`): a successful
 * transaction carrying a Transfer of exactly this payment's amount, in this
 * token, from this payment's delegate to its merchant, mined after this
 * payment's funding confirmed. Fail closed: anything short of `verified`
 * records no hash. (Its caller has already written the payment's base evidence
 * row, an idempotent upsert that never touches proof status.) Haven still
 * never contacts the merchant. The #3888 sweep hands its candidates through
 * the same seam, so a chain-named transaction is held to the SAME proof
 * standard as an agent-reported one — the sweep's only extra power is knowing
 * which transaction to look at, not any weaker verification.
 *
 * The window's far edge is the report itself, not `expires_at`: a funded
 * payment whose merchant leg never completed can be re-signed long after its
 * signing deadline (the #2290 funded-merchant-retry path), and its genuine
 * settlement must still be recordable. What the window cannot do is tell two
 * same-shaped payments apart; see `recordEip3009MerchantSettlement` for why
 * that is bounded rather than guarded.
 */
import { verifySettlementTransferTx } from '../../infra/chain/settlement-transfer-verifier.js'
import { recordEip3009MerchantSettlement } from '../../infra/repositories/x402-authorizations.js'
import { CLOCK_SKEW_SECONDS } from './settlement-observed.js'

/** The intent fields this seam reads; a structural subset of the evidence source row. */
export interface Eip3009SettlementIntent {
  id: string
  agent_id: string
  chain_id: number
  token_address: string
  /** The funding recipient: the agent's delegate EOA, the settlement's payer. */
  to_address: string
  amount_raw: string
  status: string
  tx_hash: string | null
  x402_merchant_address?: string | null
  merchant_address?: string | null
  source?: string | null
  payment_rail?: string | null
  execution_rail?: string | null
  machine_metadata?: Record<string, unknown> | string | null
  confirmed_at?: string | Date | null
}

export type Eip3009SettlementObservation =
  /** Recorded now, or this exact hash was already recorded for this payment. */
  | { outcome: 'recorded' }
  /** Not a funded eip3009 payment, or the hash IS its funding: the caller's gates apply unchanged. */
  | { outcome: 'not_applicable' }
  /** Refused, nothing written. `retryable` separates "ask again later" from a settled no. */
  | { outcome: 'unverified'; retryable: boolean; reason: string }

function metadataOf(intent: Eip3009SettlementIntent): Record<string, unknown> | null {
  const raw = intent.machine_metadata
  if (!raw) return null
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * True only for a funded eip3009 delegation-rail x402 intent whose FUNDING
 * hash is not the one being reported. Reporting the funding hash itself keeps
 * the existing evidence path (the SDK's own funding-leg report does exactly
 * that), so this seam never sees it.
 */
export function isFundedEip3009Payment(intent: Eip3009SettlementIntent, reportedTxHash: string): boolean {
  return (
    intent.status === 'confirmed' &&
    !!intent.tx_hash &&
    intent.tx_hash.toLowerCase() !== reportedTxHash.toLowerCase() &&
    (intent.payment_rail ?? intent.source) === 'x402' &&
    intent.execution_rail === 'delegation' &&
    metadataOf(intent)?.settlement_scheme === 'eip3009'
  )
}

export async function observeEip3009MerchantSettlement(
  intent: Eip3009SettlementIntent,
  txHash: string,
  nowMs: number = Date.now(),
): Promise<Eip3009SettlementObservation> {
  if (!isFundedEip3009Payment(intent, txHash)) return { outcome: 'not_applicable' }

  const merchant = intent.x402_merchant_address ?? intent.merchant_address ?? null
  const confirmedSec = Math.floor(new Date(intent.confirmed_at ?? '').getTime() / 1000)
  if (!merchant || !Number.isFinite(confirmedSec)) {
    // No merchant or no funding time means the only payment-specific checks
    // cannot run. Refuse rather than widen: a window around the wrong anchor
    // would pass a transfer that settled some other payment.
    return {
      outcome: 'unverified',
      retryable: false,
      reason: 'The payment has no merchant or no funding time, so its settlement cannot be verified',
    }
  }

  const verification = await verifySettlementTransferTx(txHash, {
    chainId: intent.chain_id,
    tokenAddress: intent.token_address,
    fromAddress: intent.to_address,
    toAddress: merchant,
    amountRaw: intent.amount_raw,
    // The merchant can only pull what this payment's funding put on the delegate.
    notBeforeSec: confirmedSec - CLOCK_SKEW_SECONDS,
    notAfterSec: Math.floor(nowMs / 1000) + CLOCK_SKEW_SECONDS,
  })
  if (verification.outcome !== 'verified') {
    return {
      outcome: 'unverified',
      retryable: verification.outcome === 'rpc_unavailable' || verification.outcome === 'not_found',
      reason: verification.reason,
    }
  }

  const recorded = await recordEip3009MerchantSettlement({
    txHash,
    intentId: intent.id,
    agentId: intent.agent_id,
  })
  switch (recorded) {
    case 'recorded':
      return { outcome: 'recorded' }
    case 'conflict':
      return {
        outcome: 'unverified',
        retryable: false,
        reason: 'This payment already has a different verified settlement transaction recorded',
      }
    case 'hash_taken':
      return {
        outcome: 'unverified',
        retryable: false,
        reason: `Transaction ${txHash} is already recorded for another payment`,
      }
    case 'not_eligible':
      return {
        outcome: 'unverified',
        retryable: false,
        reason: 'The payment changed while its settlement was being recorded',
      }
  }
}
