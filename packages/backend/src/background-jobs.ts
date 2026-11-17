/**
 * The backend's background jobs, as one importable table (#4764).
 *
 * `index.ts` used to start all ten of these inline, between its route
 * registrations and `startRetrySweep`. That made the wiring untestable —
 * importing `index.ts` boots the server — so two tests read the file as text
 * and regex-matched it, a technique that failed once on record (#4411).
 *
 * The rows live here, beside the composition root, and NOT in `platform/`:
 * their `run` bodies are orchestration that imports `modules/` and `infra/`,
 * and `docs/architecture/10-module-boundaries.md` reserves `platform/` for
 * process-level concerns and "never business rules". The generic scheduler
 * that applies the outer shape is `platform/job-scheduler.ts`.
 *
 * Behaviour is unchanged from the inline wiring: same lock keys, intervals,
 * first-run behaviour, `.unref()`, and warn messages; per-pass and per-phase
 * catches kept with their exact messages; dynamic imports stay lazy, not
 * hoisted; no overlap guard is added to these ten; the outbound job still
 * iterates per chain inside one tick.
 *
 * The eleventh job — the accounting retry sweep — is NOT a row. It registers
 * nothing when `config.accountingEnabled` is off, its interval comes from
 * config, it has an in-process overlap guard, and its leader function is
 * injectable, so it stays self-registering in
 * `modules/accounting/retry-sweep.ts` and `startBackgroundJobs` calls it.
 */
import { config } from './config.js'
import { deployableChainIds } from './domain/chains.js'
import { runDelegateBalanceMonitor } from './infra/delegate-balance-monitor.js'
import { sendDelegateAlertFromEnv } from './infra/delegate-alert-webhook.js'
import { PASSPORT_STUCK_REVOKE_SECONDS } from './infra/passport-stuck-revoke-seconds.js'
import { deleteExpiredFeedback } from './infra/repositories/feedback.js'
import { deleteExpiredRateLimits } from './infra/repositories/rate-limit-counters.js'
import { runRelayerBalanceMonitor } from './infra/relayer-balance-monitor.js'
import { startRetrySweep } from './modules/accounting/index.js'
import {
  createCatalogIngestMonitor,
  deliverCatalogAlerts,
  ingestDiscoveredCatalog,
  refreshCatalog,
  type CatalogIngestMonitor,
  type QueryableLike,
} from './modules/catalog/index.js'
import {
  listStuckReanchors,
  listStuckRevocations,
  reconcilePendingReanchors,
  reconcilePendingRevocations,
  repairAnchoredUids,
  retryPendingPassports,
} from './modules/passport/index.js'
import { SETTLEMENT_SWEEP_INTERVAL_MS } from './modules/x402/index.js'
import { LEADER_LOCK_KEYS } from './platform/leader-lock.js'
import {
  startJobs,
  type BackgroundJobRow,
  type JobLogger,
  type JobSchedulerDeps,
} from './platform/job-scheduler.js'

const CATALOG_REFRESH_INTERVAL_MS = 60 * 60 * 1000 // hourly

/**
 * Catalogue ingestion (#1714, epic #1717): the leader-locked tick that walks
 * self-submitted queue rows through ownership proof -> verification probe and
 * keeps the table bounded. Slow cadence on purpose: each probe is bounded by
 * the 15-minute per-hostname cooldown, which `createCatalogIngestMonitor`
 * holds across ticks (#4407), and re-verification is at most daily.
 */
const CATALOG_INGEST_INTERVAL_MS = 5 * 60 * 1000

/**
 * #1680: the sweep only reclaims space — every read already filters on expiry,
 * so a late run costs dead rows, never a wrong count. Five minutes keeps the
 * table small without adding a chatty query to a busy database.
 */
const RATE_LIMIT_SWEEP_INTERVAL_MS = 5 * 60 * 1000

/**
 * #3597: same reasoning as the rate-limit sweep immediately above — every
 * read already filters `expires_at > NOW()`, so a late run only costs dead
 * rows, never a wrong read. Feedback volume is far lower than rate-limit
 * counters (one submission per CLI call, rate-limited per user), so there is
 * no pressure to run this more often.
 */
const FEEDBACK_SWEEP_INTERVAL_MS = 5 * 60 * 1000

const DELEGATE_MONITOR_INTERVAL_MS = 60 * 60 * 1000 // hourly (#714)

// Every 5 minutes, not hourly: this sweep carries revocation reconciliation,
// and the backoff schedule it drives starts at 30s. An hourly tick would flatten
// that to an hour, leaving a revoked agent's attestation live on-chain far
// longer than the retry policy intends (#973).
const PASSPORT_SWEEP_INTERVAL_MS = 5 * 60 * 1000

const OUTBOUND_BUMP_INTERVAL_MS = 60_000
const RECONCILE_INTERVAL_MS = 60_000

/**
 * Ops webhook, same Slack-compatible `{ text }` shape as the
 * delegate/relayer monitors — via the shared sender (#3345), which checks
 * `res.ok`: a 4xx/5xx or network error logs a warning with the status (never
 * the URL — it is a credential) and reports `failed`, so the catalog tick
 * above can re-arm the alarm and retry on the next tick. A failed alert
 * still never affects the tick itself.
 */
async function sendCatalogOpsAlert(
  log: JobLogger,
  text: string,
): Promise<'delivered' | 'failed' | 'no-webhook'> {
  return sendDelegateAlertFromEnv(text, log, 'catalog-ingestion')
}

export interface BackgroundJobsDeps {
  log: JobLogger
  /**
   * The `pg` pool, INJECTED from `index.ts` — catalog refresh needs it, and
   * `pg-only-in-infra` allows no new importer of `db.ts`.
   */
  pool: QueryableLike
}

/**
 * Build the ten rows. A function rather than a module-level constant because
 * the catalog-ingest monitor must be built ONCE per start and held across
 * every tick (#4407) — a module-level table would build it at import time,
 * before the process has a logger or a pool.
 */
export function createBackgroundJobs(deps: BackgroundJobsDeps): BackgroundJobRow[] {
  const { log, pool } = deps

  // Built ONCE, outside the tick (#4407): the monitor owns the per-host probe
  // cooldown, so building it per tick would reset the cooldown every 5
  // minutes and let a failing merchant be probed on every tick.
  const catalogIngestMonitor: CatalogIngestMonitor = createCatalogIngestMonitor()

  /**
   * The passport sweep's phase helper. The phases are INDEPENDENT: sequencing
   * them under one try/catch meant a throw in the issuance retry skipped both
   * the revocation reconciliation and the stuck-revoke alarm for that tick —
   * and since the queues are oldest-first, one poison row would be first on
   * every tick and silence the safety-critical half permanently. The alarm
   * especially must run even when everything above it is failing: that is
   * when it matters.
   */
  const phase = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      log.warn({ err, phase: name }, 'Passport sweep phase failed')
    }
  }

  return [
    {
      name: 'catalog refresh',
      intervalMs: CATALOG_REFRESH_INTERVAL_MS,
      lockKey: LEADER_LOCK_KEYS.catalogRefresh,
      failureMessage: 'Merchant catalog refresh failed',
      // Catalog price verification: probe listed merchants hourly so the
      // catalog never advertises stale prices or dead endpoints. Best-effort —
      // a failed run logs and waits for the next tick.
      run: async () => {
        // Opt-in: pull fresh candidates from the x402 Bazaar and probe-ingest
        // them before re-verifying the catalog, so newly discovered merchants are
        // included in the same run. Best-effort — discovery failure never blocks
        // the refresh of already-listed entries.
        if (config.catalogDiscoveryEnabled) {
          try {
            const discovery = await ingestDiscoveredCatalog(pool)
            log.info(discovery, 'Merchant catalog discovery complete')
          } catch (err) {
            log.warn({ err }, 'Merchant catalog discovery failed')
          }
        }
        const { verified, degraded, deferred } = await refreshCatalog()
        // #4300: `deferred` rows hit the run budget and come first next run.
        log.info({ verified, degraded, deferred }, 'Merchant catalog refreshed')
      },
    },
    {
      name: 'catalog ingest',
      intervalMs: CATALOG_INGEST_INTERVAL_MS,
      lockKey: LEADER_LOCK_KEYS.catalogIngest,
      failureMessage: 'Catalog ingestion failed',
      // Catalogue ingestion (epic #1717, #1714): walk submitted queue rows
      // through ownership proof and the SSRF-hardened verification probe, and
      // bound the table. Leader-locked like every tick here — probes must run
      // once per interval, not once per replica. Alerts are edge-triggered by
      // the lifecycle module, so a sustained condition alarms once instead of
      // on every interval.
      run: async () => {
        const report = await catalogIngestMonitor.tick()
        if (report.acted) log.info(report, 'Catalog ingestion tick')
        for (const text of report.alerts) {
          log.warn({ text }, 'Catalog ingestion alert')
        }
        // Delivery decides the re-arm (#3345): a 'failed' send (4xx/5xx or
        // network error — logged by the shared sender with the status,
        // never the URL) rolls the lifecycle edge back so the alarm
        // re-fires on the next tick while the condition persists.
        // Delivered alarms stop, edge-triggered as before; 'no-webhook' is
        // log-only mode — the warn above is the whole alert and the
        // episode counts as handled.
        await deliverCatalogAlerts(report.alerts, (text) => sendCatalogOpsAlert(log, text))
      },
    },
    {
      name: 'rate-limit sweep',
      intervalMs: RATE_LIMIT_SWEEP_INTERVAL_MS,
      lockKey: LEADER_LOCK_KEYS.rateLimitSweep,
      failureMessage: 'Rate-limit counter sweep failed',
      // Expired rate-limit counters (#1680): nothing else removes them, and the
      // table is written by UNAUTHENTICATED traffic — so without a sweep,
      // unbounded growth is reachable by anyone with a script and a supply of
      // source addresses. Leader-gated like every tick here; a missed run only
      // leaves dead rows, never a wrong count, because every read filters on
      // expiry.
      run: async () => {
        const deleted = await deleteExpiredRateLimits()
        if (deleted > 0) log.debug({ deleted }, 'Swept expired rate-limit counters')
      },
    },
    {
      name: 'feedback sweep',
      intervalMs: FEEDBACK_SWEEP_INTERVAL_MS,
      lockKey: LEADER_LOCK_KEYS.feedbackSweep,
      failureMessage: 'Feedback sweep failed',
      // Expired feedback rows (#3597): nothing else removes them. Leader-gated
      // like every tick here; a missed run only leaves dead rows, never a wrong
      // read, because every reader filters `expires_at > NOW()` itself.
      run: async () => {
        const deleted = await deleteExpiredFeedback()
        if (deleted > 0) log.debug({ deleted }, 'Swept expired feedback rows')
      },
    },
    {
      name: 'delegate balance monitor',
      intervalMs: DELEGATE_MONITOR_INTERVAL_MS,
      lockKey: LEADER_LOCK_KEYS.delegateBalanceMonitor,
      failureMessage: 'Delegate balance monitor scan failed',
      // Delegate balance monitor (#714): hourly read-only scan of every active
      // agent's delegate USDC balance — WARNs on lingering (sweepable) balances
      // and on aggregate dust past the threshold. Best-effort: a failed scan
      // logs and waits for the next tick. It never moves funds.
      run: async () => {
        await runDelegateBalanceMonitor(log)
      },
    },
    {
      name: 'relayer balance monitor',
      intervalMs: DELEGATE_MONITOR_INTERVAL_MS,
      // NO lock key, deliberately. The scan result feeds each replica's own
      // /health/ops response, and the alert edge-trigger is the per-chain
      // lowAlerted set inside the monitor, so duplicate alerts are bounded by
      // replica count only on the low→ok→low transition. The unused
      // `LEADER_LOCK_KEYS.relayerBalanceMonitor` must stay unused.
      failureMessage: 'Relayer balance monitor scan failed',
      // Relayer balance monitor: hourly read-only scan of the relayer EOA's
      // native balance per served chain — structured warning + edge-triggered
      // webhook alert below the low-water mark, cached status served by
      // /health/ops. The relayer going dry previously surfaced only as failing
      // payments.
      run: async () => {
        await runRelayerBalanceMonitor(log)
      },
    },
    {
      name: 'outbound bump',
      intervalMs: OUTBOUND_BUMP_INTERVAL_MS,
      lockKey: LEADER_LOCK_KEYS.outboundBump,
      failureMessage: 'Outbound bump tick failed',
      // Outbound-tx bump/replacement worker (#1558, epic #1554): per served
      // chain, close broadcast rows the chain has already decided, replace the
      // truly stuck ones with bumped fees, and adopt orphaned queued rows from
      // a submitter that died mid-flight. Leader-locked: replacements are
      // same-nonce broadcasts, and two replicas bumping the same lane would
      // race each other's replacements.
      run: async () => {
        const { runOutboundBumpTick, productionBumpDeps } = await import(
          './infra/outbound-bump-worker.js'
        )
        const deps = await productionBumpDeps()
        const chains = deployableChainIds()
        for (const chainId of chains) {
          const tick = await runOutboundBumpTick(chainId, deps, log)
          if (tick.bumped || tick.closedMined || tick.closedFailed || tick.rebroadcastOrphans || tick.alerted) {
            log.info({ chainId, ...tick }, 'Outbound bump tick acted')
          }
        }
      },
    },
    {
      name: 'settlement sweep',
      intervalMs: SETTLEMENT_SWEEP_INTERVAL_MS,
      lockKey: LEADER_LOCK_KEYS.settlementSweep,
      failureMessage: 'Settlement sweep tick failed',
      // Passive settlement observation for BOTH x402 schemes. On erc7710 direct
      // settlement the merchant redeems the chain and Haven submits nothing, so
      // an intent stays `submitted` until an AGENT reports the settlement hash.
      // When that report never comes — no `PAYMENT-RESPONSE` transaction, or
      // the generic plain-HTTP flow (#2041) where Haven never sees the header —
      // the payment has no evidence row and is therefore permanently absent
      // from the Fortnox feed. This tick finds such a settlement by looking its
      // intent-unique settlement child (#2094) up in the pinned
      // DelegationManager's `RedeemedDelegation` logs and completes it through
      // the same seam the agent-reported path uses.
      //
      // On the eip3009 bridge (#3888) the merchant's settlement is a second
      // transaction Haven never submits, and since #3888 its EIP-3009 nonce is
      // derived from the payment id — so a settlement the agent never reported
      // is found the same way: `AuthorizationUsed(delegate, derived nonce)` on
      // the pinned token, handed to the same verifier and the same recording
      // order (base row, verified hash, ONE feed fire) as an agent report.
      //
      // Neither pass ever guesses: attribution is only ever a chain event that
      // names this intent's own key — the manager's child redemption, the
      // token's burned authorization nonce — never transfer shape. Bounded RPC,
      // and an outage confirms nothing and waits for the next tick.
      run: async () => {
        const { runSettlementSweepTick, runEip3009SettlementSweepTick } = await import(
          './modules/x402/index.js'
        )
        // Two passes under one leader gate — the builder decision #3888
        // left open. Each with its own boundary, so a failure in one
        // cannot silence the other.
        try {
          await runSettlementSweepTick(log)
        } catch (err) {
          log.warn({ err }, 'erc7710 settlement sweep pass failed')
        }
        try {
          await runEip3009SettlementSweepTick(log)
        } catch (err) {
          log.warn({ err }, 'eip3009 settlement sweep pass failed')
        }
      },
    },
    {
      name: 'submission reconcile',
      intervalMs: RECONCILE_INTERVAL_MS,
      lockKey: LEADER_LOCK_KEYS.submissionReconcile,
      failureMessage: 'Submission reconcile tick failed',
      // Submission reconciliation (#3564). A direct payment whose UserOp was
      // SENT but whose receipt was never confirmed is booked outcome-pending
      // (`submitted`, never `failed` — the funds may have moved), with the
      // userOpHash recorded on the row. This tick resolves such a row from the
      // bundler's receipt index for that hash: landed+succeeded → confirmed
      // with its tx_hash; landed+reverted → failed with the cause; still not
      // found inside the bounded window → failed with that cause. A read
      // failure confirms nothing and writes nothing — the next tick is the
      // retry, which is what keeps an outage from becoming a wrong terminal
      // booking.
      run: async () => {
        const { runSubmissionReconcileTick } = await import('./modules/payments/index.js')
        // #4819: a reconciled confirm runs the SAME booking the sign route
        // runs, and that booking calls the machine-payment evidence hook. The
        // hook lives in the mpp module, whose barrel imports the payments
        // barrel, so it is handed in here rather than imported by the tick.
        const { tryRecordMachinePaymentEvidenceBaseById } = await import('./modules/mpp/index.js')
        const tick = await runSubmissionReconcileTick(log, {
          recordEvidence: tryRecordMachinePaymentEvidenceBaseById,
        })
        if (tick.confirmed || tick.failedReverted || tick.failedWindowElapsed) {
          log.info(tick, 'Submission reconcile tick acted')
        }
      },
    },
    {
      name: 'passport sweep',
      intervalMs: PASSPORT_SWEEP_INTERVAL_MS,
      lockKey: LEADER_LOCK_KEYS.passportSweep,
      failureMessage: 'Passport sweep failed',
      // L0 passport anchor sweep (#972 / #973). Both halves of issuance are
      // fire-and-forget by design — an EAS write must never block agent creation
      // or an owner's revoke — which only holds because something later retries
      // what the in-request attempt dropped. This is that something; without it
      // "best-effort + retryable" is just "best-effort".
      //
      // The revocation half is the one that matters for safety: an agent revoked
      // in Haven's DB whose attestation is still live on-chain is precisely the
      // divergence #973 exists to close, and a merchant checking only the chain
      // would still see it as valid. So a revoke that stays unreconciled past
      // the alarm threshold is logged as an operational incident rather than
      // retried silently forever.
      run: async () => {
        await phase('issuance', async () => {
          const issuance = await retryPendingPassports()
          if (issuance.attempted) log.info(issuance, 'Passport issuance retries')
          if (issuance.needingAttention) {
            log.warn(
              { needingAttention: issuance.needingAttention },
              'Passport issuance rows past the attention threshold — investigate, the backoff is capped',
            )
          }
        })
        // #3294: rows anchored before the fix store the staticCall-predicted
        // UID, which never existed on-chain — revocation of such a row loops
        // on `NotFound()` while the agent's REAL attestation stays live. The
        // repair re-derives each row's UID from its anchor receipt; the
        // revocation half below (and the retire's own repair gate) then
        // converges on the real credential. Batched and paced here; the
        // phase split keeps a failure here away from the safety-critical
        // revocation half, exactly as for issuance above.
        await phase('anchor-repair', async () => {
          const repairs = await repairAnchoredUids()
          if (repairs.attempted) log.info(repairs, 'Passport anchor UID repairs')
          // #3342: every row the repair could not answer is reported BY
          // AGENT — agent_id and reason — not folded into a count. These
          // are the lines an operator checks first when a row refuses to
          // converge (see docs/operations/stuck-revoke-alarm.md).
          if (repairs.unrepairable) {
            // #3395: a REPAIRED row is an answer, not a question — it left
            // the queue on the same write (its marker is stamped), so it
            // does not belong in the operator's unanswered set. Only
            // `unrepairable` and `deferred` do.
            log.warn(
              {
                unrepairable: repairs.unrepairable,
                rows: repairs.rows.filter((r) => r.outcome !== 'confirmed' && r.outcome !== 'repaired'),
              },
              'Passport anchor UID repairs left rows unanswered — investigate the reasons',
            )
          }
        })
        await phase('revocation', async () => {
          const revocations = await reconcilePendingRevocations()
          if (revocations.attempted) log.info(revocations, 'Passport revocation reconciliation')
        })
        // #1699: a re-key rotates the delegate key underneath a live
        // attestation. Its own phase, not folded into 'revocation': the two
        // queues are mutually exclusive by agent status, and folding them
        // would let a failure in one silence the other — the exact coupling
        // the phase split above exists to prevent.
        await phase('reanchor', async () => {
          const reanchors = await reconcilePendingReanchors()
          if (reanchors.attempted) log.info(reanchors, 'Passport re-anchor reconciliation')
        })
        await phase('alarm', async () => {
          const stuck = await listStuckRevocations(PASSPORT_STUCK_REVOKE_SECONDS)
          if (stuck.length > 0) {
            log.warn(
              { count: stuck.length, agents: stuck.slice(0, 10) },
              'Passport revocations unreconciled past threshold — agents revoked in Haven still hold a live attestation on-chain',
            )
          }
        })
        await phase('reanchor-alarm', async () => {
          const stuck = await listStuckReanchors(PASSPORT_STUCK_REVOKE_SECONDS)
          if (stuck.length > 0) {
            log.warn(
              { count: stuck.length, agents: stuck.slice(0, 10) },
              'Passport re-anchors unreconciled past threshold — live agents hold an attestation naming a retired delegate key',
            )
          }
        })
      },
    },
  ]
}

export interface StartBackgroundJobsOptions extends BackgroundJobsDeps {
  /** Test seam: the scheduler. Defaults to the real `startJobs`. */
  startJobs?: (rows: readonly BackgroundJobRow[], deps: JobSchedulerDeps) => void
  /** Test seam: the accounting retry sweep. Defaults to the real one. */
  startRetrySweep?: typeof startRetrySweep
}

/**
 * The one entry point `index.ts` calls: start the ten table rows, then the
 * self-registering accounting retry sweep.
 *
 * The retry sweep is called AFTER the rows, exactly as the inline wiring did,
 * and it is not a row: it registers nothing when `config.accountingEnabled` is
 * off, its interval comes from config, it has an in-process overlap guard, and
 * its leader function is injectable.
 */
export function startBackgroundJobs(opts: StartBackgroundJobsOptions): void {
  const { log, pool } = opts
  const rows = createBackgroundJobs({ log, pool })
  const start = opts.startJobs ?? startJobs
  start(rows, { log })
  const retrySweep = opts.startRetrySweep ?? startRetrySweep
  retrySweep({ log })
}
