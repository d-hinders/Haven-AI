/**
 * Shared data-access primitives for `src/infra/repositories/**` (#985).
 *
 * Promoted VERBATIM from `repositories/agent-passports.ts`, where the
 * convention was proven by the passport epic (#973/#974) — this file is the
 * one home so the next repository does not re-define its own copies.
 */

import type { QueryResult, QueryResultRow } from 'pg'

/**
 * The query capability repositories take as an explicit argument
 * (`db: Executor = pool`). Structural rather than `Pool | PoolClient` because
 * `db.ts` exports a thin wrapper, not a `pg.Pool`. Typing the capability
 * instead of the concrete class is also what lets a caller pass a transaction
 * client — the point of taking an explicit executor in the first place.
 */
export interface Executor {
  query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>
}

/**
 * Run `fn` inside a transaction. When the executor can hand out a dedicated
 * connection (the `db.ts` pool wrapper), BEGIN/COMMIT run on that single
 * client — issuing BEGIN through the pool would hit a different connection
 * per statement. A caller that already holds a transaction client passes it
 * straight through and `fn` runs inline on it.
 */
export async function withTransaction<T>(
  db: Executor,
  fn: (tx: Executor) => Promise<T>,
): Promise<T> {
  const connectable = db as Executor & {
    connect?: () => Promise<{ query: Executor['query']; release: () => void }>
  }
  if (typeof connectable.connect !== 'function') return fn(db)
  const client = await connectable.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
