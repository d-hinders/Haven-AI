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
import type { Executor } from '../transaction.js'

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

export const INSERT_CATALOG_SUBMISSION_SQL = `
  INSERT INTO catalog_submissions (hostname, resource_url, status, submitter_ip, verify_token)
  VALUES ($1, $2, 'submitted', $3, $4)
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
 * Insert a new submission and return its handle. Returns `null` when a
 * pending/active row for the same host won the race between the route's
 * dedupe read and this insert — the partial unique index turned the race into
 * an `ON CONFLICT ... DO NOTHING` no-op. The caller reads the winner back.
 */
export async function insertCatalogSubmission(
  params: { hostname: string; resource_url: string; submitter_ip: string; verify_token: string },
  db: Executor = pool,
): Promise<CatalogSubmissionHandle | null> {
  const result = await db.query<CatalogSubmissionRow>(INSERT_CATALOG_SUBMISSION_SQL, [
    params.hostname,
    params.resource_url,
    params.submitter_ip,
    params.verify_token,
  ])
  const row = result.rows[0]
  return row ? toHandle(row) : null
}
