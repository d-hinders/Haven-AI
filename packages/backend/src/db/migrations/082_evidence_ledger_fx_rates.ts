import type { PoolClient } from 'pg'

export const version = '082_evidence_ledger_fx_rates'

/**
 * Book-time FX for ledgers that do not book in SEK (#2877, epic #2858).
 *
 * ## Additive, and deliberately so
 *
 * `machine_payment_evidence` already carries the book-time SEK capture from
 * migration 026 — `amount_sek`, `fx_rate_sek`, `fx_source`, `fx_at` — frozen
 * at settlement by the `COALESCE`s in `UPSERT_EVIDENCE_BASE_FOR_INTENT_SQL`.
 * Those four columns are **untouched here**: no rename, no backfill, no
 * rewrite. Every row written before this migration keeps feeding a SEK ledger
 * from exactly the value it was written with, which is what makes the SEK path
 * provably unchanged rather than merely believed to be.
 *
 * What this adds is one nullable JSONB column, `fx_rates`, holding the
 * token→currency rate for each supported ledger currency that had a usable
 * quote at settlement:
 *
 *     {"SEK": 10.54, "EUR": 0.92, "USD": 1.0002, "DKK": 6.87, ...}
 *
 * ## Why a map on the evidence row, and not an amount per connection
 *
 * One settled payment can be fed to a connection that books in DKK today and,
 * after a company switch, one that books in EUR. The rule the feed must keep
 * is "capture once at settlement, never recompute" — so the thing frozen has
 * to be every rate that could later be asked for, captured in the one call
 * that already fetches the price. Storing a single converted amount per
 * connection would move the capture to feed time and break that rule silently:
 * the number would still look like a book-time rate.
 *
 * Freezing is by the same mechanism as the SEK columns — a `COALESCE` in the
 * upsert — so a re-settlement or a repeated evidence write never overwrites a
 * captured map. A pricing outage writes NULL, which is backfillable and never
 * blocks settlement.
 *
 * Nothing is read row-level here and no value is asserted: an FX rate on an
 * unattested source document is provenance, not an accounting judgment
 * (CASP red line 9 — the feed still pushes no account, no VAT, no voucher).
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE machine_payment_evidence
      ADD COLUMN IF NOT EXISTS fx_rates JSONB;
  `)
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE machine_payment_evidence
      DROP COLUMN IF EXISTS fx_rates;
  `)
}
