/**
 * Real-Postgres proof for migration 118 — "Needs attention" acknowledgements
 * (#4324). No mocks — #1219's rule.
 *
 * Pins:
 *   - the widened kind/shape CHECK accepts exactly the new shapes and still
 *     refuses an unknown kind and every wrong pairing (`budget-usage` without
 *     its period end, `haven-paused` with an agent, a period end on any other
 *     kind);
 *   - the two new partial unique indexes dedupe per (user, kind, agent) and
 *     per (user, kind) for the user-level kinds, while a user's two backup
 *     dismissals (both agent-less) still coexist;
 *   - `acknowledged_at` is NOT NULL, defaults to now, and the backfill set an
 *     existing 111 row's `acknowledged_at` to its `created_at`;
 *   - `down()` deletes the new-kind rows before narrowing the CHECK, keeps the
 *     111 rows, and `up()` restores the schema (idempotent).
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import db from '../../../db.js'
import {
  assertWorkerSchemaAtHead,
  describeDb,
  initDbHarness,
  resetDb,
  withMigrationReverted,
} from '../../../infra/__tests__/helpers/db-harness.js'
import { down, up, version } from '../118_attention_acknowledgements.js'

async function run(step: typeof up): Promise<void> {
  const client = await db.connect()
  try {
    await step(client)
  } finally {
    client.release()
  }
}

async function insertTestUser(): Promise<string> {
  const email = `${randomBytes(8).toString('hex')}@example.com`
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [email],
  )
  return rows[0].id
}

async function insertTestAccount(userId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address) VALUES ($1, $2) RETURNING id`,
    [userId, `0x${randomUUID().replaceAll('-', '').padEnd(40, '0')}`],
  )
  return rows[0].id
}

async function insertTestAgent(userId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name, api_key_hash, delegate_address)
     VALUES ($1, 'ack-agent', 'hash', $2)
     RETURNING id`,
    // A distinct delegate per agent: (user_id, delegate_address) is unique
    // among non-revoked agents.
    [userId, `0x${randomUUID().replaceAll('-', '').padEnd(40, 'c')}`],
  )
  return rows[0].id
}

const insert = (
  userId: string,
  kind: string,
  ids: { accountId?: string | null; agentId?: string | null; periodEnd?: string | null } = {},
) =>
  db.query(
    `INSERT INTO attention_dismissals (user_id, item_kind, account_id, agent_id, acknowledged_period_end)
     VALUES ($1, $2, $3, $4, $5::timestamptz)`,
    [userId, kind, ids.accountId ?? null, ids.agentId ?? null, ids.periodEnd ?? null],
  )

const PERIOD_END = '2026-11-01T00:00:00.000Z'

describeDb('migration 118 — attention acknowledgements (#4324)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  it('is registered as version 118_attention_acknowledgements', () => {
    expect(version).toBe('118_attention_acknowledgements')
  })

  it('the schema is at head with both new indexes and columns', async () => {
    await assertWorkerSchemaAtHead()
    const indexes = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = current_schema() AND tablename = 'attention_dismissals'`,
    )
    const names = indexes.rows.map((row) => row.indexname)
    expect(names).toContain('idx_attention_ack_per_agent')
    expect(names).toContain('idx_attention_ack_per_user')

    const columns = await db.query<{ column_name: string; is_nullable: string; column_default: string | null }>(
      `SELECT column_name, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'attention_dismissals'
          AND column_name IN ('acknowledged_at', 'acknowledged_period_end')
        ORDER BY column_name`,
    )
    expect(columns.rows).toEqual([
      { column_name: 'acknowledged_at', is_nullable: 'NO', column_default: 'now()' },
      { column_name: 'acknowledged_period_end', is_nullable: 'YES', column_default: null },
    ])
  })

  it('accepts every new shape', async () => {
    const userId = await insertTestUser()
    const agentId = await insertTestAgent(userId)
    for (const kind of ['budget-reached', 'budget-scope', 'payments-failed']) {
      await insert(userId, kind, { agentId })
    }
    await insert(userId, 'budget-usage', { agentId, periodEnd: PERIOD_END })
    await insert(userId, 'haven-paused')
    await insert(userId, 'payments-failed')
    const { rows } = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM attention_dismissals WHERE user_id = $1`,
      [userId],
    )
    expect(rows[0].n).toBe(6)
  })

  it('refuses an unknown kind and every wrong pairing (CHECK)', async () => {
    const userId = await insertTestUser()
    const agentId = await insertTestAgent(userId)
    const accountId = await insertTestAccount(userId)
    const refused = [
      insert(userId, 'low-balance', { accountId }),
      insert(userId, 'zero-usdc'),
      insert(userId, 'budget-usage', { agentId }),
      insert(userId, 'budget-reached'),
      insert(userId, 'budget-reached', { agentId, periodEnd: PERIOD_END }),
      insert(userId, 'budget-scope', { agentId, accountId }),
      insert(userId, 'haven-paused', { agentId }),
      insert(userId, 'payments-failed', { accountId }),
      insert(userId, 'needs-setup', { agentId, periodEnd: PERIOD_END }),
      insert(userId, 'no-backup', { accountId, periodEnd: PERIOD_END }),
    ]
    for (const attempt of refused) {
      await expect(attempt).rejects.toMatchObject({ code: '23514' })
    }
  })

  it('dedupes per (user, kind, agent) and per (user, kind) for user-level kinds; backup rows still coexist', async () => {
    const userId = await insertTestUser()
    const agentId = await insertTestAgent(userId)
    const otherAgent = await insertTestAgent(userId)

    await insert(userId, 'budget-reached', { agentId })
    await expect(insert(userId, 'budget-reached', { agentId })).rejects.toMatchObject({ code: '23505' })
    // Another kind for the same agent, and the same kind for another agent, are separate rows.
    await insert(userId, 'budget-scope', { agentId })
    await insert(userId, 'budget-reached', { agentId: otherAgent })

    await insert(userId, 'haven-paused')
    await expect(insert(userId, 'haven-paused')).rejects.toMatchObject({ code: '23505' })
    // The unattributed payments-failed is its own user-level row, beside the agent one.
    await insert(userId, 'payments-failed')
    await insert(userId, 'payments-failed', { agentId })
    await expect(insert(userId, 'payments-failed')).rejects.toMatchObject({ code: '23505' })

    // Two backup dismissals of one user have no agent either: the user-level
    // index's `account_id IS NULL` keeps them out of its scope.
    await insert(userId, 'no-backup', { accountId: await insertTestAccount(userId) })
    await insert(userId, 'no-backup', { accountId: await insertTestAccount(userId) })
  })

  it('acknowledged_at defaults to now on a new row', async () => {
    const userId = await insertTestUser()
    await insert(userId, 'haven-paused')
    const { rows } = await db.query<{ lag: number }>(
      `SELECT EXTRACT(EPOCH FROM (NOW() - acknowledged_at))::float AS lag
         FROM attention_dismissals WHERE user_id = $1`,
      [userId],
    )
    expect(Math.abs(rows[0].lag)).toBeLessThan(60)
  })

  it('down() deletes the new-kind rows first and keeps 111 rows; up() backfills acknowledged_at from created_at', async () => {
    const userId = await insertTestUser()
    const agentId = await insertTestAgent(userId)
    const accountId = await insertTestAccount(userId)
    await db.query(
      `INSERT INTO attention_dismissals (user_id, item_kind, account_id, created_at)
       VALUES ($1, 'no-backup', $2, '2026-10-10T12:00:00Z')`,
      [userId, accountId],
    )
    await insert(userId, 'budget-reached', { agentId })
    await insert(userId, 'haven-paused')

    await withMigrationReverted(
      () => run(down),
      async () => {
        const rows = await db.query<{ item_kind: string }>(
          `SELECT item_kind FROM attention_dismissals WHERE user_id = $1`,
          [userId],
        )
        expect(rows.rows.map((row) => row.item_kind)).toEqual(['no-backup'])
        const columns = await db.query(
          `SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'attention_dismissals'
              AND column_name IN ('acknowledged_at', 'acknowledged_period_end')`,
        )
        expect(columns.rowCount).toBe(0)
        // The narrow 111 CHECK is back: a new kind is refused again. (The
        // insert names only 111's columns — 118's are gone here.)
        await expect(
          db.query(`INSERT INTO attention_dismissals (user_id, item_kind) VALUES ($1, 'haven-paused')`, [userId]),
        ).rejects.toMatchObject({ code: '23514' })
      },
      () => run(up),
    )

    // Restored by up(): the surviving 111 row was backfilled from its created_at.
    const { rows } = await db.query<{ acknowledged_at: Date }>(
      `SELECT acknowledged_at FROM attention_dismissals WHERE user_id = $1 AND item_kind = 'no-backup'`,
      [userId],
    )
    expect(rows[0].acknowledged_at.toISOString()).toBe('2026-10-10T12:00:00.000Z')
    await run(up) // idempotent
    await assertWorkerSchemaAtHead()
  })
})
