/**
 * Data access for `accounting_webhook_deliveries` (#3019, epic #3016 slice 3)
 * — the durable dedupe ledger for the Accounted webhook receiving side.
 *
 * Accounted delivers at-least-once: a failed or slow delivery retries at
 * 1m/5m/30m/2h/12h/24h/48h (~87 h), so the same envelope `id` arrives more
 * than once, across retries AND across backend restarts. The
 * `(provider, delivery_id)` unique constraint IS the dedupe: the insert is
 * attempted BEFORE the 2xx answer, and `ON CONFLICT DO NOTHING` plus a
 * returned row count tells "first delivery, process it" from "replay,
 * acknowledge only". After a 2xx the provider stops retrying, so processing
 * is inline — nothing may be deferred past the answer (no queue, no cron).
 *
 * `payload` carries the redacted `journal_entry.committed` `data.object` only
 * (the probe's raw material, #3019 item 5); every other event type counts
 * without storing a body. Convention: `../accounting/README.md`.
 */

import pool from '../../db.js'
import type { Executor } from '../transaction.js'

/** One recorded delivery, as the inbound route reads it back. */
export interface AccountingWebhookDeliveryRow {
  id: number
  provider: string
  delivery_id: string
  event_type: string | null
  api_version: string | null
  request_id: string | null
  payload: Record<string, unknown> | null
  received_at: Date
  processed_at: Date | null
}

/**
 * The one statement the route's correctness hangs on. The row is written
 * BEFORE the 2xx (the provider stops retrying once it sees 2xx, so a row
 * missing after the answer means the delivery was acknowledged without a
 * record — the one state this schema must make impossible). `ON CONFLICT DO
 * NOTHING` returns zero rows on a replayed `(provider, delivery_id)` — the
 * caller then answers 200 WITHOUT processing again.
 */
export const INSERT_WEBHOOK_DELIVERY_SQL = `INSERT INTO accounting_webhook_deliveries
     (provider, delivery_id, event_type, api_version, request_id, payload, processed_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     ON CONFLICT (provider, delivery_id) DO NOTHING
     RETURNING id`

export async function recordWebhookDelivery(
  input: {
    provider: string
    deliveryId: string
    eventType: string | null
    apiVersion: string | null
    requestId: string | null
    /** The redacted object to store, or null for a count-only event. */
    payload: Record<string, unknown> | null
    /** Stamp `processed_at` in the same statement when processing is done inline. */
    processed: boolean
  },
  db: Executor = pool,
): Promise<{ inserted: boolean }> {
  const r = await db.query<{ id: number }>(INSERT_WEBHOOK_DELIVERY_SQL, [
    input.provider,
    input.deliveryId,
    input.eventType,
    input.apiVersion,
    input.requestId,
    input.payload === null ? null : JSON.stringify(input.payload),
    input.processed ? new Date() : null,
  ])
  return { inserted: r.rows.length > 0 }
}

export const COUNT_WEBHOOK_DELIVERIES_SQL = `SELECT COUNT(*)::int AS n
     FROM accounting_webhook_deliveries WHERE provider = $1`

/** The dedupe row count for a provider — the `/health/ops` webhook counter's input. */
export async function countWebhookDeliveries(provider: string, db: Executor = pool): Promise<number> {
  const r = await db.query<{ n: number }>(COUNT_WEBHOOK_DELIVERIES_SQL, [provider])
  return r.rows[0]?.n ?? 0
}
