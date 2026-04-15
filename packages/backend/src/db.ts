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
  query: (...args: Parameters<pg.Pool['query']>) => getPool().query(...args),
  connect: () => getPool().connect(),
}
