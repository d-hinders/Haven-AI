/**
 * Contract: `resetDb()` alone is a SAFE first harness call (#1562 follow-up).
 *
 * The #1555/#1559 outbound test files called `initDbHarness()` bare at
 * describe-registration time, never awaiting it — so whenever a new migration
 * actually had to apply, their first tests ran concurrently with the worker's
 * own migration DDL (CI: 42P01 "relation does not exist", then 40P01 deadlocks
 * between the DDL's locks and the tests' queries — three hits on 2026-08-19,
 * all on PRs that touched no backend code).
 *
 * The fix has two halves: those call sites now await in `beforeAll`, and —
 * the half THIS file pins — `resetDb()` awaits `initDbHarness()` itself, so
 * any future file that forgets the await degrades to correct instead of to a
 * race. This file deliberately performs NO explicit init: `resetDb()` in
 * `beforeEach` is its first and only harness call, and the test then requires
 * a migrated table to already be queryable. Under the pre-fix harness this
 * ordering was unguaranteed (race-dependent whenever this file was a worker's
 * first and migrations were pending); under the fixed harness it is a
 * guarantee.
 */
import { beforeEach, expect, it } from 'vitest'
import db from '../../../../db.js'
import { describeDb, resetDb } from '../db-harness.js'

describeDb('resetDb as the first harness call (#1562 follow-up)', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('runs against a fully migrated schema — no awaited initDbHarness needed at the call site', async () => {
    // outbound_txs is the newest migration-created table (061) — exactly the
    // relation the un-awaited init raced. If resetDb did not bring the schema
    // to head first, this SELECT is the 42P01 the CI flake produced.
    const { rows } = await db.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM outbound_txs')
    expect(rows[0].n).toBe('0')
  })
})
