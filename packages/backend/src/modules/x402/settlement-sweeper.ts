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

export interface SweepLogger {
  debug: (obj: Record<string, unknown>, msg?: string) => void
  info: (obj: Record<string, unknown>, msg?: string) => void
  warn: (obj: Record<string, unknown>, msg?: string) => void
}

export interface SweepTickResult {
  candidates: number
  confirmed: number
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
    scan?: typeof scanRedeemedDelegations
    observe?: typeof observeErc7710Settlement
    recordEvidence?: typeof tryRecordMachinePaymentEvidenceBaseById
    readClock?: typeof readChainClock
  } = {},
): Promise<SweepTickResult> {
  const findCandidates = deps.findCandidates ?? findSweepableErc7710Intents
  const scan = deps.scan ?? scanRedeemedDelegations
  const observe = deps.observe ?? observeErc7710Settlement
  const recordEvidence = deps.recordEvidence ?? tryRecordMachinePaymentEvidenceBaseById
  const readClock = deps.readClock ?? readChainClock
  const nowMs = Date.now()

  const result: SweepTickResult = {
    candidates: 0,
    confirmed: 0,
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
  if (candidates.length === 0) return result

  // Drop backoff entries for payments that are no longer candidates — they were
  // confirmed, or they aged past the horizon. Bounds the map by the candidate
  // set rather than by process uptime.
  const liveIds = new Set(candidates.map((r) => r.id))
  for (const id of scanBackoff.keys()) if (!liveIds.has(id)) scanBackoff.delete(id)

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
        } else if (existing !== AMBIGUOUS && existing.toLowerCase() !== tx.toLowerCase()) {
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

  if (result.confirmed > 0 || result.refused > 0 || result.chainsUnavailable > 0 || result.unresolved > 0) {
    log.info({ ...result }, 'Settlement sweep tick acted')
  } else {
    log.debug({ ...result }, 'Settlement sweep tick found nothing to complete')
  }
  return result
}

async function sweepOne(
  row: SweepableSettlementRow,
  index: RedemptionIndex,
  fns: {
    observe: typeof observeErc7710Settlement
    recordEvidence: typeof tryRecordMachinePaymentEvidenceBaseById
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

  // The intent is `confirmed` with a hash, so it is now indistinguishable from
  // a 3009 one. This is what captures book-time FX, writes the fee-ledger row
  // and fires the Fortnox auto-feed — the same call the agent-reported path
  // makes, and idempotent, so racing an agent report costs nothing.
  await fns.recordEvidence(row.id, row.agent_id, log)
  result.confirmed += 1
  log.info(
    { paymentId: row.id, txHash: found, chainId: row.chain_id },
    'Settlement sweep completed an unreported erc7710 payment',
  )
}

function isPastSettlementWindow(row: SweepableSettlementRow): boolean {
  const createdMs = new Date(row.created_at).getTime()
  if (!Number.isFinite(createdMs)) return true
  return Date.now() > createdMs + MAX_SETTLEMENT_WINDOW_SECONDS * 1000
}
