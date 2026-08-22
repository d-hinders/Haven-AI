/**
 * #1562 — the worker schema is the WHOLE search_path.
 *
 * The hazard this pins shut: with `test_wN,public` a worker schema missing a
 * table silently resolved unqualified names to the SHARED public table, where
 * rows persist across runs and workers — a test once saw a 'mined' row it
 * never created. The contract now: a table that exists ONLY in public is
 * INVISIBLE here; a missing table errors loudly instead of aliasing shared
 * state. Mutation-proven by re-adding `,public` in vitest.setup.ts — both
 * tests fail.
 */
import { afterAll, beforeAll, expect, it } from 'vitest'
import db from '../../db.js'
import { WORKER_SCHEMA, describeDb, initDbHarness } from './helpers/db-harness.js'

// Worker-scoped (review finding): a fixed name in SHARED public would let two
// overlapping runs against one Postgres race each other's create/drop — the
// exact bug class this file exists to pin shut, reproduced in miniature.
const CANARY = `harness_isolation_canary_1562_${WORKER_SCHEMA}`

describeDb('db-harness isolation (#1562)', () => {
  beforeAll(async () => {
    // #1763: this was a bare `initDbHarness()` at describe-REGISTRATION time —
    // the un-awaited shape the harness docs warn about (#1555/#1559). A
    // `describe.skip` body still executes to collect its skipped tests, so on
    // a machine with no database the un-awaited promise rejected into an
    // unhandled error and the "skipped" file failed anyway. Awaited in
    // `beforeAll`, per the documented convention.
    await initDbHarness()
    await db.query(`CREATE TABLE IF NOT EXISTS public.${CANARY} (id INT)`)
    await db.query(`INSERT INTO public.${CANARY} VALUES (1)`)
  })

  afterAll(async () => {
    await db.query(`DROP TABLE IF EXISTS public.${CANARY}`)
  })

  it('a table that exists only in public is INVISIBLE unqualified — no silent fallback', async () => {
    await expect(db.query(`SELECT * FROM ${CANARY}`)).rejects.toThrow(/does not exist/)
  })

  it('the search_path contains exactly the worker schema', async () => {
    const { rows } = await db.query<{ search_path: string }>(`SHOW search_path`)
    expect(rows[0].search_path).toMatch(/^"?test_w\d+"?$/)
    expect(rows[0].search_path).not.toContain('public')
  })
})
