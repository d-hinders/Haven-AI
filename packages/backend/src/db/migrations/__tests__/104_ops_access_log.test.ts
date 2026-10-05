/**
 * Real-Postgres proof for migration 104 — the ops console access log (#3509).
 * No mocks — #1219's rule.
 *
 * Pins: the table and its indexes exist, `action` is a closed set, `down()`
 * drops exactly what `up()` created, and `up()` is idempotent.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import {
  assertWorkerSchemaAtHead,
  describeDb,
  initDbHarness,
  resetDb,
} from '../../../infra/__tests__/helpers/db-harness.js'
import { insertOpsAccessLog } from '../../../infra/repositories/ops-access-log.js'
import { down, up, version } from '../104_ops_access_log.js'

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
    `SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'ops_access_log'`,
  )
  return Number(rows[0].n) === 1
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
      `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'ops_access_log' ORDER BY indexname`,
    )
    expect(rows.map((r) => r.indexname)).toEqual([
      'idx_ops_access_log_created_at',
      'idx_ops_access_log_operator',
      'ops_access_log_pkey',
    ])
  })

  it('accepts every action the console writes and refuses anything else', async () => {
    for (const action of ['sign_in', 'sign_in_denied', 'view', 'search', 'reveal'] as const) {
      await insertOpsAccessLog({ operatorGithubId: 111, operatorLogin: 'founder', action, requestId: 'req-1' })
    }
    await expect(
      db.query(
        `INSERT INTO ops_access_log (operator_github_id, operator_login, action, request_id) VALUES (1, 'x', 'delete_user', 'r')`,
      ),
    ).rejects.toMatchObject({ code: '23514' })
    const { rows } = await db.query<{ n: string }>(`SELECT count(*) AS n FROM ops_access_log`)
    expect(Number(rows[0].n)).toBe(5)
  })

  it('down() drops exactly the table, and up() is idempotent', async () => {
    await run(down)
    expect(await tableExists()).toBe(false)
    await run(up)
    await run(up)
    expect(await tableExists()).toBe(true)
  })
})
