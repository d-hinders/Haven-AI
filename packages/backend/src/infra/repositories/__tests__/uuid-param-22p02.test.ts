/**
 * #1464 — the PREMISE, proven against real Postgres.
 *
 * The whole issue existed because the route tests mock db.js: Postgres's own
 * uuid type checking never ran, so `PUT /contacts/not-a-uuid` passed in tests
 * and 500'd in production. This file pins what the real database actually does
 * with a malformed uuid — raise `invalid_text_representation` (22P02) — which
 * is the exact error the app error handler now maps to a 400
 * (`infra/http-error-handler.ts`). If Postgres ever stops raising 22P02 for
 * this input, the handler's mapping is dead code and THIS test is what says so.
 */
import { expect, it } from 'vitest'
import { describeDb, resetDb } from '../../__tests__/helpers/db-harness.js'
import db from '../../../db.js'
import { renameContactForUser, deleteContactForUser } from '../contacts.js'

// #1763: the module-scope `await initDbHarness()` that used to sit here ran
// even with no database, throwing past `describeDb`. `resetDb()` awaits init
// as a documented guarantee, so dropping it changes nothing when a database
// IS present — and stops this file being the accidental reason a
// no-database run failed. That job belongs to vitest.global-setup.ts now.

// A REAL uuid, because user_id is also a UUID column — the mocked route tests
// pass 'user-1' everywhere and never learn that real Postgres rejects it.
// This file exists precisely because the mock hides that class.
const USER = '11111111-1111-4111-8111-111111111111'

describeDb('malformed uuid against real Postgres (#1464)', () => {
  it('a non-uuid id raises 22P02 — the code the error handler maps to 400', async () => {
    await resetDb()
    // Straight through the same repository function the route calls. The
    // harness runs real migrations, so contacts.id is a genuine UUID column.
    const err = await renameContactForUser('not-a-uuid', USER, 'X', db).then(
      () => null,
      (e: unknown) => e as { code?: string; message?: string },
    )
    expect(err).not.toBeNull()
    expect(err?.code).toBe('22P02')
    expect(err?.message).toMatch(/invalid input syntax for type uuid/)
  })

  it('a WELL-FORMED unknown uuid does not raise — it returns not-found, as before', async () => {
    await resetDb()
    // The boundary that keeps the 404 semantics intact: a valid uuid that
    // matches nothing is a null result, never an error, so the
    // not-found-or-not-owned indistinguishability is untouched by #1464.
    const row = await renameContactForUser(
      '00000000-0000-4000-8000-000000000000',
      USER,
      'X',
      db,
    )
    expect(row).toBeNull()
    const deleted = await deleteContactForUser(
      '00000000-0000-4000-8000-000000000000',
      USER,
      db,
    )
    expect(deleted).toBe(false)
  })
})
