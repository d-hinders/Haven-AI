/**
 * The per-RUN pristine schema reference (#2622).
 *
 * ## The defect this exists for
 *
 * `ensureMigrated()` decides from `schema_migrations`: nothing pending, nothing
 * to do. `resetDb()` empties rows and never touches schema. So a worker schema
 * that is off migration head *when a run starts* stays off it forever, and
 * every gate reads green — the schema says "applied" while the table the
 * migration dropped is still sitting there.
 *
 * #2616's guard does not close this, and cannot: it captures `headShape` AFTER
 * the migration run, so drift already present at that moment BECOMES head and
 * diffs clean against itself for the rest of time. That blind spot is written
 * down on `assertWorkerSchemaAtHead()` and this module is its answer.
 *
 * Measured on one developer machine (#2622, at `bfbd07f2`): 336 worker schemas,
 * 39 of them carrying `agent_allowances` — a table migration 075 DROPS — with
 * 075 recorded as applied in every one. `try/finally` does not help, because
 * the trigger is process TERMINATION, not a failing assertion: an interrupted
 * local run, a cancelled CI job.
 *
 * ## Why a reference rather than disposable schemas
 *
 * #2622 offered two designs and priced the second, dropping and recreating each
 * worker schema, as "a full migration run per worker per run". That price is
 * wrong in the expensive direction: `test_w*` schemas are allocated **per
 * FILE**, not per worker — `VITEST_WORKER_ID` is the file's ordinal in the
 * run's spec list, and vitest gives each file its own process. At 62 real-DB
 * files that is 62 full migration runs per suite run against a cold init
 * measured at ~572 ms, which is the cost #2211 and #2354 exist to have
 * attacked. So: one pristine schema per RUN, fingerprinted once in
 * `vitest.global-setup.ts`, and a cheap catalog read per file to compare
 * against it.
 *
 * The fingerprint is deliberately schema-PARAMETERISED and takes its own
 * `query` function, because it has to run against two different connections:
 * the reference schema from the main process before any worker exists, and the
 * worker schema from the harness pool. A copy specialised to `WORKER_SCHEMA`
 * would be a second definition of the same thing, and this repo spent a session
 * on exactly that failure mode the same week (#2625: one schema name computed
 * in two places, and the guard went silent the moment they diverged).
 */

/** The env var carrying the path to the run's reference fingerprint JSON. */
export const REFERENCE_PATH_ENV = 'HAVEN_SCHEMA_REFERENCE'

/** The schema the reference is built in. One per run, dropped and recreated. */
export const REFERENCE_SCHEMA = 'test_schema_reference'

/** One table's column and index shape. */
export type TableFingerprint = {
  table: string
  columns: { name: string; type: string; nullable: string; default: string | null }[]
  indexes: string[]
}

/** Anything that can run a parameterised query — a `Pool`, a `Client`, `db`. */
export type Queryable = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>
}

/**
 * One table's column and index shape for every table in `schema`.
 *
 * `schema_migrations` is excluded: it is the runner's own bookkeeping, its
 * CONTENT is what `ensureMigrated()` already decides from, and including it
 * would make every reference stale the moment a migration lands even when the
 * shape it produces is identical.
 *
 * Both lists are ordered by the database, so two fingerprints of the same shape
 * serialise identically regardless of catalog insertion order.
 */
export async function readFingerprint(
  client: Queryable,
  schema: string,
): Promise<TableFingerprint[]> {
  const { rows } = await client.query(
    `SELECT t.tablename AS table,
            (SELECT coalesce(json_agg(json_build_object(
                      'name', c.column_name,
                      'type', c.data_type,
                      'nullable', c.is_nullable,
                      'default', c.column_default) ORDER BY c.column_name), '[]'::json)
               FROM information_schema.columns c
              WHERE c.table_schema = t.schemaname AND c.table_name = t.tablename) AS columns,
            (SELECT coalesce(json_agg(i.indexname ORDER BY i.indexname), '[]'::json)
               FROM pg_indexes i
              WHERE i.schemaname = t.schemaname AND i.tablename = t.tablename) AS indexes
       FROM pg_tables t
      WHERE t.schemaname = $1 AND t.tablename <> 'schema_migrations'
      ORDER BY t.tablename`,
    [schema],
  )
  return rows as TableFingerprint[]
}

/** `+name` present only in `b`, `-name` only in `a`, `~name` in both but different. */
function diffNames(a: unknown[], b: unknown[]): string[] {
  // Index entries arrive from `json_agg(i.indexname)` as bare strings and
  // column entries as objects; one `key()` handles both rather than two
  // call-site-specific loops.
  const key = (e: unknown) =>
    typeof e === 'string' ? e : String((e as { name?: string }).name ?? JSON.stringify(e))
  const byKey = (list: unknown[]) => new Map(list.map((e) => [key(e), JSON.stringify(e)]))
  const [aBy, bBy] = [byKey(a), byKey(b)]
  const out: string[] = []
  for (const [k, v] of bBy) {
    if (!aBy.has(k)) out.push(`+${k}`)
    else if (aBy.get(k) !== v) out.push(`~${k}`)
  }
  for (const k of aBy.keys()) if (!bBy.has(k)) out.push(`-${k}`)
  return out.sort()
}

/**
 * Human-readable differences between a reference and an actual fingerprint.
 *
 * Empty means identical. Each entry names one table and what about it differs,
 * because "your schema is wrong" without the table is a message that sends the
 * reader back to the catalog to do the diff by hand.
 */
export function diffFingerprints(
  reference: TableFingerprint[],
  actual: TableFingerprint[],
): string[] {
  const ref = new Map(reference.map((t) => [t.table, t]))
  const now = new Map(actual.map((t) => [t.table, t]))
  const out: string[] = []
  for (const table of [...new Set([...ref.keys(), ...now.keys()])].sort()) {
    const a = ref.get(table)
    const b = now.get(table)
    if (!a) {
      out.push(`${table} (table present that head does not have)`)
      continue
    }
    if (!b) {
      out.push(`${table} (table head has that is missing)`)
      continue
    }
    const columns = diffNames(a.columns, b.columns)
    const indexes = diffNames(a.indexes, b.indexes)
    if (columns.length > 0 || indexes.length > 0) {
      out.push(
        `${table} (${[
          columns.length ? `columns ${columns.join(',')}` : '',
          indexes.length ? `indexes ${indexes.join(',')}` : '',
        ]
          .filter(Boolean)
          .join('; ')})`,
      )
    }
  }
  return out
}

/**
 * The failure text, kept here rather than at the throw site so the test that
 * pins its content does not have to reach into `db-harness.ts`'s internals.
 *
 * Names the repair explicitly. A developer meeting this message is meeting it
 * for the first time, on a schema they did not knowingly create, for drift a
 * run they may not remember left behind — "your schema is stale" without the
 * command is a message that costs an hour.
 */
export function driftMessage(schema: string, differences: string[]): string {
  return (
    `db-harness: worker schema ${schema} was ALREADY off migration head when this run started ` +
    `(#2622) — ${differences.join('; ')}.\n` +
    '\n' +
    'This is inherited drift, not something this run caused: `schema_migrations` records every ' +
    'migration as applied, so `ensureMigrated()` had nothing to do, and #2616\'s end-of-file guard ' +
    'cannot see it because it captures head AFTER the migration run — drift already present ' +
    'BECOMES head and diffs clean forever. Two common causes: an ordinary test whose hook creates or re-creates a table and does not remove it, and a run killed partway through a test ' +
    'that had reverted a migration; a `finally` does not run when the process is terminated.\n' +
    '\n' +
    `Repair (local test database only):  DROP SCHEMA ${schema} CASCADE;\n` +
    'The next run recreates it and re-applies every migration. To clear the whole reservoir at ' +
    'once, `npm run db:reap-test-schemas -w packages/backend`.'
  )
}
