/**
 * Machine-payment evidence recording + attach orchestration (#997, epic #980
 * M4). Extracted verbatim from `lib/machine-payment-evidence.ts`:
 * `recordMachinePaymentEvidenceBase` (the settlement-time base row, #956),
 * `attachMachinePaymentEvidence` (the agent-reported proof attach, first-
 * write-wins on `proof_status` via the repository's sticky `CASE`), and
 * `reconcileDelegateResidueAfterSettlement` (#716). `isProtocolPaymentRail`
 * now lives in `rail-dispatch.ts` alongside the module's other protocol-rail
 * checks — everything else here is unchanged.
 *
 * Also holds the HTTP-adjacent orchestration `routes/machine-payments.ts`
 * used to do inline: `mapEvidence` (proof-header-safe serialization shared by
 * `GET /receipts` and `POST /evidence`), the receipts-list read, and the
 * marker-to-HTTP-status mapping for `attachEvidenceHandler` — the route keeps
 * only request-shape validation and `reply.code(...).send(...)`.
 */
import {
  attachEvidenceProof,
  findIntentEvidenceSource,
  findIntentForEvidenceScoped,
  getIntentSettlementFields,
  insertResidueEvent,
  listEvidenceReceiptsForAgent,
  resolveReconciliationForPayment,
  upsertEvidenceBase,
} from '../../infra/repositories/machine-payments.js'
import { findAgentDelegateAddress } from '../../infra/repositories/agents.js'
import { getBookTimeSekValue } from '../../infra/fiat-values.js'
import { getTokenBalance } from '../../rails/allowance-module.js'
import { quoteFee, recordSettledFee } from '../fee/index.js'
import { feedSettledPaymentBestEffort } from '../reporting/index.js'
import { isProtocolPaymentRail } from './rail-dispatch.js'
import type { EvidenceBody, MppHandlerResult } from './types.js'

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/

export type PaymentProofStatus =
  | 'payment_confirmed'
  | 'merchant_response_observed'
  | 'protocol_receipt_attached'

type MachinePaymentReferenceKind = 'payment_intent' | 'approval_request'

export interface MachinePaymentEvidenceSource {
  id: string
  kind?: MachinePaymentReferenceKind
  agent_id: string
  user_id: string
  safe_address: string
  chain_id: number
  token_symbol: string
  token_address: string
  to_address: string
  amount_raw: string
  amount_human: string
  tx_hash: string | null
  status: string
  source?: string | null
  payment_rail?: string | null
  payment_resource_url?: string | null
  x402_resource_url?: string | null
  merchant_address?: string | null
  x402_merchant_address?: string | null
  machine_challenge_id?: string | null
  machine_idempotency_key?: string | null
  x402_idempotency_key?: string | null
  machine_metadata?: Record<string, unknown> | string | null
  confirmed_at?: string | null
}

export interface AttachMachinePaymentEvidenceInput {
  agentId: string
  paymentId: string
  rail: string
  txHash: string
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

export interface MachinePaymentEvidenceRow {
  id: string
  payment_intent_id: string | null
  approval_request_id: string | null
  agent_id: string
  user_id: string
  rail: string
  proof_status: PaymentProofStatus
  tx_hash: string
  chain_id: number
  resource_url: string
  merchant_address: string | null
  payer_address: string
  settlement_address: string
  token_symbol: string
  token_address: string
  amount_raw: string
  amount_human: string
  challenge_id: string | null
  idempotency_key: string | null
  challenge_payload: Record<string, unknown> | null
  selected_payment: Record<string, unknown> | null
  payment_proof_header_name: string | null
  payment_proof_header: string | null
  protocol_receipt_header_name: string | null
  protocol_receipt_header: string | null
  protocol_receipt_payload: Record<string, unknown> | null
  merchant_status: number | null
  confirmed_at: string | null
  amount_sek: string | null
  fx_rate_sek: string | null
  fx_source: string | null
  fx_at: string | null
  created_at: string
  updated_at: string
  /** Which settlement branch ran (eip3009 | erc7710), joined from the intent (#946/#1063). */
  settlement_scheme?: string | null
  /** The metering budget, uniform across schemes (#1059) — null on the legacy rail. */
  budget_delegation_hash?: string | null
}

interface PaymentIntentEvidenceRow extends MachinePaymentEvidenceSource {
  kind: 'payment_intent'
  tx_hash: string
}

interface ApprovalRequestEvidenceRow extends MachinePaymentEvidenceSource {
  kind: 'approval_request'
  tx_hash: string
}

type ProtocolPaymentEvidenceRow = PaymentIntentEvidenceRow | ApprovalRequestEvidenceRow

interface EvidenceLogger {
  warn: (payload: Record<string, unknown>, message: string) => void
}

function railForPayment(intent: MachinePaymentEvidenceSource): string | null {
  return intent.payment_rail ?? intent.source ?? null
}

function resourceUrlForPayment(intent: MachinePaymentEvidenceSource): string | null {
  return intent.payment_resource_url ?? intent.x402_resource_url ?? null
}

function merchantAddressForPayment(intent: MachinePaymentEvidenceSource): string | null {
  return intent.merchant_address ?? intent.x402_merchant_address ?? null
}

function idempotencyKeyForPayment(intent: MachinePaymentEvidenceSource): string | null {
  return intent.machine_idempotency_key ?? intent.x402_idempotency_key ?? null
}

function referenceKindForPayment(intent: MachinePaymentEvidenceSource): MachinePaymentReferenceKind {
  return intent.kind ?? 'payment_intent'
}

function referenceColumnForPayment(intent: MachinePaymentEvidenceSource): 'payment_intent_id' | 'approval_request_id' {
  return referenceKindForPayment(intent) === 'approval_request'
    ? 'approval_request_id'
    : 'payment_intent_id'
}

function expectedStatusForPayment(intent: MachinePaymentEvidenceSource): string {
  return referenceKindForPayment(intent) === 'approval_request' ? 'executed' : 'confirmed'
}

function normalizeJson(value: Record<string, unknown> | string | null | undefined): string | null {
  if (!value) return null
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

function cleanHeaderName(value: string | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 128) return null
  return trimmed
}

function cleanHeaderValue(value: string | undefined): string | null {
  if (!value) return null
  return value.length > 16384 ? value.slice(0, 16384) : value
}

function proofStatusForAttach(input: AttachMachinePaymentEvidenceInput): PaymentProofStatus {
  if (input.protocolReceiptHeader || input.protocolReceiptPayload) {
    return 'protocol_receipt_attached'
  }
  return 'merchant_response_observed'
}

export async function recordMachinePaymentEvidenceBase(
  intent: MachinePaymentEvidenceSource,
): Promise<void> {
  const rail = railForPayment(intent)
  if (!isProtocolPaymentRail(rail)) return
  if (intent.status !== expectedStatusForPayment(intent) || !intent.tx_hash) return

  const resourceUrl = resourceUrlForPayment(intent)
  if (!resourceUrl) return
  const referenceColumn = referenceColumnForPayment(intent)
  const paymentIntentId = referenceColumn === 'payment_intent_id' ? intent.id : null
  const approvalRequestId = referenceColumn === 'approval_request_id' ? intent.id : null

  // Book-time FX (migration 026): captured here, at settlement, and never
  // overwritten (the COALESCE in the repository's upsert). A pricing outage
  // yields null, which is backfillable — it must not block settlement.
  const sek = await getBookTimeSekValue(intent.token_symbol, intent.amount_human)
  const amountSek = sek ? sek.amountSek : null
  const fxRateSek = sek ? sek.fxRate : null
  const fxSource = sek ? sek.fxSource : null
  const fxAt = sek ? new Date().toISOString() : null

  await upsertEvidenceBase({
    referenceColumn,
    paymentIntentId,
    approvalRequestId,
    agentId: intent.agent_id,
    userId: intent.user_id,
    rail,
    txHash: intent.tx_hash,
    chainId: intent.chain_id,
    resourceUrl,
    merchantAddress: merchantAddressForPayment(intent),
    payerAddress: intent.safe_address,
    settlementAddress: intent.to_address,
    tokenSymbol: intent.token_symbol,
    tokenAddress: intent.token_address,
    amountRaw: intent.amount_raw,
    amountHuman: intent.amount_human,
    challengeId: intent.machine_challenge_id ?? null,
    idempotencyKey: idempotencyKeyForPayment(intent),
    challengePayload: normalizeJson(intent.machine_metadata),
    confirmedAt: intent.confirmed_at ?? null,
    amountSek,
    fxRateSek,
    fxSource,
    fxAt,
  })

  // Record the (currently zero) platform fee for this payment so the fee ledger
  // and the bookkeeping export have a complete, reconcilable history (#386
  // scaffold). Best-effort and idempotent — must never block settlement, and
  // moves no funds while the fee module is dark.
  try {
    let grossAtomic = 0n
    try { grossAtomic = BigInt(intent.amount_raw) } catch { grossAtomic = 0n }
    const quote = quoteFee({
      paymentId: intent.id,
      rail: rail ?? 'unknown',
      grossAtomic,
      token: intent.token_symbol,
      userId: intent.user_id,
    })
    await recordSettledFee(quote)
  } catch {
    // swallow — fee recording is non-critical to settlement
  }

  // Auto-feed the settled payment into the user's accounting tool (#491/#499).
  // Fire-and-forget + idempotent: never blocks or delays settlement, inert
  // unless the hosted reporting feed is available for this user.
  feedSettledPaymentBestEffort(intent.user_id, intent.id)
}

export async function recordMachinePaymentEvidenceBaseById(
  paymentIntentId: string,
  agentId?: string,
): Promise<void> {
  const intent = await findIntentEvidenceSource(paymentIntentId, agentId ?? null)
  if (intent) await recordMachinePaymentEvidenceBase(intent)
}

export async function tryRecordMachinePaymentEvidenceBaseById(
  paymentIntentId: string,
  agentId?: string,
  log?: EvidenceLogger,
): Promise<void> {
  try {
    await recordMachinePaymentEvidenceBaseById(paymentIntentId, agentId)
  } catch (err) {
    if (log) {
      log.warn(
        { err, paymentIntentId, agentId },
        'Machine payment evidence recording failed after confirmed payment',
      )
      return
    }

    console.warn(
      'Machine payment evidence recording failed after confirmed payment',
      { paymentIntentId, agentId, err },
    )
  }
}

async function findProtocolPaymentForEvidence(
  agentId: string,
  paymentId: string,
): Promise<ProtocolPaymentEvidenceRow | null> {
  // #2055: the approval_requests fallback is gone with the table — a payment
  // id either resolves as an intent or is unknown.
  const payment = await findIntentForEvidenceScoped(paymentId, agentId)
  return (payment as PaymentIntentEvidenceRow | null) ?? null
}

export async function attachMachinePaymentEvidence(
  input: AttachMachinePaymentEvidenceInput,
): Promise<MachinePaymentEvidenceRow | null> {
  if (!TX_HASH_RE.test(input.txHash)) {
    throw new Error('tx_hash_invalid')
  }
  if (!isProtocolPaymentRail(input.rail)) {
    throw new Error('unsupported_rail')
  }
  if (
    input.merchantStatus !== undefined &&
    (!Number.isInteger(input.merchantStatus) || input.merchantStatus < 100 || input.merchantStatus > 599)
  ) {
    throw new Error('merchant_status_invalid')
  }

  const payment = await findProtocolPaymentForEvidence(input.agentId, input.paymentId)
  if (!payment) return null
  if (payment.status !== expectedStatusForPayment(payment) || !payment.tx_hash) {
    throw new Error('payment_not_confirmed')
  }
  if (payment.tx_hash.toLowerCase() !== input.txHash.toLowerCase()) {
    throw new Error('tx_hash_mismatch')
  }

  const rail = railForPayment(payment)
  if (rail !== input.rail) {
    throw new Error('rail_mismatch')
  }

  const resourceUrl = resourceUrlForPayment(payment)
  if (!resourceUrl) {
    throw new Error('resource_missing')
  }
  if (input.resourceUrl && input.resourceUrl !== resourceUrl) {
    throw new Error('resource_mismatch')
  }

  await recordMachinePaymentEvidenceBase(payment)

  const proofStatus = proofStatusForAttach(input)
  const referenceColumn = referenceColumnForPayment(payment)
  const evidence = await attachEvidenceProof<MachinePaymentEvidenceRow>({
    referenceColumn,
    paymentId: payment.id,
    agentId: input.agentId,
    proofStatus,
    challengePayload: normalizeJson(input.challengePayload),
    selectedPayment: normalizeJson(input.selectedPayment),
    paymentProofHeaderName: cleanHeaderName(input.paymentProofHeaderName),
    paymentProofHeader: cleanHeaderValue(input.paymentProofHeader),
    protocolReceiptHeaderName: cleanHeaderName(input.protocolReceiptHeaderName),
    protocolReceiptHeader: cleanHeaderValue(input.protocolReceiptHeader),
    protocolReceiptPayload: normalizeJson(input.protocolReceiptPayload),
    merchantStatus: input.merchantStatus ?? null,
  })

  if (evidence) {
    await resolveReconciliationForPayment(referenceColumn, payment.id, input.agentId)

    // Post-settlement delegate reconciliation (#716, epic #713): a settle
    // proof just arrived, so for standard x402 (funding went to the agent's
    // own delegate EOA) that funding should have LEFT the delegate. Read the
    // balance now and flag residue at payment time instead of leaving it for
    // the sweep/monitor to discover later. Best-effort — a flaky RPC must
    // never fail the proof attach.
    if (
      referenceColumnForPayment(payment) === 'payment_intent_id' &&
      (payment.payment_rail ?? payment.source) === 'x402' &&
      (proofStatus === 'protocol_receipt_attached' || proofStatus === 'merchant_response_observed')
    ) {
      try {
        await reconcileDelegateResidueAfterSettlement(payment, input.agentId)
      } catch {
        // best-effort: the #714 balance monitor is the standing backstop
      }
    }
  }

  return evidence
}

/**
 * Flag funds still sitting on the delegate right after a settle proof (#716).
 * Only for standard x402 where the funding recipient IS the agent's own
 * delegate EOA — anything else (merchant-direct payTo) is not ours to read.
 * The threshold is THIS payment's amount: at/above it, this payment's funding
 * very likely never settled; smaller balances are ambient dust, which the
 * #714 monitor owns. Idempotent per (payment, event type); read-only apart
 * from the flag row — recovery stays with the sweep.
 */
export async function reconcileDelegateResidueAfterSettlement(
  payment: MachinePaymentEvidenceSource,
  agentId: string,
): Promise<void> {
  const delegate = await findAgentDelegateAddress(agentId)
  if (!delegate || delegate.toLowerCase() !== payment.to_address.toLowerCase()) return

  const balance = await getTokenBalance(payment.chain_id, delegate, payment.token_address)
  if (balance < BigInt(payment.amount_raw)) return

  await insertResidueEvent({
    agentId,
    userId: payment.user_id,
    paymentIntentId: payment.id,
    rail: payment.payment_rail ?? payment.source ?? 'x402',
    txHash: payment.tx_hash,
    resourceUrl: resourceUrlForPayment(payment),
    merchantAddress: payment.merchant_address ?? payment.x402_merchant_address ?? null,
    reason:
      'Delegate still holds at least the funded amount after the settle proof — funding may not have settled',
    details: JSON.stringify({
      observed_balance_atomic: balance.toString(),
      payment_amount_raw: payment.amount_raw,
      delegate_address: delegate,
    }),
  })
}

// ── HTTP-adjacent orchestration (moved from routes/machine-payments.ts) ─────

/**
 * Wire-shape a `machine_payment_evidence` row for an agent response. Strips
 * the raw proof-header VALUES (`payment_proof_header`, `protocol_receipt_header`)
 * — those are Haven-internal verification material, never echoed back.
 */
export function mapEvidence(row: MachinePaymentEvidenceRow) {
  return {
    id: row.id,
    settlement_scheme: row.settlement_scheme ?? null,
    budget_delegation_hash: row.budget_delegation_hash ?? null,
    payment_id: row.payment_intent_id ?? row.approval_request_id,
    payment_intent_id: row.payment_intent_id,
    approval_request_id: row.approval_request_id,
    rail: row.rail,
    proof_status: row.proof_status,
    tx_hash: row.tx_hash,
    chain_id: row.chain_id,
    resource_url: row.resource_url,
    merchant_address: row.merchant_address,
    payer_address: row.payer_address,
    settlement_address: row.settlement_address,
    token_symbol: row.token_symbol,
    token_address: row.token_address,
    amount_raw: row.amount_raw,
    amount_human: row.amount_human,
    challenge_id: row.challenge_id,
    idempotency_key: row.idempotency_key,
    challenge_payload: row.challenge_payload,
    selected_payment: row.selected_payment,
    payment_proof_header_name: row.payment_proof_header_name,
    protocol_receipt_header_name: row.protocol_receipt_header_name,
    protocol_receipt_payload: row.protocol_receipt_payload,
    merchant_status: row.merchant_status,
    confirmed_at: row.confirmed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

/** `GET /receipts` orchestration: recent evidence rows, agent-scoped. */
export async function listReceipts(agentId: string, limit: number) {
  const receipts = await listEvidenceReceiptsForAgent<MachinePaymentEvidenceRow>(agentId, limit)
  return receipts.map(mapEvidence)
}

/**
 * `POST /evidence` orchestration: attach + the marker-to-HTTP-status mapping.
 * Assumes `validateEvidenceBody` already passed. Preserves the exact
 * evidence-write-then-echo-enrichment ordering (#1118 review NB2): the
 * intent's `settlement_scheme`/`budget_delegation_hash` are looked up AFTER
 * the attach succeeds and are best-effort — a lookup failure never fails the
 * 202 the attach already earned.
 */
export async function attachEvidenceHandler(
  agentId: string,
  body: EvidenceBody,
): Promise<MppHandlerResult> {
  try {
    const evidence = await attachMachinePaymentEvidence({
      agentId,
      paymentId: body.paymentId as string,
      rail: body.rail as string,
      txHash: body.txHash as string,
      resourceUrl: body.resourceUrl,
      merchantStatus: body.merchantStatus,
      challengePayload: body.challengePayload,
      selectedPayment: body.selectedPayment,
      paymentProofHeaderName: body.paymentProofHeaderName,
      paymentProofHeader: body.paymentProofHeader,
      protocolReceiptHeaderName: body.protocolReceiptHeaderName,
      protocolReceiptHeader: body.protocolReceiptHeader,
      protocolReceiptPayload: body.protocolReceiptPayload,
    })

    if (!evidence) {
      return { statusCode: 404, body: { error: 'Payment not found' } }
    }

    // The INSERT…RETURNING row has no intent join — look the two intent
    // fields up so this echo reports the same truth the receipts list does
    // (previously both always echoed null here, #1118 review NB2).
    let intentFields: { settlement_scheme?: string | null; budget_delegation_hash?: string | null } = {}
    if (evidence.payment_intent_id) {
      try {
        intentFields = (await getIntentSettlementFields(evidence.payment_intent_id)) ?? {}
      } catch {
        // Echo enrichment only — never fail the 202 over it.
      }
    }
    return { statusCode: 202, body: { evidence: mapEvidence({ ...evidence, ...intentFields }) } }
  } catch (err) {
    const marker = err instanceof Error ? err.message : String(err)
    if (marker === 'payment_not_confirmed') {
      return { statusCode: 409, body: { error: 'Evidence requires a confirmed payment' } }
    }
    if (marker === 'tx_hash_mismatch') {
      return { statusCode: 409, body: { error: 'txHash does not match payment intent' } }
    }
    if (marker === 'rail_mismatch') {
      return { statusCode: 409, body: { error: 'rail does not match payment intent' } }
    }
    if (marker === 'resource_mismatch') {
      return { statusCode: 409, body: { error: 'resourceUrl does not match payment intent' } }
    }
    if (marker === 'unsupported_rail') {
      return { statusCode: 400, body: { error: 'Unsupported evidence rail' } }
    }
    if (marker === 'tx_hash_invalid') {
      return { statusCode: 400, body: { error: 'txHash must be a 0x-prefixed transaction hash' } }
    }
    if (marker === 'merchant_status_invalid') {
      return { statusCode: 400, body: { error: 'merchantStatus must be an HTTP status code' } }
    }

    throw err
  }
}
