import { config } from '../../config.js'
import {
  listDueRetrySyncs,
  releaseStalePending,
  markExhausted,
  RETRY_BACKOFF_CAP_MS,
  RETRY_MAX_ATTEMPTS,
  retryBackoffMs,
  type DueRetryRow,
  type Executor,
} from '../../infra/repositories/accounting-feed-syncs.js'
import { LEADER_LOCK_KEYS, runIfLeader } from '../../platform/leader-lock.js'
import { feedSettledPayment, type FeedOutcome } from './feed-orchestrator.js'
import { ProviderError } from './provider.js'
import { ACCOUNTING_EVENT } from './ops-signals.js'

/**
 * Background retry sweep for the accounting feed (#2866, epic #2858).
 *
 * Until this slice a failed push was retried only at the next settlement
 * (fire-and-forget) or when the user pressed "Sync now". The sweep is the
 * third path: every few minutes (`HAVEN_ACCOUNTING_RETRY_SWEEP_INTERVAL_MS`)
 * it selects the `failed` / `skipped` / stale-`pending` sync rows whose
 * connection is `connected` and whose backoff has elapsed, and feeds each one
 * through the SAME `feedSettledPayment` the settlement hook uses — so the
 * dedup ledger, the degraded-destination skip, the feed-from floor and the
 * FX gate all apply unchanged.
 *
 * ## The shape (review decisions, 2026-09-11)
 *
 * - **Backoff without a schema change.** A row is due when
 *   `updated_at + min(1 min · 2^(attempts−1), 1 h)` has passed
 *   (`LIST_DUE_RETRY_SYNCS_SQL`); the eighth attempt is the last
 *   (`RETRY_MAX_ATTEMPTS`). A row that exhausts them stays `failed` with its
 *   reason prefixed `exhausted:` (`EXHAUSTED_PREFIX`) — the string the
 *   dashboard keys on. A manual "Sync now" still re-claims it: the cap bounds
 *   the SWEEP, not the human.
 * - **State-skipped rows wait for the cause to go away.** The due query joins
 *   the connection and requires `connected` + active destination, so rows
 *   skipped for `needs_reauthorisation` (#2863) or behind a `scope_missing`
 *   row are untouched until the user re-consents. FX-not-ready rows retry
 *   normally — the orchestrator no-ops before claiming, no attempt consumed.
 * - **One connection at a time, under Fortnox's floor.** Rows are grouped by
 *   (user, provider) and the groups are walked serially; inside a group a
 *   `RequestPacer` enforces the documented 25 requests / 5 s per tenant as a
 *   FIXED floor, budgeting `REQUESTS_PER_PUSH` for each push (supplier
 *   lookup + create, invoice, two attachment calls, merchant receipts — the
 *   sweep cannot count the connector's requests, so it assumes the worst
 *   case). Fortnox sends its 429 WITHOUT `Retry-After`; when a provider does
 *   send one (`retryAfterMs` on the error) it is honoured as a courtesy via
 *   `deferredUntil`, never depended on.
 * - **A 429 defers the whole connection.** The row that hit it is recorded
 *   by the orchestrator like any failure; every REMAINING row of that
 *   connection is left exactly as it was — no claim, no `attempts + 1` — and
 *   comes back on the next tick.
 * - **Inert when the feed is off.** `config.accountingEnabled === false`
 *   means no interval is registered and `runRetrySweep` returns without a
 *   query. Leader-locked like its siblings so a multi-replica deployment
 *   runs one sweep per tick; a tick that is still running when the next one
 *   fires is skipped in-process.
 * - **Structured log events (#2872).** One line per run,
 *   `accounting.sweep.run`, carrying the counters below (`info` when anything
 *   was considered, `debug` when idle); and one `accounting.sync.exhausted`
 *   line at `warn` for every row that takes the terminal reason — the
 *   signal on-call alerts on (thresholds in
 *   `docs/operations/accounting-feed.md`). A tick that throws outside a run
 *   (leader election, an unhandled error) logs `accounting.sweep.failed` at
 *   `warn`. All carry `event` so a single grep finds them alongside
 *   `accounting.connection.needs_attention`.
 */

/** Terminal reason prefix on a row the sweep gave up on. */
export const EXHAUSTED_PREFIX = 'exhausted:'

/** Fortnox's documented limit per client-id + tenant — the fixed floor. */
export const PROVIDER_RATE_LIMIT = { requests: 25, windowMs: 5_000 } as const

/**
 * Worst-case provider requests one push makes: token refresh, supplier
 * search, supplier create, invoice, evidence upload + connect, merchant
 * receipt upload + connect. Three pushes fit one window with this budget.
 */
export const REQUESTS_PER_PUSH = 8

/** Rows fetched per tick — bounds a run to a few minutes even at the floor. */
export const RETRY_SWEEP_BATCH = 200

export { RETRY_MAX_ATTEMPTS, retryBackoffMs }

export interface RetrySweepResult {
  /** Due rows fetched this run. */
  considered: number
  pushed: number
  /** Retried and failed again, still under the cap. */
  failed: number
  /** Left untouched because their connection hit a 429 (or a Retry-After is pending). */
  deferred: number
  /** Retried and now at the cap — terminal, `exhausted:` reason written. */
  exhausted: number
  /** Retried and skipped by the connector, or no-op (FX not ready, row owned elsewhere). */
  skipped: number
  /** Distinct (user, provider) groups seen. */
  connections: number
  /** Groups that hit a 429 this run. */
  rateLimited: number
}

export interface RetrySweepLogger {
  info: (obj: Record<string, unknown>, msg: string) => void
  debug: (obj: Record<string, unknown>, msg: string) => void
  warn: (obj: Record<string, unknown>, msg: string) => void
}

export interface RetrySweepDeps {
  db?: Executor
  /** The sweep's clock; injected by tests so backoff is never waited for. */
  now?: () => Date
  log?: RetrySweepLogger
  /** The pacer's wait; injected by tests as a recorder. */
  sleep?: (ms: number) => Promise<void>
  /** The per-row feed; defaults to the orchestrator's. */
  feed?: (userId: string, paymentId: string) => Promise<FeedOutcome>
}

const silentLog: RetrySweepLogger = { info: () => {}, debug: () => {}, warn: () => {} }
const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * A fixed-window budget for one tenant: `requests` per `windowMs`. `acquire`
 * charges one push and waits for the window to roll over when the budget is
 * spent. Deliberately not a token bucket — the floor is a hard shape, not an
 * average, and Fortnox counts a fixed window.
 */
export class RequestPacer {
  private windowStart: number
  private used = 0

  constructor(
    private readonly now: () => number,
    private readonly sleep: (ms: number) => Promise<void>,
    private readonly limit: { requests: number; windowMs: number } = PROVIDER_RATE_LIMIT,
    private readonly perPush = REQUESTS_PER_PUSH,
  ) {
    this.windowStart = now()
  }

  async acquire(): Promise<void> {
    const t = this.now()
    if (t - this.windowStart >= this.limit.windowMs) {
      this.windowStart = t
      this.used = 0
    }
    if (this.used + this.perPush > this.limit.requests) {
      const wait = this.windowStart + this.limit.windowMs - t
      if (wait > 0) await this.sleep(wait)
      this.windowStart = this.now()
      this.used = 0
    }
    this.used += this.perPush
  }
}

/** A provider 429 — `ProviderError.status` carries the HTTP status. */
export function isRateLimited(err: unknown): boolean {
  return err instanceof ProviderError && err.status === 429
}

/**
 * `Retry-After`, when a provider sends one, as ms — read off the error as an
 * optional `retryAfterMs`. Fortnox sends none, so this is usually undefined.
 */
function retryAfterMs(err: unknown): number | undefined {
  const v = (err as { retryAfterMs?: unknown } | null)?.retryAfterMs
  // Clamped to the backoff cap: a courtesy, never a lever — a provider (or a
  // bug) sending `Retry-After: 99999999` must not park a connection until
  // the process restarts (review on #2899).
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(v, RETRY_BACKOFF_CAP_MS) : undefined
}

/** Courtesy deferrals keyed by connection — in-process, best-effort. */
const deferredUntil = new Map<string, number>()
let running = false

/** For tests — forget deferrals and the in-flight flag between cases. */
export function resetRetrySweepState(): void {
  deferredUntil.clear()
  running = false
}

function groupKey(row: DueRetryRow): string {
  return `${row.user_id}\u0000${row.provider}`
}

function emptyResult(): RetrySweepResult {
  return { considered: 0, pushed: 0, failed: 0, deferred: 0, exhausted: 0, skipped: 0, connections: 0, rateLimited: 0 }
}

/**
 * One sweep. Safe to call directly (tests, an operator script); the interval
 * in `startRetrySweep` is the production caller.
 */
export async function runRetrySweep(deps: RetrySweepDeps = {}): Promise<RetrySweepResult> {
  const result = emptyResult()
  // MUTATION TARGET (retry-sweep.test.ts "inert when the flag is off"): the
  // sweep must not even query with the feed dark.
  if (!config.accountingEnabled) return result
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? silentLog
  const sleep = deps.sleep ?? realSleep
  const feed = deps.feed ?? feedSettledPayment

  const rows = await listDueRetrySyncs(now(), RETRY_SWEEP_BATCH, deps.db)
  result.considered = rows.length

  // Group by connection, preserving the query's order (oldest row first).
  const groups = new Map<string, DueRetryRow[]>()
  for (const row of rows) {
    const key = groupKey(row)
    const list = groups.get(key)
    if (list) list.push(row)
    else groups.set(key, [row])
  }
  result.connections = groups.size

  for (const [key, group] of groups) {
    const until = deferredUntil.get(key)
    if (until !== undefined) {
      if (until > now().getTime()) {
        result.deferred += group.length
        continue
      }
      deferredUntil.delete(key)
    }
    // One pacer per tenant: the floor is per client-id + tenant, and groups
    // run serially, so nothing else is spending this tenant's budget here.
    const pacer = new RequestPacer(() => now().getTime(), sleep)
    for (let i = 0; i < group.length; i++) {
      const row = group[i]
      if (row.status === 'pending') {
        // A claim whose owner died: release it (attempts untouched) so the
        // orchestrator's re-claim below can take it. If it is no longer a
        // stale pending — the owner finished after all — leave it alone.
        const released = await releaseStalePending(
          row.id,
          now(),
          'stale pending claim released by the retry sweep',
          deps.db,
        )
        if (!released) {
          result.skipped += 1
          continue
        }
      }
      await pacer.acquire()
      const outcome = await feed(row.user_id, row.payment_id)
      // The re-claim inside `feed` incremented `attempts`; this is the number
      // the row now carries when it was claimed.
      const attemptsNow = row.attempts + 1
      if (outcome.outcome === 'pushed') {
        result.pushed += 1
      } else if (outcome.outcome === 'not_fed') {
        result.skipped += 1
      } else if (outcome.outcome === 'failed' && isRateLimited(outcome.error)) {
        // MUTATION TARGET (retry-sweep.db.test.ts "a 429 defers"): the rest
        // of this connection must be left untouched — no claim, no attempt.
        // The row that hit the limit made a real request and is counted as
        // a failure (the orchestrator recorded it); the others are deferred.
        result.failed += 1
        result.rateLimited += 1
        result.deferred += group.length - i - 1
        const courtesy = retryAfterMs(outcome.error)
        if (courtesy !== undefined) deferredUntil.set(key, now().getTime() + courtesy)
        break
      } else if (attemptsNow >= RETRY_MAX_ATTEMPTS) {
        // MUTATION TARGET (retry-sweep.db.test.ts "at the cap"): the terminal
        // reason is what the dashboard keys on.
        const reason = outcome.outcome === 'failed' ? outcome.reason : `skipped: ${outcome.reason}`
        // Guarded: only a row that is still failed/skipped at the cap takes
        // the terminal reason. A manual sync that re-claimed (pending) or
        // pushed it in between is left alone (review on #2899).
        const written = await markExhausted(row.user_id, row.provider, row.payment_id, `${EXHAUSTED_PREFIX} ${reason}`, deps.db)
        result.exhausted += 1
        // MUTATION TARGET (retry-sweep.test.ts "accounting.sync.exhausted"):
        // the terminal reason is what on-call alerts on; a row given up on
        // silently is a payment nobody re-feeds. Only a row that actually
        // took the reason is announced (the guard above may have found it
        // re-claimed or pushed in the meantime).
        if (written) {
          log.warn(
            {
              event: ACCOUNTING_EVENT.syncExhausted,
              userId: row.user_id,
              provider: row.provider,
              paymentId: row.payment_id,
              attempts: attemptsNow,
              reason,
            },
            ACCOUNTING_EVENT.syncExhausted,
          )
        }
      } else if (outcome.outcome === 'failed') {
        result.failed += 1
      } else {
        result.skipped += 1
      }
    }
  }

  const line = { event: ACCOUNTING_EVENT.sweepRun, ...result }
  if (result.considered > 0) log.info(line, ACCOUNTING_EVENT.sweepRun)
  else log.debug(line, ACCOUNTING_EVENT.sweepRun)
  return result
}

export interface StartRetrySweepOptions {
  log: RetrySweepLogger
  /** Leader election; defaults to `runIfLeader` on the sweep's own key. */
  leader?: (fn: () => Promise<void>) => Promise<boolean>
  intervalMs?: number
}

/**
 * Register the interval — the `index.ts` call. Returns the timer (already
 * `unref()`ed, so it never keeps the process alive) or null when the feed is
 * off and nothing was registered. The first tick runs immediately, like the
 * sibling monitors.
 */
export function startRetrySweep(opts: StartRetrySweepOptions): NodeJS.Timeout | null {
  // MUTATION TARGET (retry-sweep.test.ts "skipped when the flag is off").
  if (!config.accountingEnabled) return null
  const leader = opts.leader ?? ((fn: () => Promise<void>) => runIfLeader(LEADER_LOCK_KEYS.accountingRetrySweep, fn))
  const tick = async () => {
    if (running) return
    running = true
    try {
      await leader(async () => {
        await runRetrySweep({ log: opts.log })
      })
    } catch (err) {
      opts.log.warn({ event: ACCOUNTING_EVENT.sweepFailed, err }, 'Accounting retry sweep failed')
    } finally {
      running = false
    }
  }
  void tick()
  const timer = setInterval(tick, opts.intervalMs ?? config.accountingRetrySweepIntervalMs)
  timer.unref()
  return timer
}
