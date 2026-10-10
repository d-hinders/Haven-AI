/**
 * Real-Postgres proof for migration 111 — the server-saved "Needs you"
 * dismissals table (#3813). No mocks — #1219's rule.
 *
 * Pins: the table and its two partial unique indexes exist; the kind/shape
 * CHECK is enforced by the database (a `no-backup` row without an account
 * and a `needs-setup` row without an agent are both refused); the partial
 * unique indexes actually dedupe (one dismissal per user per account, one
 * per user per agent, but an account dismissal and an agent dismissal
 * coexist); the cascades fire (a deleted user, account or agent takes its
 * dismissals with it); `up()` is idempotent; and `down()` drops exactly
 * what `up()` created.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import db from '../../../db.js'
import {
  assertWorkerSchemaAtHead,
  describeDb,
  initDbHarness,
  resetDb,
} from '../../../infra/__tests__/helpers/db-harness.js'
import { down, up, version } from '../111_attention_dismissals.js'

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
    // A distinct address per account: (user_id, account_address, chain_id)
    // is UNIQUE, so two fixture accounts of one user cannot share an address.
    [userId, `0x${randomUUID().replaceAll('-', '').padEnd(40, '0')}`],
  )
  return rows[0].id
}

async function insertTestAgent(userId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name, api_key_hash, delegate_address)
     VALUES ($1, 'budgetless-agent', 'hash', '0x${'b'.repeat(40)}')
     RETURNING id`,
    [userId],
  )
  return rows[0].id
}

/** The shape a correct no-backup row has; columns overridden per call. */
const BACKUP_ROW = `INSERT INTO attention_dismissals (user_id, item_kind, account_id)
                    VALUES ($1, 'no-backup', $2)`

describeDb('migration 111 — attention_dismissals (#3813)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  it('is registered as version 111_attention_dismissals', () => {
    expect(version).toBe('111_attention_dismissals')
  })

  it('the schema is at head with the table and its indexes in place', async () => {
    await assertWorkerSchemaAtHead()

    const table = await db.query(
      `SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = 'attention_dismissals'`,
    )
    expect(table.rowCount).toBe(1)

    const indexes = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = current_schema() AND tablename = 'attention_dismissals'
        ORDER BY indexname`,
    )
    expect(indexes.rows.map((row) => row.indexname)).toContain(
      'idx_attention_dismissals_backup_per_account',
    )
    expect(indexes.rows.map((row) => row.indexname)).toContain(
      'idx_attention_dismissals_setup_per_agent',
    )
  })

  it('refuses a no-backup row without an account and a needs-setup row without an agent (CHECK)', async () => {
    const userId = await insertTestUser()

    await expect(
      db.query(`INSERT INTO attention_dismissals (user_id, item_kind) VALUES ($1, 'no-backup')`, [
        userId,
      ]),
    ).rejects.toMatchObject({ code: '23514' })

    await expect(
      db.query(`INSERT INTO attention_dismissals (user_id, item_kind) VALUES ($1, 'needs-setup')`, [
        userId,
      ]),
    ).rejects.toMatchObject({ code: '23514' })

    // An unknown kind is refused outright — a future dismissible kind has to
    // extend the constraint in a new migration, not sneak in here.
    await expect(
      db.query(`INSERT INTO attention_dismissals (user_id, item_kind, account_id) VALUES ($1, 'low-balance', $2)`, [
        userId,
        '00000000-0000-0000-0000-000000000000',
      ]),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('dedupes per (user, account) and per (user, agent), and lets the kinds coexist', async () => {
    const userId = await insertTestUser()
    const accountId = await insertTestAccount(userId)
    const agentId = await insertTestAgent(userId)

    await db.query(BACKUP_ROW, [userId, accountId])
    // The same dismissal again — the partial unique index refuses it.
    await expect(db.query(BACKUP_ROW, [userId, accountId])).rejects.toMatchObject({
      code: '23505',
    })
    // A second account is its own dismissal.
    const accountId2 = await insertTestAccount(userId)
    await db.query(BACKUP_ROW, [userId, accountId2])

    await db.query(
      `INSERT INTO attention_dismissals (user_id, item_kind, agent_id) VALUES ($1, 'needs-setup', $2)`,
      [userId, agentId],
    )
    // The same agent's dismissal again — refused by the other partial index.
    await expect(
      db.query(
        `INSERT INTO attention_dismissals (user_id, item_kind, agent_id) VALUES ($1, 'needs-setup', $2)`,
        [userId, agentId],
      ),
    ).rejects.toMatchObject({ code: '23505' })

    const rows = await db.query<{ item_kind: string; account_id: string | null }>(
      `SELECT item_kind, account_id FROM attention_dismissals WHERE user_id = $1 ORDER BY account_id NULLS LAST`,
      [userId],
    )
    expect(rows.rows).toHaveLength(3)
    expect(rows.rows.filter((row) => row.item_kind === 'no-backup')).toHaveLength(2)
    expect(rows.rows.filter((row) => row.item_kind === 'needs-setup')).toHaveLength(1)
  })

  it('cascades on user, account and agent deletion', async () => {
    const userId = await insertTestUser()
    const accountId = await insertTestAccount(userId)
    const agentId = await insertTestAgent(userId)
    await db.query(BACKUP_ROW, [userId, accountId])
    await db.query(
      `INSERT INTO attention_dismissals (user_id, item_kind, agent_id) VALUES ($1, 'needs-setup', $2)`,
      [userId, agentId],
    )

    await db.query(`DELETE FROM agents WHERE id = $1`, [agentId])
    expect(
      (await db.query(`SELECT 1 FROM attention_dismissals WHERE agent_id = $1`, [agentId]))
        .rowCount,
    ).toBe(0)

    await db.query(`DELETE FROM smart_accounts WHERE id = $1`, [accountId])
    expect(
      (await db.query(`SELECT 1 FROM attention_dismissals WHERE account_id = $1`, [accountId]))
        .rowCount,
    ).toBe(0)

    await db.query(`DELETE FROM users WHERE id = $1`, [userId])
    expect(
      (await db.query(`SELECT COUNT(*)::int AS n FROM attention_dismissals WHERE user_id = $1`, [
        userId,
      ])).rows[0].n,
    ).toBe(0)
  })

  it('up() is idempotent and down() drops exactly what up() created', async () => {
    await run(up) // already applied at head — a second run must be a no-op

    await run(down)
    const table = await db.query(
      `SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = 'attention_dismissals'`,
    )
    expect(table.rowCount).toBe(0)

    await run(up)
    const restored = await db.query(
      `SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = 'attention_dismissals'`,
    )
    expect(restored.rowCount).toBe(1)
  })
})
