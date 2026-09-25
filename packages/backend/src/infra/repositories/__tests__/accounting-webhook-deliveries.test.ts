/**
 * Real-Postgres proof for `recordWebhookDelivery` — the function whose
 * `inserted` verdict IS the webhook receiver's dedupe (#3019, quality scan
 * 2026-09-22 candidate C2).
 *
 * What was missing: no test ran this function against Postgres. The route
 * test mocks the repository, and migration 092's test pastes its own INSERT
 * (the "by import, never by paste" failure `infra/repositories/README.md`
 * rule 4 names), so flipping `inserted: r.rows.length > 0` to a constant
 * `true` left the whole backend suite green while every replay the provider
 * sends was reprocessed. These tests import the function and exercise its
 * REAL statement against the REAL table — the acceptance criterion
 * verbatim: a replayed delivery id is refused after a "restart" (fresh
 * pooled connections, the same framing migration 092's test pins for the
 * constraint itself).
 *
 * The migration's table shape and up/down round-trip are 092's own file's
 * job; this file owns the FUNCTION's decisions on that table.
 *
 * Harness: #1220's real-Postgres worker schema — #1219's rule, no mocks.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import { recordWebhookDelivery } from '../accounting-webhook-deliveries.js'

let seq = 0

/** A fresh delivery id per drill — resetDb empties the table between tests. */
function deliveryId(label: string): string {
  return `evt_c2_${label}_${++seq}_${Date.now()}`
}

async function seedUser(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`whdel-${++seq}-${Date.now()}@test.example`],
  )
  return rows[0].id
}

describeDb('recordWebhookDelivery — real-DB replay dedupe (#3019 C2)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
  })

  it('the first delivery inserts and writes exactly the row the route expects', async () => {
    const userId = await seedUser()
    const payload = { id: 'je_1', voucher_number: 'V1' }
    const result = await recordWebhookDelivery({
      provider: 'accounted',
      deliveryId: deliveryId('first'),
      userId,
      eventType: 'journal_entry.committed',
      apiVersion: '2026-05-12',
      requestId: 'req_1',
      payload,
      processed: true,
    })
    expect(result).toEqual({ inserted: true })

    // The row the route's 2xx stands on: owner carried (S1), the redacted
    // object stored as jsonb, processed_at stamped in the same statement.
    const { rows } = await db.query<{
      user_id: string | null
      event_type: string | null
      api_version: string | null
      request_id: string | null
      payload: unknown
      received_at: Date
      processed_at: Date | null
    }>(`SELECT user_id, event_type, api_version, request_id, payload, received_at, processed_at
         FROM accounting_webhook_deliveries WHERE provider = 'accounted'`)
    expect(rows).toHaveLength(1)
    expect(rows[0].user_id).toBe(userId)
    expect(rows[0].event_type).toBe('journal_entry.committed')
    expect(rows[0].api_version).toBe('2026-05-12')
    expect(rows[0].request_id).toBe('req_1')
    expect(rows[0].payload).toEqual(payload)
    expect(rows[0].received_at).toBeInstanceOf(Date)
    expect(rows[0].processed_at).not.toBeNull()
  })

  it('MUTATION PROOF: a replayed (provider, delivery_id) returns inserted:false on FRESH connections — the dedupe lives in the table, not the process', async () => {
    // `inserted: r.rows.length > 0` hard-coded to true survives every mocked
    // test (the C2 mutation). Only the real ON CONFLICT DO NOTHING returning
    // zero rows can produce the `false` both assertions below demand.
    const id = deliveryId('replay')
    const input = {
      provider: 'accounted',
      deliveryId: id,
      eventType: 'journal_entry.committed',
      apiVersion: '2026-05-12',
      requestId: 'req_1',
      payload: { id: 'je_1' } as Record<string, unknown> | null,
      processed: true,
    }

    // First delivery — its own dedicated connection, released before the
    // replay: the second call runs through a DIFFERENT pooled connection,
    // so an in-process memo could never satisfy this test (the "restart"
    // the acceptance criterion names).
    const first = await db.connect()
    try {
      expect(await recordWebhookDelivery({ ...input, userId: await seedUser() }, first)).toEqual({ inserted: true })
    } finally {
      first.release()
    }
    const second = await db.connect()
    try {
      expect(await recordWebhookDelivery({ ...input, userId: await seedUser() }, second)).toEqual({ inserted: false })
    } finally {
      second.release()
    }

    // And the ledger still holds exactly ONE row for the delivery.
    const count = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM accounting_webhook_deliveries WHERE delivery_id = $1`,
      [id],
    )
    expect(count.rows[0].n).toBe('1')
  })

  it('MUTATION PROOF: the ledger is provider-scoped — a different provider owning the same delivery id is NOT a replay', async () => {
    const id = deliveryId('cross')
    const base = {
      deliveryId: id,
      eventType: 'period.locked',
      apiVersion: null,
      requestId: null,
      payload: null,
      processed: true,
    }
    expect(await recordWebhookDelivery({ ...base, provider: 'accounted', userId: null })).toEqual({ inserted: true })
    expect(await recordWebhookDelivery({ ...base, provider: 'other', userId: null })).toEqual({ inserted: true })

    const count = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM accounting_webhook_deliveries WHERE delivery_id = $1`,
      [id],
    )
    expect(count.rows[0].n).toBe('2')
  })

  it('a count-only event stores no payload but still dedupes and stamps processed_at', async () => {
    const id = deliveryId('countonly')
    const input = {
      provider: 'accounted',
      deliveryId: id,
      userId: await seedUser(),
      eventType: 'period.locked',
      apiVersion: '2026-05-12',
      requestId: null,
      payload: null,
      processed: true,
    }
    expect(await recordWebhookDelivery(input)).toEqual({ inserted: true })
    expect(await recordWebhookDelivery(input)).toEqual({ inserted: false })

    const { rows } = await db.query<{ payload: unknown; processed_at: Date | null }>(
      `SELECT payload, processed_at FROM accounting_webhook_deliveries WHERE delivery_id = $1`,
      [id],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].payload).toBeNull()
    expect(rows[0].processed_at).not.toBeNull()
  })
})
