/**
 * Data access for the ops console access log (#3509, migration 104).
 * Convention: `README.md` in this directory.
 *
 * This is the one table the ops console WRITES, and it is written through the
 * main pool (`db = pool`): the read-only ops role (#3510) is never granted it.
 * Callers treat a failed insert as a failed request — the ops console never
 * returns data it could not record returning (epic #3507 invariant 6).
 *
 * Not tenant-scoped, deliberately: it records operators, not customers.
 */

import pool from '../../db.js'
import type { Executor } from '../transaction.js'

export type OpsAccessAction = 'sign_in' | 'sign_in_denied' | 'view' | 'search' | 'reveal'

export interface OpsAccessLogEntry {
  operatorGithubId: number | string
  operatorLogin: string
  action: OpsAccessAction
  targetType?: string | null
  targetId?: string | null
  field?: string | null
  /** A MASKED value (e.g. a search term) — never a raw customer value. */
  detail?: string | null
  requestId: string
}

export interface OpsAccessLogRow {
  id: string
  operator_github_id: string
  operator_login: string
  action: OpsAccessAction
  target_type: string | null
  target_id: string | null
  field: string | null
  detail: string | null
  request_id: string
  created_at: string
}

export const INSERT_OPS_ACCESS_LOG_SQL = `INSERT INTO ops_access_log
  (operator_github_id, operator_login, action, target_type, target_id, field, detail, request_id)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`

export async function insertOpsAccessLog(entry: OpsAccessLogEntry, db: Executor = pool): Promise<void> {
  await db.query(INSERT_OPS_ACCESS_LOG_SQL, [
    String(entry.operatorGithubId),
    entry.operatorLogin,
    entry.action,
    entry.targetType ?? null,
    entry.targetId ?? null,
    entry.field ?? null,
    entry.detail ?? null,
    entry.requestId,
  ])
}
