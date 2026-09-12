import {
  NEEDS_ATTENTION_STATUSES,
  countConnectionsNeedingAttention,
  setStatus,
  type ConnectionStatus,
  type Executor,
} from '../../infra/repositories/accounting-connections.js'
import { countExhaustedSyncs } from '../../infra/repositories/accounting-feed-syncs.js'

/**
 * Operations signals for the accounting feed (#2872, epic #2858): the three
 * structured log events on-call greps for and the two counters `/health/ops`
 * exposes. Nothing here decides anything — it is what the module SAYS about
 * what it did.
 *
 * ## The three events
 *
 * | event | when | shape (besides `event`) |
 * |---|---|---|
 * | `accounting.sweep.run` | once per retry-sweep tick (`retry-sweep.ts`) | the `RetrySweepResult` counters |
 * | `accounting.sync.exhausted` | the sweep writes a row's terminal `exhausted:` reason | `userId`, `provider`, `paymentId`, `attempts`, `reason` |
 * | `accounting.connection.needs_attention` | a connection flips to a state only a re-consent resolves (`NEEDS_ATTENTION_STATUSES`) | `userId`, `provider`, `status`, `reason` |
 *
 * `reason` is the provider's error message as the ledger stores it — never
 * token material (the OAuth flow writes the error CODE, `oauth-flow.ts`).
 * Every line carries `event` so one grep (`"event":"accounting.`) finds all
 * of them whichever transport wrote it: the sweep writes through the app
 * logger it is given at boot, this file through `OpsEventSink`, which
 * `index.ts` points at the same logger and which defaults to `console` so a
 * flow that runs without the app (a script, a test) still says what it did.
 *
 * ## Why `flagConnectionStatus` and not the repository's `setStatus`
 *
 * Every write of a degraded status goes through here (the orchestrator's
 * pre-/post-push findings, the OAuth flow's refused refresh and scope
 * shortfall, the company read refused for scope) so the event cannot be
 * forgotten at a new call site — the repository function stays the one SQL
 * statement and this is the one place that says "a human has to act now".
 */

export const ACCOUNTING_EVENT = {
  sweepRun: 'accounting.sweep.run',
  syncExhausted: 'accounting.sync.exhausted',
  connectionNeedsAttention: 'accounting.connection.needs_attention',
} as const

export type OpsEventLevel = 'info' | 'warn'
export type OpsEvent = { event: string } & Record<string, unknown>
export type OpsEventSink = (level: OpsEventLevel, event: OpsEvent) => void

const consoleSink: OpsEventSink = (level, event) => {
  const line = JSON.stringify(event)
  if (level === 'warn') console.warn(line)
  else console.info(line)
}

let sink: OpsEventSink = consoleSink

/** `index.ts` routes the events into the app logger; tests capture them. `null` restores the console default. */
export function setOpsEventSink(next: OpsEventSink | null): void {
  sink = next ?? consoleSink
}

export function emitOpsEvent(level: OpsEventLevel, event: OpsEvent): void {
  sink(level, event)
}

export function needsAttention(status: ConnectionStatus): boolean {
  return (NEEDS_ATTENTION_STATUSES as readonly string[]).includes(status)
}

/**
 * Write a connection status and, when it is one only the user can resolve,
 * say so. The write comes FIRST, so a failed statement emits nothing. One
 * honest limit: the refused-refresh flip in `oauth-flow.ts` writes on the
 * refresh lock's transaction and the event fires before that transaction
 * commits — the `dead` outcome is a return, not a throw, so the commit
 * follows immediately, but a crash in between leaves one event without a
 * row. On-call reads the row, not the event (runbook: the SQL is next to
 * each state), so the worst case is a grep hit with nothing behind it.
 */
export async function flagConnectionStatus(
  userId: string,
  provider: string,
  status: ConnectionStatus,
  reason: string | null,
  db?: Executor,
): Promise<void> {
  // The executor is forwarded only when given, so the repository's default (the pool) applies otherwise.
  await (db ? setStatus(userId, provider, status, reason, db) : setStatus(userId, provider, status, reason))
  // MUTATION TARGET (feed-orchestrator.test.ts "needs_attention event"):
  // without this emit a degraded connection is a dashboard-only fact.
  if (needsAttention(status)) {
    emitOpsEvent('warn', { event: ACCOUNTING_EVENT.connectionNeedsAttention, userId, provider, status, reason })
  }
}

export interface AccountingOpsCounters {
  /** `failed` sync rows at the retry cap — the sweep has given up; a human presses Sync now after fixing the cause. */
  exhaustedSyncs: number
  /** Connections in `needs_reauthorisation` / `scope_missing` / `revoked_at_provider` — only a re-consent resolves them. */
  connectionsNeedingAttention: number
}

/** The two `/health/ops` numbers — one aggregate query each, no per-user data. */
export async function getAccountingOpsCounters(db?: Executor): Promise<AccountingOpsCounters> {
  const [exhaustedSyncs, connectionsNeedingAttention] = await Promise.all([
    countExhaustedSyncs(db),
    countConnectionsNeedingAttention(db),
  ])
  return { exhaustedSyncs, connectionsNeedingAttention }
}
