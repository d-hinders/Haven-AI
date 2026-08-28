import {
  AgentPaymentNextAction,
  AgentPaymentPhase,
  AgentPaymentRail,
  type AgentPaymentNextAction as AgentPaymentNextActionValue,
  type AgentPaymentPhase as AgentPaymentPhaseValue,
} from '../../domain/agent-payment-taxonomy.js'
import { ethers } from 'ethers'
import {
  expireOverdueIntentById,
  findIntentStatusRow,
  type PaymentIntentStatusRow,
} from '../../infra/repositories/payment-intents.js'
import { type AgentContext } from '../../middleware/agentAuth.js'
import { quoteFee } from '../fee/index.js'

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
  tx_hash: string | null
  expires_at: string
  chain_id: number
  message: string
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
}) {
  const metadata = metadataObject(input.machineMetadata)

  if (input.rail === AgentPaymentRail.X402) {
    const context = {
      amount_atomic: input.amountRaw,
      asset: input.tokenAddress,
      network: nullableString(metadata.network),
      description: nullableString(metadata.description),
      idempotency_key: input.idempotencyKey,
      x402: {
        amount_atomic: input.amountRaw,
        asset: input.tokenAddress,
        network: nullableString(metadata.network),
        resource_url: input.resourceUrl,
        merchant_address: input.merchantAddress,
        description: nullableString(metadata.description),
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

/**
 * #2145: how long after the funding leg confirms before a missing merchant
 * report means "the agent is gone" rather than "the agent is mid-retry".
 *
 * A live agent retries the merchant within seconds of the funding
 * confirmation; inside this window the status must not instruct a concurrent
 * second retry. The figure mirrors the delegate-balance monitor's
 * IN_FLIGHT_WINDOW_MIN (`infra/delegate-balance-monitor.ts`), which encodes
 * the same judgement about the same interval from the operator side.
 */
export const MERCHANT_REPORT_GRACE_MIN = 15

/** `machine_metadata.settlement_scheme`, parsed the way `settlement-observed.ts` does. */
function settlementSchemeOf(machineMetadata: unknown): string | null {
  if (!machineMetadata) return null
  let metadata: Record<string, unknown> | null = null
  if (typeof machineMetadata === 'string') {
    try {
      metadata = JSON.parse(machineMetadata) as Record<string, unknown>
    } catch {
      return null
    }
  } else {
    metadata = machineMetadata as Record<string, unknown>
  }
  const scheme = metadata?.settlement_scheme
  return typeof scheme === 'string' ? scheme : null
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
 * signal cannot provide. Scoped to `settlement_scheme === 'eip3009'`: on
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
  if (
    payment.status === 'confirmed' &&
    railFor(payment) === AgentPaymentRail.X402 &&
    settlementSchemeOf(payment.machine_metadata) === 'eip3009' &&
    !payment.merchant_leg_reported &&
    payment.confirmed_at !== null &&
    Date.now() - new Date(payment.confirmed_at).getTime() >= MERCHANT_REPORT_GRACE_MIN * 60_000
  ) {
    return {
      phase: AgentPaymentPhase.FundedButUnsettled,
      nextAction: AgentPaymentNextAction.RetryOriginalX402Request,
      message: "Haven's funding leg confirmed but no merchant response was ever recorded — the merchant has likely not been paid. Resume this payment to retry the original request; do not start a new payment for the same purchase.",
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
  const status = await getAgentPaymentStatus(agent, paymentId)
  if (!status) return { status: null, resumeState: null }

  if (status.status === 'expired') {
    return {
      status,
      resumeState: null,
      error: 'Payment approval expired and cannot be resumed',
      errorCode: ResumeStateErrorCode.Expired,
    }
  }

  if (status.rail === AgentPaymentRail.X402) {
    return buildX402ResumeState(status)
  }

  if (isMppRail(status.rail)) {
    return buildMppResumeState(status)
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
  await expireOverdueIntentById(paymentId, agent.id)

  const payment: PaymentIntentStatusRow | null = await findIntentStatusRow(paymentId, agent.id)
  if (payment) {
    const state = intentStateFor(payment)
    const rail = railFor(payment)
    const resourceUrl = payment.payment_resource_url ?? payment.x402_resource_url
    const merchantAddress = payment.merchant_address ?? payment.x402_merchant_address
    return {
      payment_id: payment.id,
      kind: 'payment_intent',
      rail,
      status: payment.status,
      phase: state.phase,
      next_action: state.nextAction,
      amount: payment.amount_human,
      token: payment.token_symbol,
      resource_url: resourceUrl,
      merchant_address: merchantAddress,
      payer_address: payment.delegate_address,
      tx_hash: payment.tx_hash,
      expires_at: payment.expires_at,
      chain_id: payment.chain_id,
      message: state.message,
      fee: statusFee({ paymentId: payment.id, rail, amountRaw: payment.amount_raw, token: payment.token_symbol, userId: agent.user_id }),
      ...railContext({
        rail,
        amountRaw: payment.amount_raw,
        tokenAddress: payment.token_address,
        resourceUrl,
        merchantAddress,
        idempotencyKey: payment.machine_idempotency_key ?? payment.x402_idempotency_key,
        challengeId: payment.machine_challenge_id,
        machineMetadata: payment.machine_metadata,
      }),
    }
  }

  // #2055: the approval_requests fallback that stood here is gone — the table
  // is dropped and queue history is waived (owner decision on #2021). An id
  // that is not a payment intent is now simply unknown.
  return null
}
