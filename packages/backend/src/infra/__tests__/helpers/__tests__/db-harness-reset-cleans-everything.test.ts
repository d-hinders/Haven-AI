/**
 * Contract: `resetDb()` leaves the worker schema GENUINELY clean (#2211).
 *
 * #2211 replaced the reset's single `TRUNCATE … RESTART IDENTITY CASCADE`
 * with foreign-key-ordered `DELETE`s, because `TRUNCATE` costs a fixed amount
 * per relation and so got slower with every migration. A faster reset that
 * changes isolation semantics would be a correctness regression disguised as
 * a speedup, and its failure mode is the worst kind: a test that passes
 * because the leftover state happened to be compatible, surfacing months
 * later as an unreproducible flake.
 *
 * So this file proves the cleanliness rather than asserting it, and it is
 * written to be NON-NARROWING (#2208's lesson). The post-reset census
 * enumerates `pg_tables` — the same authority the reset itself reads, but
 * consulted independently and AFTER the fact. A reset that stopped covering
 * some table cannot make this file agree with it by shrinking a list, because
 * this file maintains no list: the expectation is "every table the database
 * says exists in this schema has zero rows".
 *
 * The seed is the positive control. A reset that cleans nothing would pass a
 * census over an already-empty schema, so the test asserts the seeded tables
 * are non-empty BEFORE the reset, naming them as independent literals.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../../db.js'
import { describeDb, initDbHarness, resetDb, WORKER_SCHEMA } from '../db-harness.js'

/** Every table the DATABASE says lives in this worker's schema. */
async function tableCensus(): Promise<Array<{ table: string; rows: number }>> {
  const { rows: tables } = await db.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = $1 AND tablename <> 'schema_migrations'
      ORDER BY tablename`,
    [WORKER_SCHEMA],
  )
  const counts = await Promise.all(
    tables.map(async ({ tablename }) => {
      const { rows } = await db.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM ${WORKER_SCHEMA}."${tablename}"`,
      )
      return { table: tablename, rows: Number(rows[0].n) }
    }),
  )
  return counts
}

/**
 * The positive control, named as independent literals so shrinking it weakens
 * the control visibly rather than silently.
 *
 * Two shapes, and the second is the one that makes the control SHARP:
 *
 * - `users` → `agents` → `agent_allowances` is a foreign-key chain, so it
 *   exercises the delete ORDER, not just the coverage.
 * - `rate_limit_counters` is deliberately a table that **no cascade can
 *   reach** — it has no foreign key at all, so nothing empties it as a side
 *   effect of emptying something else. Without it, dropping a table from the
 *   reset's coverage is invisible here: `ON DELETE CASCADE` cleans up the
 *   dropped child anyway, and the census still passes. (Measured — mutation
 *   M1 of #2211 removed `agent_allowances` from the reset's table list and
 *   survived the first version of this file for exactly that reason.)
 */
const SEEDED_TABLES = ['users', 'agents', 'agent_allowances', 'rate_limit_counters'] as const

async function seed(): Promise<void> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`reset-census-${Date.now()}-${Math.random()}@test.example`],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'reset census') RETURNING id`,
    [user.rows[0].id],
  )
  await db.query(
    `INSERT INTO agent_allowances (agent_id, token_address, token_symbol, allowance_amount)
     VALUES ($1, '0x0000000000000000000000000000000000000001', 'USDC', '1')`,
    [agent.rows[0].id],
  )
  await db.query(
    `INSERT INTO rate_limit_counters (key, count, expires_at)
     VALUES ($1, 1, NOW() + INTERVAL '1 hour')`,
    [`reset-census-${Date.now()}-${Math.random()}`],
  )
}

describeDb('resetDb leaves the worker schema genuinely clean (#2211)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  it('empties EVERY table the catalog reports, not a list the harness maintains', async () => {
    await seed()

    // Positive control: a reset that cleans nothing must not be able to pass
    // this test. Assert the seed actually landed before asking about after.
    const before = await tableCensus()
    const seededBefore = before.filter((t) => SEEDED_TABLES.includes(t.table as never))
    expect(seededBefore.map((t) => t.table).sort()).toEqual([...SEEDED_TABLES].sort())
    for (const entry of seededBefore) expect(entry.rows).toBeGreaterThan(0)

    await resetDb()

    const after = await tableCensus()
    // The census is meaningless if it saw nothing — pin that it enumerated the
    // real schema, not an empty result set.
    expect(after.length).toBeGreaterThanOrEqual(before.length)
    expect(after.filter((t) => t.rows !== 0)).toEqual([])
  })

  it('restarts sequences that a test advanced, as RESTART IDENTITY did', async () => {
    await db.query(
      `CREATE TABLE IF NOT EXISTS ${WORKER_SCHEMA}.reset_identity_probe (
         id BIGSERIAL PRIMARY KEY, note TEXT
       )`,
    )
    try {
      await db.query(`INSERT INTO ${WORKER_SCHEMA}.reset_identity_probe (note) VALUES ('a'), ('b')`)
      const advanced = await db.query<{ id: string }>(
        `SELECT id::text AS id FROM ${WORKER_SCHEMA}.reset_identity_probe ORDER BY id DESC LIMIT 1`,
      )
      expect(advanced.rows[0].id).toBe('2')

      await resetDb()

      const reused = await db.query<{ id: string }>(
        `INSERT INTO ${WORKER_SCHEMA}.reset_identity_probe (note) VALUES ('c') RETURNING id::text AS id`,
      )
      expect(reused.rows[0].id).toBe('1')
    } finally {
      await db.query(`DROP TABLE IF EXISTS ${WORKER_SCHEMA}.reset_identity_probe`)
    }
  })

  it('still cleans a schema whose foreign keys form a cycle (the TRUNCATE fallback)', async () => {
    // `planDeleteOrder` returns null here, so resetDb takes the pre-#2211
    // TRUNCATE path. Created and dropped inside this test: left behind, the
    // cycle would put EVERY later reset in the run on the fallback path.
    await db.query(`
      CREATE TABLE ${WORKER_SCHEMA}.cycle_a (id INT PRIMARY KEY, b_id INT);
      CREATE TABLE ${WORKER_SCHEMA}.cycle_b (id INT PRIMARY KEY, a_id INT);
      ALTER TABLE ${WORKER_SCHEMA}.cycle_a
        ADD CONSTRAINT cycle_a_b_fk FOREIGN KEY (b_id) REFERENCES ${WORKER_SCHEMA}.cycle_b(id);
      ALTER TABLE ${WORKER_SCHEMA}.cycle_b
        ADD CONSTRAINT cycle_b_a_fk FOREIGN KEY (a_id) REFERENCES ${WORKER_SCHEMA}.cycle_a(id);
    `)
    try {
      await db.query(`INSERT INTO ${WORKER_SCHEMA}.cycle_a (id, b_id) VALUES (1, NULL)`)
      await db.query(`INSERT INTO ${WORKER_SCHEMA}.cycle_b (id, a_id) VALUES (1, 1)`)
      await seed()

      await resetDb()

      expect((await tableCensus()).filter((t) => t.rows !== 0)).toEqual([])
    } finally {
      await db.query(`DROP TABLE IF EXISTS ${WORKER_SCHEMA}.cycle_b, ${WORKER_SCHEMA}.cycle_a`)
    }
  })
})
