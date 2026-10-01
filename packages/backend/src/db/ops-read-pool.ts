/**
 * The ops console's read connection (#3510, epic #3507 invariant 5).
 *
 * A pool on `OPS_DATABASE_URL` — a login for the read-only role the operator
 * creates with `scripts/ops-readonly-role.ts`. Every ops DATA read goes
 * through it (the executor `routes/ops.ts` receives as `readDb`); the ops
 * audit insert keeps using the main pool, because this role cannot write.
 *
 * There is no fallback (owner decision, #3510): with `OPS_DATABASE_URL`
 * unset this returns null and the ops data routes answer 404. Pointing it at
 * the main login refuses the boot (`config/ops.ts`, by user name), and the
 * executor checks the login's actual privileges before its first read
 * (`guardOpsReadExecutor`): an unsafe login fails every ops read, and the
 * routes answer 404.
 */
import pg from 'pg'
import { config } from '../config.js'
import type { Executor } from '../infra/transaction.js'
import { guardOpsReadExecutor } from '../infra/repositories/ops-read-role.js'

/**
 * Per process. The role is capped at CONNECTION LIMIT 5
 * (`OPS_READONLY_CONNECTION_LIMIT`), so this fits two backend replicas with
 * one connection to spare for an operator's console session; a third replica
 * would need the limit raised in the role script.
 */
export const OPS_READ_POOL_MAX = 2

let opsReadDb: Executor | null = null

export function createOpsReadPool(connectionString: string): pg.Pool {
  const created = new pg.Pool({
    connectionString,
    max: OPS_READ_POOL_MAX,
    idleTimeoutMillis: config.dbPoolIdleTimeout,
    connectionTimeoutMillis: config.dbPoolConnectionTimeout,
  })
  created.on('error', (err) => {
    console.error('Unexpected ops read pool error:', err.message)
  })
  return created
}

/**
 * The ops read executor, or null when the deployment configures none. It has
 * no `connect`, so `withTransaction` runs inline on it with no BEGIN: a data
 * slice that needs one snapshot across several reads must not assume a
 * transaction here.
 */
export function getOpsReadDb(): Executor | null {
  if (config.opsDatabaseUrl === '') return null
  opsReadDb ??= guardOpsReadExecutor(createOpsReadPool(config.opsDatabaseUrl), (err) => {
    console.error(`Ops console data reads are OFF: ${err.message}`)
  })
  return opsReadDb
}
