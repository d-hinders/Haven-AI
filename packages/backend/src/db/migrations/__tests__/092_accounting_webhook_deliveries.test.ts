/**
 * Real-Postgres proof for migration 092 — the Accounted webhook receiving
 * side (#3019, epic #3016 slice 3). No mocks — #1219's rule.
 *
 * Pins the acceptance criterion directly: the deliveries table refuses a
 * replayed `(provider, delivery_id)` after a "restart" (fresh connections),
 * the capability-URL token column exists on the connections table, and
 * up/down round-trips.
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
import { down, up, version } from '../092_accounting_webhook_deliveries.js'

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

describeDb('migration 092_accounting_webhook_deliveries', () => {
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
    expect(version).toBe('092_accounting_webhook_deliveries')
  })

  it('records a delivery and rejects a replayed (provider, delivery_id) after a restart', async () => {
    await runUp()

    // Two POOLED connections, sequentially: the second insert runs through a
    // different connection than the first — the replay refusal must not
    // depend on any in-process state (an in-memory dedupe set would reset
    // "across a restart"; the table is the point).
    const first = await db.connect()
    try {
      await first.query(
        `INSERT INTO accounting_webhook_deliveries (provider, delivery_id, event_type, api_version, request_id)
         VALUES ('accounted', 'd290f1ee-6c54-4b01-90e6-d701748f0851', 'journal_entry.committed', '2026-05-12', 'whdel_1')`,
      )
    } finally {
      first.release()
    }
    const second = await db.connect()
    let replayed: unknown
    try {
      await second.query(
        `INSERT INTO accounting_webhook_deliveries (provider, delivery_id, event_type)
         VALUES ('accounted', 'd290f1ee-6c54-4b01-90e6-d701748f0851', 'journal_entry.committed')`,
      )
    } catch (err) {
      replayed = err
    } finally {
      second.release()
    }
    expect(replayed).toBeInstanceOf(Error)
    expect((replayed as { code?: string }).code).toBe('23505')

    // A different provider's same id is NOT a replay.
    await db.query(
      `INSERT INTO accounting_webhook_deliveries (provider, delivery_id, event_type)
       VALUES ('other', 'd290f1ee-6c54-4b01-90e6-d701748f0851', 'period.locked')`,
    )
    const count = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM accounting_webhook_deliveries`,
    )
    expect(count.rows[0].n).toBe('2')
  })

  it('stores the redacted payload as JSONB and stamps received_at by default', async () => {
    await runUp()
    const payload = { id: 'evt_1', type: 'journal_entry.committed', data: { object: { voucher_number: 'A1' } } }
    const { rows } = await db.query<{ payload: unknown; received_at: Date; processed_at: Date | null }>(
      `INSERT INTO accounting_webhook_deliveries (provider, delivery_id, event_type, payload)
       VALUES ('accounted', 'evt-row-1', 'journal_entry.committed', $1)
       RETURNING payload, received_at, processed_at`,
      [JSON.stringify(payload)],
    )
    expect(rows[0].payload).toEqual(payload)
    expect(rows[0].received_at).toBeInstanceOf(Date)
    expect(rows[0].processed_at).toBeNull()
  })

  it('adds the webhook_token column to accounting_connections and round-trips up/down', async () => {
    await runUp()
    // information_schema is search_path-wide: qualify with the worker schema,
    // or a parallel worker's identically-named table would be counted too.
    const withColumn = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'accounting_connections' AND column_name = 'webhook_token'`,
    )
    expect(withColumn.rows[0].n).toBe('1')

    await withMigrationReverted(runDown, async () => {
      const withoutColumn = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'accounting_connections' AND column_name = 'webhook_token'`,
      )
      expect(withoutColumn.rows[0].n).toBe('0')
      const table = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'accounting_webhook_deliveries'`,
      )
      expect(table.rows[0].n).toBe('0')
    }, runUp)

    // Restored: the helper's `finally` ran up() again.
    const restored = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'accounting_connections' AND column_name = 'webhook_token'`,
    )
    expect(restored.rows[0].n).toBe('1')
  })
})
