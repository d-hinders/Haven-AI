/**
 * Real-Postgres proof for migration 121 — `agents.avatar_tint` (#4429, epic
 * #4428 slice 1). No mocks — #1219's rule.
 *
 * Pins:
 *   - the column exists at head, `smallint`, `NOT NULL`, no default, with the
 *     1..6 CHECK;
 *   - the two triggers and the four functions this migration adds exist at
 *     head, and `down()` removes every one of them;
 *   - `up()` restores the column AND the assignment behaviour — a plain
 *     `INSERT INTO agents` that does not name `avatar_tint` still gets one,
 *     which is the whole reason the trigger exists (127 insert sites, old
 *     replicas during a rolling deploy).
 *
 * The assignment RULES themselves (held / released / inherited / backfill
 * order) are proven against real Postgres in
 * `infra/repositories/__tests__/agents-avatar-tint.db.test.ts`.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import db from '../../../db.js'
import {
  assertWorkerSchemaAtHead,
  describeDb,
  initDbHarness,
  resetDb,
  withMigrationReverted,
} from '../../../infra/__tests__/helpers/db-harness.js'
import { down, up, version } from '../121_agents_avatar_tint.js'

async function run(step: typeof up): Promise<void> {
  const client = await db.connect()
  try {
    await step(client)
  } finally {
    client.release()
  }
}

const columns = () =>
  db.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'agents'
        AND column_name = 'avatar_tint'`,
  )

const checkConstraint = () =>
  db.query<{ conname: string; definition: string }>(
    `SELECT c.conname, pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = current_schema() AND t.relname = 'agents'
        AND c.conname = 'agents_avatar_tint_range'`,
  )

const triggers = () =>
  db.query<{ tgname: string }>(
    `SELECT t.tgname
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relname = 'agents'
        AND NOT t.tgisinternal
      ORDER BY t.tgname`,
  )

const functions = () =>
  db.query<{ proname: string }>(
    `SELECT p.proname
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = current_schema()
        AND p.proname IN (
          'agent_holds_avatar_tint',
          'agent_next_avatar_tint',
          'agent_least_used_avatar_tint',
          'agents_assign_avatar_tint_on_insert',
          'agents_inherit_avatar_tint_on_supersede'
        )
      ORDER BY p.proname`,
  )

async function insertUser(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`${randomUUID()}@example.com`],
  )
  return rows[0].id
}

describeDb('migration 121 — agents.avatar_tint (#4429)', () => {
  beforeAll(async () => {
    await initDbHarness()
    // Re-apply THIS source over the worker schema, so every case below tests
    // the migration as written now — not a schema an earlier run left behind.
    await resetDb()
    try {
      await run(down)
    } finally {
      await run(up)
    }
  })

  beforeEach(async () => {
    await resetDb()
  })

  it('is registered as version 121_agents_avatar_tint', () => {
    expect(version).toBe('121_agents_avatar_tint')
  })

  it('the schema is at head with a NOT NULL, defaultless smallint and the 1..6 CHECK', async () => {
    await assertWorkerSchemaAtHead()
    expect((await columns()).rows).toEqual([
      { column_name: 'avatar_tint', data_type: 'smallint', is_nullable: 'NO', column_default: null },
    ])
    const check = await checkConstraint()
    expect(check.rows).toHaveLength(1)
    expect(check.rows[0].definition).toContain('avatar_tint')
    expect(check.rows[0].definition).toContain('1')
    expect(check.rows[0].definition).toContain('6')
  })

  it('the two triggers and the five functions exist at head', async () => {
    expect((await triggers()).rows.map((r) => r.tgname)).toEqual([
      'agents_assign_avatar_tint',
      'agents_inherit_avatar_tint',
    ])
    expect((await functions()).rows.map((r) => r.proname)).toEqual([
      'agent_holds_avatar_tint',
      'agent_least_used_avatar_tint',
      'agent_next_avatar_tint',
      'agents_assign_avatar_tint_on_insert',
      'agents_inherit_avatar_tint_on_supersede',
    ])
  })

  it('down() removes the column, the CHECK, both triggers and every function; up() restores them', async () => {
    await withMigrationReverted(
      () => run(down),
      async () => {
        expect((await columns()).rows).toEqual([])
        expect((await checkConstraint()).rows).toEqual([])
        expect((await triggers()).rows).toEqual([])
        expect((await functions()).rows).toEqual([])
      },
      () => run(up),
    )
    expect((await columns()).rows).toHaveLength(1)
    expect((await triggers()).rows).toHaveLength(2)
    expect((await functions()).rows).toHaveLength(5)
  })

  it('after a down/up cycle a plain INSERT that does not name avatar_tint still gets one', async () => {
    await withMigrationReverted(
      () => run(down),
      async () => {
        expect((await columns()).rows).toEqual([])
      },
      () => run(up),
    )
    const userId = await insertUser()
    const { rows } = await db.query<{ avatar_tint: number }>(
      `INSERT INTO agents (user_id, name) VALUES ($1, '121 agent') RETURNING avatar_tint`,
      [userId],
    )
    expect(rows[0].avatar_tint).toBe(1)
  })

  it('the CHECK refuses a tint outside 1..6', async () => {
    const userId = await insertUser()
    await expect(
      db.query(`INSERT INTO agents (user_id, name, avatar_tint) VALUES ($1, 'bad', 7)`, [userId]),
    ).rejects.toThrow(/agents_avatar_tint_range/)
  })
})
