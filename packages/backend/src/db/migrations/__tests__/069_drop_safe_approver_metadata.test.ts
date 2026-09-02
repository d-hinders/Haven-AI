/**
 * Real-Postgres proof for the `safe_approver_metadata` drop (migration 069,
 * #1990, epic #1440 slice 7). No mocks — #1219's rule: assertions about what
 * the database does belong on the real-DB harness.
 *
 * Note the ordering the harness imposes and what it buys. `initDbHarness()`
 * runs the FULL migration set, so by the time a test body runs, 069 has
 * already been applied and the table is already gone. That makes the
 * post-migration state — not a hand-driven `up()` — the thing under test,
 * which is the state production will actually be in. Where a test needs the
 * table back it calls `down()` first, which doubles as the reversibility
 * proof.
 *
 * What this file is really guarding is the SHRINK. #1990 was scoped to three
 * tables and cut to one after enumeration found live readers on the other
 * two (#2020, #2021). A future edit that quietly widens `up()` back to the
 * original three would be a production outage, and the surviving-tables test
 * below is what makes that edit red instead of green.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { up, down, version } from '../069_drop_safe_approver_metadata.js'

async function tableExists(name: string): Promise<boolean> {
  const { rows } = await db.query<{ exists: boolean }>(
    `SELECT to_regclass(current_schema() || '.' || $1) IS NOT NULL AS exists`,
    [name],
  )
  return rows[0].exists
}

async function columnNames(table: string): Promise<string[]> {
  const { rows } = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1
     ORDER BY column_name`,
    [table],
  )
  return rows.map((r) => r.column_name)
}

async function seedUserSafe(n: number): Promise<{ userId: string; safeId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`sam${n}-${Date.now()}@test.example`],
  )
  const userId = user.rows[0].id
  const safe = await db.query<{ id: string }>(
    `INSERT INTO user_safes (user_id, safe_address, chain_id, execution_rail, account_type)
     VALUES ($1, $2, 84532, 'delegation', 'delegator_hybrid') RETURNING id`,
    [userId, `0x${String(n).padStart(40, 'b')}`],
  )
  return { userId, safeId: safe.rows[0].id }
}

describeDb('migration 069: drop safe_approver_metadata (#1990)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  it('the table is gone once the migration set has run', async () => {
    expect(await tableExists('safe_approver_metadata')).toBe(false)
  })

  it('up() is idempotent — re-running against an already-dropped table does not error', async () => {
    await up(db as never)
    await up(db as never)
    expect(await tableExists('safe_approver_metadata')).toBe(false)
  })

  // ── The KEEP half. A deletion slice is judged by what it kept. ────────────

  it('KEEPS user_safes ROWS, not just the table — the #1440 phase-5 owner decision', async () => {
    const { safeId } = await seedUserSafe(1)

    await up(db as never)

    const { rows } = await db.query<{ id: string; account_type: string; execution_rail: string }>(
      `SELECT id, account_type, execution_rail FROM user_safes WHERE id = $1`,
      [safeId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].account_type).toBe('delegator_hybrid')
    expect(rows[0].execution_rail).toBe('delegation')
  })

  // #2263 (epic #1440 slice, migration 075): this guard has now inverted
  // twice, and the reason is the same both times. It began as "KEEPS the two
  // tables split out to #2020 and #2021 — the shrink guard", asserting that
  // 069 deliberately left `agent_allowances` and `approval_requests` alone
  // because each still had live readers. Both have since graduated from
  // "split out, kept" to "actually dropped" by their own migrations —
  // `approval_requests` by 070 (#2021), `agent_allowances` by 075 (#2263),
  // once #2020 deleted its last writer and #1090 moved the agent `allowances`
  // projection onto `agent_delegations`.
  //
  // `initDbHarness()` runs the FULL migration set, so both tables are gone
  // before THIS test's `up()` call runs — before 069 does anything at all.
  // That is not a 069 regression: 069's own `up()` never touched either
  // table, only `safe_approver_metadata`. What survives here is the narrower
  // and still useful claim — that 069 is not the migration that dropped
  // them, and that its scope has stayed exactly as narrow as it was written.
  // Each drop is proven where it happens: `070_drop_approval_requests.test.ts`
  // and `075_drop_inert_safe_rail_schema.test.ts`.
  it('does not itself drop the two tables split out to #2020 and #2021', async () => {
    await up(db as never)

    expect(await tableExists('agent_allowances')).toBe(false)
    expect(await tableExists('approval_requests')).toBe(false)
  })

  // #2055: was "PROVES the approval_requests FK cascade hazard #2021 must
  // not repeat" — demonstrated here, against a still-live `approval_requests`
  // table, BEFORE #2021's migration existed, as the precedent its author
  // would copy. #2021's migration (070) now exists and copied it: the same
  // demonstration — seed an evidence row anchored on an approval, delete the
  // approval, show the evidence row survives the *migration's* CASCADE
  // (not a hand-issued DELETE) — is proven in
  // `070_drop_approval_requests.test.ts` ("the drop severs FKs without
  // touching evidence ROWS — the #2021 hazard, proven"). It cannot be
  // re-proven here: `approval_requests` no longer exists in a DB that has
  // run the full migration set, so `INSERT INTO approval_requests` errors
  // rather than demonstrating anything.

  // ── Reversibility. ───────────────────────────────────────────────────────

  it('down() restores 024\'s exact shape, and up() drops it again', async () => {
    await down(db as never)

    expect(await tableExists('safe_approver_metadata')).toBe(true)
    expect(await columnNames('safe_approver_metadata')).toEqual([
      'address',
      'created_at',
      'id',
      'label',
      'safe_id',
      'type',
      'updated_at',
    ])

    // The lower-cased unique index 024 created, not merely "an index".
    const { rows: idx } = await db.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = current_schema() AND tablename = 'safe_approver_metadata'
         AND indexname = 'safe_approver_metadata_safe_addr'`,
    )
    expect(idx).toHaveLength(1)
    expect(idx[0].indexdef).toContain('lower((address)::text)')

    // And the restored shape actually accepts the row it was designed for.
    const { safeId } = await seedUserSafe(2)
    await db.query(
      `INSERT INTO safe_approver_metadata (safe_id, address, type, label)
       VALUES ($1, '0xAbCd000000000000000000000000000000000001', 'passkey', 'Ledger')`,
      [safeId],
    )
    await expect(
      db.query(
        `INSERT INTO safe_approver_metadata (safe_id, address, type, label)
         VALUES ($1, '0xabcd000000000000000000000000000000000001', 'eoa', 'dup')`,
        [safeId],
      ),
    ).rejects.toThrow(/duplicate key/i)

    await up(db as never)
    expect(await tableExists('safe_approver_metadata')).toBe(false)
  })

  it('dropping the child leaves the user_safes PARENT untouched', async () => {
    const { safeId } = await seedUserSafe(3)
    await down(db as never)
    await db.query(
      `INSERT INTO safe_approver_metadata (safe_id, address) VALUES ($1, '0xcc')`,
      [safeId],
    )

    await up(db as never)

    const { rows } = await db.query(`SELECT id FROM user_safes WHERE id = $1`, [safeId])
    expect(rows).toHaveLength(1)
  })

  // ── #1994's census is not foreclosed. ────────────────────────────────────

  it('#1994 torn-row census still RUNS after the drop — and can still say yes', async () => {
    // The predicate touches only `users` and `user_safes`, both kept. Run it
    // for real rather than asserting that by inspection. LOWER() on both
    // sides is #1994's first recorded trap: `user_safes.safe_address` is
    // VARCHAR(42) with no normalisation.
    const CENSUS = `
      SELECT u.id
      FROM users u
      WHERE u.safe_address IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM user_safes s
          WHERE s.user_id = u.id
            AND LOWER(s.safe_address) = LOWER(u.safe_address)
        )`

    await up(db as never)

    // Healthy pair: mirror set, matching user_safes row, DIFFERENT casing.
    const healthy = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, safe_address)
       VALUES ($1, 'x', '0xDDDD000000000000000000000000000000000001') RETURNING id`,
      [`census-ok-${Date.now()}@test.example`],
    )
    await db.query(
      `INSERT INTO user_safes (user_id, safe_address, chain_id, execution_rail, account_type)
       VALUES ($1, '0xdddd000000000000000000000000000000000001', 84532, 'delegation', 'delegator_hybrid')`,
      [healthy.rows[0].id],
    )

    // A positive control BEFORE any zero is allowed to mean anything: this
    // census must be able to return a row, or its emptiness proves nothing.
    const torn = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, safe_address)
       VALUES ($1, 'x', '0xeeee000000000000000000000000000000000002') RETURNING id`,
      [`census-torn-${Date.now()}@test.example`],
    )

    const { rows } = await db.query<{ id: string }>(CENSUS)
    expect(rows.map((r) => r.id)).toEqual([torn.rows[0].id])
    // The case-only difference did NOT register as torn — trap one, held.
    expect(rows.map((r) => r.id)).not.toContain(healthy.rows[0].id)
  })
})

describe('migration 069 registration', () => {
  it('exports up, down and a version matching its filename', () => {
    expect(typeof up).toBe('function')
    expect(typeof down).toBe('function')
    expect(version).toBe('069_drop_safe_approver_metadata')
  })
})
