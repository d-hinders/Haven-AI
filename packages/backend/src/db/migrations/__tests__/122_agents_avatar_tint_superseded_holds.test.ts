/**
 * Real-Postgres proof for migration 122 — a superseded agent keeps holding its
 * tint until it is archived (#4448, epic #4428 finding B1). No mocks — #1219's
 * rule.
 *
 * Pins:
 *   - at head, `agent_holds_avatar_tint` takes ONE argument (`archived_at`) and
 *     the inheritance trigger and its function are gone;
 *   - `down()` restores 121's shape — the two-argument predicate, the
 *     inheritance trigger and its function — and `up()` puts 122 back on top;
 *   - the worker schema is left at head, so the tests that follow see 122.
 *
 * The RULES themselves (supersede, archive, several predecessors, the backfill
 * and unarchive) are proven against real Postgres in
 * `infra/repositories/__tests__/agents-avatar-tint-122.db.test.ts`.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import {
  assertWorkerSchemaAtHead,
  describeDb,
  initDbHarness,
  resetDb,
  withMigrationReverted,
} from '../../../infra/__tests__/helpers/db-harness.js'
import { down, up, version } from '../122_agents_avatar_tint_superseded_holds.js'

async function run(step: typeof up): Promise<void> {
  const client = await db.connect()
  try {
    await step(client)
  } finally {
    client.release()
  }
}

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

const holdsSignatures = () =>
  db.query<{ args: string }>(
    `SELECT pg_get_function_identity_arguments(p.oid) AS args
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = current_schema()
        AND p.proname = 'agent_holds_avatar_tint'
      ORDER BY args`,
  )

describeDb('migration 122 — a superseded agent holds its tint (#4448)', () => {
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

  it('is registered as version 122_agents_avatar_tint_superseded_holds', () => {
    expect(version).toBe('122_agents_avatar_tint_superseded_holds')
  })

  it('the schema is at head with one trigger, four functions and a one-argument held predicate', async () => {
    await assertWorkerSchemaAtHead()
    expect((await triggers()).rows.map((r) => r.tgname)).toEqual(['agents_assign_avatar_tint'])
    expect((await functions()).rows.map((r) => r.proname)).toEqual([
      'agent_holds_avatar_tint',
      'agent_least_used_avatar_tint',
      'agent_next_avatar_tint',
      'agents_assign_avatar_tint_on_insert',
    ])
    expect((await holdsSignatures()).rows).toEqual([{ args: 'p_archived_at timestamp with time zone' }])
  })

  it('down() restores 121\'s inheritance pair and two-argument predicate; up() removes them again', async () => {
    await withMigrationReverted(
      () => run(down),
      async () => {
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
        expect((await holdsSignatures()).rows).toEqual([
          { args: 'p_archived_at timestamp with time zone, p_superseded_by_agent_id uuid' },
        ])
      },
      () => run(up),
    )

    expect((await triggers()).rows.map((r) => r.tgname)).toEqual(['agents_assign_avatar_tint'])
    expect((await functions()).rows).toHaveLength(4)
    expect((await holdsSignatures()).rows).toHaveLength(1)
  })
})
