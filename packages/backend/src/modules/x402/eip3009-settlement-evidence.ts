/**
 * Agent-reported merchant settlement for the eip3009 funding leg (#3475).
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
 * The agent reports the hash through the same door as erc7710,
 * `POST /machine-payments/evidence` (`haven_report_settlement_evidence`), per
 * the owner decision on #3475. Nothing about the intent's lifecycle changes: it
 * is already `confirmed` with Haven's funding hash, and that hash stays. The
 * verified settlement is recorded beside it, and the receipt read prefers it
 * over the merchant's unverified echo.
 *
 * ## Trust
 *
 * The hash is CLIENT INPUT that ends in the user's receipts, so it is verified
 * against the chain first (`verifySettlementTransferTx`): a successful
 * transaction carrying a Transfer of exactly this payment's amount, in this
 * token, from this payment's delegate to its merchant, mined inside this
 * payment's window. Fail closed: anything short of `verified` writes nothing.
 * Haven still never contacts the merchant.
 *
 * What it cannot prove: WHICH of two same-shaped payments a transfer settled.
 * Haven never sees the EIP-3009 nonce on this path, so overlapping look-alikes
 * are attributed oldest-funded first: the repository refuses a settlement
 * whose block also falls inside the window of an EARLIER-funded look-alike
 * that has none recorded (`recordEip3009MerchantSettlement`, outcome
 * `ambiguous`). See `eip3009TwinExistsSql` for why only earlier ones block.
 */
import {
  X402_MAX_AUTHORIZATION_WINDOW_SECONDS,
  X402_SETTLEMENT_FORWARD_MARGIN_SECONDS,
} from '@haven_ai/sdk'
import { verifySettlementTransferTx } from '../../infra/chain/settlement-transfer-verifier.js'
import { recordEip3009MerchantSettlement } from '../../infra/repositories/x402-authorizations.js'
import { CLOCK_SKEW_SECONDS } from './settlement-observed.js'

/**
 * How long after `expires_at` a genuine settlement can still be mined: the
 * agent signs its EIP-3009 authorization no later than the payment's signing
 * deadline, and the SDK caps that authorization's lifetime at the clamped
 * merchant timeout plus the forward margin. Both constants are the SDK's own,
 * so the backend window cannot drift from what the signer signs.
 */
export const EIP3009_AUTHORIZATION_LIFETIME_SECONDS =
  X402_MAX_AUTHORIZATION_WINDOW_SECONDS + X402_SETTLEMENT_FORWARD_MARGIN_SECONDS

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
  confirmed_at?: string | null
  expires_at?: string | null
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

function toSeconds(value: string | null | undefined): number {
  return Math.floor(new Date(value ?? '').getTime() / 1000)
}

export async function observeEip3009MerchantSettlement(
  intent: Eip3009SettlementIntent,
  txHash: string,
): Promise<Eip3009SettlementObservation> {
  if (!isFundedEip3009Payment(intent, txHash)) return { outcome: 'not_applicable' }

  const merchant = intent.x402_merchant_address ?? intent.merchant_address ?? null
  const confirmedSec = toSeconds(intent.confirmed_at)
  const expiresSec = toSeconds(intent.expires_at)
  if (!merchant || !Number.isFinite(confirmedSec) || !Number.isFinite(expiresSec)) {
    // No merchant or no window means the only payment-specific checks cannot
    // run. Refuse rather than widen: a window around the wrong anchor would
    // pass a transfer that settled some other payment.
    return {
      outcome: 'unverified',
      retryable: false,
      reason: 'The payment has no merchant or no funding window, so its settlement cannot be verified',
    }
  }

  const forwardSeconds = EIP3009_AUTHORIZATION_LIFETIME_SECONDS + CLOCK_SKEW_SECONDS
  const verification = await verifySettlementTransferTx(txHash, {
    chainId: intent.chain_id,
    tokenAddress: intent.token_address,
    fromAddress: intent.to_address,
    toAddress: merchant,
    amountRaw: intent.amount_raw,
    // The merchant can only pull what funding already put on the delegate.
    notBeforeSec: confirmedSec - CLOCK_SKEW_SECONDS,
    notAfterSec: expiresSec + forwardSeconds,
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
    blockTimestampSec: verification.blockTimestampSec,
    skewSeconds: CLOCK_SKEW_SECONDS,
    forwardSeconds,
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
    case 'ambiguous':
      return {
        outcome: 'unverified',
        retryable: false,
        reason:
          `Transaction ${txHash} matches this payment, but also an earlier payment of the same amount ` +
          'to the same merchant whose settlement is not recorded yet; report that payment\'s settlement first',
      }
    case 'not_eligible':
      return {
        outcome: 'unverified',
        retryable: false,
        reason: 'The payment changed while its settlement was being recorded',
      }
  }
}
