/**
 * Real-Postgres proof for migration 106 — the CLI feedback table (#3597).
 * No mocks — #1219's rule.
 *
 * Pins: the table and its two indexes exist, `expires_at` defaults to seven
 * days out, `down()` drops exactly what `up()` created, and `up()` is
 * idempotent.
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
import { down, up, version } from '../106_feedback.js'

async function run(step: typeof up): Promise<void> {
  const client = await db.connect()
  try {
    await step(client)
  } finally {
    client.release()
  }
}

async function tableExists(): Promise<boolean> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'feedback'`,
  )
  return Number(rows[0].n) === 1
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
    // Leave the worker schema at head for the next file.
    await run(up)
    await assertWorkerSchemaAtHead()
  })

  it('creates the table with its two indexes', async () => {
    expect(await tableExists()).toBe(true)
    const { rows } = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'feedback' ORDER BY indexname`,
    )
    expect(rows.map((r) => r.indexname)).toEqual([
      'feedback_pkey',
      'idx_feedback_expires_at',
      'idx_feedback_user_created_at',
    ])
  })

  it('expires_at defaults to seven days from insertion', async () => {
    const userId = await insertTestUser()
    const { rows } = await db.query<{ created_at: string; expires_at: string }>(
      `INSERT INTO feedback (user_id, text) VALUES ($1, 'hello') RETURNING created_at, expires_at`,
      [userId],
    )
    const createdAt = new Date(rows[0].created_at).getTime()
    const expiresAt = new Date(rows[0].expires_at).getTime()
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000
    expect(expiresAt - createdAt).toBeGreaterThan(sevenDaysMs - 5_000)
    expect(expiresAt - createdAt).toBeLessThan(sevenDaysMs + 5_000)
  })

  it('a row with no user_id is rejected (23502), one with an unknown user_id is rejected (23503)', async () => {
    await expect(
      db.query(`INSERT INTO feedback (text) VALUES ('hello')`),
    ).rejects.toMatchObject({ code: '23502' })
    await expect(
      db.query(`INSERT INTO feedback (user_id, text) VALUES ($1, 'hello')`, [randomUUID()]),
    ).rejects.toMatchObject({ code: '23503' })
  })

  it('down() drops exactly the table, and up() is idempotent', async () => {
    await run(down)
    expect(await tableExists()).toBe(false)
    await run(up)
    await run(up)
    expect(await tableExists()).toBe(true)
  })
})
