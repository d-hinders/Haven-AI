/**
 * Data access for the self-service catalogue submission queue (epic #1717,
 * #1711).
 *
 * The queue is deliberately narrow: dedupe by pending hostname, count the
 * pending set for the flood cap, and insert a row. Ownership proof (#1712),
 * the SSRF-hardened probe (#1713) and lifecycle (#1714) build on this table in
 * later slices; nothing here makes outbound requests of any kind.
 *
 * Dedupe is a DATABASE guarantee, not a check-then-act race: the partial
 * unique index `idx_catalog_submissions_pending_host` (migration 066) makes
 * `ON CONFLICT (hostname) WHERE status IN (...)` target exactly the
 * pending/active rows, so two concurrent first-time submits of the same host
 * cannot produce two queue rows. The `... AND EXISTS(...)` follow-up SELECT is
 * the read-back for the no-op path ("same id returned").
 */
import pool from '../../db.js'
import { KEYED_LOCK_NAMESPACES } from '../../platform/leader-lock.js'
import { withTransaction, type Executor } from '../transaction.js'

export interface CatalogSubmissionRow {
  id: string
  hostname: string
  resource_url: string
  status: string
  submitter_ip: string
  verify_token: string
  created_at: string
  updated_at: string
}

/** The statuses a host is "owned by" for dedupe / cap purposes. */
const PENDING_STATUSES = "'submitted', 'ownership_verified', 'verified_payable'"

/**
 * Serialises the count-then-insert of the queue cap. Transaction-scoped, so
 * Postgres releases it at COMMIT/ROLLBACK with no unlock path to leak.
 *
 * Why a lock rather than a cleverer statement: under READ COMMITTED every
 * statement takes a FRESH snapshot, so folding the ceiling into the INSERT as
 * `... WHERE (SELECT COUNT(*) ...) < cap` does NOT serialise anything — two
 * concurrent inserts each evaluate the subquery before the other commits, both
 * see room, and both write. Only mutual exclusion actually bounds the set.
 *
 * Uses its OWN keyed namespace rather than `LEADER_LOCK_KEYS`, so it can
 * collide neither with the `catalogIngest` monitor key #1713 adds nor with
 * `accountDeploy`'s hashed subject ids — the namespace registry's rule is
 * never to reuse a value, and an earlier version of this file hardcoded
 * `accountDeploy`'s.
 */
const QUEUE_CAP_LOCK_NAMESPACE = KEYED_LOCK_NAMESPACES.catalogSubmissionQueue
const QUEUE_CAP_LOCK_ID = 1711

export const INSERT_CATALOG_SUBMISSION_SQL = `
  INSERT INTO catalog_submissions (hostname, resource_url, status, submitter_ip, verify_token)
  SELECT $1, $2, 'submitted', $3, $4
  WHERE (
    SELECT COUNT(*) FROM catalog_submissions WHERE status IN (${PENDING_STATUSES})
  ) < $5
  ON CONFLICT (hostname) WHERE status IN (${PENDING_STATUSES}) DO NOTHING
  RETURNING id, verify_token, status`

export const FIND_PENDING_CATALOG_SUBMISSION_BY_HOST_SQL = `
  SELECT id, hostname, resource_url, status, submitter_ip, verify_token, created_at, updated_at
  FROM catalog_submissions
  WHERE hostname = $1
    AND status IN (${PENDING_STATUSES})
  LIMIT 1`

export const COUNT_PENDING_CATALOG_SUBMISSIONS_SQL = `
  SELECT COUNT(*)::int AS pending
  FROM catalog_submissions
  WHERE status IN (${PENDING_STATUSES})`

export interface CatalogSubmissionHandle {
  id: string
  verify_token: string
  status: string
}

function toHandle(row: Pick<CatalogSubmissionRow, 'id' | 'verify_token' | 'status'>): CatalogSubmissionHandle {
  return { id: row.id, verify_token: row.verify_token, status: row.status }
}

/**
 * The pending/active submission for a host, if any — the no-op path of
 * `POST /catalog/submit` (same id returned). `null` means new work.
 */
export async function findPendingCatalogSubmissionByHost(
  hostname: string,
  db: Executor = pool,
): Promise<CatalogSubmissionHandle | null> {
  const result = await db.query<CatalogSubmissionRow>(FIND_PENDING_CATALOG_SUBMISSION_BY_HOST_SQL, [
    hostname,
  ])
  const row = result.rows[0]
  return row ? toHandle(row) : null
}

/**
 * Number of pending/active rows — the flood ceiling behind the route's 429.
 */
export async function countPendingCatalogSubmissions(
  db: Executor = pool,
): Promise<number> {
  const result = await db.query<{ pending: number }>(COUNT_PENDING_CATALOG_SUBMISSIONS_SQL)
  return result.rows[0]?.pending ?? 0
}

/**
 * Insert a new submission and return its handle, refusing to push the pending
 * set past `queueCap`.
 *
 * Returns `null` for BOTH refusal modes — a same-host row won the race (the
 * partial unique index turned it into an `ON CONFLICT ... DO NOTHING` no-op),
 * or the queue was full. They are distinguished by the caller, which reads the
 * host back: a winner means dedupe, no winner means the cap.
 *
 * The whole check runs under `pg_advisory_xact_lock` inside one transaction,
 * which is what makes the ceiling a real ceiling instead of a suggestion —
 * see the note on the lock constants above.
 */
export async function insertCatalogSubmission(
  params: {
    hostname: string
    resource_url: string
    submitter_ip: string
    verify_token: string
    queueCap: number
  },
  db: Executor = pool,
): Promise<CatalogSubmissionHandle | null> {
  return withTransaction(db, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1, $2)', [
      QUEUE_CAP_LOCK_NAMESPACE,
      QUEUE_CAP_LOCK_ID,
    ])
    const result = await tx.query<CatalogSubmissionRow>(INSERT_CATALOG_SUBMISSION_SQL, [
      params.hostname,
      params.resource_url,
      params.submitter_ip,
      params.verify_token,
      params.queueCap,
    ])
    const row = result.rows[0]
    return row ? toHandle(row) : null
  })
}

// ---------------------------------------------------------------------------
// Lifecycle verbs (#1714). The queue is DUMB on purpose: these are single
// statements with guarded transitions (`... WHERE status = <expected>`), so
// the once-only property of each move is a database fact, not a caller
// convention. The lifecycle module (`modules/catalog/lifecycle.ts`) holds the
// policy — cadence, failure thresholds, retention, alarm thresholds — and a
// concurrency-safe cooldown is enforced up-stack by `runProbeBatch`.
// ---------------------------------------------------------------------------

export interface CatalogLifecycleRow {
  id: string
  hostname: string
  resource_url: string
  status: string
  verify_token: string
  created_at: string
  consecutive_failures: number
}

export const LIST_SUBMITTED_CATALOG_SUBMISSIONS_SQL = `
  SELECT id, hostname, resource_url, status, verify_token, created_at
  FROM catalog_submissions
  WHERE status = 'submitted'
  ORDER BY created_at ASC`

export const LIST_OWNERSHIP_VERIFIED_CATALOG_SUBMISSIONS_SQL = `
  SELECT id, resource_url
  FROM catalog_submissions
  WHERE status = 'ownership_verified'
  ORDER BY updated_at ASC`

/** Verified rows whose last success is older than the re-verification cadence. */
export const LIST_VERIFIED_CATALOG_SUBMISSIONS_DUE_SQL = `
  SELECT id, resource_url
  FROM catalog_submissions
  WHERE status = 'verified_payable'
    AND (last_verified_at IS NULL OR last_verified_at < $1)
  ORDER BY last_verified_at ASC NULLS FIRST`

/**
 * `submitted -> ownership_verified`. The WHERE guard makes the transition
 * once-only even across leader crashes: only a row still in `submitted` can
 * move, and nothing re-enters that status.
 */
export const MARK_CATALOG_SUBMISSION_OWNERSHIP_VERIFIED_SQL = `
  UPDATE catalog_submissions
  SET status = 'ownership_verified', consecutive_failures = 0, updated_at = now()
  WHERE id = $1 AND status = 'submitted'`

/**
 * `* -> verified_payable`, for both the first success and a re-verification.
 * Persists the pointer metadata from the x402 quote. The status guard accepts
 * the two non-terminal outcomes the probe can hit.
 */
export const MARK_CATALOG_SUBMISSION_VERIFIED_PAYABLE_SQL = `
  UPDATE catalog_submissions
  SET status = 'verified_payable',
      last_verified_at = now(),
      consecutive_failures = 0,
      name = $2, description = $3, entrypoint = $4,
      updated_at = now()
  WHERE id = $1 AND status IN ('ownership_verified', 'verified_payable')`

/**
 * Count one more consecutive failure and report the streak + the pre-update
 * status, so the lifecycle can decide whether this is a fresh candidate that
 * failed or a previously-verified entry degrading.
 */
export const INCREMENT_CATALOG_SUBMISSION_FAILURES_SQL = `
  UPDATE catalog_submissions
  SET consecutive_failures = consecutive_failures + 1, updated_at = now()
  WHERE id = $1 AND status <> 'delisted'
  RETURNING consecutive_failures, status`

/** `* -> failed`. `failed_at` anchors the retention TTL for the purge. */
export const MARK_CATALOG_SUBMISSION_FAILED_SQL = `
  UPDATE catalog_submissions
  SET status = 'failed', failed_at = now(), updated_at = now()
  WHERE id = $1 AND status <> 'failed' AND status <> 'delisted'`

/** Submitted rows that have not moved in `olderThan` — the stuck-alarm input. */
export const COUNT_STUCK_CATALOG_SUBMISSIONS_SQL = `
  SELECT COUNT(*)::int AS n
  FROM catalog_submissions
  WHERE status = 'submitted' AND created_at < $1`

/**
 * Purge terminal rows past their retention anchor — `failed_at` for failed
 * rows, `updated_at` for operator-delisted ones. This is what keeps the table
 * bounded under sustained failure: nothing terminal survives `retention`.
 */
export const DELETE_TERMINAL_CATALOG_SUBMISSIONS_BEFORE_SQL = `
  DELETE FROM catalog_submissions
  WHERE status IN ('failed', 'delisted')
    AND COALESCE(failed_at, updated_at) < $1`

export async function listSubmittedCatalogSubmissions(
  db: Executor = pool,
): Promise<CatalogLifecycleRow[]> {
  const result = await db.query<CatalogLifecycleRow>(LIST_SUBMITTED_CATALOG_SUBMISSIONS_SQL)
  return result.rows
}

export async function listOwnershipVerifiedCatalogSubmissions(
  db: Executor = pool,
): Promise<Array<Pick<CatalogLifecycleRow, 'id' | 'resource_url'>>> {
  const result = await db.query<CatalogLifecycleRow>(LIST_OWNERSHIP_VERIFIED_CATALOG_SUBMISSIONS_SQL)
  return result.rows.map((r) => ({ id: r.id, resource_url: r.resource_url }))
}

export async function listVerifiedCatalogSubmissionsDueForRecheck(
  olderThan: Date,
  db: Executor = pool,
): Promise<Array<Pick<CatalogLifecycleRow, 'id' | 'resource_url'>>> {
  const result = await db.query<CatalogLifecycleRow>(
    LIST_VERIFIED_CATALOG_SUBMISSIONS_DUE_SQL,
    [olderThan.toISOString()],
  )
  return result.rows.map((r) => ({ id: r.id, resource_url: r.resource_url }))
}

/** True when the row was still `submitted` and moved to `ownership_verified`. */
export async function markCatalogSubmissionOwnershipVerified(
  id: string,
  db: Executor = pool,
): Promise<boolean> {
  const result = await db.query(MARK_CATALOG_SUBMISSION_OWNERSHIP_VERIFIED_SQL, [id])
  return (result.rowCount ?? 0) > 0
}

export async function markCatalogSubmissionVerifiedPayable(
  id: string,
  metadata: { name: string; description: string | null; entrypoint: string },
  db: Executor = pool,
): Promise<boolean> {
  const result = await db.query(MARK_CATALOG_SUBMISSION_VERIFIED_PAYABLE_SQL, [
    id,
    metadata.name,
    metadata.description,
    metadata.entrypoint,
  ])
  return (result.rowCount ?? 0) > 0
}

export interface CatalogFailureTally {
  streak: number
  /** Status BEFORE the increment — lets the caller distinguish degrading a
   * previously-verified entry from failing a never-verified candidate. */
  status: string
}

export async function incrementCatalogSubmissionFailures(
  id: string,
  db: Executor = pool,
): Promise<CatalogFailureTally | null> {
  const result = await db.query<Pick<CatalogLifecycleRow, 'consecutive_failures' | 'status'>>(
    INCREMENT_CATALOG_SUBMISSION_FAILURES_SQL,
    [id],
  )
  const row = result.rows[0]
  return row ? { streak: row.consecutive_failures, status: row.status } : null
}

export async function markCatalogSubmissionFailed(id: string, db: Executor = pool): Promise<boolean> {
  const result = await db.query(MARK_CATALOG_SUBMISSION_FAILED_SQL, [id])
  return (result.rowCount ?? 0) > 0
}

export async function countStuckCatalogSubmissions(
  olderThan: Date,
  db: Executor = pool,
): Promise<number> {
  const result = await db.query<{ n: number }>(COUNT_STUCK_CATALOG_SUBMISSIONS_SQL, [
    olderThan.toISOString(),
  ])
  return result.rows[0]?.n ?? 0
}

export async function deleteTerminalCatalogSubmissionsBefore(
  olderThan: Date,
  db: Executor = pool,
): Promise<number> {
  const result = await db.query(DELETE_TERMINAL_CATALOG_SUBMISSIONS_BEFORE_SQL, [
    olderThan.toISOString(),
  ])
  return result.rowCount ?? 0
}

// ---------------------------------------------------------------------------
// Read-back for the status surface (#1715): one row by id, full lifecycle
// columns, so the public status endpoint can render current state without the
// caller ever seeing `verify_token` (the route decides what crosses the wire).
// ---------------------------------------------------------------------------

export interface CatalogSubmissionDetail extends CatalogLifecycleRow {
  resource_url: string
  updated_at: string
  last_verified_at: string | null
  failed_at: string | null
  name: string | null
  description: string | null
  entrypoint: string | null
}

export const GET_CATALOG_SUBMISSION_SQL = `
  SELECT id, hostname, resource_url, status, submitter_ip, verify_token,
         created_at, updated_at, last_verified_at, consecutive_failures,
         failed_at, name, description, entrypoint
  FROM catalog_submissions
  WHERE id = $1
  LIMIT 1`

export async function getCatalogSubmission(
  id: string,
  db: Executor = pool,
): Promise<CatalogSubmissionDetail | null> {
  const result = await db.query<CatalogSubmissionDetail>(GET_CATALOG_SUBMISSION_SQL, [id])
  return result.rows[0] ?? null
}

/** Verified, listable rows — the ingestion half of the public catalogue. */
export const LIST_VERIFIED_CATALOG_SUBMISSIONS_SQL = `
  SELECT id, resource_url, name, description, entrypoint, last_verified_at
  FROM catalog_submissions
  WHERE status = 'verified_payable'
  ORDER BY name ASC NULLS LAST, id ASC`

export interface VerifiedCatalogListingRow {
  id: string
  resource_url: string
  name: string | null
  description: string | null
  entrypoint: string | null
  last_verified_at: string | null
}

export async function listVerifiedCatalogSubmissions(
  db: Executor = pool,
): Promise<VerifiedCatalogListingRow[]> {
  const result = await db.query<VerifiedCatalogListingRow>(LIST_VERIFIED_CATALOG_SUBMISSIONS_SQL)
  return result.rows
}
