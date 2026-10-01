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
 * the main `DATABASE_URL` refuses the boot (`config/ops.ts`), because that
 * login can read every secret column the role exists to withhold.
 */
import pg from 'pg'
import { config } from '../config.js'
import type { Executor } from './transaction.js'

/** Small on purpose: the role itself is capped at CONNECTION LIMIT 5. */
export const OPS_READ_POOL_MAX = 3

let opsPool: pg.Pool | null = null

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

/** The ops read executor, or null when the deployment configures none. */
export function getOpsReadDb(): Executor | null {
  if (config.opsDatabaseUrl === '') return null
  opsPool ??= createOpsReadPool(config.opsDatabaseUrl)
  return opsPool
}
