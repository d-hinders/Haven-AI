/**
 * Real-Postgres proof for migration 093 — agent labels (#3167). No mocks —
 * #1219's rule.
 *
 * Pins the issue's acceptance criteria at the schema level: the label
 * vocabulary is unique per user on the LOWERCASED name (one "prod", not
 * "prod" and "Prod"), an agent cannot carry the same label twice, deleting a
 * label removes only its assignments (the agents rows are untouched — the
 * issue's "never deletes or alters agents"), deleting an agent removes its
 * assignments, and `down()` drops exactly what `up()` created.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import db from '../../../db.js'
import {
  assertWorkerSchemaAtHead,
  describeDb,
  initDbHarness,
  resetDb,
  withMigrationReverted,
} from '../../../infra/__tests__/helpers/db-harness.js'
import { down, up, version } from '../093_agent_labels.js'

async function runUp(): Promise<void> {
  const client = await db.connect()
  try {
    await up(client)
  } finally {
    client.release()
  }
}

async function runDown(): Promise<void> {
  const client = await db.connect()
  try {
    await down(client)
  } finally {
    client.release()
  }
}

let seq = 0

async function seedUser(): Promise<string> {
  seq += 1
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`labels-mig-${seq}-${Date.now()}@test.example`],
  )
  return rows[0].id
}

async function seedAgent(userId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name, delegate_address, status)
     VALUES ($1, 'a', $2, 'active') RETURNING id`,
    [userId, '0x' + 'ab'.repeat(20)],
  )
  return rows[0].id
}

async function insertLabel(userId: string, name: string, color = 'neutral'): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO agent_labels (user_id, name, color) VALUES ($1, $2, $3) RETURNING id`,
    [userId, name, color],
  )
  return rows[0].id
}

describeDb('migration 093_agent_labels', () => {
  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
  })
  afterAll(async () => {
    await assertWorkerSchemaAtHead()
  })

  it('names itself', () => {
    expect(version).toBe('093_agent_labels')
  })

  it('creates both tables and down() drops them', async () => {
    await runUp()
    // Scoped to the worker's own schema: pg_tables sees every schema in the
    // cluster, and the shared reference schema carries the same tables.
    const present = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_tables
       WHERE schemaname = current_schema()
         AND tablename IN ('agent_labels', 'agent_label_assignments')`,
    )
    expect(present.rows[0].count).toBe('2')
    // withMigrationReverted restores migration head even when the body throws
    // (#1372): the assertion lives inside, down()/up() around it.
    await withMigrationReverted(
      () => runDown(),
      async () => {
        const gone = await db.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM pg_tables
           WHERE schemaname = current_schema()
             AND tablename IN ('agent_labels', 'agent_label_assignments')`,
        )
        expect(gone.rows[0].count).toBe('0')
      },
      () => runUp(),
    )
  })

  it('is idempotent (IF NOT EXISTS re-run)', async () => {
    await runUp()
    await runUp()
  })

  it('enforces one label name per user on the LOWERCASED name', async () => {
    await runUp()
    const userId = await seedUser()
    await insertLabel(userId, 'prod')
    // Case variant of the same name is the same label: 23505 on the unique index.
    await expect(insertLabel(userId, 'Prod')).rejects.toMatchObject({ code: '23505' })
    // The same name on ANOTHER user is a different label — per-user scope.
    const other = await seedUser()
    await expect(insertLabel(other, 'PROD')).resolves.toBeDefined()
  })

  it('rejects blank and over-long names', async () => {
    await runUp()
    const userId = await seedUser()
    await expect(insertLabel(userId, '   ')).rejects.toMatchObject({ code: '23514' })
    await expect(insertLabel(userId, 'x'.repeat(65))).rejects.toMatchObject({ code: '22001' })
  })

  it('keeps assignment unique per (agent, label) pair', async () => {
    await runUp()
    const userId = await seedUser()
    const agentId = await seedAgent(userId)
    const labelId = await insertLabel(userId, 'prod')
    await db.query(
      `INSERT INTO agent_label_assignments (agent_id, label_id) VALUES ($1, $2)`,
      [agentId, labelId],
    )
    await expect(
      db.query(`INSERT INTO agent_label_assignments (agent_id, label_id) VALUES ($1, $2)`, [
        agentId,
        labelId,
      ]),
    ).rejects.toMatchObject({ code: '23505' })
  })

  it('deleting a label removes its assignments and never touches agents', async () => {
    await runUp()
    const userId = await seedUser()
    const agentId = await seedAgent(userId)
    const labelId = await insertLabel(userId, 'prod')
    await db.query(
      `INSERT INTO agent_label_assignments (agent_id, label_id) VALUES ($1, $2)`,
      [agentId, labelId],
    )
    await db.query(`DELETE FROM agent_labels WHERE id = $1`, [labelId])
    const assignments = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_label_assignments WHERE agent_id = $1`,
      [agentId],
    )
    expect(assignments.rows[0].count).toBe('0')
    const agent = await db.query<{ id: string; name: string }>(
      `SELECT id, name FROM agents WHERE id = $1`,
      [agentId],
    )
    expect(agent.rows).toHaveLength(1)
    expect(agent.rows[0].name).toBe('a')
  })

  it('deleting an agent removes its assignments and keeps the label', async () => {
    await runUp()
    const userId = await seedUser()
    const agentId = await seedAgent(userId)
    const labelId = await insertLabel(userId, 'prod')
    await db.query(
      `INSERT INTO agent_label_assignments (agent_id, label_id) VALUES ($1, $2)`,
      [agentId, labelId],
    )
    await db.query(`DELETE FROM agents WHERE id = $1`, [agentId])
    const assignments = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_label_assignments`,
    )
    expect(assignments.rows[0].count).toBe('0')
    const label = await db.query<{ id: string }>(`SELECT id FROM agent_labels WHERE id = $1`, [
      labelId,
    ])
    expect(label.rows).toHaveLength(1)
  })

  it('deleting a user removes their labels (per-user scope)', async () => {
    await runUp()
    const userId = await seedUser()
    await insertLabel(userId, 'prod')
    await db.query(`DELETE FROM users WHERE id = $1`, [userId])
    const labels = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_labels`,
    )
    expect(labels.rows[0].count).toBe('0')
  })
})
