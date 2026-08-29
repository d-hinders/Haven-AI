/**
 * Postgres advisory locks: leader election for periodic ticks, and keyed
 * mutual exclusion for work that must happen once across replicas.
 *
 * Two mechanisms with OPPOSITE waiting behaviour, which is the thing to know
 * before reaching for one. `runIfLeader` is non-blocking — a monitor tick
 * that loses should be skipped, not queued. `withKeyedAdvisoryLock` (#1673)
 * blocks — a caller that loses still needs an answer, so it waits and then
 * re-checks what the winner did.
 *
 * Leader election for periodic monitor ticks.
 *
 * Every backend replica starts the same in-process `setInterval` monitors
 * (catalog refresh, delegate balance, schedule renewal, relayer balance), so
 * a multi-instance deployment runs every scan N times and — because the
 * edge-trigger alert state is per-process memory — sends up to N copies of
 * each webhook alert. Wrapping a tick in `runIfLeader` makes exactly one
 * replica execute it: `pg_try_advisory_lock` is non-blocking, so the losers
 * skip the tick instead of queueing behind the winner.
 *
 * The lock is session-scoped, so acquire and release MUST happen on the same
 * pooled connection — that is why this checks out a dedicated client rather
 * than using `pool.query` (which may run the two statements on different
 * connections, leaking the lock).
 */

import { createHash } from 'node:crypto'
// dep-lint-exempt: pg advisory locks are session-scoped, so the lock must acquire and hold ONE dedicated connection (pool.connect) for its whole lease — connection lifecycle management, not repository SQL
import pool from '../db.js'

/**
 * One stable key per monitor. Advisory locks share a global 64-bit keyspace
 * with anything else in the database, so keep these grouped under an
 * arbitrary but distinctive prefix (81100x) and never reuse a value.
 *
 * **The keyspace is shared with keys that are not in this object**, and "never
 * reuse a value" is only checkable if they are findable. The others in use
 * (#2150):
 *
 * - `811000061` — the real-DB test harness's migration lock
 *   (`infra/__tests__/helpers/db-harness.ts`), which serialises whole
 *   `runMigrations()` calls across vitest workers;
 * - `21500001` — `NON_TRANSACTIONAL_LOCK_KEY` (`db/migrate.ts`), which
 *   serialises the migration runner's non-transactional lane across replicas;
 * - `811000062` — a test-only scratch key
 *   (`infra/__tests__/db-harness-lock-concurrency.test.ts`, #2198), which parks
 *   a waiter on a held lock and deliberately provokes a `40P01` without
 *   touching the real harness key.
 *
 * Neither belongs in this object — this one is the *monitor* lease registry and
 * both of those are boot/test-time — but a new key anywhere should be checked
 * against this list, not only against grep.
 */
export const LEADER_LOCK_KEYS = {
  catalogRefresh: 811001,
  delegateBalanceMonitor: 811002,
  relayerBalanceMonitor: 811004,
  /** L0 passport anchor sweep — issuance retries + revocation reconciliation (#973). */
  passportSweep: 811005,
  /** Outbound-tx bump/replacement worker (#1558, epic #1554). */
  outboundBump: 811006,
  /** Expired rate-limit counter sweep (#1680). */
  rateLimitSweep: 811007,
  /**
   * Catalogue ingestion probe — verification of self-submitted merchant
   * endpoints (#1713, epic #1717). Deliberately its OWN key rather than
   * sharing `catalogRefresh`: refresh re-prices an operator-curated catalogue
   * on a fast cadence, ingest probes attacker-supplied URLs on a slow one, and
   * a shared key would let either starve the other's tick for reasons that
   * have nothing to do with the other's work.
   *
   * 811003 is skipped on purpose — it belonged to the schedule-renewal monitor
   * retired with the session rail (#834), and this block's rule is never to
   * reuse a value, not merely to avoid live ones.
   */
  catalogIngest: 811008,
  /**
   * Passive erc7710 settlement observation (#2117) — completes `submitted`
   * delegation-rail x402 intents whose settlement hash nobody reported.
   * Leader-gated because every replica would otherwise run the same bounded
   * `eth_getLogs` scan, and the RPC cost is the expensive part; correctness
   * does not depend on it (the confirm is a CAS serialized per hash).
   */
  settlementSweep: 811009,
} as const

/**
 * Namespace for KEYED advisory locks — the two-argument
 * `pg_advisory_lock(int4, int4)` form, where the first argument separates
 * namespaces and the second identifies the subject inside one. Distinct from
 * the single-argument keyspace above so a hashed subject id can never collide
 * with a monitor's lock.
 */
export const KEYED_LOCK_NAMESPACES = {
  /** One counterfactual account deploy at a time, per (chain, address) (#1673). */
  accountDeploy: 811100,
  /**
   * Serialises the catalogue-submission queue cap, so the ceiling is enforced
   * by mutual exclusion rather than a check-then-act (#1711, epic #1717).
   */
  catalogSubmissionQueue: 811101,
} as const

export interface QueryableClientLike {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>
  /** pg semantics: a truthy argument destroys the connection instead of pooling it. */
  release: (destroy?: boolean) => void
}

export interface PoolLike {
  connect: () => Promise<QueryableClientLike>
}

/**
 * Run `fn` only if this replica wins the advisory lock for `lockKey`.
 * Returns true when `fn` ran (we were the leader), false when another
 * replica held the lock and the tick was skipped. Errors from `fn`
 * propagate after the lock is released.
 */
export async function runIfLeader(
  lockKey: number,
  fn: () => Promise<void>,
  db: PoolLike = pool as unknown as PoolLike,
): Promise<boolean> {
  const client = await db.connect()
  let destroyConnection = false
  try {
    const result = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [lockKey])
    if (result.rows[0]?.locked !== true) {
      return false
    }
    try {
      await fn()
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [lockKey])
      } catch {
        // The session still holds the lock; pooling the connection again
        // would leak leadership onto an idle-but-held session and leave the
        // monitor leaderless cluster-wide. Destroy the connection instead —
        // Postgres frees session advisory locks on disconnect. (A hard crash
        // mid-tick is safe for the same reason.)
        destroyConnection = true
      }
    }
    return true
  } finally {
    client.release(destroyConnection || undefined)
  }
}

/**
 * A stable signed 32-bit id for an arbitrary subject string.
 *
 * Postgres advisory-lock arguments are `int4`, so the subject has to be
 * hashed into that range. A collision would only ever mean two unrelated
 * accounts serialise against each other for a few seconds — no correctness
 * loss, since the lock is an optimisation over a check-then-act that is
 * already safe-but-wasteful when it races.
 */
export function advisoryLockIdFor(subject: string): number {
  const digest = createHash('sha256').update(subject).digest()
  // Signed, because int4 is; readInt32BE gives exactly that range.
  return digest.readInt32BE(0)
}

/**
 * Run `fn` while holding a keyed advisory lock, so concurrent callers across
 * REPLICAS serialise rather than racing (#1673).
 *
 * Blocking, unlike `runIfLeader` — and the difference is the whole point. A
 * monitor tick that loses the race should be skipped; a caller that loses the
 * race here must WAIT and then observe what the winner did, because its own
 * caller still needs an answer. Callers therefore re-check the condition they
 * locked for after acquiring: the classic double-check, where the second
 * check is the one that matters.
 *
 * **One connection, held for as long as `fn` runs.** Every caller must
 * therefore be rare per subject — the only one today deploys a given account
 * once in its lifetime. A frequent caller would hold shared-pool connections
 * across its work and starve request-serving queries.
 *
 * #1686 assessed that hold and ACCEPTED it: the deploy path short-circuits on
 * a pre-lock bytecode check, so it is reached roughly once per account — not
 * "ever", since a reverted deploy leaves no bytecode and the retry re-enters.
 * The burst scenario, the reasoning, and the THREE triggers that reopen it as
 * real work are recorded in `docs/operations/backend-scaling.md` → "Accepted
 * cost: the deploy lock holds a pooled connection". Adding a caller that is
 * NOT once-per-subject-rare is one of them — read that section before you do.
 *
 * That accept assumed a SHORT hold, and #1722 made the assumption true rather
 * than hopeful: the deploy's confirmation wait now carries an explicit
 * deadline (`HYBRID_DEPLOY_CONFIRM_TIMEOUT_MS`), so the hold has a ceiling
 * instead of inheriting an unbounded `tx.wait()`. A NEW caller inherits no
 * such ceiling — `fn` is whatever you pass, and this lock bounds only the
 * wait to acquire (below), never the work. Bound your own critical section.
 *
 * **Bounded, and fail-open past the bound.** `lock_timeout` caps the wait; on
 * expiry `fn` runs anyway, WITHOUT the lock, and `onDegraded` reports it.
 * That direction is deliberate: this lock exists to stop duplicated work, not
 * to make the work safe, so failing to get it degrades to exactly the
 * behaviour that shipped before the lock existed. Refusing instead would turn
 * a wasted-gas problem into a failed request.
 *
 * Read that last sentence as scoped to the LOCK, because it is: it is the
 * lock's own failure that costs only gas. It does not make `fn` immune to
 * whatever is causing the lock to fail — under real pool exhaustion the work's
 * own fail-CLOSED writes can still reject, and the request fails with them.
 * The doc section above works that through.
 */
export async function withKeyedAdvisoryLock<T>(
  namespace: number,
  subject: string,
  fn: () => Promise<T>,
  options: {
    waitMs?: number
    onDegraded?: (reason: 'timeout' | 'error') => void
    db?: PoolLike
  } = {},
): Promise<T> {
  const waitMs = options.waitMs ?? 30_000
  const db = options.db ?? (pool as unknown as PoolLike)
  const lockId = advisoryLockIdFor(subject)

  let client: QueryableClientLike
  try {
    client = await db.connect()
  } catch {
    // Cannot even reach the pool — run unserialised rather than fail.
    options.onDegraded?.('error')
    return fn()
  }

  let held = false
  let destroyConnection = false
  try {
    // Bound the WAIT, not the work: once acquired the lock is held for as
    // long as `fn` runs. Without this a stuck holder would park every later
    // caller indefinitely, and nothing else would time them out. `SET` takes
    // no bind parameters in Postgres, so the bound is interpolated — it is a
    // truncated number, never caller text.
    let boundApplied = false
    try {
      await client.query(`SET lock_timeout = ${Math.max(1, Math.trunc(waitMs))}`)
      boundApplied = true
    } catch {
      // A broken connection, not a contended lock. Reported separately
      // because the two mean different things to whoever reads the log: this
      // one says the database is unwell, not that another replica is busy.
      options.onDegraded?.('error')
    }

    if (boundApplied) {
      try {
        await client.query('SELECT pg_advisory_lock($1, $2)', [namespace, lockId])
        held = true
      } catch {
        // 55P03 lock_not_available — someone else is mid-deploy and outlasted
        // the bound.
        options.onDegraded?.('timeout')
      }
    }

    return await fn()
  } finally {
    if (held) {
      try {
        await client.query('SELECT pg_advisory_unlock($1, $2)', [namespace, lockId])
      } catch {
        // Same reasoning as runIfLeader: a session that still holds the lock
        // must not go back to the pool, or the next borrower inherits it.
        destroyConnection = true
      }
    }
    try {
      // Reset the session setting before pooling the connection, so an
      // unrelated later query does not inherit this lock_timeout.
      if (!destroyConnection) await client.query('RESET lock_timeout')
    } catch {
      destroyConnection = true
    }
    client.release(destroyConnection || undefined)
  }
}
