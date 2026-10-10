/**
 * Passive settlement observation for the eip3009 bridge — the leader-gated
 * pass that completes an eip3009 payment whose merchant settlement nobody
 * ever reported (#3888, the #3776 residual).
 *
 * ## The gap
 *
 * On the eip3009 bridge Haven submits the FUNDING transaction (treasury →
 * delegate EOA) and the merchant's facilitator settles the agent's EIP-3009
 * authorization in a SECOND transaction Haven never submits. Before #3888
 * the nonce of that authorization was drawn randomly inside the x402
 * library, so when the agent never reported the settlement (the dropped
 * final report the #3776 plain-HTTP paid retry must survive), nothing could
 * attribute it: `MERCHANT_REPORT_GRACE_MIN` passed, the status read said
 * "the merchant has likely not been paid" for a payment the merchant DID
 * settle, and the accounting feed booked and pinned the FUNDING hash.
 *
 * The remedy has two halves. The signer and the SDK now derive the EIP-3009
 * nonce from the payment id (`deriveX402PaymentNonce`, SDK edge surface), so
 * the settlement is attributable BY THE PAYMENT ITSELF; and this tick finds
 * `AuthorizationUsed(delegate EOA, derived nonce)` on the pinned token,
 * exactly where the payment says it must be.
 *
 * ## The rules, inherited from the #2117 sweeper
 *
 * - **Attribute by a key the chain names.** The ONLY attribution is the
 *   token's own `AuthorizationUsed(authorizer, nonce)` log for this
   * payment's delegate and derived nonce. Transfer shape is never an
 *   attribution path: the tx the log names still runs the full
 *   `verifySettlementTransferTx` verifier (delegate → merchant, exact
 *   amount, pinned token, not before this payment's funding confirm) —
 *   defense in depth, not the attribution itself. `authorizationState ==
 *   true` alone is not proof either: `cancelAuthorization` sets it, so it
 *   only licenses a log scan (the cheap pre-check), never a record.
 * - **Fail closed on any RPC failure.** A receipt that cannot be read, a
 *   head that cannot be read, a state call or a log batch that throws —
 *   every one leaves the candidate untouched and un-backoffed. The next
 *   tick is the retry; nothing is written on an unreadable chain.
 * - **Bound the block range.** Each candidate is scanned from its FUNDING
 *   confirm block forward, at most {@link EIP3009_SCAN_SPAN_BLOCKS} blocks
 *   per tick (batched `eth_getLogs`, hard batch budget), advancing an
 *   in-memory cursor across ticks until the recovery horizon. The
 *   authorization's own validity keeps a genuine settlement close to the
 *   funding confirm in practice; the span is over-reach in the safe
 *   direction and costs a topics-indexed filter, not a Transfer walk.
 * - **Hand what it finds to the existing verifier.** The recorded write is
 *   `observeEip3009MerchantSettlement` — the same seam the agent-reported
 *   path (`modules/mpp/evidence.ts`) uses, with its replay guard, its
 *   compare-and-set (`merchant_settlement_tx_hash IS NULL`) and its
 *   `settlementHashTakenSql` refusal.
 *
 * ## Recording order — the reported path's order, verbatim
 *
 * Base `machine_payment_evidence` row (feed SUPPRESSED) → verified hash
 * recorded beside the funding hash → ONE accounting-feed fire
 * (`feedSettledPaymentBestEffort`). The feed must never fire before the
 * hash write, or it books the funding hash exactly as today's bug does
 * (#3767's B1 rule, which the reported path already obeys). A hash already
 * pinned is left alone — the candidate query excludes it and the writer's
 * CAS would refuse it anyway.
 *
 * ## The agent-reported-vs-chain-detected precedence (owner question 2)
 *
 * Open until the owner rules otherwise, the conservative answer is
 * implemented: a nonce-proven attribution does NOT override an earlier
 * agent-reported hash on a same-shaped sibling payment.
 * `observeEip3009MerchantSettlement` answers `hash_taken`, the tick logs it
 * loudly and records nothing — the agent-reported record is shape-verified
 * client input that already passed its own guards, and silently rewriting
 * recorded evidence is not a decision this module takes for itself.
 *
 * ## Residuals
 *
 * - A signer older than #3888 drew random nonces; those settlements stay
 *   unattributable here (the status read and the agent-reported path are
 *   unchanged for them) — exactly today's behaviour.
 * - Past the recovery horizon the tick stops looking; the payment is still
 *   reachable through the agent-reported path, which is not horizon-bound.
 * - The cursor and the backoff are in-memory on purpose (losing them costs
 *   one extra scan, persisting them would mean a migration for a cache).
 */
import {
  findSweepableEip3009Intents,
  type SweepableEip3009Row,
} from '../../infra/repositories/x402-authorizations.js'
import {
  findAuthorizationUsedTx,
  readAuthorizationState,
} from '../../infra/chain/authorization-used-scanner.js'
import { getProvider } from '../../infra/chain/relayer-reads.js'
import { deriveX402PaymentNonce } from '@haven_ai/sdk/edge'
import { observeEip3009MerchantSettlement } from './eip3009-settlement-evidence.js'
import { findIntentEvidenceSource } from '../../infra/repositories/machine-payments.js'
import {
  recordMachinePaymentEvidenceBase,
  type MachinePaymentEvidenceSource,
  type EvidenceRecordOutcome,
} from '../mpp/evidence.js'
import { feedSettledPaymentBestEffort } from '../accounting/index.js'
import { SWEEP_RECOVERY_HORIZON_SECONDS } from '../../domain/x402-sweep-window.js'

/**
 * Grace between the FUNDING confirm and the first scan. Deliberately much
 * smaller than the #2145 merchant report grace — the hash must land BEFORE
 * the feed's funding-hash selection, which runs at that grace — and small
 * enough that the ordinary happy path (the agent reports within seconds)
 * never pays for a scan.
 */
export const EIP3009_SWEEP_MIN_AGE_SECONDS = 60

/** How far back an eip3009 payment stays sweepable, anchored on the funding confirm. */
export const EIP3009_SWEEP_RECOVERY_HORIZON_SECONDS = SWEEP_RECOVERY_HORIZON_SECONDS

/** Candidates considered per tick, across all chains. */
export const EIP3009_SWEEP_MAX_CANDIDATES_PER_TICK = 200

/**
 * When a fruitlessly-scanned candidate starts counting as `unresolved` — the
 * builder-decided threshold INSIDE the 24h look horizon. The EIP-3009 header
 * itself is only redeemable for minutes (≤900s: the 600s clamp plus the SDK's
 * `X402_SETTLEMENT_FORWARD_MARGIN_SECONDS`), and a resume re-sign — the other
 * route to a genuine settlement — is agent-driven, so a settlement that has
 * not appeared within six hours of the funding confirm is unlikely to ever
 * appear; from there each fruitless tick is logged loudly (with the remedy)
 * instead of silently aging out at the horizon. The horizon still bounds the
 * LOOKING: until it, a genuinely-late settlement (a resume that lands days
 * later) is found.
 */
export const EIP3009_UNRESOLVED_AFTER_SECONDS = 6 * 60 * 60

/** Blocks per `eth_getLogs` call — under every provider's served span. */
export const EIP3009_LOG_BATCH_BLOCKS = 500

/**
 * How far one tick looks forward from a candidate's cursor: the batch budget
 * (500 × 20) as a span. On Base's ~2s blocks that is ~5.5h of history per
 * tick; an EIP-3009 authorization is only redeemable within its own
 * `validBefore`, which is minutes past signing — so the first tick's span
 * covers a genuine settlement with room to spare, and the cursor exists for
 * the pathological ones, not the expected ones.
 */
export const EIP3009_SCAN_SPAN_BLOCKS =
  EIP3009_LOG_BATCH_BLOCKS * 20

const SCAN_BACKOFF_BASE_MS = 120_000
const SCAN_BACKOFF_MAX_MS = 60 * 60 * 1000

const scanBackoff = new Map<string, { attempts: number; nextAttemptAtMs: number }>()
/** Next unscanned block per candidate, so a multi-tick scan advances instead of restarting. */
const scanCursors = new Map<string, number>()

/** Test seam: both maps are process-lifetime state, so a suite must reset them. */
export function resetEip3009SettlementSweepState(): void {
  scanBackoff.clear()
  scanCursors.clear()
}

function isSuppressed(paymentId: string, nowMs: number): boolean {
  const entry = scanBackoff.get(paymentId)
  return entry !== undefined && entry.nextAttemptAtMs > nowMs
}

function recordFruitlessScan(paymentId: string, nowMs: number): void {
  const attempts = (scanBackoff.get(paymentId)?.attempts ?? 0) + 1
  const delay = Math.min(SCAN_BACKOFF_MAX_MS, SCAN_BACKOFF_BASE_MS * 2 ** (attempts - 1))
  scanBackoff.set(paymentId, { attempts, nextAttemptAtMs: nowMs + delay })
}

export interface SweepLogger {
  debug: (obj: Record<string, unknown>, msg?: string) => void
  info: (obj: Record<string, unknown>, msg?: string) => void
  warn: (obj: Record<string, unknown>, msg?: string) => void
}

/**
 * What an operator can actually DO about an eip3009 settlement the tick
 * could not attribute. The agent-reported path runs the same verifier with
 * no derived-nonce requirement and is not horizon-bound, so the remedy is
 * real — the alert names it.
 */
export const EIP3009_UNRESOLVED_REMEDY =
  'Re-report the merchant settlement transaction hash to POST /machine-payments/evidence ' +
  "with this agent's credential. That path verifies the same transfer without needing the " +
  'derived nonce this scan could not match, and is not bounded by the sweep recovery horizon.'

export interface Eip3009SweepTickResult {
  /** Candidates the query handed over this tick (before suppression). */
  candidates: number
  /** Candidates skipped by the fruitless-scan backoff, or past the tick's batch budget. */
  suppressed: number
  /** Settlements verified and recorded from the chain alone. */
  recorded: number
  /** `machine_payment_evidence` base rows the tick ensured exist. */
  evidencePushed: number
  /** Candidates whose found tx the verifier or the guards refused. */
  refused: number
  /** Nonce-proven attributions declined because another payment holds the hash. */
  hashTaken: number
  /** Candidates this tick could not judge because the chain could not be read. */
  chainsUnavailable: number
  /** Candidates past the recovery horizon the tick still cannot attribute. */
  unresolved: number
}

/** The chain reads the tick needs; injectable so a fixture chain can serve them. */
export interface Eip3009ChainDeps {
  readHead: (chainId: number) => Promise<number | null>
  readFundingBlock: (chainId: number, txHash: string) => Promise<number | null>
  readAuthState: (
    chainId: number,
    tokenAddress: string,
    authorizer: string,
    nonce: string,
  ) => Promise<boolean | null>
  findUsed: typeof findAuthorizationUsedTx
}

async function defaultReadHead(chainId: number): Promise<number | null> {
  try {
    return await getProvider(chainId).getBlockNumber()
  } catch {
    return null
  }
}

async function defaultReadFundingBlock(chainId: number, txHash: string): Promise<number | null> {
  try {
    const receipt = await getProvider(chainId).getTransactionReceipt(txHash)
    return receipt?.blockNumber ?? null
  } catch {
    return null
  }
}

const defaultChainDeps: Eip3009ChainDeps = {
  readHead: defaultReadHead,
  readFundingBlock: defaultReadFundingBlock,
  readAuthState: readAuthorizationState,
  findUsed: findAuthorizationUsedTx,
}

/**
 * One eip3009 sweep pass. Never throws for an individual candidate — one
 * poison row must not silence the rest, and the queue is oldest-first.
 */
export async function runEip3009SettlementSweepTick(
  log: SweepLogger,
  deps: {
    findCandidates?: typeof findSweepableEip3009Intents
    chain?: Partial<Eip3009ChainDeps>
    findEvidenceSource?: (paymentIntentId: string, agentId: string | null) => Promise<MachinePaymentEvidenceSource | null>
    recordBase?: (intent: MachinePaymentEvidenceSource, opts?: { suppressFeed?: boolean }) => Promise<EvidenceRecordOutcome>
    observe?: typeof observeEip3009MerchantSettlement
    feed?: typeof feedSettledPaymentBestEffort
  } = {},
): Promise<Eip3009SweepTickResult> {
  const findCandidates = deps.findCandidates ?? findSweepableEip3009Intents
  const chain: Eip3009ChainDeps = { ...defaultChainDeps, ...deps.chain }
  const findEvidenceSource = deps.findEvidenceSource ?? findIntentEvidenceSource
  const recordBase = deps.recordBase ?? recordMachinePaymentEvidenceBase
  const observe = deps.observe ?? observeEip3009MerchantSettlement
  const feed = deps.feed ?? feedSettledPaymentBestEffort
  const nowMs = Date.now()

  const result: Eip3009SweepTickResult = {
    candidates: 0,
    suppressed: 0,
    recorded: 0,
    evidencePushed: 0,
    refused: 0,
    hashTaken: 0,
    chainsUnavailable: 0,
    unresolved: 0,
  }

  const candidates = await findCandidates(
    EIP3009_SWEEP_MIN_AGE_SECONDS,
    EIP3009_SWEEP_RECOVERY_HORIZON_SECONDS,
    EIP3009_SWEEP_MAX_CANDIDATES_PER_TICK,
  )
  result.candidates = candidates.length

  // Bounds both maps by the live candidate set: anything no longer in it was
  // recorded (it left the SQL) or aged past the horizon.
  const liveIds = new Set(candidates.map((r) => r.id))
  for (const id of scanBackoff.keys()) if (!liveIds.has(id)) scanBackoff.delete(id)
  for (const id of scanCursors.keys()) if (!liveIds.has(id)) scanCursors.delete(id)

  const byChain = new Map<number, SweepableEip3009Row[]>()
  for (const row of candidates) {
    if (isSuppressed(row.id, nowMs)) {
      result.suppressed += 1
      continue
    }
    const list = byChain.get(row.chain_id)
    if (list) list.push(row)
    else byChain.set(row.chain_id, [row])
  }

  for (const [chainId, rows] of byChain) {
    const head = await chain.readHead(chainId)
    if (head === null) {
      // "Could not ask" — never a verdict. Nothing is written, nothing is
      // marked failed, and the next tick is the retry. Deliberately NOT a
      // fruitless scan: an outage that had nothing to do with a candidate
      // must not delay its recovery.
      result.chainsUnavailable += 1
      log.warn({ chainId, candidates: rows.length }, 'Eip3009 settlement sweep could not read the chain head — nothing recorded')
      continue
    }

    for (const row of rows) {
      try {
        await sweepOne(row, head, chain, { findEvidenceSource, recordBase, observe, feed }, log, result, nowMs)
      } catch (err) {
        log.warn({ err, paymentId: row.id }, 'Eip3009 settlement sweep candidate failed')
      }
    }
  }

  const acted =
    result.recorded > 0 || result.refused > 0 || result.hashTaken > 0 || result.unresolved > 0 || result.chainsUnavailable > 0
  if (acted) {
    log.info({ ...result }, 'Eip3009 settlement sweep tick acted')
  } else {
    log.debug({ ...result }, 'Eip3009 settlement sweep tick found nothing to record')
  }
  return result
}

/**
 * The block this payment's settlement must be searched from: the FUNDING
 * confirm. The merchant can only pull what the funding put on the delegate,
 * so the settlement provably mined after it — and the feed's funding-hash
 * selection provably runs later than it, which is why the scan anchors here
 * and not on the report grace.
 */
async function fundingBlockOf(
  row: SweepableEip3009Row,
  chain: Eip3009ChainDeps,
): Promise<number | null> {
  if (!row.tx_hash) return null
  return chain.readFundingBlock(row.chain_id, row.tx_hash)
}

async function sweepOne(
  row: SweepableEip3009Row,
  head: number,
  chain: Eip3009ChainDeps,
  fns: {
    findEvidenceSource: (paymentIntentId: string, agentId: string | null) => Promise<MachinePaymentEvidenceSource | null>
    recordBase: (intent: MachinePaymentEvidenceSource, opts?: { suppressFeed?: boolean }) => Promise<EvidenceRecordOutcome>
    observe: typeof observeEip3009MerchantSettlement
    feed: typeof feedSettledPaymentBestEffort
  },
  log: SweepLogger,
  result: Eip3009SweepTickResult,
  nowMs: number,
): Promise<void> {
  const fundingBlock = await fundingBlockOf(row, chain)
  if (fundingBlock === null) {
    // Fail closed: without the funding block there is no honest lower bound,
    // and a guessed one could scan the wrong history. Not a fruitless scan —
    // an unreadable receipt is an RPC fact, not a negative answer.
    result.chainsUnavailable += 1
    log.warn(
      { paymentId: row.id, chainId: row.chain_id, fundingTxHash: row.tx_hash },
      'Eip3009 settlement sweep could not read the funding receipt — nothing recorded',
    )
    return
  }

  const cursor = Math.max(scanCursors.get(row.id) ?? fundingBlock, fundingBlock)
  const toBlock = Math.min(head, cursor + EIP3009_SCAN_SPAN_BLOCKS - 1)
  if (cursor > toBlock) {
    // Already scanned up to the head on a previous tick.
    recordFruitlessScan(row.id, nowMs)
    result.suppressed += 1
    return
  }

  // Cheap pre-check (builder decision): `authorizationState` is a single
  // eth_call. `false` means the nonce is unburned — no settlement yet — and
  // a `getLogs` would answer the same thing for a batch budget. `true` is
  // NOT proof (cancelAuthorization sets it); it only licenses the log scan.
  const nonce = deriveX402PaymentNonce(row.id)
  const state = await chain.readAuthState(row.chain_id, row.token_address, row.to_address, nonce)
  if (state === null) {
    result.chainsUnavailable += 1
    log.debug({ paymentId: row.id, chainId: row.chain_id }, 'Eip3009 settlement sweep could not read authorizationState — nothing recorded')
    return
  }

  if (state) {
    const scan = await chain.findUsed(
      row.chain_id,
      row.token_address,
      row.to_address,
      nonce,
      { fromBlock: cursor, toBlock },
      { batchBlocks: EIP3009_LOG_BATCH_BLOCKS, maxBatches: Math.ceil((toBlock - cursor + 1) / EIP3009_LOG_BATCH_BLOCKS) },
    )

    if (scan.status === 'unavailable') {
      result.chainsUnavailable += 1
      log.debug({ paymentId: row.id, chainId: row.chain_id }, 'Eip3009 settlement sweep log scan failed — nothing recorded')
      return
    }

    if (scan.status === 'found') {
      await recordOne(row, scan.txHash, fns, log, result)
      return
    }

    if (scan.status === 'ambiguous') {
      // The token refuses a reused nonce; a second sighting is a fact we do
      // not understand and will not resolve by choosing. Loud, and refused.
      result.refused += 1
      log.warn(
        { paymentId: row.id, chainId: row.chain_id, nonce, reason: 'ambiguous_authorization_use', remedy: EIP3009_UNRESOLVED_REMEDY },
        'Eip3009 settlement sweep found the nonce used by more than one transaction — refusing rather than choosing',
      )
      return
    }
  }

  // Scanned and named nothing. Advance the cursor past what was actually
  // covered so a multi-tick scan walks forward, then back the candidate off
  // so the residue cannot monopolise the tick's budget.
  scanCursors.set(row.id, toBlock + 1)
  recordFruitlessScan(row.id, nowMs)

  // "Log the rest loudly": from the threshold on, a fruitless scan is a
  // payment that is very unlikely to resolve by itself, so it is named —
  // with the remedy — instead of silently aging out of the candidate query
  // at the horizon. Before the threshold it is the ordinary not-yet case.
  const confirmedMs = new Date(row.confirmed_at).getTime()
  if (
    Number.isFinite(confirmedMs) &&
    nowMs > confirmedMs + EIP3009_UNRESOLVED_AFTER_SECONDS * 1000
  ) {
    result.unresolved += 1
    log.warn(
      {
        paymentId: row.id,
        agentId: row.agent_id,
        chainId: row.chain_id,
        reason: 'no_matching_authorization_used',
        remedy: EIP3009_UNRESOLVED_REMEDY,
      },
      'Eip3009 payment is long past its header validity and the sweep cannot attribute its settlement — it is not in the accounting feed with its merchant hash until an agent re-reports it',
    )
  }
}

/**
 * The recorded write, in the reported path's order: base evidence row with
 * the feed SUPPRESSED, the verified hash recorded beside the funding hash,
 * then ONE feed fire. Mirrors `modules/mpp/evidence.ts`'s eip3009 branch —
 * including refusing BEFORE the hash when the base row cannot exist.
 */
async function recordOne(
  row: SweepableEip3009Row,
  txHash: string,
  fns: {
    findEvidenceSource: (paymentIntentId: string, agentId: string | null) => Promise<MachinePaymentEvidenceSource | null>
    recordBase: (intent: MachinePaymentEvidenceSource, opts?: { suppressFeed?: boolean }) => Promise<EvidenceRecordOutcome>
    observe: typeof observeEip3009MerchantSettlement
    feed: typeof feedSettledPaymentBestEffort
  },
  log: SweepLogger,
  result: Eip3009SweepTickResult,
): Promise<void> {
  const source = await fns.findEvidenceSource(row.id, row.agent_id)
  if (!source) {
    result.refused += 1
    log.warn(
      { paymentId: row.id, agentId: row.agent_id },
      'Eip3009 settlement sweep could not re-read the payment for evidence recording',
    )
    return
  }

  const base = await fns.recordBase(source, { suppressFeed: true })
  if (base.status === 'failed' && base.reason === 'missing_resource_url') {
    // Same refusal as the reported path: never commit a hash the evidence
    // table cannot carry. The feed is not fired either — nothing was fed.
    result.refused += 1
    log.warn(
      { paymentId: row.id, reason: 'missing_resource_url' },
      'Eip3009 settlement detected but its evidence base row is unwritable (no resource URL) — hash not recorded',
    )
    return
  }
  if (base.status !== 'recorded') {
    // `not_applicable` cannot survive the candidate query (confirmed +
    // funded + protocol rail); anything else is a write failure. The hash is
    // NOT written on a failed base — the next tick is the retry.
    result.refused += 1
    log.warn(
      { paymentId: row.id, outcome: base.status, reason: base.status === 'failed' ? base.reason : undefined },
      'Eip3009 settlement detected but its evidence base row could not be written — hash not recorded, will be retried',
    )
    return
  }
  result.evidencePushed += 1

  const settled = await fns.observe(source, txHash)
  if (settled.outcome !== 'recorded') {
    if (settled.outcome === 'unverified' && settled.reason.includes('already recorded for another payment')) {
      // Owner question 2's conservative default: a nonce-proven attribution
      // does not override an earlier agent-reported hash on a same-shaped
      // sibling payment. Logged loudly, recorded never — rewriting recorded
      // evidence is not this module's decision.
      result.hashTaken += 1
      log.warn(
        { paymentId: row.id, agentId: row.agent_id, chainId: row.chain_id, txHash, reason: 'settlement_hash_taken' },
        'Eip3009 settlement is nonce-proven for this payment but its transaction is already recorded for another — recording nothing; an owner ruling can revisit this precedence',
      )
      return
    }
    result.refused += 1
    log.warn(
      {
        paymentId: row.id,
        agentId: row.agent_id,
        chainId: row.chain_id,
        txHash,
        reason: settled.outcome === 'unverified' ? settled.reason : undefined,
      },
      'Eip3009 settlement sweep refused a candidate settlement',
    )
    return
  }

  result.recorded += 1
  fns.feed(source.user_id, source.id)
  log.info(
    { paymentId: row.id, agentId: row.agent_id, chainId: row.chain_id, txHash },
    'Eip3009 settlement sweep recorded an unreported merchant settlement from the chain',
  )
}
