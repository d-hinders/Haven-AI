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
 * settlement must still be recordable. And since #3925 the window is no
 * longer the only thing separating two same-shaped payments: every recorded
 * settlement is also bound to an `AuthorizationUsed` nonce provably this
 * payment's — derived from its id (the sweep), or signed by its delegate in
 * the X-PAYMENT header the report posts (the agent path, via
 * {@link eip3009SettlementProofFromHeader}). See `recordEip3009MerchantSettlement`.
 */
import { ethers } from 'ethers'
import { verifySettlementTransferTx } from '../../infra/chain/settlement-transfer-verifier.js'
import {
  recordEip3009MerchantSettlement,
  findSiblingX402DelegationPaymentIds,
} from '../../infra/repositories/x402-authorizations.js'
import { TRANSFER_WITH_AUTHORIZATION_TYPES, sweepUsdcDomain } from '@haven_ai/sdk'
import { deriveX402PaymentNonce } from '@haven_ai/sdk/edge'
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
  /**
   * Refused, nothing written. `retryable` separates "ask again later" from a
   * settled no. `errorCode` (#4061) is present only on a refusal a client
   * must branch on — today the missing proof header, whose remedy is to
   * re-report WITH the header, unlike every other refusal here.
   */
  | { outcome: 'unverified'; retryable: boolean; reason: string; errorCode?: SettlementProofErrorCode }

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

/**
 * The nonce attribution a merchant-settlement record must carry (#3925): the
 * EIP-3009 nonce the transaction is required to have burned, and whether that
 * nonce is the one derived from this payment's id (the consistency check).
 */
export interface Eip3009SettlementNonceProof {
  nonce: string
  nonceDerived: boolean
}

export type Eip3009SettlementProofResult =
  | { ok: true; proof: Eip3009SettlementNonceProof }
  | { ok: false; reason: string; errorCode?: SettlementProofErrorCode }

/**
 * #4061: the machine-readable code on the missing-proof-header refusal,
 * relayed as the evidence 409 body's `error_code`. It is the ONE settlement
 * refusal whose remedy is to report again — with the payment header the
 * agent retried the merchant with — so a client (the hosted report tools)
 * branches on this code, never on the sentence below. Every other refusal
 * here names a hash or a header that does not belong to this payment, and
 * re-reporting it re-refuses.
 */
export const SETTLEMENT_PROOF_HEADER_MISSING_ERROR_CODE = 'settlement_proof_header_missing'
export type SettlementProofErrorCode = typeof SETTLEMENT_PROOF_HEADER_MISSING_ERROR_CODE

/** The refusal for a report that carries no header to prove its nonce from. */
export const MISSING_PROOF_HEADER_REASON =
  'The settlement report carries no X-PAYMENT payment header, so the nonce its settlement ' +
  'burned cannot be proven bound to this payment — report the settlement again with the ' +
  'payment header that was sent to the merchant (the retry path carries it)'

/**
 * The EIP-712 domain of the token a payment settles in, or `null` when the
 * token has no pinned domain — the same pinned, on-chain-verified values the
 * sweep leg uses (`sweepUsdcDomain`). `verifyingContract` must be the
 * payment's own token or the domain proves nothing about it.
 */
function x402TokenEip712Domain(
  chainId: number,
  tokenAddress: string,
): { name: string; version: string; chainId: number; verifyingContract: string } | null {
  try {
    const domain = sweepUsdcDomain(chainId)
    return domain.verifyingContract.toLowerCase() === tokenAddress.toLowerCase() ? domain : null
  } catch {
    return null
  }
}

/**
 * Derive the settlement's nonce proof from the X-PAYMENT header the report
 * posts (#3925, owner option iii). The header is the one the SDK already sent
 * to the merchant — its `authorization` carries the delegate's signature over
 * the EIP-3009 struct, so its `nonce` is provably bound to THIS payment:
 *
 * - the header must decode to a payload carrying `signature` + `authorization`;
 * - the authorization's `from` AND the recovered EIP-712 signer must both be
 *   the payment's delegate (`intent.to_address`) — a header lifted from a
 *   sibling payment names the wrong delegate and is refused before its nonce
 *   is ever used;
 * - the token must have a pinned EIP-712 domain (Base USDC today); a token
 *   the backend cannot verify signatures for is refused, never trusted.
 *
 * The result is the proof `observeEip3009MerchantSettlement` records against:
 * `nonceDerived` is the consistency check (the header nonce equals
 * `deriveX402PaymentNonce(intent.id)`, i.e. the client derives nonces).
 * The header's `to`/`value` are NOT checked here — the chain-side verifier
 * binds the settlement transfer to the merchant and the exact amount, and
 * since the #4061 review it reads ONLY the transfer paired with this nonce's
 * `AuthorizationUsed` (the log immediately after it), so the nonce and the
 * transfer it is held to are the same authorization. The signature covers
 * whatever the delegate actually authorized.
 */
export function eip3009SettlementProofFromHeader(
  intent: Eip3009SettlementIntent,
  header: string | null | undefined,
): Eip3009SettlementProofResult {
  if (!header || !header.trim()) {
    return {
      ok: false,
      reason: MISSING_PROOF_HEADER_REASON,
      errorCode: SETTLEMENT_PROOF_HEADER_MISSING_ERROR_CODE,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(header, 'base64').toString('utf8'))
  } catch {
    return {
      ok: false,
      reason: 'The settlement report’s X-PAYMENT header is not a decodable x402 payment payload',
    }
  }
  const payload =
    parsed && typeof parsed === 'object' && 'payload' in parsed
      ? (parsed as { payload?: unknown }).payload
      : parsed
  const payloadRecord =
    payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null
  const authorization =
    payloadRecord && typeof payloadRecord.authorization === 'object'
      ? (payloadRecord.authorization as Record<string, unknown>)
      : null
  const signature = payloadRecord?.signature
  if (!authorization || typeof signature !== 'string' || !signature) {
    return {
      ok: false,
      reason: 'The settlement report’s X-PAYMENT header carries no signed EIP-3009 authorization',
    }
  }
  const nonce = authorization.nonce
  if (typeof nonce !== 'string' || !nonce) {
    return {
      ok: false,
      reason: 'The settlement report’s X-PAYMENT header carries no authorization nonce',
    }
  }

  const delegate = intent.to_address
  const domain = x402TokenEip712Domain(intent.chain_id, intent.token_address)
  if (!domain) {
    return {
      ok: false,
      reason: `This payment's token ${intent.token_address} on chain ${intent.chain_id} has no ` +
        'pinned EIP-712 domain, so the header’s authorization signature cannot be verified',
    }
  }
  if (typeof authorization.from !== 'string' || authorization.from.toLowerCase() !== delegate.toLowerCase()) {
    return {
      ok: false,
      reason: 'The X-PAYMENT header’s authorization names a different payer than this payment’s delegate',
    }
  }
  let signer: string
  try {
    signer = ethers.verifyTypedData(
      domain,
      TRANSFER_WITH_AUTHORIZATION_TYPES as unknown as Record<string, ethers.TypedDataField[]>,
      {
        from: authorization.from,
        to: authorization.to,
        value: BigInt(String(authorization.value)),
        validAfter: BigInt(String(authorization.validAfter ?? 0)),
        validBefore: BigInt(String(authorization.validBefore ?? 0)),
        nonce,
      },
      signature,
    )
  } catch {
    return {
      ok: false,
      reason: 'The X-PAYMENT header’s authorization is not signed by this payment’s delegate',
    }
  }
  if (signer.toLowerCase() !== delegate.toLowerCase()) {
    return {
      ok: false,
      reason: 'The X-PAYMENT header’s authorization is not signed by this payment’s delegate',
    }
  }

  return {
    ok: true,
    proof: {
      nonce: nonce.toLowerCase(),
      nonceDerived: nonce.toLowerCase() === deriveX402PaymentNonce(intent.id).toLowerCase(),
    },
  }
}

export async function observeEip3009MerchantSettlement(
  intent: Eip3009SettlementIntent,
  txHash: string,
  nowMs: number = Date.now(),
  nonceProof?: Eip3009SettlementNonceProof,
): Promise<Eip3009SettlementObservation> {
  if (!isFundedEip3009Payment(intent, txHash)) return { outcome: 'not_applicable' }

  // Fail closed on an unproven report: a settlement may be recorded only when
  // the transaction burned a nonce provably bound to THIS payment (#3925).
  // The sweep always derives one from the payment id; the agent path derives
  // one from the posted X-PAYMENT header. No proof, no record.
  if (!nonceProof) {
    return {
      outcome: 'unverified',
      retryable: false,
      reason: MISSING_PROOF_HEADER_REASON,
      errorCode: SETTLEMENT_PROOF_HEADER_MISSING_ERROR_CODE,
    }
  }

  // #4061: a header LIFTED from a same-agent sibling passes every check
  // above — same delegate, so the payer and signature are right — and a
  // transaction that settled the sibling really burned the nonce it names.
  // That nonce is the SIBLING's derived nonce, which is what gives it away:
  // a nonce derived from another payment's id was signed for that payment.
  // Refused before the chain is read. (A non-deriving client's random nonce
  // cannot be tied to a sibling this way; the burned-nonce check still binds
  // the record to the header the delegate signed.) Only an agent-reported
  // proof can be non-derived — the sweep always derives from this payment.
  if (!nonceProof.nonceDerived) {
    const siblingIds = await findSiblingX402DelegationPaymentIds(intent.agent_id, intent.id)
    if (siblingIds.some((id) => deriveX402PaymentNonce(id).toLowerCase() === nonceProof.nonce)) {
      return {
        outcome: 'unverified',
        retryable: false,
        reason:
          'The X-PAYMENT header’s authorization nonce is the derived nonce of another payment of ' +
          'this agent — the header was signed for that payment, not this one',
      }
    }
  }

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
    // Check 9 (#3925): the transaction must have burned the nonce this
    // payment's proof names — the sweep's own attribution standard.
    expectedAuthorizationUsed: { authorizer: intent.to_address, nonce: nonceProof.nonce },
  })
  if (verification.outcome !== 'verified') {
    // A burned-but-different nonce that IS another payment's derived nonce
    // names the theft: the report's hash settles a sibling payment.
    if (verification.outcome === 'mismatch' && verification.authorizationUsedNonces) {
      const siblingIds = await findSiblingX402DelegationPaymentIds(intent.agent_id, intent.id)
      if (
        siblingIds.some((id) =>
          verification.authorizationUsedNonces!.includes(deriveX402PaymentNonce(id).toLowerCase()),
        )
      ) {
        return {
          outcome: 'unverified',
          retryable: false,
          reason: `Transaction ${txHash} burned the derived nonce of another payment of this agent — it settles another payment`,
        }
      }
    }
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
    proof: { nonceBound: verification.nonceBound === true, nonceDerived: nonceProof.nonceDerived },
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
