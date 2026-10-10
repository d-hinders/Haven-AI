import { x402Description } from '../../domain/x402-description.js'
import {
  AgentPaymentNextAction,
  AgentPaymentPhase,
  AgentPaymentRail,
  type AgentPaymentNextAction as AgentPaymentNextActionValue,
  type AgentPaymentPhase as AgentPaymentPhaseValue,
} from '../../domain/agent-payment-taxonomy.js'
import { config } from '../../config.js'
import { ethers } from 'ethers'
import { withParties, type Parties } from '../../openapi/party-model.js'
import {
  expireOverdueIntentById,
  findIntentStatusRow,
  type PaymentIntentStatusRow,
} from '../../infra/repositories/payment-intents.js'
import { type AgentContext } from '../../middleware/agentAuth.js'
import { quoteFee } from '../fee/index.js'
import { toCanonicalAddress } from '../transactions/index.js'
import { MAX_SETTLEMENT_WINDOW_SECONDS } from '../x402/x402-delegation.js'
import { CLOCK_SKEW_SECONDS } from '../x402/settlement-observed.js'

/**
 * #2085: narrowed — this module constructs `'payment_intent'` and nothing
 * else, and no read can supply another value (see
 * `infra/repositories/__tests__/approval-kind-unconstructible.test.ts`).
 */
export type AgentPaymentKind = 'payment_intent'

/**
 * Platform fee surfaced on a machine-payment status (#386 — no silent
 * collection), matching the shape on the direct payment result. Dark today
 * (amount "0", applied false) via the fee module's quote.
 */
function statusFee(input: {
  paymentId: string
  rail: string
  amountRaw: string | null
  token: string | null
  userId: string
}): { amount: string; token: string; basis_points: number; applied: boolean } {
  let gross = 0n
  try { gross = BigInt(input.amountRaw ?? '0') } catch { gross = 0n }
  const quote = quoteFee({
    paymentId: input.paymentId,
    rail: input.rail,
    grossAtomic: gross,
    token: input.token ?? '',
    userId: input.userId,
  })
  return {
    amount: quote.feeAtomic === 0n ? '0' : ethers.formatUnits(quote.feeAtomic, 18),
    token: quote.feeToken,
    basis_points: quote.basisPoints,
    applied: !quote.isZero,
  }
}

/**
 * #3494: the cap every surfaced failure cause shares — the sign route's 502
 * `message`, this module's `failure_reason`, and `GET /payments/:id`'s
 * `error_message` (bounded at that route's read, same function). Vendor
 * secrets are already redacted before a message reaches storage
 * (`redactVendorSecrets`, `routes/payments.ts`); this is the second,
 * independent bound — LENGTH — because a viem/bundler failure can carry the
 * full encoded callData or ABI in its message, and neither redaction nor
 * truncation alone catches what the other misses.
 */
export const FAILURE_MESSAGE_MAX_LENGTH = 300

/** Bound (and trim) a stored or raw failure message; `null` in, `null` out. */
export function boundFailureMessage(message: string | null | undefined): string | null {
  if (message == null) return null
  const trimmed = message.trim()
  if (!trimmed) return null
  return trimmed.length > FAILURE_MESSAGE_MAX_LENGTH
    ? `${trimmed.slice(0, FAILURE_MESSAGE_MAX_LENGTH)}…`
    : trimmed
}

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
  /** Delegate captured with this intent; never inferred from a later agent rotation. */
  payer_address?: string | null
  /** #2960: the party quadruple, additive alongside `payer_address` (`delegate` only). */
  parties?: Parties
  tx_hash: string | null
  expires_at: string
  chain_id: number
  message: string
  /**
   * #3420: the delivered half of the settle vocabulary, on the status read —
   * `true` when a `machine_payment_evidence` row records the merchant's
   * response (`merchant_leg_reported`, which `FIND_INTENT_STATUS_ROW_SQL`
   * already computes: the receipt capture `completeX402MerchantCall` runs on
   * every accepted merchant reply). Absent when there is no such row —
   * honest "unknown", never a claimed `false`.
   */
  delivered?: boolean
  /**
   * #3475 follow-up: `machine_metadata.settlement_scheme`, the same read
   * `isFundedX402AwaitingMerchantLeg` already uses internally — surfaced so a
   * caller can tell an eip3009 funding-leg payment from an erc7710
   * no-funding-leg one without re-deriving it. `null` on the legacy rail, on
   * any x402 intent whose scheme metadata predates #946, and on any stored
   * value this enum does not (yet) name — never a third string this type
   * does not declare.
   */
  settlement_scheme?: 'eip3009' | 'erc7710' | null
  /**
   * #3475 follow-up: `true` only when an eip3009 payment's merchant
   * settlement transaction is already recorded and on-chain-verified
   * (`machine_metadata.merchant_settlement_tx_hash`, written by
   * `haven_report_settlement_evidence`'s eip3009 branch or by the #3888
   * settlement sweep when the chain names the settlement and the agent never
   * reported it). Always absent on erc7710 — its one settlement transaction
   * IS the confirmed intent, not a separately recorded hash, so this flag is
   * not the right signal there. Absent — never `false` — when unknown,
   * matching `delivered`'s own honesty rule.
   */
  merchant_settlement_recorded?: boolean
  /**
   * #3494: a bounded, redacted cause for a `failed` payment — the same
   * `error_message` `failSubmittedIntent` books on the row (already scrubbed
   * of vendor secrets by `redactVendorSecrets` before it is stored), capped
   * so a viem/bundler dump never rides a status read. Present (possibly
   * `null`, when no message was recorded) only when `status === 'failed'`;
   * omitted on every other status.
   */
  failure_reason?: string | null
  /**
   * #3564: `true` only while a payment's submit is receipt-unconfirmed and
   * not yet reconciled from the chain. Absent on every other row — never
   * `false` — matching the module's honesty rule for unknown facts.
   */
  submission_outcome_pending?: true
  fee?: { amount: string; token: string; basis_points: number; applied: boolean } | null
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
  mpp?: {
    amount_atomic: string | null
    asset: string | null
    network: string | null
    resource_url: string | null
    merchant_address: string | null
    description: string | null
    idempotency_key: string | null
    challenge_id: string | null
  }
}

/**
 * Stable identifiers for the structured-error cases the resume-state
 * endpoint can return. Documented in the OpenAPI spec so clients can
 * pattern-match on the code rather than the human-readable message.
 */
export const ResumeStateErrorCode = {
  Expired: 'expired',
  RailNotResumable: 'rail_not_resumable',
  ContextIncomplete: 'context_incomplete',
} as const
export type ResumeStateErrorCode = (typeof ResumeStateErrorCode)[keyof typeof ResumeStateErrorCode]

export interface AgentPaymentResumeStateLookup {
  status: AgentPaymentStatus | null
  resumeState: AgentPaymentResumeState | null
  error?: string
  errorCode?: ResumeStateErrorCode
}

export type AgentPaymentResumeState = AgentX402ResumeState | AgentMppResumeState

interface AgentX402PaymentOption {
  scheme: 'exact'
  network: string
  amount: string
  maxAmountRequired: string
  resource: string
  description?: string
  asset: string
  payTo: string
  maxTimeoutSeconds: number
}

interface AgentX402PaymentRequired {
  x402Version: number
  resource: {
    url: string
    description?: string
  }
  accepts: AgentX402PaymentOption[]
}

export interface AgentX402ResumeState {
  rail: 'x402'
  paymentId: string
  idempotencyKey: string
  paymentRequired: AgentX402PaymentRequired
  accepted: AgentX402PaymentOption
  url: string
  resourceUrl: string
  description: string | null
  amountAtomic: string
  amount: string
  token: string
  asset: string
  network: string
  chainId: number
  merchantAddress: string
}

export interface AgentMppResumeState {
  rail: 'mpp'
  paymentRail: string
  paymentId: string
  idempotencyKey: string
  challenge: {
    rail: string
    version: string
    challengeId: string
    resource: string
    description: string
    network: {
      chainId: number
      name: 'base'
    }
    asset: {
      symbol: string
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
  url: string
  resourceUrl: string
  description: string | null
  amountAtomic: string
  amount: string
  token: string
  asset: string
  network: string
  chainId: number
  merchantAddress: string
  expiresAt: string
}

interface MachinePaymentMetadata {
  network?: unknown
  description?: unknown
  protocol?: unknown
  /** #1355: the verbatim 402 PaymentRequired; #3610 reads `resource.description` from it on older rows. */
  payment_required?: unknown
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

function isMppRail(rail: string): boolean {
  return rail === AgentPaymentRail.Mpp || rail.startsWith('mpp_')
}

function chainNetwork(chainId: number): string {
  if (chainId === 8453) return 'base'
  return `eip155:${chainId}`
}

function nonEmpty(value: string | null | undefined): string | null {
  return value && value.length > 0 ? value : null
}

function railContext(input: {
  rail: string
  amountRaw: string | null
  tokenAddress: string | null
  resourceUrl: string | null
  merchantAddress: string | null
  idempotencyKey: string | null
  challengeId?: string | null
  machineMetadata: unknown
  /** #3494: the direct (non-x402/mpp) rail's own key, `payment_intents.send_idempotency_key`. */
  sendIdempotencyKey?: string | null
}) {
  const metadata = metadataObject(input.machineMetadata)

  if (input.rail === AgentPaymentRail.X402) {
    // #3610: rows authorized before the description was persisted still carry
    // the verbatim 402 (#1355); read the merchant's description from there.
    const description = x402Description(metadata.description, metadata.payment_required)
    const context = {
      amount_atomic: input.amountRaw,
      asset: input.tokenAddress,
      network: nullableString(metadata.network),
      description,
      idempotency_key: input.idempotencyKey,
      x402: {
        amount_atomic: input.amountRaw,
        asset: input.tokenAddress,
        network: nullableString(metadata.network),
        resource_url: input.resourceUrl,
        merchant_address: input.merchantAddress,
        description,
        idempotency_key: input.idempotencyKey,
      },
    }

    return context
  }

  if (isMppRail(input.rail)) {
    const context = {
      amount_atomic: input.amountRaw,
      asset: input.tokenAddress,
      network: nullableString(metadata.network),
      description: nullableString(metadata.description),
      idempotency_key: input.idempotencyKey,
      mpp: {
        amount_atomic: input.amountRaw,
        asset: input.tokenAddress,
        network: nullableString(metadata.network),
        resource_url: input.resourceUrl,
        merchant_address: input.merchantAddress,
        description: nullableString(metadata.description),
        idempotency_key: input.idempotencyKey,
        challenge_id: input.challengeId ?? null,
      },
    }

    return context
  }

  // #3494: the direct rail persisted no idempotency key of its own in the
  // railContext object before this — `send_idempotency_key` is a real column
  // (`routes/payments.ts` writes it from the request body, echoed on
  // `haven_send`/`haven_pay` since #3524), but `FIND_INTENT_STATUS_ROW_SQL`
  // did not select it and this function returned `{}` for every direct row.
  // One flat field, matching the x402/mpp branches' top-level `idempotency_key`
  // — no nested `direct: {}` block, since the direct rail has no other
  // rail-specific context to carry alongside it.
  if (input.rail === AgentPaymentRail.Direct) {
    return { idempotency_key: nonEmpty(input.sendIdempotencyKey ?? null) }
  }

  return {}
}

// #2115: `messageForRail` is DELETED, not reworded. It overrode the payment
// intent's own message on the x402 and MPP rails for four statuses —
// `pending`, `approved`, `proposed`, `executed` — and all four are
// unconstructible on this path.
//
// The proof, in one line: this module reads `payment_intents` and nothing else
// (`findIntentStatusRow`; the `approval_requests` fallback died with #2055),
// and every write to `payment_intents.status` in the repository layer sets one
// of five literals — `pending_signature` (the four INSERTs in
// `infra/repositories/payment-intents.ts`), `submitted`, `confirmed`,
// `expired`, `failed` (the UPDATEs there and in `x402-authorizations.ts` /
// `agent-rekeys.ts`). The four overridden statuses were `approval_requests`
// statuses, fed here by `approvalState`, which #2055 deleted with the table.
// Pinned by `__tests__/status-domain.test.ts` on the real-DB harness.
//
// Why it mattered more than the average dead branch: `GET /payments/:id` is
// the endpoint an agent calls to decide what to do next, and the SDK passes
// `message`/`next_action` straight through (`mapPaymentStatusResult` in
// `packages/sdk/src/payment-mappers.ts`) — so the backend's string wins over
// every client-side correction #2113 made. Those strings told an agent, in the
// imperative, to hold the merchant session open and poll for an approval that
// no live rail can produce: the legacy AllowanceModule rail answers 410 at
// every agent-payment entry point (#1986, `rails/execution-rail.ts`), and the
// delegation rail declines an out-of-policy payment at prepare with nothing
// written (`routes/payments.ts` 403/502; `modules/x402/delegation-authorize.ts`
// 403 `delegation_budget_exceeded`, #2082).

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

  // #2115: the catch-all, retained FAIL-CLOSED. The five branches above are
  // the whole reachable status domain (see the `messageForRail` deletion note
  // and `__tests__/status-domain.test.ts`), so nothing live lands here — but
  // if a status this module does not recognise is ever read back, the honest
  // verdict is STOP, not poll. It used to answer `check_status_later`, which
  // is a poll instruction for a row nothing can transition; that is the same
  // defect #2101/PR #2113 fixed one layer up in the SDK's
  // `nextActionForStatus`, and the backend's own `next_action` overrides the
  // SDK's, so the fix has to be made here too. `phase` is deliberately left at
  // `payment_submitted`: it is the least-wrong member of a closed wire enum
  // for a state that cannot occur, and `next_action` is the field the agent
  // contract says to follow first.
  return {
    phase: AgentPaymentPhase.PaymentSubmitted,
    nextAction: AgentPaymentNextAction.StopAndTellUser,
    message: `This payment is in an unrecognised state ("${status}") that no live Haven rail produces. Do not poll or retry it — tell the user to review this payment in Haven.`,
  }
}

// #2055: `approvalState` died with the approval_requests fallback — every
// status this module reports is a payment intent now.

// #2145 grace window, #3767 shared value: defined in a domain leaf so the
// accounting feed can wait out the SAME window without a module cycle.
import { merchantReportGraceElapsed } from '../../domain/merchant-report-grace.js'
export {
  MERCHANT_REPORT_GRACE_MIN,
  resolveMerchantReportGraceMin,
  merchantReportGraceMin,
  merchantReportGraceElapsed,
} from '../../domain/merchant-report-grace.js'

/** Parse `machine_metadata` the way `settlement-observed.ts` does, once, for both keys read off it below. */
function parsedMachineMetadata(machineMetadata: unknown): Record<string, unknown> | null {
  if (!machineMetadata) return null
  if (typeof machineMetadata === 'string') {
    try {
      return JSON.parse(machineMetadata) as Record<string, unknown>
    } catch {
      return null
    }
  }
  return machineMetadata as Record<string, unknown>
}

/** `machine_metadata.settlement_scheme`, parsed the way `settlement-observed.ts` does. */
function settlementSchemeOf(machineMetadata: unknown): string | null {
  const scheme = parsedMachineMetadata(machineMetadata)?.settlement_scheme
  return typeof scheme === 'string' ? scheme : null
}

/**
 * #3475 follow-up (review round 1, N1): the WIRE-TYPED narrowing of
 * `settlementSchemeOf` above for `AgentPaymentStatus.settlement_scheme` —
 * that helper stays `string | null` because its other two call sites
 * (`isFundedX402AwaitingMerchantLeg`, `isPastSettlementEvidenceWindowErc7710`)
 * only ever compare it against a literal and never surface it on the wire.
 * A stored value outside the declared enum (never written today, but not
 * schema-enforced at the column) maps to `null` here rather than escaping
 * the OpenAPI-declared type.
 */
function narrowSettlementScheme(scheme: string | null): 'eip3009' | 'erc7710' | null {
  return scheme === 'eip3009' || scheme === 'erc7710' ? scheme : null
}

/**
 * #2960: `machine_metadata.delegate_account_address`, written at authorize
 * on both delegation-rail legs (`modules/x402/delegation-authorize.ts`).
 * Null on rows authorized before #2960 and on the legacy rail.
 */
function delegateAccountAddressOf(machineMetadata: unknown): string | null {
  const value = parsedMachineMetadata(machineMetadata)?.delegate_account_address
  return typeof value === 'string' ? value : null
}

/**
 * #3475: an eip3009 merchant settlement the agent reported and Haven verified
 * on-chain (`modules/x402/eip3009-settlement-evidence.ts`), or the #3888
 * settlement sweep verified from the chain alone when no report ever came.
 * Its presence is proof the merchant already pulled this payment's funds from
 * the delegate.
 */
function hasVerifiedMerchantSettlement(machineMetadata: unknown): boolean {
  return typeof parsedMachineMetadata(machineMetadata)?.merchant_settlement_tx_hash === 'string'
}

/**
 * #2290: the funded-but-deliverable state — case 2 of `intentStateFor` below,
 * the one that emits `retry_original_x402_request`.
 *
 * Exported because `GET /x402/:id/sign-context` opens its already-executed
 * gate for exactly this state and no other. The remedy and the permission to
 * act on it have to be the SAME predicate: #2145 shipped a diagnosis whose
 * cure was unreachable, and a second, separately-worded copy of this
 * condition would just move that failure rather than remove it. Any refusal
 * here must therefore leave `intentStateFor` with nothing to promise.
 *
 * `!funded_but_unsettled` is load-bearing, not defensive: an open
 * `merchant_retry_rejected_after_payment` event means the merchant was asked
 * and said no, and case 1 below claims that row first. Its remedy is
 * `sweep_stranded_funds` — reclaiming the money, not re-signing a header for
 * a merchant that already refused it.
 *
 * `!hasVerifiedMerchantSettlement` (#3475) is load-bearing the same way: a
 * recorded, on-chain-verified delegate → merchant pull proves this payment's
 * merchant was already paid. Re-signing a fresh EIP-3009 authorization for the
 * same amount from the shared delegate could then pay that merchant twice, out
 * of another payment's in-flight funding. A pull is not proof of delivery, but
 * it is proof a retry must not re-pay.
 */
export function isFundedX402AwaitingMerchantLeg(payment: PaymentIntentStatusRow): boolean {
  return (
    payment.status === 'confirmed' &&
    !payment.funded_but_unsettled &&
    railFor(payment) === AgentPaymentRail.X402 &&
    settlementSchemeOf(payment.machine_metadata) === 'eip3009' &&
    !hasVerifiedMerchantSettlement(payment.machine_metadata) &&
    !payment.merchant_leg_reported &&
    payment.confirmed_at !== null &&
    merchantReportGraceElapsed(payment.confirmed_at)
  )
}

/**
 * #2970: true past its settlement window for a `submitted` erc7710 intent
 * that never received verified evidence — the case `check_status_later`
 * lied about, because nothing is watching for this settlement except a
 * report (#2092's on-chain-verified confirm seam, `modules/mpp/evidence.ts`
 * → `settlement-observed.ts`, runs only when the evidence endpoint is
 * called; there is no passive success path for this row besides the
 * sweeper's own best-effort scan). Mirrors the sweeper's own
 * `isPastSettlementWindow` (`modules/x402/settlement-sweeper.ts`) — same
 * anchor (`created_at`, the authorize time), same constant
 * (`MAX_SETTLEMENT_WINDOW_SECONDS`), no clock-skew allowance added on top,
 * because this is a UX cutover (stop promising a poll will resolve it), not
 * the sweeper's own attribution boundary.
 *
 * `status === 'submitted'` alone is enough to know evidence never arrived:
 * that same confirm seam moves the intent to `confirmed` the instant a
 * verifiable hash is reported, so a still-`submitted` erc7710 intent has
 * never had one. (Deliberately not naming the confirm function here by its
 * identifier — `__tests__/erc7710-confirm-seam-census-pin.test.ts` greps
 * production source for it and pins an exact three-file import census; a
 * fourth textual hit would redden a pin about call sites, not comments.)
 */
export function isPastSettlementEvidenceWindowErc7710(payment: PaymentIntentStatusRow): boolean {
  if (
    payment.status !== 'submitted' ||
    railFor(payment) !== AgentPaymentRail.X402 ||
    settlementSchemeOf(payment.machine_metadata) !== 'erc7710'
  ) {
    return false
  }
  const createdMs = new Date(payment.created_at).getTime()
  if (!Number.isFinite(createdMs)) return true
  return Date.now() > createdMs + MAX_SETTLEMENT_WINDOW_SECONDS * 1000
}

/**
 * #3420: the sweep's LAST attribution chance, as a wall-clock instant.
 *
 * A settlement of this intent can only ever be confirmed by the evidence
 * report (the agent-reported settle door) or by the sweeper, and BOTH
 * verify the transfer with `notAfterSec = authorize + MAX_SETTLEMENT_WINDOW_SECONDS
 * + CLOCK_SKEW_SECONDS` (`settlement-observed.ts` — the child delegation's
 * on-chain `timestamp` caveat bounded by the window, widened by the same skew
 * both copies carry). Past that instant no verified confirmation is possible
 * at ANY age: the sweep's tick cadence only decides how long the within-grace
 * answer stays honest, and its width here is the verifier's own boundary, not
 * an invented second constant.
 *
 * Exported for the status test, which pins the cutover on the real DB like
 * #2970's suite does.
 */
export function isPastSettlementAttributionHorizonErc7710(
  payment: Pick<PaymentIntentStatusRow, 'created_at'>,
  nowMs = Date.now(),
): boolean {
  const createdMs = new Date(payment.created_at).getTime()
  // Same fail-closed direction as the window predicate: an unreadable anchor
  // is past every horizon.
  if (!Number.isFinite(createdMs)) return true
  return nowMs > createdMs + (MAX_SETTLEMENT_WINDOW_SECONDS + CLOCK_SKEW_SECONDS) * 1000
}

/**
 * #2145: the phase/next_action/message for a payment-intent row, including
 * the two funded-but-unsettled overrides of the plain status mapping.
 *
 * On the EIP-3009 bridge, `confirmed` means the FUNDING leg confirmed — value
 * left the treasury and sits on the delegate EOA — and says nothing about the
 * merchant. Two evidence states distinguish what happened next:
 *
 * 1. **Merchant rejected the retry** (client-reported open
 *    `merchant_retry_rejected_after_payment` event) → the retry was tried and
 *    refused; the remedy is reclaiming the funds (`sweep_stranded_funds`).
 * 2. **Merchant leg never reported** (no evidence row upgraded past the
 *    server-written `payment_confirmed` base, and the grace window has
 *    passed) → the agent died between funding and retry — the #2145 crash
 *    shape. The payment is still deliverable: the delegate holds the funds
 *    and the resume call re-signs a fresh EIP-3009 header locally, so the
 *    remedy is `retry_original_x402_request`. If that retry is then rejected,
 *    the SDK records the rejection and this same function flips the answer to
 *    case 1 — the two states are self-consistent, with no time-based expiry
 *    policy invented here.
 *
 * Derived entirely from evidence Haven holds server-side: case 2 must fire
 * for an agent that never came back, which is exactly what a client-written
 * signal cannot provide. #2292 does NOT change that — it changes how long
 * case 2 has to wait when the agent DID come back. The grace window was the
 * only route to either state on the plain-HTTP flow, because case 1's
 * reconciliation event was written solely by the SDK's own retry path and a
 * manually retried merchant had no way to report anything. An agent-reported
 * rejection now reaches case 1 directly, and an agent-reported acceptance
 * writes the `merchant_response_observed` evidence row that makes
 * `merchant_leg_reported` true — so a delivered purchase leaves case 2's
 * predicate permanently, rather than entering it when the window elapses.
 * Since #3888 the settlement sweep is a second exit: a payment the merchant
 * settled but nobody ever reported gets its verified hash recorded from the
 * chain, `hasVerifiedMerchantSettlement` goes true, and the payment reads as
 * plain `payment_confirmed` — "the merchant has likely not been paid" is now
 * said only about payments nothing has proven settled. Neither report is
 * trusted with anything financial: see
 * `MerchantCompletion.reportMerchantOutcome` in the SDK for the boundary. Scoped to `settlement_scheme === 'eip3009'`: on
 * erc7710 there is no funding leg and `confirmed` IS merchant settlement, and
 * an intent with no scheme metadata fails closed to the plain mapping.
 *
 * The residual ambiguity is a delivered payment whose evidence upgrade never
 * reached Haven (the attach is best-effort): that payment reads as case 2 and
 * is told to retry a merchant that was already paid. That is the safe side —
 * x402 merchants answer a re-request of a settled purchase idempotently
 * (#1519) — and the alternative (treating missing evidence as delivered) is
 * the #2145 bug itself.
 */
function intentStateFor(payment: PaymentIntentStatusRow): {
  phase: AgentPaymentPhaseValue
  nextAction: AgentPaymentNextActionValue
  message: string
} {
  if (payment.status === 'confirmed' && payment.funded_but_unsettled) {
    return {
      phase: AgentPaymentPhase.FundedButUnsettled,
      nextAction: AgentPaymentNextAction.SweepStrandedFunds,
      message: "Haven's funding leg confirmed but the merchant rejected the payment retry. The delegate wallet may hold stranded funds — tell the user to review this payment in Haven.",
    }
  }
  if (isFundedX402AwaitingMerchantLeg(payment)) {
    return {
      phase: AgentPaymentPhase.FundedButUnsettled,
      nextAction: AgentPaymentNextAction.RetryOriginalX402Request,
      message: "Haven's funding leg confirmed but no merchant response was ever recorded — the merchant has likely not been paid. Resume this payment to retry the original request; do not start a new payment for the same purchase. Report what the merchant answers, so Haven records the outcome instead of waiting out this window again.",
    }
  }
  if (isPastSettlementEvidenceWindowErc7710(payment)) {
    // #3420: split the #2970 answer by HOW LONG the window has been past.
    //
    // Within the sweep's last attribution chance (window + the verifier's own
    // clock-skew allowance — `isPastSettlementAttributionHorizonErc7710`
    // below), `awaiting_settlement_evidence` stays honest and a poll can
    // still resolve: the sweep's 120s tick runs continuously, so a settlement
    // mined inside the window can still land at any point up to that horizon.
    // The message now says which, instead of the fixed "about two minutes"
    // that read identically at 3 minutes and at 3 hours (#3420's wording
    // defect) — the sweep works from the SAME verifier boundary this code
    // does, so the remaining patience is exactly horizon − now, and an agent
    // reading the expiry it already holds (expires_at = authorize + window)
    // can derive it without a new field.
    //
    // Past the horizon the answer is TERMINAL: no verification — reported
    // hash or sweep — can ever confirm this settlement again, so the phase
    // names the fact (`delivered_unverified`), the next action is the
    // tool-less stop, and the message says polling is over. `phase` moves off
    // `payment_submitted` (the #2970 shape) because that phase's own
    // description promises a poll; the wire enum gains one ADDITIVE member —
    // no existing value is narrowed, retired, or remapped. The row's stored
    // `status` stays `submitted`: the sweep's confirm seam can still flip a
    // late-reported hash, and nothing here writes.
    if (isPastSettlementAttributionHorizonErc7710(payment)) {
      return {
        phase: AgentPaymentPhase.DeliveredUnverified,
        nextAction: AgentPaymentNextAction.StopAndTellUser,
        message:
          'This payment is settled no further than it was: the merchant delivered, but the settlement window and the sweep\'s last chance to verify a settlement have both passed with no verified on-chain evidence. Polling cannot change this — tell the user the goods were delivered but Haven holds no verified settlement evidence for this payment. If you hold the merchant\'s real settlement transaction hash, haven_report_settlement_evidence still accepts it.',
      }
    }
    return {
      phase: AgentPaymentPhase.PaymentSubmitted,
      nextAction: AgentPaymentNextAction.AwaitingSettlementEvidence,
      // #2972: if the agent holds the merchant's real settlement transaction
      // hash (PAYMENT-RESPONSE.transaction, or a prior settle/complete
      // result's settlement_tx_hash), report it with
      // haven_report_settlement_evidence instead of waiting on the sweep —
      // that tool posts to the SAME fail-closed on-chain verification door
      // `modules/mpp/evidence.ts` already guards (see #2680's confirm-seam
      // census). Otherwise poll haven_get_payment_status, unchanged.
      //
      // #3420: the sweep's residual window is stated as what it is — bounded
      // by the payment's own expiry plus the verifier's skew allowance, not a
      // fixed "about two minutes". expires_at IS authorize + the settlement
      // window (both anchors are the authorize write), so this phrasing stays
      // true at every age inside the grace band.
      message: "The settlement window passed with no verified on-chain evidence for this payment's settlement yet. If you hold the merchant's real settlement transaction hash, report it with haven_report_settlement_evidence. Otherwise, Haven's settlement sweep can still attribute it until shortly after this payment's expiry — poll haven_get_payment_status once more a couple of minutes past that. If it still shows no evidence, the goods were delivered but Haven holds no verified settlement evidence for this payment; tell the user.",
    }
  }
  // #3564: a `submitted` row whose submit was receipt-unconfirmed is
  // OUTCOME-PENDING, not an ordinary in-flight submit. Same non-terminal
  // phase and next_action as the ordinary submit state (poll status), but a
  // message that says what is actually happening — the ordinary text would
  // read as "everything is fine" when the bundler never answered, and the
  // #2115 lesson is that this string reaches the agent verbatim. Once the
  // submission reconciler resolves the row, the status is terminal and the
  // real state speaks instead.
  if (payment.status === 'submitted' && payment.submission_outcome === 'unknown' && payment.user_op_hash != null) {
    return {
      phase: AgentPaymentPhase.PaymentSubmitted,
      nextAction: AgentPaymentNextAction.CheckStatusLater,
      message:
        'The payment was submitted but its on-chain outcome is not known yet. ' +
        'Do not create a new payment for this — check status again later: ' +
        'Haven reconciles this payment from the chain, and this status becomes the real outcome.',
    }
  }
  return paymentIntentState(payment.status)
}

export function agentPaymentStatusHttpCode(status: AgentPaymentStatus): number {
  // #2085: the `kind === 'approval_request'` block that stood here mapped the
  // queue's statuses (202/200/409/410). It was unreachable — the comment four
  // lines above already said every status this module reports is a payment
  // intent — so removing it changes no response.
  if (status.status === 'confirmed') return 200
  if (status.status === 'pending_signature' || status.status === 'submitted') return 409
  if (status.status === 'expired') return 410
  if (status.status === 'failed') return 502
  return 200
}

function buildX402ResumeState(status: AgentPaymentStatus): AgentPaymentResumeStateLookup {
  const context = status.x402
  const resourceUrl = nonEmpty(context?.resource_url ?? status.resource_url)
  const merchantAddress = nonEmpty(context?.merchant_address ?? status.merchant_address)
  const amountAtomic = nonEmpty(context?.amount_atomic ?? status.amount_atomic)
  const asset = nonEmpty(context?.asset ?? status.asset)
  const network = nonEmpty(context?.network ?? status.network) ?? chainNetwork(status.chain_id)
  const description = context?.description ?? status.description ?? null
  const idempotencyKey =
    nonEmpty(context?.idempotency_key ?? status.idempotency_key) ??
    `x402:${status.payment_id}`

  if (!resourceUrl || !merchantAddress || !amountAtomic || !asset) {
    return {
      status,
      resumeState: null,
      error: 'Stored x402 payment context is incomplete and cannot be resumed from payment id alone',
      errorCode: ResumeStateErrorCode.ContextIncomplete,
    }
  }

  const accepted: AgentX402PaymentOption = {
    scheme: 'exact',
    network,
    amount: amountAtomic,
    maxAmountRequired: amountAtomic,
    resource: resourceUrl,
    description: description ?? undefined,
    asset,
    payTo: merchantAddress,
    maxTimeoutSeconds: 30,
  }

  const paymentRequired: AgentX402PaymentRequired = {
    x402Version: 2,
    resource: {
      url: resourceUrl,
      description: description ?? undefined,
    },
    accepts: [accepted],
  }

  return {
    status,
    resumeState: {
      rail: 'x402',
      paymentId: status.payment_id,
      idempotencyKey,
      paymentRequired,
      accepted,
      url: resourceUrl,
      resourceUrl,
      description,
      amountAtomic,
      amount: status.amount,
      token: status.token,
      asset,
      network,
      chainId: status.chain_id,
      merchantAddress,
    },
  }
}

function buildMppResumeState(status: AgentPaymentStatus): AgentPaymentResumeStateLookup {
  const context = status.mpp
  const resourceUrl = nonEmpty(context?.resource_url ?? status.resource_url)
  const merchantAddress = nonEmpty(context?.merchant_address ?? status.merchant_address)
  const amountAtomic = nonEmpty(context?.amount_atomic ?? status.amount_atomic)
  const asset = nonEmpty(context?.asset ?? status.asset)
  const description = context?.description ?? status.description ?? null
  const challengeId = nonEmpty(context?.challenge_id)
  const idempotencyKey =
    nonEmpty(context?.idempotency_key ?? status.idempotency_key) ??
    `${status.rail}:${status.payment_id}`
  // status.rail is the wire value persisted on the row (e.g. `mpp_demo`,
  // `mpp_crypto`). We carry it through verbatim onto the resume state's
  // granular `paymentRail` field; the categorical `rail: 'mpp'` below is the
  // SDK discriminator and is set independently.
  const paymentRail = status.rail

  if (status.chain_id !== 8453) {
    return {
      status,
      resumeState: null,
      error: 'Stored MPP payment context uses an unsupported network for SDK resume state rehydration',
      errorCode: ResumeStateErrorCode.ContextIncomplete,
    }
  }

  if (!resourceUrl || !merchantAddress || !amountAtomic || !asset || !challengeId) {
    return {
      status,
      resumeState: null,
      error: 'Stored MPP payment context is incomplete and cannot be resumed from payment id alone',
      errorCode: ResumeStateErrorCode.ContextIncomplete,
    }
  }

  const challenge = {
    rail: paymentRail,
    version: '2026-05-12',
    challengeId,
    resource: resourceUrl,
    description: description ?? 'Haven machine payment',
    network: {
      chainId: status.chain_id,
      name: 'base' as const,
    },
    asset: {
      symbol: status.token,
      address: asset,
      decimals: 6 as const,
    },
    amount: {
      display: status.amount,
      atomic: amountAtomic,
    },
    recipient: merchantAddress,
    expiresAt: status.expires_at,
    metadata: {
      protocol: 'mpp',
      payment_id: status.payment_id,
    },
  }

  return {
    status,
    resumeState: {
      rail: 'mpp',
      paymentRail,
      paymentId: status.payment_id,
      idempotencyKey,
      challenge,
      url: resourceUrl,
      resourceUrl,
      description,
      amountAtomic,
      amount: status.amount,
      token: status.token,
      asset,
      network: 'base',
      chainId: status.chain_id,
      merchantAddress,
      expiresAt: status.expires_at,
    },
  }
}

export async function getAgentPaymentResumeState(
  agent: AgentContext,
  paymentId: string,
): Promise<AgentPaymentResumeStateLookup> {
  const read = await readPaymentStatus(agent, paymentId)
  if (!read) return { status: null, resumeState: null }
  // #3307: the resume lookup EMBEDS the agent-facing (checksummed) status, but
  // REBUILDS its payment objects — `accepted` / `paymentRequired` / the MPP
  // `challenge`, which go back to merchants and signers — from the same row in
  // STORED casing, so they stay byte-identical to before the casing change.
  const { canonical: status, stored } = read
  const embed = (lookup: AgentPaymentResumeStateLookup): AgentPaymentResumeStateLookup => ({ ...lookup, status })

  if (status.status === 'expired') {
    return {
      status,
      resumeState: null,
      error: 'Payment approval expired and cannot be resumed',
      errorCode: ResumeStateErrorCode.Expired,
    }
  }

  if (status.rail === AgentPaymentRail.X402) {
    return embed(buildX402ResumeState(stored))
  }

  if (isMppRail(status.rail)) {
    return embed(buildMppResumeState(stored))
  }

  // `AgentPaymentRail` declares `stripe_deposit` and `spt` as valid rails so
  // wire validation matches the database, but the resume-state surface only
  // supports x402 and MPP today. Return a structured code so OpenAPI clients
  // can match on it instead of grepping the human message.
  return {
    status,
    resumeState: null,
    error: `Payment rail ${status.rail} does not support resume-state rehydration`,
    errorCode: ResumeStateErrorCode.RailNotResumable,
  }
}

export async function getAgentPaymentStatus(
  agent: AgentContext,
  paymentId: string,
): Promise<AgentPaymentStatus | null> {
  return (await readPaymentStatus(agent, paymentId))?.canonical ?? null
}

/** How a status build cases its addresses: canonical for agents, identity for merchant-bound rebuilds. */
type AddressCasing = <T extends string | null | undefined>(value: T) => T
const storedCasing: AddressCasing = (value) => value

/**
 * One read of the payment row, as two builds of the same status (#3307):
 * `canonical` — every Haven-owned address EIP-55 checksummed, the same rule as
 * the receipt (`mapEvidence`) and the transactions feed (#3129), which is what
 * agents see; `stored` — the row's own casing, which the resume builders read
 * so the payment objects they hand back to merchants and signers do not change.
 */
async function readPaymentStatus(
  agent: AgentContext,
  paymentId: string,
): Promise<{ canonical: AgentPaymentStatus; stored: AgentPaymentStatus } | null> {
  await expireOverdueIntentById(paymentId, agent.id)

  const payment: PaymentIntentStatusRow | null = await findIntentStatusRow(paymentId, agent.id)
  // #2055: the approval_requests fallback that stood here is gone — the table
  // is dropped and queue history is waived (owner decision on #2021). An id
  // that is not a payment intent is now simply unknown.
  if (!payment) return null
  return {
    canonical: statusFromRow(agent, payment, toCanonicalAddress),
    stored: statusFromRow(agent, payment, storedCasing),
  }
}

function statusFromRow(
  agent: AgentContext,
  payment: PaymentIntentStatusRow,
  address: AddressCasing,
): AgentPaymentStatus {
  const state = intentStateFor(payment)
  const rail = railFor(payment)
  const resourceUrl = payment.payment_resource_url ?? payment.x402_resource_url
  // #3307: canonicalised in THIS caller's arguments, never inside
  // `withParties`, which also builds the signed receipt bundle (left as it is).
  const merchantAddress = address(payment.merchant_address ?? payment.x402_merchant_address)
  const delegateAddress = address(payment.delegate_address)
  return withParties(
    {
      payment_id: payment.id,
      kind: 'payment_intent' as const,
      rail,
      status: payment.status,
      phase: state.phase,
      next_action: state.nextAction,
      amount: payment.amount_human,
      token: payment.token_symbol,
      resource_url: resourceUrl,
      merchant_address: merchantAddress,
      payer_address: delegateAddress,
      tx_hash: payment.tx_hash,
      expires_at: payment.expires_at,
      chain_id: payment.chain_id,
      message: state.message,
      // #3420: additive delivered-visibility — `true` only when the merchant's
      // response is recorded server-side; the key is OMITTED otherwise so the
      // payload never claims a `false` it cannot know.
      ...(payment.merchant_leg_reported ? { delivered: true as const } : {}),
      // #3475 follow-up: additive alongside `delivered` — same read
      // `isFundedX402AwaitingMerchantLeg` already performs, surfaced so a
      // caller does not have to re-derive it from `machine_metadata`.
      settlement_scheme: narrowSettlementScheme(settlementSchemeOf(payment.machine_metadata)),
      // #3518: WHICH budget metered this payment, recorded at authorize —
      // the settle summary joins its allowance rows on this instead of
      // re-deriving a (token, payee) selection whose winner can move
      // between pay and settle. Null on the legacy rail and pre-053 rows.
      ...(payment.budget_delegation_hash ? { budget_delegation_hash: payment.budget_delegation_hash } : {}),
      // #3564: additive outcome-pending visibility — present ONLY while a
      // submit is receipt-unconfirmed and not yet reconciled (the wire rule
      // everywhere on this object: absent, never `false`).
      ...(payment.submission_outcome === 'unknown' && payment.user_op_hash != null
        ? { submission_outcome_pending: true as const }
        : {}),
      ...(hasVerifiedMerchantSettlement(payment.machine_metadata)
        ? { merchant_settlement_recorded: true as const }
        : {}),
      // #3494: additive, failed rows only — see the field doc on
      // `AgentPaymentStatus.failure_reason`.
      ...(payment.status === 'failed' ? { failure_reason: boundFailureMessage(payment.error_message) } : {}),
      fee: statusFee({ paymentId: payment.id, rail, amountRaw: payment.amount_raw, token: payment.token_symbol, userId: agent.user_id }),
      ...railContext({
        rail,
        amountRaw: payment.amount_raw,
        tokenAddress: address(payment.token_address),
        resourceUrl,
        merchantAddress,
        idempotencyKey: payment.machine_idempotency_key ?? payment.x402_idempotency_key,
        challengeId: payment.machine_challenge_id,
        machineMetadata: payment.machine_metadata,
        sendIdempotencyKey: payment.send_idempotency_key,
      }),
    },
    {
      account_address: address(payment.account_address) ?? null,
      delegate_address: delegateAddress,
      // #2960: `machine_metadata.delegate_account_address`, written at
      // authorize on both delegation-rail legs — null for rows authorized
      // before #2960 and on the legacy rail, where no such account exists.
      delegate_account_address: address(delegateAccountAddressOf(payment.machine_metadata)),
      merchant_address: merchantAddress,
    },
  )
}
