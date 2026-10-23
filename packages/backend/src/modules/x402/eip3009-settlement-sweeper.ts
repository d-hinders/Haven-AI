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
 *   every one leaves the candidate untouched: nothing is written and
 *   nothing is judged. A failure of THIS candidate's own reads backs it off
 *   on a growing, capped schedule (#4012), kept apart from the fruitless
 *   backoff because "could not ask" is not "found nothing". An unreadable
 *   head is chain-wide and costs one call, so it is never backed off.
 * - **Bound the block range.** Each candidate is scanned from its FUNDING
 *   confirm block forward, at most {@link EIP3009_MAX_BATCHES_PER_CANDIDATE}
 *   batched `eth_getLogs` calls per tick, under a per-chain call budget
 *   ({@link EIP3009_MAX_LOG_CALLS_PER_CHAIN}). It advances an in-memory
 *   cursor across ticks until the recovery horizon. The batch span is the
 *   provider's, not a constant: `effectiveLogBatchBlocks` narrows the
 *   500-block default to what the provider serves (#4012). A narrow span
 *   costs coverage per tick, never calls. The
 *   authorization's own validity keeps a genuine settlement close to the
 *   funding confirm in practice; the span is over-reach in the safe
 *   direction and costs a topics-indexed filter, not a Transfer walk.
 * - **Hand what it finds to the existing verifier.** The recorded write is
 *   `observeEip3009MerchantSettlement` — the same seam the agent-reported
 *   path (`modules/mpp/evidence.ts`) uses, with its replay guard, its two
 *   advisory locks (the hash, then the payment, #3927), its compare-and-set
 *   (`merchant_settlement_tx_hash IS NULL`) and its `settlementHashTakenSql`
 *   refusal.
 *
 * ## Recording order — the reported path's order, verbatim
 *
 * Base `machine_payment_evidence` row (feed SUPPRESSED) → verified hash
 * recorded beside the funding hash → ONE accounting-feed fire
 * (`feedSettledPaymentBestEffort`). The feed must never fire before the
 * hash write, or it books the funding hash exactly as today's bug does
 * (#3767's B1 rule, which the reported path already obeys). A hash already
 * pinned is left alone — the candidate query excludes it, and the writer
 * answers `conflict` under its intent lock (#3927; its CAS is the backstop).
 *
 * ## The agent-reported-vs-chain-detected precedence (owner question 2)
 *
 * Open until the owner rules otherwise, the conservative answer is
 * implemented: a nonce-proven attribution does NOT override an earlier
 * agent-reported hash on a same-shaped sibling payment.
 * `observeEip3009MerchantSettlement` answers `hash_taken`, the tick logs it
 * loudly and records nothing — the agent-reported record is nonce-proven
 * client input (since #3925: its header's authorization is signature-checked
 * against the delegate) that already passed its own guards, and silently
 * rewriting recorded evidence is not a decision this module takes for itself.
 *
 * ## Residuals
 *
 * - A signer older than #3888 drew random nonces; those settlements stay
 *   unattributable HERE (the status read is unchanged for them) — and since
 *   #3925 the agent-reported path refuses a report whose posted X-PAYMENT
 *   header does not prove the burned nonce, so a random-nonce settlement is
 *   unattributable there too. Exactly the accepted residual.
 * - Since #3925 the observe call passes THIS payment's derived nonce as the
 *   proof (`nonceDerived: true`), so a settlement recorded THROUGH THIS SWEEP
 *   is always nonce-bound — the sweep can no longer be the weaker
 *   attribution path. Since #4319 the tick ALSO runs Tier 1 from a stored
 *   X-PAYMENT header (same nonce-bound standard, the header's nonce as the
 *   key); Tier 2 (the receipt hash) never runs in the tick — historic and
 *   receipt-only rows belong to the backfill.
 * - Past the recovery horizon the tick stops looking; the payment is still
 *   reachable through the agent-reported path, which is not horizon-bound.
 * - The cursor, both backoffs and the learned range limit are in-memory on purpose (losing them costs
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
import {
  effectiveLogBatchBlocks,
  LOG_RANGE_LIMIT_REASON,
} from '../../infra/chain/log-range-limit.js'
import { deriveX402PaymentNonce } from '@haven_ai/sdk/edge'
import { observeEip3009MerchantSettlement, type Eip3009SettlementNonceProof } from './eip3009-settlement-evidence.js'
import { eip3009SettlementProofFromHeader } from './eip3009-settlement-evidence.js'
import { findIntentEvidenceSource, findEvidenceProofsForIntent } from '../../infra/repositories/machine-payments.js'
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

/**
 * Default blocks per `eth_getLogs` call. It is a ceiling, not a promise: the
 * span actually requested is `effectiveLogBatchBlocks(chainId, this)`, which
 * narrows it to what the provider serves (Alchemy's free plan: 10, #4012).
 */
export const EIP3009_LOG_BATCH_BLOCKS = 500

/** At most this many `eth_getLogs` calls for one candidate in one tick. */
export const EIP3009_MAX_BATCHES_PER_CANDIDATE = 20

/**
 * How far one tick looks forward from a candidate's cursor at the DEFAULT
 * span (500 × 20). On Base's ~2s blocks that is ~5.5h of history per tick.
 * An EIP-3009 authorization is only redeemable within its own `validBefore`,
 * minutes past signing, so the first tick's span covers a genuine settlement
 * with room to spare. The cursor exists for the pathological ones, not the
 * expected ones. A provider-narrowed span covers less per tick (10 × 20 = 200
 * blocks, ~7 min) and the cursor walks it forward over later ticks.
 */
export const EIP3009_SCAN_SPAN_BLOCKS =
  EIP3009_LOG_BATCH_BLOCKS * EIP3009_MAX_BATCHES_PER_CANDIDATE

/**
 * Hard ceiling on `eth_getLogs` calls per chain per tick, across every
 * candidate (#4012). Before it, the only bound was per candidate, so a
 * backlog of a hundred candidates was a hundred times that. A candidate the
 * budget does not reach is left untouched (`suppressed`), not judged. It is
 * not backed off either, because nothing was asked about it.
 */
export const EIP3009_MAX_LOG_CALLS_PER_CHAIN = 20

const SCAN_BACKOFF_BASE_MS = 120_000
const SCAN_BACKOFF_MAX_MS = 60 * 60 * 1000

/**
 * The backoff for a candidate whose own chain read FAILED (#4012). The same
 * growing, capped schedule as the fruitless backoff, in its own map, because
 * the two mean different things: fruitless is "asked and found nothing",
 * this is "could not ask". It never advances the cursor and never counts
 * toward `unresolved`. The first successful read clears it, so a recovered
 * chain is only held to the delay already scheduled, never to a longer one.
 */
const UNAVAILABLE_BACKOFF_BASE_MS = SCAN_BACKOFF_BASE_MS
const UNAVAILABLE_BACKOFF_MAX_MS = SCAN_BACKOFF_MAX_MS

type Backoff = Map<string, { attempts: number; nextAttemptAtMs: number }>
const scanBackoff: Backoff = new Map()
const unavailableBackoff: Backoff = new Map()
/** Next unscanned block per candidate, so a multi-tick scan advances instead of restarting. */
const scanCursors = new Map<string, number>()

/** Test seam: the maps are process-lifetime state, so a suite must reset them. */
export function resetEip3009SettlementSweepState(): void {
  scanBackoff.clear()
  unavailableBackoff.clear()
  scanCursors.clear()
}

function isSuppressed(paymentId: string, nowMs: number): boolean {
  for (const map of [scanBackoff, unavailableBackoff]) {
    const entry = map.get(paymentId)
    if (entry !== undefined && entry.nextAttemptAtMs > nowMs) return true
  }
  return false
}

function backOff(map: Backoff, paymentId: string, nowMs: number, baseMs: number, maxMs: number): void {
  const attempts = (map.get(paymentId)?.attempts ?? 0) + 1
  const delay = Math.min(maxMs, baseMs * 2 ** (attempts - 1))
  map.set(paymentId, { attempts, nextAttemptAtMs: nowMs + delay })
}

function recordFruitlessScan(paymentId: string, nowMs: number): void {
  backOff(scanBackoff, paymentId, nowMs, SCAN_BACKOFF_BASE_MS, SCAN_BACKOFF_MAX_MS)
}

/** "Could not ask" for this candidate: back it off, judge nothing. */
function recordUnavailableRead(paymentId: string, nowMs: number): void {
  backOff(unavailableBackoff, paymentId, nowMs, UNAVAILABLE_BACKOFF_BASE_MS, UNAVAILABLE_BACKOFF_MAX_MS)
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
  /**
   * Candidates skipped this tick: held by the fruitless or the unavailable
   * backoff, already scanned to the head, or past the chain's call budget.
   */
  suppressed: number
  /** Settlements verified and recorded from the chain alone. */
  recorded: number
  /** `machine_payment_evidence` base rows the tick ensured exist. */
  evidencePushed: number
  /** Candidates whose found tx the verifier or the guards refused. */
  refused: number
  /** Nonce-proven attributions declined because another payment holds the hash. */
  hashTaken: number
  /**
   * Candidates this tick could not judge because the chain could not be read.
   * Each one but a chain-wide head failure is backed off (#4012).
   */
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
    findProofs?: (paymentIntentId: string, agentId: string | null) => Promise<{ payment_proof_header: string | null } | null>
    recordBase?: (intent: MachinePaymentEvidenceSource, opts?: { suppressFeed?: boolean }) => Promise<EvidenceRecordOutcome>
    observe?: typeof observeEip3009MerchantSettlement
    feed?: typeof feedSettledPaymentBestEffort
  } = {},
): Promise<Eip3009SweepTickResult> {
  const findCandidates = deps.findCandidates ?? findSweepableEip3009Intents
  const chain: Eip3009ChainDeps = { ...defaultChainDeps, ...deps.chain }
  const findEvidenceSource = deps.findEvidenceSource ?? findIntentEvidenceSource
  const findProofs = deps.findProofs ?? findEvidenceProofsForIntent
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
  for (const id of unavailableBackoff.keys()) if (!liveIds.has(id)) unavailableBackoff.delete(id)
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
      // marked failed, and the next tick is the retry. Deliberately NOT
      // backed off: one head read per chain per tick is the whole cost, and
      // an outage that had nothing to do with a candidate must not delay
      // its recovery.
      result.chainsUnavailable += 1
      log.warn({ chainId, candidates: rows.length }, 'Eip3009 settlement sweep could not read the chain head — nothing recorded')
      continue
    }

    const budget = { logCallsLeft: EIP3009_MAX_LOG_CALLS_PER_CHAIN, rangeLimitLogged: false }
    for (const row of rows) {
      try {
        await sweepOne(row, head, chain, { findEvidenceSource, findProofs, recordBase, observe, feed }, log, result, nowMs, budget)
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
    findProofs: (paymentIntentId: string, agentId: string | null) => Promise<{ payment_proof_header: string | null } | null>
    recordBase: (intent: MachinePaymentEvidenceSource, opts?: { suppressFeed?: boolean }) => Promise<EvidenceRecordOutcome>
    observe: typeof observeEip3009MerchantSettlement
    feed: typeof feedSettledPaymentBestEffort
  },
  log: SweepLogger,
  result: Eip3009SweepTickResult,
  nowMs: number,
  budget: { logCallsLeft: number; rangeLimitLogged: boolean },
): Promise<void> {
  if (budget.logCallsLeft <= 0) {
    // The chain's log-call budget is spent. The receipt and state reads below
    // only serve a scan, so skip them too: untouched, not backed off.
    result.suppressed += 1
    return
  }
  const fundingBlock = await fundingBlockOf(row, chain)
  if (fundingBlock === null) {
    // Fail closed: without the funding block there is no honest lower bound,
    // and a guessed one could scan the wrong history. Not a fruitless scan —
    // an unreadable receipt is an RPC fact, not a negative answer — but it is
    // this candidate's own read, so it backs off (#4012).
    recordUnavailableRead(row.id, nowMs)
    result.chainsUnavailable += 1
    log.warn(
      { paymentId: row.id, chainId: row.chain_id, fundingTxHash: row.tx_hash },
      'Eip3009 settlement sweep could not read the funding receipt — nothing recorded',
    )
    return
  }

  const cursor = Math.max(scanCursors.get(row.id) ?? fundingBlock, fundingBlock)
  if (cursor > head) {
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
    recordUnavailableRead(row.id, nowMs)
    result.chainsUnavailable += 1
    log.debug({ paymentId: row.id, chainId: row.chain_id }, 'Eip3009 settlement sweep could not read authorizationState — nothing recorded')
    return
  }

  // `false` needs no scan and advances the cursor one default span, as it
  // always has. `true` scans only as far as the call budget reaches (#4012).
  let toBlock = Math.min(head, cursor + EIP3009_SCAN_SPAN_BLOCKS - 1)
  if (state) {
    // The span is the provider's (#4012): the default narrowed by the env cap
    // and by any limit a refusal taught this chain. The call count is bounded
    // per candidate and per chain, so a 10-block cap shortens the stretch
    // scanned this tick instead of multiplying the calls.
    const batchBlocks = effectiveLogBatchBlocks(row.chain_id, EIP3009_LOG_BATCH_BLOCKS, nowMs)
    const needed = Math.ceil((head - cursor + 1) / batchBlocks)
    const batches = Math.min(needed, EIP3009_MAX_BATCHES_PER_CANDIDATE, budget.logCallsLeft)
    if (batches <= 0) {
      // The chain's call budget is spent. Not scanned is not "not found":
      // untouched, and not backed off, because nothing was asked.
      result.suppressed += 1
      return
    }
    toBlock = Math.min(head, cursor + batchBlocks * batches - 1)
    budget.logCallsLeft -= batches

    const scan = await chain.findUsed(
      row.chain_id,
      row.token_address,
      row.to_address,
      nonce,
      { fromBlock: cursor, toBlock },
      { batchBlocks, maxBatches: batches },
    )

    if (scan.status === 'unavailable') {
      result.chainsUnavailable += 1
      const narrowed = effectiveLogBatchBlocks(row.chain_id, EIP3009_LOG_BATCH_BLOCKS, nowMs)
      if (narrowed < batchBlocks) {
        // The provider refused the span and named a narrower one. The next
        // request is a different, fitting one, so this is not a repeating
        // failure and is not backed off. The cause is named at warn, once per
        // chain per tick, so it shows in the deploy logs.
        if (!budget.rangeLimitLogged) {
          budget.rangeLimitLogged = true
          log.warn(
            { chainId: row.chain_id, reason: LOG_RANGE_LIMIT_REASON, requestedBlocks: batchBlocks, limitBlocks: narrowed },
            'Eip3009 settlement sweep: the RPC provider refused the eth_getLogs block range — narrowing the span to the limit it named (set ETH_GETLOGS_MAX_BLOCK_RANGE to skip the refused call)',
          )
        }
        return
      }
      recordUnavailableRead(row.id, nowMs)
      log.debug({ paymentId: row.id, chainId: row.chain_id }, 'Eip3009 settlement sweep log scan failed — nothing recorded, backed off')
      return
    }

    unavailableBackoff.delete(row.id)

    if (scan.status === 'found') {
      await recordOne(row, scan.txHash, fns, log, result)
      return
    }

    // #4319 Tier 1, second key: when the DERIVED nonce names nothing, a
    // stored X-PAYMENT header names a nonce of its own (a random-nonce
    // client's report carries it) — the same strongest-first proof, scanned
    // over the range just covered, under the same budget.
    if (scan.status === 'none') {
      const tier1Handled = await tier1FromStoredHeader(row, cursor, toBlock, chain, fns, log, result, nowMs, budget)
      if (tier1Handled) return
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
  // so the residue cannot monopolise the tick's budget. Every read succeeded,
  // so any unavailable backoff is over.
  unavailableBackoff.delete(row.id)
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
 * #4319 Tier 1 inside the tick: the payment's stored X-PAYMENT header names
 * its own nonce — derive the proof from it and scan the SAME range just
 * covered for `AuthorizationUsed(delegate, headerNonce)`, under the same
 * per-chain budget. Skipped when the header carries the derived nonce (the
 * scan above already asked that key) or the budget is spent. Returns whether
 * the candidate was handled (recorded or definitively not found under this
 * proof).
 */
async function tier1FromStoredHeader(
  row: SweepableEip3009Row,
  fromBlock: number,
  toBlock: number,
  chain: Eip3009ChainDeps,
  fns: {
    findProofs: (paymentIntentId: string, agentId: string | null) => Promise<{ payment_proof_header: string | null } | null>
    recordBase: (intent: MachinePaymentEvidenceSource, opts?: { suppressFeed?: boolean }) => Promise<EvidenceRecordOutcome>
    observe: typeof observeEip3009MerchantSettlement
    feed: typeof feedSettledPaymentBestEffort
    findEvidenceSource: (paymentIntentId: string, agentId: string | null) => Promise<MachinePaymentEvidenceSource | null>
  },
  log: SweepLogger,
  result: Eip3009SweepTickResult,
  nowMs: number,
  budget: { logCallsLeft: number; rangeLimitLogged: boolean },
): Promise<boolean> {
  if (budget.logCallsLeft <= 0) return false
  const proofs = await fns.findProofs(row.id, row.agent_id)
  const header = proofs?.payment_proof_header ?? null
  if (!header) return false
  const proof = eip3009SettlementProofFromHeader(row, header)
  if (!proof.ok) {
    // An undecodable stored header is a stored fact, not a chain verdict —
    // logged, not counted as refused. The next report can replace it.
    log.debug({ paymentId: row.id, reason: proof.reason }, 'Eip3009 settlement sweep: the stored X-PAYMENT header does not decode — Tier 1 skipped')
    return false
  }
  if (proof.proof.nonce === deriveX402PaymentNonce(row.id).toLowerCase()) return false

  const batchBlocks = effectiveLogBatchBlocks(row.chain_id, EIP3009_LOG_BATCH_BLOCKS, nowMs)
  const needed = Math.ceil((toBlock - fromBlock + 1) / batchBlocks)
  const batches = Math.min(needed, EIP3009_MAX_BATCHES_PER_CANDIDATE, budget.logCallsLeft)
  if (batches <= 0) return false
  budget.logCallsLeft -= batches
  const headerScan = await chain.findUsed(
    row.chain_id,
    row.token_address,
    row.to_address,
    proof.proof.nonce,
    { fromBlock, toBlock },
    { batchBlocks, maxBatches: batches },
  )
  if (headerScan.status !== 'found') return false
  await recordOne(row, headerScan.txHash, fns, log, result, proof.proof)
  return true
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
    findProofs: (paymentIntentId: string, agentId: string | null) => Promise<{ payment_proof_header: string | null } | null>
    recordBase: (intent: MachinePaymentEvidenceSource, opts?: { suppressFeed?: boolean }) => Promise<EvidenceRecordOutcome>
    observe: typeof observeEip3009MerchantSettlement
    feed: typeof feedSettledPaymentBestEffort
  },
  log: SweepLogger,
  result: Eip3009SweepTickResult,
  proofOverride?: Eip3009SettlementNonceProof,
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

  // #3925: the sweep's proof is the nonce it derived from the payment id —
  // the very key `findAuthorizationUsedTx` found this transaction by. Passed
  // explicitly so the observe call is held to the same nonce-bound standard
  // it now enforces on the agent-reported path. #4319: a Tier 1 header proof
  // (proofOverride) binds the record to the header's nonce instead —
  // `nonce_derived` only when that nonce happens to equal the derived one.
  const proof =
    proofOverride ?? { nonce: deriveX402PaymentNonce(row.id), nonceDerived: true }
  const settled = await fns.observe(source, txHash, undefined, proof)
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
