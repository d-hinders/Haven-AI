/**
 * Catalogue ingestion lifecycle — the leader-locked tick that turns queued
 * claims into a bounded, self-healing directory (epic #1717, #1714).
 *
 * The submission slice (#1711) only writes rows, and the modules it depends
 * on are deliberately inert until someone drives them: `ownership.ts` takes a
 * claim and returns a verdict, `probe.ts` takes candidates and returns
 * outcomes. This module is the driver. One tick runs, in order:
 *
 *   1. **Ownership** — for every `submitted` row, ask `verifyDomainOwnership`.
 *      Success moves the row to `ownership_verified` and resets the failure
 *      streak; any non-expiry failure leaves it `submitted` to be retried on
 *      later ticks (verification is idempotent within the token lifetime,
 *      see ownership.ts). A token past its TTL is failed, which is what
 *      bounds how long a "submitted forever" row can occupy the pending cap.
 *   2. **Probe** — `ownership_verified` rows, plus `verified_payable` rows
 *      whose last success is older than the re-verification cadence, go
 *      through `runProbeBatch` under the shared per-hostname cooldown (a
 *      merchant is never hammered). Success persiss the pointer metadata
 *      (`name`/`description`/`entrypoint`). Failure increments the
 *      consecutive-failure streak; at the threshold the row degrades to
 *      `failed` — for a never-verified candidate that is the end of its
 *      life, for a previously-verified entry it is the "stale entries
 *      degrade to failed" acceptance criterion.
 *   3. **Purge** — terminal rows (`failed`, `delisted`) whose retention
 *      anchor predates the TTL are deleted. Together with the per-hostname
 *      pending uniqueness of migration 066 this is what makes table growth
 *      provably bounded under repeated failed submissions.
 *   4. **Alarm** — submitted rows that have not moved (`created_at` older
 *      than the stuck threshold) and mass-failure in one tick produce ops
 *      signals instead of silent churn. Edge-triggered per process so an
 *      ongoing condition alarms once, not every tick.
 *
 * ## Fail-closed posture
 *
 * If `CATALOG_OWNERSHIP_SECRET` is unset (config default `''`), the
 * ownership stage cannot verify anything. Rather than let rows churn toward
 * `failed` on a configuration error, the tick skips the ownership stage and
 * the stuck alarm fires on the accumulating `submitted` rows — the correct
 * operational signal for a misconfigured deployment, not a data-purging one.
 *
 * ## Money-path
 *
 * None. This module signs nothing, pays nothing, and touches no payment or
 * authority surface; the probe is quote-only by construction (probe.ts) and
 * ownership proof makes no outbound request for a configuration failure.
 */
import { config } from '../../config.js'
// dep-lint-exempt: pool appears only as the DEFAULT of the injectable Executor (index.ts and the real-DB tests inject their own); the lifecycle module otherwise runs against an injected db and makes no direct pool usage — same shape as the sibling merchant-catalog.ts exemption
import pool from '../../db.js'
import type { Executor } from '../../infra/transaction.js'
import * as repo from '../../infra/repositories/catalog-submissions.js'
import { isTokenExpired, verifyDomainOwnership, type OwnershipClaim, type OwnershipDeps } from './ownership.js'
import {
  HostCooldown,
  runProbeBatch,
  type GuardedPost,
  type ProbeCandidate,
} from './probe.js'

/** Re-probe a verified entry when its last success is older than this. */
export const REVERIFY_CADENCE_MS = 24 * 60 * 60 * 1000
/** Consecutive probe failures before a row degrades to `failed`. */
export const FAIL_AFTER_CONSECUTIVE_FAILURES = 3
/** Terminal rows are purged after this long in `failed`/`delisted`. */
export const RETENTION_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** A `submitted` row that has not moved in this long is stuck (ops alarm). */
export const STUCK_AFTER_MS = 48 * 60 * 60 * 1000
/** Failures in a single tick this large enter the mass-failure alarm text. */
export const MASS_FAILURE_THRESHOLD = 20
/** Probes in flight across the whole tick (probe.ts default, kept visible). */
export const MAX_PROBE_CONCURRENCY = 4

export interface CatalogIngestTickResult {
  ownershipVerified: number
  ownershipExpired: number
  probedVerified: number
  probedFailed: number
  /** Previously-verified entries that degraded to `failed` this tick. */
  degraded: number
  skippedCooldown: number
  purged: number
  /** Submitted rows older than the stuck threshold (edges to an alarm). */
  stuckSubmitted: number
  /** Fresh ops signals from this tick — empty unless an edge fired. */
  alerts: string[]
  acted: boolean
}

export type { GuardedPost }

export interface CatalogIngestDeps {
  /** Defaults to the app pool — inject a fake for module tests. */
  db?: Executor
  /** Defaults to `config.catalogOwnershipSecret`. */
  verifySecret?: string
  fetchText?: OwnershipDeps['fetchText']
  resolveTxt?: OwnershipDeps['resolveTxt']
  post?: GuardedPost
  now?: () => Date
  ttlMs?: number
  /** Shared across ticks by the caller so cooldown survives between runs. */
  cooldown?: HostCooldown
  maxConcurrency?: number
  cadenceMs?: number
  failAfter?: number
  retentionMs?: number
  stuckAfterMs?: number
  massFailureThreshold?: number
}

const zero = (): Omit<CatalogIngestTickResult, 'alerts' | 'acted'> => ({
  ownershipVerified: 0,
  ownershipExpired: 0,
  probedVerified: 0,
  probedFailed: 0,
  degraded: 0,
  skippedCooldown: 0,
  purged: 0,
  stuckSubmitted: 0,
})

export async function runCatalogIngestTick(deps: CatalogIngestDeps = {}): Promise<CatalogIngestTickResult> {
  const db = deps.db ?? pool
  const now = deps.now ?? (() => new Date())
  const report = { ...zero(), alerts: [] as string[], acted: false }
  const secret = deps.verifySecret ?? config.catalogOwnershipSecret

  const ownership = await runOwnershipStage(secret, { ...deps, db, now })
  report.ownershipVerified += ownership.verified
  report.ownershipExpired += ownership.expired

  const probe = await runProbeStage({ ...deps, db, now })
  report.probedVerified += probe.verified
  report.probedFailed += probe.failed
  report.degraded += probe.degraded
  report.skippedCooldown += probe.skipped

  report.purged = await runPurgeStage({ ...deps, db, now })

  report.stuckSubmitted = await repo.countStuckCatalogSubmissions(
    new Date(now().getTime() - (deps.stuckAfterMs ?? STUCK_AFTER_MS)),
    db,
  )

  const failuresThisTick = report.probedFailed + report.ownershipExpired
  report.alerts = catalogAlerts({
    stuckSubmitted: report.stuckSubmitted,
    failuresThisTick,
    massFailureThreshold: deps.massFailureThreshold ?? MASS_FAILURE_THRESHOLD,
    now: now(),
  })

  report.acted =
    report.ownershipVerified > 0 ||
    report.ownershipExpired > 0 ||
    report.probedVerified > 0 ||
    report.probedFailed > 0 ||
    report.degraded > 0 ||
    report.skippedCooldown > 0 ||
    report.purged > 0 ||
    report.alerts.length > 0

  return report
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

async function runOwnershipStage(
  secret: string,
  deps: CatalogIngestDeps & { db: Executor; now: () => Date },
): Promise<{ verified: number; expired: number }> {
  const db = deps.db
  const ttlMs = deps.ttlMs

  // Fail closed on a missing secret: no verification is possible, and failing
  // rows for it would purge a misconfiguration's victims. The stuck alarm
  // names the condition instead.
  if (secret === '') return { verified: 0, expired: 0 }

  const rows = await repo.listSubmittedCatalogSubmissions(db)
  if (rows.length === 0) return { verified: 0, expired: 0 }

  let verified = 0
  let expired = 0
  for (const row of rows) {
    const claim: OwnershipClaim = {
      submissionId: row.id,
      hostname: row.hostname,
      verifyToken: row.verify_token,
      tokenIssuedAt: new Date(row.created_at),
    }
    const at = deps.now()
    if (isTokenExpired(claim, at, ttlMs)) {
      await repo.markCatalogSubmissionFailed(row.id, db)
      expired += 1
      continue
    }
    const result = await verifyDomainOwnership(claim, secret, {
      fetchText: deps.fetchText,
      resolveTxt: deps.resolveTxt,
      now: deps.now(),
      ttlMs,
    })
    if (result.ok) {
      if (await repo.markCatalogSubmissionOwnershipVerified(row.id, db)) verified += 1
    }
    // Any other outcome leaves the row `submitted` for the next tick. The
    // token TTL bounds retries; per-tick network blips must not kill a claim.
  }
  return { verified, expired }
}

async function runProbeStage(
  deps: CatalogIngestDeps & { db: Executor; now: () => Date },
): Promise<{ verified: number; failed: number; degraded: number; skipped: number }> {
  const db = deps.db
  const failAfter = deps.failAfter ?? FAIL_AFTER_CONSECUTIVE_FAILURES
  const cadenceMs = deps.cadenceMs ?? REVERIFY_CADENCE_MS

  const candidates: ProbeCandidate[] = [
    ...(await repo.listOwnershipVerifiedCatalogSubmissions(db)).map((r) => ({
      id: r.id,
      resourceUrl: r.resource_url,
    })),
    ...(await repo.listVerifiedCatalogSubmissionsDueForRecheck(
      new Date(deps.now().getTime() - cadenceMs),
      db,
    )).map((r) => ({ id: r.id, resourceUrl: r.resource_url })),
  ]
  if (candidates.length === 0) return { verified: 0, failed: 0, degraded: 0, skipped: 0 }

  const outcomes = await runProbeBatch(candidates, {
    cooldown: deps.cooldown,
    post: deps.post,
    now: deps.now,
    maxConcurrency: deps.maxConcurrency ?? MAX_PROBE_CONCURRENCY,
  })

  let verified = 0
  let failed = 0
  let degraded = 0
  let skipped = 0
  for (const outcome of outcomes) {
    if (outcome.status === 'verified_payable') {
      if (
        await repo.markCatalogSubmissionVerifiedPayable(
          outcome.id,
          { name: outcome.metadata.name, description: outcome.metadata.description, entrypoint: outcome.metadata.entrypoint },
          db,
        )
      ) {
        verified += 1
      }
      continue
    }
    if (outcome.status === 'skipped') {
      skipped += 1
      continue
    }
    // failed
    const tally = await repo.incrementCatalogSubmissionFailures(outcome.id, db)
    if (tally === null) continue // row vanished between list and write
    if (tally.streak >= failAfter) {
      if (await repo.markCatalogSubmissionFailed(outcome.id, db)) {
        failed += 1
        if (tally.status === 'verified_payable') degraded += 1
      }
    }
  }
  return { verified, failed, degraded, skipped }
}

async function runPurgeStage(
  deps: CatalogIngestDeps & { db: Executor; now: () => Date },
): Promise<number> {
  const cutoff = new Date(deps.now().getTime() - (deps.retentionMs ?? RETENTION_TTL_MS))
  return repo.deleteTerminalCatalogSubmissionsBefore(cutoff, deps.db)
}

// ---------------------------------------------------------------------------
// Ops alarms — edge-triggered per process (#1714)
// ---------------------------------------------------------------------------

interface CatalogAlertInput {
  stuckSubmitted: number
  failuresThisTick: number
  massFailureThreshold: number
  now: Date
}

/**
 * Edge-triggered per process, mirroring the delegate/relayer monitors: an
 * ongoing condition fires an alert once (on the 0 -> N edge) instead of on
 * every tick. A leader replica holds steady state; the leader lock means one
 * replica owns the alert channel per tick.
 */
const catalogAlertState: { stuckActive: boolean; massFailureActive: boolean } = {
  stuckActive: false,
  massFailureActive: false,
}

export function resetCatalogAlertStateForTests(): void {
  catalogAlertState.stuckActive = false
  catalogAlertState.massFailureActive = false
}

export function catalogAlerts(input: CatalogAlertInput): string[] {
  const alerts: string[] = []
  if (input.stuckSubmitted > 0 && !catalogAlertState.stuckActive) {
    catalogAlertState.stuckActive = true
    alerts.push(
      `Catalog ingestion: ${input.stuckSubmitted} submission(s) stuck in 'submitted' past 48h — check CATALOG_OWNERSHIP_SECRET and the ownership-proof flow.`,
    )
  } else if (input.stuckSubmitted === 0) {
    catalogAlertState.stuckActive = false
  }
  if (input.failuresThisTick >= input.massFailureThreshold && !catalogAlertState.massFailureActive) {
    catalogAlertState.massFailureActive = true
    alerts.push(
      `Catalog ingestion: ${input.failuresThisTick} submission(s) failed this tick (mass-failure threshold ${input.massFailureThreshold}) — probe or ownership verification is likely misbehaving.`,
    )
  } else if (input.failuresThisTick < input.massFailureThreshold) {
    catalogAlertState.massFailureActive = false
  }
  return alerts
}
