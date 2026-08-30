/**
 * Passive settlement observation — the leader-gated tick that completes an
 * erc7710 payment nobody ever reported a hash for (#2117, #2092 residual).
 *
 * ## The gap
 *
 * On erc7710 direct settlement the merchant redeems the delegation chain and
 * Haven submits nothing, so the intent sits at `submitted` until an AGENT posts
 * the merchant's settlement hash to `POST /machine-payments/evidence`. When
 * that report never happens — the merchant returned no `PAYMENT-RESPONSE`
 * transaction, or the generic plain-HTTP flow (#2041) meant Haven never saw the
 * header at all — the payment has no `machine_payment_evidence` row, and a row
 * is what the Fortnox feed enumerates. Settled money, permanently absent from
 * the books, with no rail-level reason a user could have predicted.
 *
 * ## The decision this monitor settles
 *
 * #2117's acceptance criterion offered a choice: complete such a payment by
 * passive observation, **or** surface it as unresolved. This is the completion,
 * and the surfacing is kept as its complement rather than its alternative —
 * because they are not interchangeable. The issue's own requirement is that
 * every settled machine payment eventually SYNCS; an "unresolved" badge is a
 * to-do list, not a book entry, and it discharges the requirement onto the
 * user. But a sweep can never be complete either (see the three residuals
 * below), so leaving what it cannot reach silent would recreate today's failure
 * on a smaller set. So: complete what can be attributed, and log the rest
 * loudly as it ages out.
 *
 * ## Attribution — one path, and it refuses to guess
 *
 * Given an intent, the sweep must find its transaction. It does that with
 * exactly the evidence #2096 uses in the opposite direction: the pinned
 * DelegationManager's `RedeemedDelegation` log, re-hashed and compared to the
 * `delegation_hash` #2094 stores at authorize time. `salt =
 * keccak256("haven-x402-settlement:" || <intent id>)` and the intent id is the
 * row's primary key written before the child is built, so intent → child is a
 * pure function of the row and the lookup key is intent-unique.
 *
 * **There is no second path.** The sweep never proposes a candidate from
 * transfer shape, and it passes `requireDelegationBound` so the seam refuses
 * even a shape-perfect match the manager did not name. That is the whole
 * safety argument: today's gap is "fail-closed — never wrong, sometimes
 * missing", and on an accounting feed a confidently misattributed row is worse
 * than a missing one, because the missing one surfaces at reconciliation and
 * the wrong one does not. A sweep that guessed would trade the good failure for
 * the bad one.
 *
 * Everything #2096 refuses is still refused, unchanged and by the same code:
 * the transaction runs through the full verifier (checks 1–8) and the guarded
 * `UPDATE` with its replay guard and its ambiguity guard. Two pre-#2094
 * look-alikes share one child hash, so this scan finds the same transaction for
 * both, each attempt fails the "different child" conjunct, and both stay
 * `submitted` — which is the correct answer for them and is asserted as such.
 *
 * ## Two passes, and why the second one exists (#2213)
 *
 * The forward pass above completes an unreported settlement. It does that in
 * two writes — confirm, then evidence — and only the first is undoable-proof:
 * once an intent is `confirmed` with a hash it leaves the candidate query for
 * good, and the accounting backfill enumerates evidence ROWS, so a missing row
 * is invisible to it as well. A confirm whose evidence write failed therefore
 * used to move a payment out of the gap this module closes and into one nothing
 * automated reaches — and, because the seam returned `void`, it did so while
 * reporting success, removing the only signal that anyone should look.
 *
 * (An agent re-posting the same hash would still have completed it:
 * `observeErc7710Settlement` answers `not_applicable` on an already-confirmed
 * intent and `attachMachinePaymentEvidence` falls through to the same evidence
 * write. The gap was never a refused retry; it was that nothing prompts one,
 * and on the plain-HTTP flow the agent has no hash to re-post.)
 *
 * That is fixed in two halves. The seam now reports whether a row landed, so
 * `evidencePushed` and `evidenceFailed` are counted apart from the state
 * transition `confirmed`, and a failure is a `warn`, never the completion log.
 * And a RECOVERY pass re-derives the hole from state — a confirmed erc7710
 * intent with no evidence row — and rewrites the row, so the failure leaves the
 * payment inside a retry path instead of outside every one. `recoverOne`'s
 * comment records why the ordering cannot simply be inverted and why the two
 * writes cannot share a transaction.
 *
 * Credit: PR #2134 (PhilipEriksson), the parallel never-merged implementation
 * of #2117, caught the unobservable seam in its own reviewer pass and fixed it
 * there first. The observability half of this is his design.
 *
 * ## Concurrency
 *
 * Leader-gated across replicas, and safe against an agent reporting the same
 * hash at the same instant: the confirm is a CAS (`status = 'submitted' AND
 * tx_hash IS NULL`) serialized per hash by `pg_advisory_xact_lock`, so exactly
 * one writer wins and the loser's outcome is "not confirmed" rather than a
 * second row. Evidence recording is an upsert, so a double call is a no-op.
 *
 * ## Cost, and what an outage does
 *
 * Every RPC failure returns "not known yet" and the tick does nothing for that
 * chain. Nothing is written, nothing is marked failed, and there is no retry
 * inside the tick — the next scheduled tick is the retry, which is what keeps a
 * dead RPC from becoming a hot loop.
 *
 * Each candidate is scanned over ITS OWN settlement window, which is where its
 * transaction provably is, so no candidate's coverage depends on any other's —
 * the property review found missing from the first draft, where one range per
 * chain anchored on the oldest candidate let a permanently-stuck row freeze the
 * range short of the head and starve every newer payment on that chain. On top
 * of that: overlapping windows share their `eth_getLogs` calls, a hard batch
 * budget per chain per tick, and a per-candidate exponential backoff after a
 * fruitless scan so the three residual gaps cannot spend the budget forever. A
 * candidate the budget did not reach is left untouched rather than judged —
 * "not scanned" and "not found" are different facts.
 *
 * ## Residual gaps this deliberately does NOT close
 *
 * 1. A facilitator route that emits no decodable `RedeemedDelegation` log from
 *    the pinned manager. Nothing names the payment, so it is not discoverable
 *    and stays `submitted`.
 * 2. A pre-#2094 look-alike pair, refused as above.
 * 3. A payment whose transaction is older than the recovery horizon.
 *
 * All three are logged as they age past the horizon, and all three are recorded
 * in `docs/architecture/04-x402-payment-sequence.md` and
 * `docs/operations/fortnox-reporting-feed.md`.
 */
import {
  findEvidenceOrphanedErc7710Intents,
  findSweepableErc7710Intents,
  type SweepableSettlementRow,
} from '../../infra/repositories/x402-authorizations.js'
import {
  AMBIGUOUS,
  scanRedeemedDelegations,
  type RedemptionIndex,
  type ScanRange,
} from '../../infra/chain/redeemed-delegation-scanner.js'
import { getProvider } from '../../rails/allowance-module.js'
import { observeErc7710Settlement } from './settlement-observed.js'
import { tryRecordMachinePaymentEvidenceBaseById } from '../mpp/index.js'
import { MAX_SETTLEMENT_WINDOW_SECONDS } from './x402-delegation.js'

/** How often the tick runs. */
export const SETTLEMENT_SWEEP_INTERVAL_MS = 120_000

/**
 * Grace before a payment becomes a candidate. Long enough that the ordinary
 * agent-reported completion has happened, so the sweep costs nothing on the
 * happy path and only ever pays for payments that really went unreported.
 */
export const SWEEP_MIN_AGE_SECONDS = 90

/**
 * How far back a payment stays sweepable. NOT the settlement window — see the
 * SQL's comment: the window bounds when the transaction can have been mined,
 * this bounds how long Haven keeps looking. Sized so an RPC outage lasting up
 * to a day is fully recovered rather than turning into permanent invisibility.
 */
export const SWEEP_RECOVERY_HORIZON_SECONDS = 24 * 60 * 60

/** Candidates considered per tick, across all chains. */
export const SWEEP_MAX_CANDIDATES_PER_TICK = 200

/** Blocks per `eth_getLogs` call — under every provider's served span. */
export const SWEEP_LOG_BATCH_BLOCKS = 500

/** Hard cap on `eth_getLogs` calls per chain per tick: ≤ 10 000 blocks. */
export const SWEEP_MAX_BATCHES_PER_CHAIN = 20

/**
 * Slack on each end of a candidate's estimated block window, as a fraction of
 * how far back that window is plus a flat pad. Both are over-reach in the SAFE
 * direction: scanning a few blocks too many costs a fraction of a batch, while
 * scanning too few silently loses a payment. Over-reaching can never confirm
 * anything extra — check 7 still requires the mined block to sit inside the
 * intent's own settlement window, whatever the scan happened to cover.
 */
const BLOCK_ESTIMATE_DRIFT_FRACTION = 0.1
const BLOCK_ESTIMATE_PAD = 500

/** Clock-skew allowance, matching the seam's own window widening. */
const CLOCK_SKEW_SECONDS = 120

/** Blocks back to sample when measuring this chain's actual block time. */
const BLOCK_TIME_SAMPLE_SPAN = 5_000

/** Fallback seconds-per-block if the sample is unusable (never zero). */
const FALLBACK_SECONDS_PER_BLOCK = 2

/**
 * Backoff for a candidate whose scan found nothing, so the residue cannot
 * monopolise the tick's RPC budget (review finding on the first draft).
 *
 * The three residual gaps are permanent for the payments they affect, but the
 * database cannot know that — those rows stay candidates for the full 24-hour
 * horizon and would otherwise be re-scanned every two minutes forever, crowding
 * out freshly authorized payments that ARE findable. This is purely a cost
 * schedule: a suppressed candidate is scanned later, never dropped, and the
 * horizon leaves ample room. In-memory on purpose — losing it on restart costs
 * one extra scan, and persisting it would mean a migration for a cache.
 */
const SCAN_BACKOFF_BASE_MS = SETTLEMENT_SWEEP_INTERVAL_MS
const SCAN_BACKOFF_MAX_MS = 60 * 60 * 1000

const scanBackoff = new Map<string, { attempts: number; nextAttemptAtMs: number }>()

/** Test seam: the backoff is process-lifetime state, so a suite must reset it. */
export function resetSettlementSweepBackoff(): void {
  scanBackoff.clear()
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

/**
 * The evidence-recording seam. Widened from `Promise<void>` to an outcome in
 * #2213 so this module can tell "the row landed" from "it did not" — the
 * distinction the merged #2117 implementation could not make.
 */
export type EvidenceRecorder = typeof tryRecordMachinePaymentEvidenceBaseById

export interface SweepLogger {
  debug: (obj: Record<string, unknown>, msg?: string) => void
  info: (obj: Record<string, unknown>, msg?: string) => void
  warn: (obj: Record<string, unknown>, msg?: string) => void
}

export interface SweepTickResult {
  candidates: number
  /**
   * Intents this tick flipped `submitted → confirmed`. A STATE TRANSITION, not
   * a completion — #2213 split the two because they were the same number and
   * the number was wrong. A confirm with no evidence row is a payment moved
   * from one gap into another, so read `evidencePushed` for success and
   * `evidenceFailed` for the residue.
   */
  confirmed: number
  /**
   * Confirms that also landed a `machine_payment_evidence` row — the completion
   * this module exists for, because a row is what the Fortnox feed enumerates.
   */
  evidencePushed: number
  /**
   * Confirmed, but no evidence row landed. Recoverable — see the recovery pass
   * — but never a success, and always logged at `warn`.
   */
  evidenceFailed: number
  /**
   * Evidence rows landed by the recovery pass for intents that were already
   * confirmed and orphaned when the tick started.
   */
  evidenceRecovered: number
  /** Orphaned intents the recovery pass could not write a row for this tick. */
  evidenceOrphaned: number
  /** Candidates whose hash was found but which the seam or the guards refused. */
  refused: number
  /** Chains skipped because the RPC could not be read. Never a verdict. */
  chainsUnavailable: number
  /** Candidates past their settlement window that remain unattributable. */
  unresolved: number
  /** Candidates skipped this tick by the fruitless-scan backoff. */
  suppressed: number
}

/** What a chain's head says about its height and its pace. */
export interface ChainClock {
  headNumber: number
  headTimestamp: number
  secondsPerBlock: number
}

/**
 * Read the chain head and MEASURE this chain's block time from a real sample,
 * rather than assuming one. `null` on any RPC failure — never a guessed clock,
 * because every block range below is derived from it.
 */
async function readChainClock(chainId: number): Promise<ChainClock | null> {
  try {
    const provider = getProvider(chainId)
    const head = await provider.getBlock('latest')
    if (!head || typeof head.number !== 'number' || typeof head.timestamp !== 'number') return null

    let secondsPerBlock = FALLBACK_SECONDS_PER_BLOCK
    const sampleNumber = head.number - BLOCK_TIME_SAMPLE_SPAN
    if (sampleNumber > 0) {
      const sample = await provider.getBlock(sampleNumber)
      if (sample && typeof sample.timestamp === 'number') {
        const measured = (head.timestamp - sample.timestamp) / (head.number - sampleNumber)
        if (Number.isFinite(measured) && measured > 0) secondsPerBlock = measured
      }
    }
    return { headNumber: head.number, headTimestamp: head.timestamp, secondsPerBlock }
  } catch {
    return null
  }
}

/**
 * The blocks that could carry THIS candidate's settlement.
 *
 * Anchored on the candidate's OWN settlement window — `[authorize - skew,
 * authorize + 600s + skew]` — because that is where its transaction provably
 * is: the child's `timestamp` caveat is enforced on-chain, so a genuine
 * settlement of this child cannot be mined outside it.
 *
 * The first draft instead anchored ONE range per chain on the oldest candidate
 * and ran it forward to the head, capped by the batch budget. Review found that
 * starves: an unattributable candidate — residual gap 1 or 2, which this module
 * documents as expected — stays a candidate for the full 24-hour horizon, keeps
 * anchoring the range, and since the anchor recedes as fast as the head
 * advances, the capped range never reaches the head again. Freshly authorized
 * payments, whose settlements sit near the head, would then never be scanned at
 * all for as long as one stuck row existed on that chain. Deriving the range
 * from each candidate's own window removes the coupling entirely, and costs
 * less: a 600-second window is a few hundred blocks, not a walk back to the
 * oldest thing in the backlog.
 */
export function candidateScanRange(createdAtMs: number, clock: ChainClock): ScanRange {
  const authorizeSec = Math.floor(createdAtMs / 1000)
  const blockAt = (sec: number) =>
    clock.headNumber - Math.ceil((clock.headTimestamp - sec) / clock.secondsPerBlock)

  const rawFrom = blockAt(authorizeSec - CLOCK_SKEW_SECONDS)
  const rawTo = blockAt(authorizeSec + MAX_SETTLEMENT_WINDOW_SECONDS + CLOCK_SKEW_SECONDS)

  // Estimation error grows with distance from the head, so the slack does too.
  const drift = Math.ceil(
    Math.max(0, clock.headNumber - rawFrom) * BLOCK_ESTIMATE_DRIFT_FRACTION,
  ) + BLOCK_ESTIMATE_PAD

  return {
    fromBlock: Math.max(0, rawFrom - drift),
    toBlock: Math.min(clock.headNumber, rawTo + drift),
  }
}

/** Merge overlapping or touching ranges so co-authorized candidates share calls. */
export function coalesceRanges(ranges: ScanRange[]): ScanRange[] {
  const sorted = [...ranges].sort((a, b) => a.fromBlock - b.fromBlock)
  const merged: ScanRange[] = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last && range.fromBlock <= last.toBlock + 1) {
      last.toBlock = Math.max(last.toBlock, range.toBlock)
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}

/**
 * One sweep tick. Never throws for an individual candidate — one poison row
 * must not silence the rest, and the queue is oldest-first, so a row that threw
 * on every tick would otherwise be first in line every time.
 */
export async function runSettlementSweepTick(
  log: SweepLogger,
  deps: {
    findCandidates?: typeof findSweepableErc7710Intents
    findOrphans?: typeof findEvidenceOrphanedErc7710Intents
    scan?: typeof scanRedeemedDelegations
    observe?: typeof observeErc7710Settlement
    recordEvidence?: EvidenceRecorder
    readClock?: typeof readChainClock
  } = {},
): Promise<SweepTickResult> {
  const findCandidates = deps.findCandidates ?? findSweepableErc7710Intents
  const findOrphans = deps.findOrphans ?? findEvidenceOrphanedErc7710Intents
  const scan = deps.scan ?? scanRedeemedDelegations
  const observe = deps.observe ?? observeErc7710Settlement
  const recordEvidence = deps.recordEvidence ?? tryRecordMachinePaymentEvidenceBaseById
  const readClock = deps.readClock ?? readChainClock
  const nowMs = Date.now()

  const result: SweepTickResult = {
    candidates: 0,
    confirmed: 0,
    evidencePushed: 0,
    evidenceFailed: 0,
    evidenceRecovered: 0,
    evidenceOrphaned: 0,
    refused: 0,
    chainsUnavailable: 0,
    unresolved: 0,
    suppressed: 0,
  }

  const candidates = await findCandidates(
    SWEEP_MIN_AGE_SECONDS,
    SWEEP_RECOVERY_HORIZON_SECONDS,
    SWEEP_MAX_CANDIDATES_PER_TICK,
  )
  result.candidates = candidates.length

  // #2213 recovery pass. Both working sets are SELECTed here, before either
  // loop writes anything, so a hole this tick's forward pass is about to create
  // cannot appear in this tick's orphan set whichever loop runs first — it is
  // closed on the next tick. What this pass does close is a hole left by any
  // earlier tick, or by an agent-reported settlement whose evidence write threw. Chain-free: these payments are
  // already attributed, so nothing is scanned, verified or moved. The write is
  // the same idempotent upsert, so racing anything else costs nothing.
  const orphans = await findOrphans(
    SWEEP_MIN_AGE_SECONDS,
    SWEEP_RECOVERY_HORIZON_SECONDS,
    SWEEP_MAX_CANDIDATES_PER_TICK,
  )

  // Drop backoff entries for payments that are in neither working set — they
  // were completed, or they aged past the horizon. Bounds the map by the live
  // sets rather than by process uptime.
  const liveIds = new Set([...candidates, ...orphans].map((r) => r.id))
  for (const id of scanBackoff.keys()) if (!liveIds.has(id)) scanBackoff.delete(id)

  for (const row of orphans) {
    if (isSuppressed(row.id, nowMs)) {
      result.suppressed += 1
      continue
    }
    try {
      await recoverOne(row, recordEvidence, log, result, nowMs)
    } catch (err) {
      // Same rule as the forward sweep: one poison row must not silence the
      // rest, and the queue is oldest-first.
      log.warn({ err, paymentId: row.id }, 'Settlement sweep evidence recovery failed')
    }
  }

  if (candidates.length === 0) {
    logTickOutcome(log, result)
    return result
  }

  const byChain = new Map<number, SweepableSettlementRow[]>()
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
    const clock = await readClock(chainId)
    if (!clock) {
      // "Could not ask" — never a verdict. Nothing is written, nothing is
      // marked failed, and the next tick is the retry. Deliberately NOT counted
      // as a fruitless scan: backing a candidate off for an outage that had
      // nothing to do with it would delay the recovery this exists for.
      result.chainsUnavailable += 1
      log.warn({ chainId, candidates: rows.length }, 'Settlement sweep could not read the chain — nothing confirmed')
      continue
    }

    // Each candidate is scanned over ITS OWN settlement window, so no candidate
    // can displace another's coverage. Overlapping windows are merged, and the
    // batch budget is spent oldest-first.
    const withRanges = rows.map((row) => ({
      row,
      range: candidateScanRange(new Date(row.created_at).getTime(), clock),
    }))
    const merged = coalesceRanges(withRanges.map((c) => c.range))

    const index: RedemptionIndex = new Map()
    let batchesSpent = 0
    let scanFailed = false
    const covered: ScanRange[] = []
    for (const range of merged) {
      const span = range.toBlock - range.fromBlock + 1
      const batches = Math.ceil(span / SWEEP_LOG_BATCH_BLOCKS)
      if (batchesSpent + batches > SWEEP_MAX_BATCHES_PER_CHAIN) break
      let part: RedemptionIndex | null
      try {
        part = await scan(chainId, range, {
          batchBlocks: SWEEP_LOG_BATCH_BLOCKS,
          maxBatches: SWEEP_MAX_BATCHES_PER_CHAIN,
        })
      } catch {
        part = null
      }
      if (!part) {
        scanFailed = true
        break
      }
      // Merging the per-range indexes must preserve the scanner's own ambiguity
      // semantics ACROSS ranges: two candidates far enough apart in time that
      // their windows never coalesce are scanned separately, so a child seen
      // redeemed by two different transactions would otherwise be silently
      // resolved to whichever range was scanned first. Case-insensitive for the
      // same reason the scanner is — a provider may echo a hash in either case.
      for (const [hash, tx] of part) {
        const existing = index.get(hash)
        if (existing === undefined) {
          index.set(hash, tx)
        } else if (existing === AMBIGUOUS || tx === AMBIGUOUS) {
          // Ambiguity found WITHIN one range must survive the merge too, or a
          // second range naming the same child would overwrite the poison.
          index.set(hash, AMBIGUOUS)
        } else if (existing.toLowerCase() !== tx.toLowerCase()) {
          index.set(hash, AMBIGUOUS)
        }
      }
      covered.push(range)
      batchesSpent += batches
    }

    if (scanFailed) {
      result.chainsUnavailable += 1
      log.warn({ chainId, candidates: rows.length }, 'Settlement sweep log scan failed — nothing confirmed')
      continue
    }

    for (const { row, range } of withRanges) {
      // Only judge a candidate whose whole window was actually scanned. A
      // candidate the budget did not reach is untouched — not "not found" —
      // because those are the same observation and only one of them is true.
      const scanned = covered.some((c) => c.fromBlock <= range.fromBlock && c.toBlock >= range.toBlock)
      if (!scanned) {
        result.suppressed += 1
        continue
      }
      try {
        await sweepOne(row, index, { observe, recordEvidence }, log, result, nowMs)
      } catch (err) {
        log.warn({ err, paymentId: row.id }, 'Settlement sweep candidate failed')
      }
    }
  }

  logTickOutcome(log, result)
  return result
}

function logTickOutcome(log: SweepLogger, result: SweepTickResult): void {
  const acted =
    result.confirmed > 0 ||
    result.refused > 0 ||
    result.chainsUnavailable > 0 ||
    result.unresolved > 0 ||
    result.evidenceRecovered > 0 ||
    result.evidenceOrphaned > 0
  if (acted) {
    log.info({ ...result }, 'Settlement sweep tick acted')
  } else {
    log.debug({ ...result }, 'Settlement sweep tick found nothing to complete')
  }
}

async function sweepOne(
  row: SweepableSettlementRow,
  index: RedemptionIndex,
  fns: {
    observe: typeof observeErc7710Settlement
    recordEvidence: EvidenceRecorder
  },
  log: SweepLogger,
  result: SweepTickResult,
  nowMs: number,
): Promise<void> {
  const key = row.delegation_hash?.toLowerCase()
  const found = key ? index.get(key) : undefined

  if (found === undefined || found === AMBIGUOUS) {
    // Its window was scanned and named nothing. Back this candidate off so the
    // residue cannot spend the whole budget every tick.
    recordFruitlessScan(row.id, nowMs)
    // Not settled yet, not visible in this range, no decodable manager log on
    // the route that settled it — or, for AMBIGUOUS, redeemed by two different
    // transactions, which is a fact we do not understand and will not resolve
    // by choosing. The intent stays exactly where it was.
    if (isPastSettlementWindow(row)) {
      result.unresolved += 1
      log.warn(
        {
          paymentId: row.id,
          agentId: row.agent_id,
          chainId: row.chain_id,
          delegationHash: row.delegation_hash,
          reason: found === AMBIGUOUS ? 'ambiguous_redemption' : 'no_manager_log',
        },
        'Settled erc7710 payment is past its settlement window and still unattributable — it will not reach the accounting feed',
      )
    }
    return
  }

  // `requireDelegationBound` is the constraint, not an optimisation: the seam
  // refuses even a shape-perfect match the pinned manager did not name.
  const observation = await fns.observe(row, found, undefined, { requireDelegationBound: true })

  if (observation.outcome !== 'confirmed') {
    result.refused += 1
    log.warn(
      {
        paymentId: row.id,
        txHash: found,
        outcome: observation.outcome,
        reason: observation.outcome === 'unverified' ? observation.reason : undefined,
      },
      'Settlement sweep refused a candidate settlement',
    )
    return
  }

  // The confirm has landed and CANNOT be undone — see `recoverOne`'s comment
  // for why the two writes are not one transaction and why rolling the confirm
  // back would be wrong even if they could be. So from here the only honest
  // reporting is: say whether the row landed, and never call the failure a
  // completion.
  result.confirmed += 1

  // The intent is `confirmed` with a hash, so it is now indistinguishable from
  // a 3009 one. This is what captures book-time FX, writes the fee-ledger row
  // and fires the Fortnox auto-feed — the same call the agent-reported path
  // makes, and idempotent, so racing an agent report costs nothing.
  const outcome = await fns.recordEvidence(row.id, row.agent_id, log)

  // #2213: EVERY non-`recorded` outcome is a failure at this call site. The
  // seam's `not_applicable` means "nothing to record" for callers that reach it
  // speculatively — but this caller has just established every precondition
  // itself, so there is no legitimate "nothing to record" left here.
  if (outcome.status !== 'recorded') {
    result.evidenceFailed += 1
    log.warn(
      {
        paymentId: row.id,
        agentId: row.agent_id,
        txHash: found,
        chainId: row.chain_id,
        outcome: outcome.status,
        reason: outcome.reason,
      },
      'Settlement sweep confirmed an erc7710 payment but no evidence row landed — it is not in the accounting feed and will be retried by the recovery pass',
    )
    return
  }

  result.evidencePushed += 1
  log.info(
    { paymentId: row.id, txHash: found, chainId: row.chain_id },
    'Settlement sweep completed an unreported erc7710 payment',
  )
}

/**
 * The recovery pass (#2213) — write the missing evidence row for a payment that
 * is already `confirmed` with a hash and has none.
 *
 * ## Why this exists rather than an ordering fix
 *
 * The obvious remedy for "the confirm happened and the evidence write did not"
 * is to reverse the order, or to make them atomic. Neither is available:
 *
 * - **The order cannot be inverted.** `recordMachinePaymentEvidenceBase`
 *   refuses any intent that is not already `confirmed` with a `tx_hash`, and it
 *   reads `confirmed_at` off the row. Those are precisely what the confirm
 *   writes. Evidence is settlement-time proof BY CONSTRUCTION; there is no
 *   evidence to record before the settlement is recorded.
 * - **They cannot share a transaction.** The confirm is a guarded CAS
 *   serialized per hash by `pg_advisory_xact_lock` inside
 *   `observeErc7710Settlement`; the evidence write is a separate upsert plus a
 *   fee-ledger row plus a fire-and-forget network call to the accounting feed.
 *   The last of those cannot be rolled back.
 * - **The confirm should not be undone even so.** It records a true fact about
 *   the chain — the merchant redeemed, the money moved. Reverting it to
 *   `submitted` with a null hash would make the database assert something
 *   false, and would re-open the replay/ambiguity surface that CAS exists to
 *   close by letting exactly one writer win.
 *
 * So the guarantee this pass provides instead is: **a failed evidence write
 * leaves the payment inside a retry path rather than outside every one.** The
 * hole is re-derived from state — confirmed erc7710 intent, no evidence row —
 * so it does not depend on the failure having been remembered anywhere.
 *
 * What it does NOT recover: a payment whose `resource_url` is missing, which is
 * unwritable rather than unwritten. Those are retried until the recovery
 * horizon and logged at `warn` every attempt, which is the difference between
 * a missing row that announces itself and one that reports success.
 */
async function recoverOne(
  row: SweepableSettlementRow,
  recordEvidence: EvidenceRecorder,
  log: SweepLogger,
  result: SweepTickResult,
  nowMs: number,
): Promise<void> {
  const outcome = await recordEvidence(row.id, row.agent_id, log)

  if (outcome.status === 'recorded') {
    result.evidenceRecovered += 1
    log.info(
      { paymentId: row.id, agentId: row.agent_id, chainId: row.chain_id, txHash: row.tx_hash },
      'Settlement sweep recovered a missing evidence row for an already-confirmed erc7710 payment',
    )
    return
  }

  recordFruitlessScan(row.id, nowMs)
  result.evidenceOrphaned += 1
  log.warn(
    {
      paymentId: row.id,
      agentId: row.agent_id,
      chainId: row.chain_id,
      txHash: row.tx_hash,
      outcome: outcome.status,
      reason: outcome.reason,
    },
    'Settled erc7710 payment is confirmed with no evidence row and the row could not be written — it will not reach the accounting feed',
  )
}

function isPastSettlementWindow(row: SweepableSettlementRow): boolean {
  const createdMs = new Date(row.created_at).getTime()
  if (!Number.isFinite(createdMs)) return true
  return Date.now() > createdMs + MAX_SETTLEMENT_WINDOW_SECONDS * 1000
}
