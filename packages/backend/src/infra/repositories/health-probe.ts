/**
 * The ops diagnostics builder's ONE database probe (#3514), behind the
 * repository layer per the inline-SQL gauge (#1210): `index.ts` builds the
 * injected `/health/ops` payload options and must not grow a second inline
 * `SELECT 1` call site — the composition root keeps exactly the one the
 * public `/health` liveness probe has always had (dep-lint-exempt, see the
 * pool import's comment there).
 */

import pool from '../../db.js'
import type { Executor } from '../transaction.js'

/** Liveness probe: the database answers at all. */
export async function probeDatabase(db: Executor = pool): Promise<unknown> {
  return db.query('SELECT 1')
}
