/**
 * Real-Postgres proof for migration 115 — the feedback retention window is
 * 168 hours whatever the session `TimeZone` (#4084). No mocks — #1219's rule.
 *
 * `NOW()` cannot be moved, so a test that only inserts a row proves the
 * window only when the wall clock happens to sit within a week of a DST
 * change (that is how 106's own test found this, locally, on 2026-10-19).
 * The proof here is deterministic instead: it reads the column default as
 * Postgres stores it and evaluates THAT expression at a fixed instant just
 * before a DST change, in a session pinned to a zone that has one — so CI's
 * UTC server exercises the Stockholm path too.
 *
 * Pins:
 *   - at head, the default is exactly 168 h across autumn and spring DST in
 *     `Europe/Stockholm`, across `America/New_York`'s, and in UTC;
 *   - with 115 reverted (106's `INTERVAL '7 days'`) the same evaluation reads
 *     169 h — the instrument can say no;
 *   - the real write path (`insertFeedback`) in a Stockholm session gets an
 *     exact 168 h window (both columns share one `NOW()`);
 *   - `up()` is idempotent and `down()` restores 106's default.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import type { PoolClient } from 'pg'
import db from '../../../db.js'
import {
  assertWorkerSchemaAtHead,
  describeDb,
  initDbHarness,
  resetDb,
  withMigrationReverted,
} from '../../../infra/__tests__/helpers/db-harness.js'
import { insertFeedback } from '../../../infra/repositories/feedback.js'
import { down, up, version } from '../115_feedback_expires_at_fixed_window.js'

const WINDOW_SECONDS = 168 * 60 * 60

// One instant ~13 h before each zone's DST change, so a calendar-day interval
// crosses it and an elapsed-time one does not.
const STOCKHOLM_AUTUMN = '2026-10-24T12:00:00Z' // clocks go back 2026-10-25 01:00 UTC
const STOCKHOLM_SPRING = '2027-03-27T12:00:00Z' // clocks go forward 2027-03-28 01:00 UTC
const NEW_YORK_AUTUMN = '2026-10-31T19:00:00Z' // clocks go back 2026-11-01 06:00 UTC

async function run(step: typeof up): Promise<void> {
  const client = await db.connect()
  try {
    await step(client)
  } finally {
    client.release()
  }
}

/** `body` runs in a transaction whose session `TimeZone` is `timeZone`; always rolled back. */
async function inTimeZone<T>(timeZone: string, body: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('TimeZone', $1, true)`, [timeZone])
    return await body(client)
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
}

async function expiresAtDefault(): Promise<string> {
  const { rows } = await db.query<{ column_default: string | null }>(
    `SELECT column_default FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'feedback' AND column_name = 'expires_at'`,
  )
  const expr = rows[0]?.column_default
  if (!expr) throw new Error('feedback.expires_at has no default')
  return expr
}

/**
 * Seconds between `anchor` and the stored `expires_at` default evaluated as
 * if `NOW()` were `anchor`, in a session zoned `timeZone`.
 */
async function windowSecondsAt(timeZone: string, anchor: string): Promise<number> {
  const expr = await expiresAtDefault()
  // The substitution must hit exactly once, or this would evaluate something
  // other than the default (and a missing `now()` would read as a constant).
  expect(expr.split('now()').length - 1).toBe(1)
  const atAnchor = expr.replace('now()', '$1::timestamptz')
  return inTimeZone(timeZone, async (client) => {
    const { rows } = await client.query<{ seconds: number }>(
      `SELECT EXTRACT(EPOCH FROM ((${atAnchor}) - $1::timestamptz))::float8 AS seconds`,
      [anchor],
    )
    return rows[0].seconds
  })
}

async function insertTestUser(): Promise<string> {
  const email = `${randomBytes(8).toString('hex')}@example.com`
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [email],
  )
  return rows[0].id
}

describeDb(`migration ${version}`, () => {
  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
  })
  afterAll(async () => {
    await run(up)
    await assertWorkerSchemaAtHead()
  })

  it.each([
    ['Europe/Stockholm', STOCKHOLM_AUTUMN],
    ['Europe/Stockholm', STOCKHOLM_SPRING],
    ['America/New_York', NEW_YORK_AUTUMN],
    ['UTC', STOCKHOLM_AUTUMN],
  ])('the default is exactly 168 h in %s from %s', async (timeZone, anchor) => {
    expect(await windowSecondsAt(timeZone, anchor)).toBe(WINDOW_SECONDS)
  })

  it("with 115 reverted, 106's calendar-day default drifts by an hour across DST", async () => {
    await withMigrationReverted(
      () => run(down),
      async () => {
        expect(await windowSecondsAt('Europe/Stockholm', STOCKHOLM_AUTUMN)).toBe(WINDOW_SECONDS + 3600)
        expect(await windowSecondsAt('Europe/Stockholm', STOCKHOLM_SPRING)).toBe(WINDOW_SECONDS - 3600)
        expect(await windowSecondsAt('UTC', STOCKHOLM_AUTUMN)).toBe(WINDOW_SECONDS)
      },
      () => run(up),
    )
  })

  it('a row written through insertFeedback in a Stockholm session expires exactly 168 h after it was created', async () => {
    const userId = await insertTestUser()
    const row = await inTimeZone('Europe/Stockholm', (client) => insertFeedback(userId, 'hello', client))
    const windowMs = new Date(row.expires_at).getTime() - new Date(row.created_at).getTime()
    expect(windowMs).toBe(WINDOW_SECONDS * 1000)
  })

  it("up() is idempotent and down() restores 106's default", async () => {
    await run(up)
    await run(up)
    expect(await expiresAtDefault()).toBe("(now() + '168:00:00'::interval)")
    await withMigrationReverted(
      () => run(down),
      async () => {
        expect(await expiresAtDefault()).toBe("(now() + '7 days'::interval)")
      },
      () => run(up),
    )
  })
})
