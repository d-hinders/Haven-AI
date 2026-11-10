/**
 * The generic periodic-job scheduler (#4764).
 *
 * `index.ts` used to hand-wire ten background jobs inline, each one the same
 * outer shape: `try` / leader gate / `catch → log.warn`, then `void run()` and
 * `setInterval(run, INTERVAL).unref()`. That wiring could not be imported —
 * importing `index.ts` boots the server — so the only way to test it was to
 * regex the file's source, and that technique failed once on record (#4411: a
 * `/*` inside a line comment made the comment stripper swallow `index.ts`
 * lines 599–633).
 *
 * This module knows nothing about any job. Given a row it applies the outer
 * shape and nothing else: the leader gate when the row names a lock key, the
 * catch-and-warn with the row's own message, the immediate first run, and the
 * `unref()`ed interval. The rows themselves live in `src/background-jobs.ts`,
 * beside the composition root — their `run` bodies are orchestration that
 * imports `modules/` and `infra/`, which `platform/` must never hold
 * (`docs/architecture/10-module-boundaries.md`).
 */
import { runIfLeader } from './leader-lock.js'

/** The slice of a pino/Fastify logger the scheduler and the job table use. */
export interface JobLogger {
  debug: (obj: unknown, msg?: string) => void
  info: (obj: unknown, msg?: string) => void
  warn: (obj: unknown, msg?: string) => void
  error: (obj: unknown, msg?: string) => void
}

/**
 * One row of the background-job table.
 *
 * `lockKey` is OPTIONAL and its absence is meaningful, not an oversight: a
 * per-replica job (the relayer balance monitor) must run on every replica, so
 * it carries no key and the scheduler never calls `runIfLeader` for it.
 */
export interface BackgroundJobRow {
  /** Stable name — the table's identity, asserted by its test. */
  name: string
  /** Tick interval in milliseconds. */
  intervalMs: number
  /** Advisory-lock key (`LEADER_LOCK_KEYS.*`); omitted for a per-replica job. */
  lockKey?: number
  /** The `warn` message logged when a tick throws. */
  failureMessage: string
  /** One tick. Errors propagate to the scheduler's catch. */
  run: () => Promise<void>
}

export interface JobSchedulerDeps {
  log: JobLogger
  /** Defaults to the real `runIfLeader`; injectable for tests. */
  runIfLeader?: (lockKey: number, fn: () => Promise<void>) => Promise<boolean>
}

/**
 * Start one row: run it once now, then every `intervalMs`, `unref()`ed so the
 * timer never keeps the process alive.
 *
 * The first run is deliberately NOT awaited — it is `void tick()`, exactly as
 * the inline wiring did — so a slow first tick cannot delay `listen()`'s
 * caller or the other rows.
 */
export function startJob(row: BackgroundJobRow, deps: JobSchedulerDeps): void {
  const leader = deps.runIfLeader ?? runIfLeader
  const tick = async (): Promise<void> => {
    try {
      if (row.lockKey === undefined) {
        await row.run()
      } else {
        await leader(row.lockKey, row.run)
      }
    } catch (err) {
      deps.log.warn({ err }, row.failureMessage)
    }
  }
  void tick()
  const timer = setInterval(tick, row.intervalMs)
  timer.unref()
}

/** Start every row in the table. */
export function startJobs(rows: readonly BackgroundJobRow[], deps: JobSchedulerDeps): void {
  for (const row of rows) startJob(row, deps)
}
