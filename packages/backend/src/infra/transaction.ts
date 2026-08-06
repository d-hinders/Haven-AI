/**
 * The two primitives every repository under `infra/repositories/` shares (#985).
 *
 * Promoted here rather than invented: `agent-passports.ts` (#972) established
 * both, and `hybrid-signers.ts` (#1081) then copied `Executor` verbatim — two
 * structurally identical declarations of the same contract is the point at
 * which a shape becomes a primitive. See `repositories/README.md` for the
 * convention they belong to.
 *
 * This file deliberately holds NO queries. It is the only thing outside
 * `repositories/` that `pg-only-in-infra` (rule 3,
 * `docs/architecture/10-module-boundaries.md`) needs to tolerate, and keeping
 * it query-free is what makes that exception uninteresting.
 */

/**
 * The part of a driver result this codebase actually reads.
 *
 * Declared structurally rather than imported from `pg` on purpose. `pg-only-in-
 * infra` counts an import EDGE, and with `tsPreCompilationDeps` a type-only
 * `import type { QueryResult } from 'pg'` is still an edge — so importing the
 * driver's types here, one directory above `repositories/`, would open exactly
 * the boundary this file exists to keep closed. `pg`'s own `QueryResult`
 * satisfies this shape, so every call site type-checks unchanged.
 */
/**
 * A result row. Mirrors `pg`'s `QueryResultRow` — `{ [column: string]: any }` —
 * deliberately, including the `any`. `Record<string, unknown>` looks stricter
 * but is the wrong constraint here: a plain `interface` has no index signature,
 * so every row type in the codebase would fail to satisfy it. The `any` is what
 * makes an arbitrary declared row shape assignable, which is exactly the
 * property a driver-result constraint needs.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type QueryRow = Record<string, any>

export interface QueryOutcome<R> {
  rows: R[]
  rowCount: number | null
}

/**
 * Anything that can run a query: the app's `db.ts` default export, a raw
 * `pg.Pool`, or a `PoolClient` inside a transaction.
 *
 * Structural rather than `Pool | PoolClient` because `db.ts` exports a thin
 * wrapper, not a `pg.Pool`. Typing the capability instead of the concrete class
 * is also what lets a caller pass a transaction client — the point of taking an
 * explicit executor in the first place.
 */
export interface Executor {
  query<R extends QueryRow = QueryRow>(sql: string, values?: unknown[]): Promise<QueryOutcome<R>>
}

/**
 * Run `fn` inside a transaction. When the executor can hand out a dedicated
 * connection (the `db.ts` pool wrapper), BEGIN/COMMIT run on that single
 * client — issuing BEGIN through the pool would hit a different connection
 * per statement. A caller that already holds a transaction client passes it
 * straight through and `fn` runs inline on it.
 *
 * `fn` throwing is the ONLY way to roll back. That is deliberate: a callback
 * that returns normally has, by definition, decided the work is complete, and
 * an early `return` reading as "abandon the transaction" is exactly the
 * ambiguity that produces a committed half-write. Callers that need to abandon
 * a transaction and still answer the caller — an HTTP route refusing a request
 * mid-transaction — throw a sentinel of their own and catch it outside.
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
