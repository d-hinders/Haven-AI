/**
 * The #4319 proof ladder's Tier 2 — receipt-hash attribution for the EIP-3009
 * merchant settlement — and the shared Tier 1 helper that records from the
 * STORED X-PAYMENT header (arrival path, sweep tick, backfill).
 *
 * ## Why a separate entry point
 *
 * `observeEip3009MerchantSettlement`'s `!nonceProof` refusal stays EXACTLY as
 * it is (#3925/#4061): an agent-reported settlement is recorded only when the
 * burned nonce is provably this payment's. Tier 2 is the owner-approved
 * relaxation for clients whose nonce Haven cannot prove — Lovable Dev reports
 * only the funding hash, so the generic attach path holds the merchant
 * receipt (`protocol_receipt_payload.transaction`) and nothing else. The
 * relaxation is gated behind `HAVEN_EIP3009_RECEIPT_ATTRIBUTION` (default
 * off) and fenced by seven limits, every one of which fails closed. The
 * record is labelled `merchant_settlement_proof: 'receipt'` and carries no
 * nonce flags — and it NEVER stamps `merchant_settlement_nonce_bound`.
 *
 * ## The limits, and what each refuses
 *
 * 1. **Fallback only.** The write is the same compare-and-set
 *    `recordEip3009MerchantSettlement` always was: it never overrides a
 *    recorded value, and a record landing between selection and write
 *    answers `conflict` — nothing is written, nothing is judged.
 * 2. **Exactly one burn.** The candidate's receipt must contain exactly one
 *    `AuthorizationUsed(delegate, *)` from the payment's token — several
 *    means a batch, refused as ambiguous. That single nonce is passed to
 *    `verifySettlementTransferTx` so check 9 (the #4061 pairing) and every
 *    transfer check apply: exact amount and token, delegate → merchant,
 *    `confirmed_at − 120 s`.
 * 3. **Sibling nonce.** A burned nonce that is any sibling's DERIVED nonce is
 *    refused — the post-verification check `:366-380`'s logic. If it equals
 *    THIS payment's derived nonce, the proof is Tier 1-strength and the
 *    record is written as a nonce record (no receipt label).
 * 4. **Symmetric ambiguity guard, by block.** Any same-shape sibling (same
 *    agent, delegate, merchant and amount) funded at or before the
 *    candidate's block must be PROVABLY settled before this payment's
 *    funding — its own recorded settlement's block, read over RPC, below
 *    this payment's funding block. Covers siblings both earlier and later;
 *    the A-B-swap counter-example is refused.
 * 5. **Before the next funding.** The candidate's block is before the same
 *    delegate's next funding block (the first sibling funding after this
 *    payment's). A pull that burned after new funds arrived could relate to
 *    them.
 * 6. **Derived nonce burned elsewhere.** While
 *    `authorizationState(delegate, deriveX402PaymentNonce(id))` is true, the
 *    receipt proof is refused: the sweep's stronger attribution is pending
 *    or recorded elsewhere, and the weaker proof must not block it (#3888).
 * 7. **Persisted verdict.** `machine_metadata.merchant_settlement_receipt_
 *    verdict` records `recorded` / `refused_ambiguous` /
 *    `refused_mismatch` / `retryable`. A refused verdict is final and never
 *    re-checked; a retryable one is re-checked with backoff (each evidence
 *    attach, each idempotent backfill run).
 *
 * An RPC failure is retryable and records NOTHING — "could not ask" is never
 * a verdict about the chain. Funding blocks are not stored, so the block
 * guards read them over RPC under a per-candidate cap
 * ({@link MAX_FUNDING_BLOCK_READS_PER_CANDIDATE}); an unreadable block
 * refuses (retryable) for now rather than guess.
 *
 * `protocol_receipt_header` is deliberately NOT decoded as a candidate
 * fallback in this slice — rows carrying only it are counted by the dry run.
 */
import { ethers } from 'ethers'
import { getProvider } from '../../infra/chain/relayer-reads.js'
import {
  AUTHORIZATION_USED_IFACE,
  AUTHORIZATION_USED_TOPIC,
  findAuthorizationUsedTx,
  readAuthorizationState,
} from '../../infra/chain/authorization-used-scanner.js'
import { effectiveLogBatchBlocks } from '../../infra/chain/log-range-limit.js'
import { verifySettlementTransferTx } from '../../infra/chain/settlement-transfer-verifier.js'
import { isZeroSettlementTxHash } from '@haven_ai/sdk'
import { deriveX402PaymentNonce } from '@haven_ai/sdk/edge'
import { config } from '../../config.js'
import { CLOCK_SKEW_SECONDS } from './settlement-observed.js'
import { observeEip3009MerchantSettlement, type Eip3009SettlementIntent } from './eip3009-settlement-evidence.js'
import {
  findSiblingX402DelegationPayments,
  recordEip3009MerchantSettlement,
  recordEip3009ReceiptVerdict,
  type Eip3009ReceiptVerdict,
  type SiblingX402DelegationRow,
} from '../../infra/repositories/x402-authorizations.js'

/** Well-formed 32-byte transaction hash; anything else is refused, never decoded loosely. */
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/

/**
 * Funding-block reads per Tier 2 candidate, on top of the candidate's own
 * two (the funding tx and the candidate tx). A same-shape sibling storm over
 * the cap refuses retryable — bounding one candidate's RPC cost beats an
 * unbounded walk, and a later run (backoff) is the retry.
 */
export const MAX_FUNDING_BLOCK_READS_PER_CANDIDATE = 12

/**
 * The Tier 1 arrival/backfill scan span: the same 500 × 20 shape the sweep
 * tick uses per candidate. An EIP-3009 authorization is redeemable only
 * minutes past signing, so the settlement lies close to the funding block;
 * the span is over-reach in the safe direction and costs a topics-indexed
 * filter, not a Transfer walk.
 */
export const TIER1_SCAN_SPAN_BLOCKS = 500 * 20

/** Tier 2's outcome. `conflict` is the race answer, `disabled` the flag's, `would_record` the dry run's. */
export type Eip3009ReceiptAttributionOutcome =
  | { outcome: 'recorded' }
  | { outcome: 'would_record' }
  | { outcome: 'conflict'; reason: string }
  | { outcome: 'not_applicable' }
  | { outcome: 'disabled' }
  | { outcome: 'refused_ambiguous'; reason: string }
  | { outcome: 'refused_mismatch'; reason: string }
  | { outcome: 'retryable'; reason: string }

const REFUSED_OUTCOMES = ['refused_ambiguous', 'refused_mismatch'] as const

function refused(
  verdict: (typeof REFUSED_OUTCOMES)[number],
  reason: string,
): Eip3009ReceiptAttributionOutcome {
  return { outcome: verdict, reason }
}

/** The receipt payload's candidate hash, or `null` when it names none. */
export function receiptPayloadTransaction(payload: unknown): string | null {
  const parsed =
    typeof payload === 'string'
      ? (() => {
          try {
            return JSON.parse(payload) as unknown
          } catch {
            return null
          }
        })()
      : payload
  const tx =
    parsed && typeof parsed === 'object' && 'transaction' in parsed
      ? (parsed as { transaction?: unknown }).transaction
      : null
  return typeof tx === 'string' && tx ? tx : null
}

function metadataOf(row: SiblingX402DelegationRow): Record<string, unknown> {
  if (!row.machine_metadata) return {}
  if (typeof row.machine_metadata !== 'string') return row.machine_metadata
  try {
    return JSON.parse(row.machine_metadata) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** The chain reads Tier 2 needs; injectable so tests can serve a fixture chain. */
export interface Eip3009ReceiptDeps {
  verify?: typeof verifySettlementTransferTx
  record?: typeof recordEip3009MerchantSettlement
  recordVerdict?: typeof recordEip3009ReceiptVerdict
  findSiblings?: typeof findSiblingX402DelegationPayments
  readAuthState?: typeof readAuthorizationState
  /** The block a transaction was mined in; `null` when unreadable. */
  readTxBlock?: (chainId: number, txHash: string) => Promise<number | null>
  /** Reads the candidate receipt's own logs; defaults to the real provider. */
  readReceiptLogs?: (
    chainId: number,
    txHash: string,
  ) => Promise<
    | { status: 'unavailable' }
    | { status: 'reverted' }
    | { status: 'found'; logs: ReadonlyArray<{ address: string; topics: readonly string[]; data: string }> }
  >
}

async function defaultReadTxBlock(chainId: number, txHash: string): Promise<number | null> {
  try {
    const receipt = await getProvider(chainId).getTransactionReceipt(txHash)
    return receipt?.blockNumber ?? null
  } catch {
    return null
  }
}

async function defaultReadReceiptLogs(
  chainId: number,
  txHash: string,
): Promise<
  { status: 'unavailable' } | { status: 'reverted' } | { status: 'found'; logs: Array<{ address: string; topics: readonly string[]; data: string }> }
> {
  try {
    const receipt = await getProvider(chainId).getTransactionReceipt(txHash)
    if (!receipt) return { status: 'unavailable' }
    if (receipt.status === 0) return { status: 'reverted' }
    const logs = (receipt.logs ?? []).map((log) => ({
      address: log.address as string,
      topics: log.topics as readonly string[],
      data: log.data as string,
    }))
    return { status: 'found', logs }
  } catch {
    return { status: 'unavailable' }
  }
}

/**
 * Tier 2: attribute the merchant settlement from the stored merchant receipt
 * under the seven limits. Records nothing unless every check passes; a
 * `refused_*`/`retryable` verdict is persisted (limit 7) EXCEPT on
 * `conflict` — a race means another writer won, and the winner's record is
 * the state, not a verdict about this payment.
 */
export async function observeEip3009ReceiptSettlement(
  intent: Eip3009SettlementIntent,
  candidateTxHash: string | null | undefined,
  opts: {
    nowMs?: number
    /** Tier 2 is flag-gated; tests may inject the flag directly. */
    flagEnabled?: boolean
    /** Backfill `--dry-run`: every limit runs, nothing is written. */
    dryRun?: boolean
    deps?: Eip3009ReceiptDeps
  } = {},
): Promise<Eip3009ReceiptAttributionOutcome> {
  const nowMs = opts.nowMs ?? Date.now()
  const flagEnabled = opts.flagEnabled ?? config.eip3009ReceiptAttribution
  const dryRun = opts.dryRun === true
  const deps = opts.deps ?? {}
  const verify = deps.verify ?? verifySettlementTransferTx
  const record = deps.record ?? recordEip3009MerchantSettlement
  const recordVerdict = deps.recordVerdict ?? recordEip3009ReceiptVerdict
  const findSiblings = deps.findSiblings ?? findSiblingX402DelegationPayments
  const readAuthState = deps.readAuthState ?? readAuthorizationState
  const readTxBlock = deps.readTxBlock ?? defaultReadTxBlock
  const readReceiptLogs = deps.readReceiptLogs ?? defaultReadReceiptLogs

  const persistVerdict = async (verdict: Eip3009ReceiptVerdict): Promise<void> => {
    if (dryRun) return
    try {
      await recordVerdict(intent.id, intent.agent_id, verdict)
    } catch {
      // A verdict write is bookkeeping; the attribution answer above stands
      // on its own. Never fail the caller for it.
    }
  }

  // A malformed / zero / funding-hash candidate is not this seam (the
  // funding-hash rule lives in isFundedEip3009Payment). Refused for good —
  // the input cannot change — and the verdict says so.
  if (!candidateTxHash || !TX_HASH_RE.test(candidateTxHash) || isZeroSettlementTxHash(candidateTxHash)) {
    return refused('refused_mismatch', 'The stored receipt names no well-formed settlement transaction hash')
  }
  if (!isFundedEip3009Shaped(intent, candidateTxHash)) return { outcome: 'not_applicable' }
  if (!flagEnabled) return { outcome: 'disabled' }

  const merchant = intent.x402_merchant_address ?? intent.merchant_address ?? null
  const confirmedSec = Math.floor(new Date(intent.confirmed_at ?? '').getTime() / 1000)
  if (!merchant || !Number.isFinite(confirmedSec)) {
    return refused(
      'refused_mismatch',
      'The payment has no merchant or no funding time, so its settlement cannot be verified',
    )
  }

  // Limit 2: exactly one burn. The candidate's receipt is the source of the
  // nonce — the transfer verifier is fed it, never trusted around it.
  const receipt = await readReceiptLogs(intent.chain_id, candidateTxHash)
  if (receipt.status === 'unavailable') {
    await persistVerdict('retryable')
    return { outcome: 'retryable', reason: `The receipt of ${candidateTxHash} could not be read` }
  }
  if (receipt.status === 'reverted') {
    await persistVerdict('refused_mismatch')
    return refused('refused_mismatch', `Transaction ${candidateTxHash} reverted — nothing settled`)
  }
  const delegate = intent.to_address
  const burns = receipt.logs.filter(
    (log) =>
      log.address?.toLowerCase() === intent.token_address.toLowerCase() &&
      log.topics?.[0]?.toLowerCase() === AUTHORIZATION_USED_TOPIC.toLowerCase() &&
      log.topics[1] &&
      ethers.zeroPadValue(ethers.getAddress(delegate.toLowerCase()), 32).toLowerCase() ===
        log.topics[1].toLowerCase(),
  )
  if (burns.length === 0) {
    await persistVerdict('refused_mismatch')
    return refused(
      'refused_mismatch',
      `Transaction ${candidateTxHash} burned no AuthorizationUsed nonce for this payment's delegate`,
    )
  }
  if (burns.length > 1) {
    await persistVerdict('refused_ambiguous')
    return refused(
      'refused_ambiguous',
      `Transaction ${candidateTxHash} carries ${burns.length} AuthorizationUsed burns for this delegate — a batch, refused as ambiguous`,
    )
  }
  const burnedNonce = AUTHORIZATION_USED_IFACE.decodeEventLog(
    'AuthorizationUsed',
    burns[0]!.data as string,
    burns[0]!.topics as [string, string, string],
  ).nonce.toLowerCase()

  const derivedNonce = deriveX402PaymentNonce(intent.id).toLowerCase()
  const tier1Strength = burnedNonce === derivedNonce

  // Limit 3: a burn that names a SIBLING's derived nonce settles that
  // sibling. Checked before the chain verify — it needs no RPC.
  if (!tier1Strength) {
    const siblingIds = await findSiblings(intent.agent_id, intent.id, delegate)
    if (siblingIds.some((s) => deriveX402PaymentNonce(s.id).toLowerCase() === burnedNonce)) {
      await persistVerdict('refused_mismatch')
      return refused(
        'refused_mismatch',
        `Transaction ${candidateTxHash} burned the derived nonce of another payment of this agent — it settles another payment`,
      )
    }
    // Limit 6: the derived nonce burned in SOME other transaction — the
    // sweep's stronger attribution is live; the weaker receipt proof must
    // not block it (#3888, owner question 2).
    const derivedState = await readAuthState(intent.chain_id, intent.token_address, delegate, derivedNonce)
    if (derivedState === true) {
      await persistVerdict('refused_ambiguous')
      return refused(
        'refused_ambiguous',
        'This payment’s derived nonce is already burned in another transaction — the receipt proof must not pre-empt the sweep’s stronger attribution',
      )
    }
    if (derivedState === null) {
      await persistVerdict('retryable')
      return { outcome: 'retryable', reason: 'The derived nonce’s authorization state could not be read' }
    }
  }

  const verification = await verify(candidateTxHash, {
    chainId: intent.chain_id,
    tokenAddress: intent.token_address,
    fromAddress: delegate,
    toAddress: merchant,
    amountRaw: intent.amount_raw,
    notBeforeSec: confirmedSec - CLOCK_SKEW_SECONDS,
    notAfterSec: Math.floor(nowMs / 1000) + CLOCK_SKEW_SECONDS,
    expectedAuthorizationUsed: { authorizer: delegate, nonce: burnedNonce },
  })
  if (verification.outcome !== 'verified') {
    if (
      verification.outcome === 'mismatch' &&
      verification.authorizationUsedNonces?.some((n) => n.toLowerCase() === burnedNonce) === false
    ) {
      // The receipt's burn is not the log the verifier saw — unreachable
      // today (the nonce was read from this receipt), but a refusal, never a
      // guess, if it ever happens.
      await persistVerdict('refused_mismatch')
      return refused('refused_mismatch', verification.reason)
    }
    if (verification.outcome === 'rpc_unavailable' || verification.outcome === 'not_found') {
      await persistVerdict('retryable')
      return { outcome: 'retryable', reason: verification.reason }
    }
    await persistVerdict('refused_mismatch')
    return refused('refused_mismatch', verification.reason)
  }

  // Tier 1-strength burn: record through the standard nonce path — the
  // receipt's transaction IS bound to this payment's derived nonce.
  if (tier1Strength) {
    if (dryRun) return { outcome: 'would_record' }
    const recorded = await record({
      txHash: candidateTxHash,
      intentId: intent.id,
      agentId: intent.agent_id,
      proof: { nonceBound: verification.nonceBound === true, nonceDerived: true },
    })
    if (recorded === 'recorded') {
      await persistVerdict('recorded')
      return { outcome: 'recorded' }
    }
    if (recorded === 'conflict') return { outcome: 'conflict', reason: 'A settlement record landed while this attribution ran' }
    if (recorded === 'not_eligible') {
      await persistVerdict('retryable')
      return { outcome: 'retryable', reason: 'The payment changed while its settlement was being recorded' }
    }
    await persistVerdict('refused_mismatch')
    return refused('refused_mismatch', `Transaction ${candidateTxHash} is already recorded for another payment`)
  }

  // Limits 4–5, by block. Every block read is RPC; the cap bounds the walk.
  const candidateBlock = await readTxBlock(intent.chain_id, candidateTxHash)
  if (candidateBlock === null) {
    await persistVerdict('retryable')
    return { outcome: 'retryable', reason: `The block of ${candidateTxHash} could not be read` }
  }
  const fundingBlock = intent.tx_hash ? await readTxBlock(intent.chain_id, intent.tx_hash) : null
  if (fundingBlock === null) {
    await persistVerdict('retryable')
    return { outcome: 'retryable', reason: 'This payment’s funding block could not be read' }
  }
  if (candidateBlock < fundingBlock) {
    await persistVerdict('refused_mismatch')
    return refused('refused_mismatch', 'The candidate transaction was mined before this payment’s funding')
  }

  const siblings = (await findSiblings(intent.agent_id, intent.id, delegate)).filter((s) => {
    const sibMerchant = s.x402_merchant_address ?? s.merchant_address ?? null
    return (
      s.tx_hash != null &&
      sibMerchant != null &&
      sibMerchant.toLowerCase() === merchant.toLowerCase() &&
      s.amount_raw === intent.amount_raw
    )
  })
  if (siblings.length > MAX_FUNDING_BLOCK_READS_PER_CANDIDATE) {
    await persistVerdict('retryable')
    return {
      outcome: 'retryable',
      reason: `Too many same-shape sibling payments (${siblings.length}) to bound the block reads`,
    }
  }

  let nextFundingAfterOurs: number | null = null
  for (const sibling of siblings) {
    const siblingBlock = await readTxBlock(intent.chain_id, sibling.tx_hash!)
    if (siblingBlock === null) {
      await persistVerdict('retryable')
      return { outcome: 'retryable', reason: `The funding block of sibling ${sibling.id} could not be read` }
    }
    // Limit 4 (symmetric ambiguity): a sibling funded at or before the
    // candidate must be provably settled before THIS payment's funding —
    // its own recorded settlement's block, read over RPC. No recorded hash
    // is a definitive "not provably settled"; an UNREADABLE recorded hash is
    // "could not ask" and stays retryable.
    if (siblingBlock <= candidateBlock) {
      const recordedHash = metadataOf(sibling).merchant_settlement_tx_hash
      if (typeof recordedHash !== 'string') {
        await persistVerdict('refused_ambiguous')
        return refused(
          'refused_ambiguous',
          `Same-shape sibling ${sibling.id} was funded at or before the candidate's block and is not provably settled before this payment's funding — the pull is ambiguous`,
        )
      }
      const recordedBlock = await readTxBlock(intent.chain_id, recordedHash)
      if (recordedBlock === null) {
        await persistVerdict('retryable')
        return {
          outcome: 'retryable',
          reason: `Sibling ${sibling.id}'s recorded settlement block could not be read`,
        }
      }
      if (recordedBlock >= fundingBlock) {
        await persistVerdict('refused_ambiguous')
        return refused(
          'refused_ambiguous',
          `Same-shape sibling ${sibling.id} was funded at or before the candidate's block and is not provably settled before this payment's funding — the pull is ambiguous`,
        )
      }
    }
    // Limit 5 (before the next funding): the candidate must burn before the
    // delegate's next funding after this payment's own.
    if (siblingBlock > fundingBlock && (nextFundingAfterOurs === null || siblingBlock < nextFundingAfterOurs)) {
      nextFundingAfterOurs = siblingBlock
    }
  }
  if (nextFundingAfterOurs !== null && candidateBlock >= nextFundingAfterOurs) {
    await persistVerdict('refused_ambiguous')
    return refused(
      'refused_ambiguous',
      'The candidate transaction burned after the same delegate’s next funding — it could relate to that funding instead',
    )
  }

  if (dryRun) return { outcome: 'would_record' }
  const recorded = await record({
    txHash: candidateTxHash,
    intentId: intent.id,
    agentId: intent.agent_id,
    proof: { kind: 'receipt' },
  })
  if (recorded === 'recorded') {
    await persistVerdict('recorded')
    return { outcome: 'recorded' }
  }
  if (recorded === 'conflict') {
    return { outcome: 'conflict', reason: 'A settlement record landed while this attribution ran' }
  }
  if (recorded === 'not_eligible') {
    await persistVerdict('retryable')
    return { outcome: 'retryable', reason: 'The payment changed while its settlement was being recorded' }
  }
  await persistVerdict('refused_mismatch')
  return refused('refused_mismatch', `Transaction ${candidateTxHash} is already recorded for another payment`)
}

/**
 * The Tier 2 applicability gate, WITHOUT the flag: same population
 * `isFundedEip3009Payment` guards, but for the generic attach path the
 * reported hash IS the funding hash, so the funding-hash exclusion is
 * inverted — the candidate must be a DIFFERENT hash than the funding one,
 * which is exactly the original check's shape.
 */
function isFundedEip3009Shaped(intent: Eip3009SettlementIntent, candidateTxHash: string): boolean {
  return (
    intent.status === 'confirmed' &&
    !!intent.tx_hash &&
    intent.tx_hash.toLowerCase() !== candidateTxHash.toLowerCase() &&
    (intent.payment_rail ?? intent.source) === 'x402' &&
    intent.execution_rail === 'delegation' &&
    metadataRecord(intent)?.settlement_scheme === 'eip3009'
  )
}

function metadataRecord(intent: Eip3009SettlementIntent): Record<string, unknown> {
  const raw = intent.machine_metadata
  if (!raw) return {}
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

// ── Tier 1 from the stored header (arrival + backfill) ──────────────────────

/** The chain + repo reads the stored-header Tier 1 path needs. */
export interface Tier1FromHeaderDeps {
  findProofs?: (intentId: string, agentId: string | null) => Promise<{ payment_proof_header: string | null } | null>
  scan?: typeof findAuthorizationUsedTx
  readFundingBlock?: (chainId: number, txHash: string) => Promise<number | null>
  observe?: typeof observeEip3009MerchantSettlement
  nowMs?: number
  /** Backfill `--dry-run`: verify without writing. */
  dryRun?: boolean
}

export type Tier1FromHeaderOutcome =
  | { outcome: 'recorded' }
  | { outcome: 'would_record' }
  | { outcome: 'no_header' }
  | { outcome: 'invalid_header'; reason: string }
  | { outcome: 'unavailable'; reason: string }
  | { outcome: 'not_found' }
  | { outcome: 'unverified'; reason: string }

/**
 * Tier 1: record the settlement for a payment whose evidence row stores the
 * X-PAYMENT header (#3925 standard, no relaxation). The proof is derived
 * from the stored header (`eip3009SettlementProofFromHeader` — delegate-signed
 * nonce, random nonces included), the settlement is FOUND by the same
 * `AuthorizationUsed(delegate, headerNonce)` lookup the sweep runs with the
 * derived nonce, and the record goes through `observeEip3009MerchantSettlement`
 * exactly as today — `nonce_bound`, and `nonce_derived` only when the header
 * nonce equals the derived one. Used by the evidence-arrival ladder and the
 * backfill; the sweep tick runs the same lookup inline under its own budget.
 */
export async function recordTier1SettlementFromStoredHeader(
  intent: Eip3009SettlementIntent,
  deps: Tier1FromHeaderDeps = {},
): Promise<Tier1FromHeaderOutcome> {
  const nowMs = deps.nowMs ?? Date.now()
  const dryRun = deps.dryRun === true
  const findProofs =
    deps.findProofs ??
    (async (id: string, agentId: string | null) => {
      const { findEvidenceProofsForIntent } = await import('../../infra/repositories/machine-payments.js')
      return findEvidenceProofsForIntent(id, agentId)
    })
  const scan = deps.scan ?? findAuthorizationUsedTx
  const readFundingBlock =
    deps.readFundingBlock ??
    (async (chainId: number, txHash: string) => {
      try {
        const receipt = await getProvider(chainId).getTransactionReceipt(txHash)
        return receipt?.blockNumber ?? null
      } catch {
        return null
      }
    })
  const observe = deps.observe ?? observeEip3009MerchantSettlement

  const proofs = await findProofs(intent.id, intent.agent_id)
  const header = proofs?.payment_proof_header ?? null
  if (!header) return { outcome: 'no_header' }

  const { eip3009SettlementProofFromHeader } = await import('./eip3009-settlement-evidence.js')
  const proof = eip3009SettlementProofFromHeader(intent, header)
  if (!proof.ok) return { outcome: 'invalid_header', reason: proof.reason }

  if (!intent.tx_hash) return { outcome: 'unavailable', reason: 'The payment has no funding hash to scan from' }
  const fundingBlock = await readFundingBlock(intent.chain_id, intent.tx_hash)
  if (fundingBlock === null) {
    return { outcome: 'unavailable', reason: 'The funding block could not be read — nothing recorded' }
  }
  const batchBlocks = effectiveLogBatchBlocks(intent.chain_id, 500, nowMs)
  const scanResult = await scan(
    intent.chain_id,
    intent.token_address,
    intent.to_address,
    proof.proof.nonce,
    { fromBlock: fundingBlock, toBlock: fundingBlock + TIER1_SCAN_SPAN_BLOCKS - 1 },
    { batchBlocks, maxBatches: 20 },
  )
  if (scanResult.status === 'unavailable') {
    return { outcome: 'unavailable', reason: 'The AuthorizationUsed scan could not be read — nothing recorded' }
  }
  if (scanResult.status === 'none') return { outcome: 'not_found' }
  if (scanResult.status === 'ambiguous') {
    return {
      outcome: 'unverified',
      reason: 'The header nonce was used by more than one transaction — refusing rather than choosing',
    }
  }

  // Backfill `--dry-run`: the SAME verification the observe path runs, minus
  // the write — so the counts are what the write run would record, not a
  // scan-shaped approximation.
  if (dryRun) {
    const { verifyEip3009SettlementTransfer } = await import('./eip3009-settlement-evidence.js')
    const verification = await verifyEip3009SettlementTransfer(intent, scanResult.txHash, proof.proof, nowMs)
    if (verification.outcome !== 'verified') {
      return {
        outcome: 'unverified',
        reason: verification.reason,
      }
    }
    return { outcome: 'would_record' }
  }

  const settled = await observe(intent, scanResult.txHash, nowMs, proof.proof)
  if (settled.outcome === 'recorded') return { outcome: 'recorded' }
  if (settled.outcome === 'not_applicable') {
    return { outcome: 'unverified', reason: 'The payment is not a funded eip3009 settlement candidate' }
  }
  return { outcome: 'unverified', reason: settled.reason }
}
