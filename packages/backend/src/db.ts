import pg from 'pg'
import { config } from './config.js'

let pool: pg.Pool

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: config.dbPoolMax,
      idleTimeoutMillis: config.dbPoolIdleTimeout,
      connectionTimeoutMillis: config.dbPoolConnectionTimeout,
    })

    pool.on('error', (err) => {
      console.error('Unexpected database pool error:', err.message)
    })
  }
  return pool
}

export default {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    queryTextOrConfig: string | pg.QueryConfig,
    values?: unknown[],
  ): Promise<pg.QueryResult<R>> {
    return getPool().query<R>(queryTextOrConfig as string, values)
  },
  connect: () => getPool().connect(),
}
