/**
 * Cross-worker isolation, half 2 (#1220) — the twin of db-harness.test.ts.
 *
 * Vitest schedules separate test FILES onto separate workers, so this file
 * and its twin run concurrently against the SAME unqualified table name.
 * Each inserts rows tagged with its own worker schema and asserts it never
 * sees the other's — the explicit parallel-isolation proof the harness
 * acceptance criteria demand. If both files happen to land on one worker
 * (single-core CI), the assertion still holds; it just proves less, which is
 * why BOTH files carry it on every run rather than one file trying to
 * orchestrate true simultaneity.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../../db.js'
import { describeDb, initDbHarness, resetDb, WORKER_SCHEMA } from '../db-harness.js'

describeDb('db-harness parallel isolation (#1220)', () => {
  beforeAll(async () => {
    await initDbHarness()
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

  it('sees only rows tagged with its own worker (cross-worker isolation, half 2)', async () => {
    await db.query(`INSERT INTO harness_smoke (worker) VALUES ($1), ($1), ($1)`, [WORKER_SCHEMA])
    // Give the twin file's inserts a moment to land if it is running right now.
    await new Promise((resolve) => setTimeout(resolve, 150))
    const rows = await db.query<{ worker: string }>(`SELECT worker FROM harness_smoke`)
    expect(rows.rows).toHaveLength(3)
    for (const row of rows.rows) expect(row.worker).toBe(WORKER_SCHEMA)
  })

  it('reports the schema its worker id predicts', async () => {
    const r = await db.query<{ s: string }>(`SELECT current_schema() AS s`)
    expect(r.rows[0].s).toBe(WORKER_SCHEMA)
    expect(WORKER_SCHEMA).toMatch(/^test_w\d+$/)
  })
})
