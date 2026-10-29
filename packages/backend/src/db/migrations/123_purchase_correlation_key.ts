import type { PoolClient } from 'pg'

export const version = '123_purchase_correlation_key'

/**
 * 123 — the purchase correlation key on a settled payment (#4534).
 *
 * ## Why
 *
 * The feed files one `underlag` per settled payment, and that shape is right:
 * a pushed document is immutable, so an aggregate would go stale the moment a
 * member is refunded, fails delivery or settles late. But it leaves the
 * accountant with no way to see that three documents are one purchase.
 *
 * Measured on production 2026-10-29 (#4497): one BikBok gift-card purchase
 * through Bitrefill's x402 route settled three payments — `invoice/create`
 * (0.002 USDC), `invoice/pay` (0.010) and `invoice/status` (0.001) — and
 * therefore produced three documents. Nothing in the feed payload or the
 * receipt said they belonged together. The only real correlation is
 * Bitrefill's `invoice_id`, which lived in the request/response body and was
 * never stored.
 *
 * ## What this adds
 *
 * - `purchase_group_id` — the merchant's own invoice/order id (or an
 *   agent-supplied group key) that every payment of one purchase shares.
 * - `parent_payment_id` — for a fee call, the purchase payment it paid for.
 *   Null for the purchase itself and for every ungrouped payment.
 *
 * Both are DESCRIPTIVE metadata on a document the feed already produces. No
 * payment, settlement, amount or custody fact changes, and nothing is
 * withheld: an ungrouped payment is fed exactly as before, with both columns
 * null. Historical rows stay ungrouped (no backfill — the correlation was
 * never captured, and a time-window guess is explicitly out of scope).
 *
 * `parent_payment_id` deliberately carries NO foreign key: the fee leg of a
 * purchase can settle BEFORE the purchase leg (`invoice/create` precedes
 * `invoice/pay`), so the parent row may not exist yet when the child is
 * written. The link is resolved by the evidence path once the purchase row
 * lands, and a dangling id is impossible in practice because the resolver
 * only ever writes an id it just read from the same table.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE machine_payment_evidence
      ADD COLUMN IF NOT EXISTS purchase_group_id VARCHAR(128),
      ADD COLUMN IF NOT EXISTS parent_payment_id UUID;
  `)

  // Grouping is a read pattern ("show me the documents of one purchase"), so
  // the index is on the group id alone; the parent link is read by primary
  // key. Partial, because the overwhelming majority of rows are ungrouped and
  // a full index would be mostly nulls.
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_machine_payment_evidence_purchase_group
      ON machine_payment_evidence(purchase_group_id)
      WHERE purchase_group_id IS NOT NULL;
  `)
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    DROP INDEX IF EXISTS idx_machine_payment_evidence_purchase_group;
  `)
  await client.query(`
    ALTER TABLE machine_payment_evidence
      DROP COLUMN IF EXISTS parent_payment_id,
      DROP COLUMN IF EXISTS purchase_group_id;
  `)
}
