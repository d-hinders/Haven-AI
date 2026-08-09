/**
 * End-to-end smoke for the real-Postgres harness (#1220).
 *
 * Proves the properties every conversion in epic #1219 leans on: schema
 * creation + migrations, per-test truncation, REAL `withTransaction`
 * rollback, and — the property most likely to be silently wrong — that the
 * module-level pool's connections all land in the worker schema.
 *
 * `db-harness-parallel.test.ts` is this file's twin: both write worker-tagged
 * rows into the SAME table name, so when vitest schedules them in different
 * workers, each asserts it sees only its own rows.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../../db.js'
import { migrations } from '../../../../db/migrations/index.js'
import { withTransaction } from '../../../transaction.js'
import { describeDb, initDbHarness, resetDb, WORKER_SCHEMA } from '../db-harness.js'

describeDb('db-harness (#1220)', () => {
  beforeAll(async () => {
    await initDbHarness()
    // Scratch table for harness assertions only — the harness itself stays
    // domain-free, so the smoke test brings its own table.
    await db.query(
      `CREATE TABLE IF NOT EXISTS harness_smoke (
         id SERIAL PRIMARY KEY,
         worker TEXT NOT NULL,
         note TEXT
       )`,
    )
  })

  beforeEach(async () => {
    await resetDb()
  })

  it('applied the migrations into the worker schema', async () => {
    const versions = await db.query<{ version: string }>(
      `SELECT version FROM schema_migrations`,
    )
    // Bound to the runner's own list — exact, and self-updating as
    // migrations land.
    expect(versions.rows.length).toBe(migrations.length)
    // A migration-created table resolves unqualified — proof the migrations
    // landed in the schema the connections are bound to.
    const users = await db.query(`SELECT COUNT(*)::int AS n FROM users`)
    expect(users.rows[0].n).toBe(0)
  })

  it('binds EVERY pooled connection to the worker schema, not just the first', async () => {
    // Concurrent queries force the pool onto multiple physical connections;
    // `search_path` is a per-connection setting, so this is the assertion
    // that the URL `options` binding (vitest.setup.ts) actually reaches all
    // of them — the property #1220 calls out as the likely silent failure.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => db.query<{ s: string }>(`SELECT current_schema() AS s`)),
    )
    for (const r of results) expect(r.rows[0].s).toBe(WORKER_SCHEMA)
  })

  it('resetDb leaves no rows from a prior test', async () => {
    await db.query(`INSERT INTO harness_smoke (worker, note) VALUES ($1, 'leftover')`, [
      WORKER_SCHEMA,
    ])
    await resetDb()
    const after = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM harness_smoke`)
    expect(after.rows[0].n).toBe(0)
    // RESTART IDENTITY: the sequence starts over too.
    const inserted = await db.query<{ id: number }>(
      `INSERT INTO harness_smoke (worker) VALUES ($1) RETURNING id`,
      [WORKER_SCHEMA],
    )
    expect(inserted.rows[0].id).toBe(1)
  })

  it('a throw inside withTransaction rolls back — no rows committed', async () => {
    await expect(
      withTransaction(db, async (tx) => {
        await tx.query(`INSERT INTO harness_smoke (worker, note) VALUES ($1, 'doomed')`, [
          WORKER_SCHEMA,
        ])
        const mid = await tx.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM harness_smoke`)
        expect(mid.rows[0].n).toBe(1) // visible inside the transaction…
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    const after = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM harness_smoke`)
    expect(after.rows[0].n).toBe(0) // …and gone after the rollback.
  })

  it('sees only rows tagged with its own worker (cross-worker isolation, half 1)', async () => {
    await db.query(`INSERT INTO harness_smoke (worker) VALUES ($1), ($1)`, [WORKER_SCHEMA])
    const rows = await db.query<{ worker: string }>(`SELECT worker FROM harness_smoke`)
    expect(rows.rows).toHaveLength(2)
    for (const row of rows.rows) expect(row.worker).toBe(WORKER_SCHEMA)
  })
})
