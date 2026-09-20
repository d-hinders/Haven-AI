import type { PoolClient } from 'pg'

export const version = '090_display_currency_sek'

/**
 * The display side of the currency preference (#3127 round 2).
 *
 * Round 1 made `currency_preference` a real setting — SEK became the
 * documented no-preference default and a selectable value — but the dashboard
 * could not represent SEK: its totals, monthly spend and analytics all branch
 * binary EUR-vs-USD over `usd_value` / `eur_value` columns. A user who chose
 * the currency they were being served got USD numbers under a SEK label — the
 * exact wrong-currency-label defect class the issue was filed to remove.
 *
 * This migration gives the display path its own SEK column on the three
 * tables the dashboard aggregates, mirroring the 005 pattern for usd/eur:
 *
 * - `payment_intents.sek_value` — booked by the SAME confirm UPDATE that
 *   books `usd_value`/`eur_value` (same price read via the widened
 *   `FiatValues`, so the three can never disagree about when they were
 *   taken). Nullable like its siblings: unpriced rows stay NULL and are
 *   excluded by the existing aggregates' COALESCE arithmetic.
 * - Backfilled from `machine_payment_evidence.amount_sek` where an evidence
 *   row exists (UNIQUE per payment_intent, migration 026): those are the
 *   frozen book-time SEK values the accounting feed already files against,
 *   so historical analytics keep the same figure the ledger shows. Rows
 *   without evidence keep NULL until their own backfill (#2877 posture) —
 *   a missing figure is never invented.
 * - `user_daily_portfolio_snapshots.total_sek` — NULLABLE, deliberately not
 *   DEFAULT 0: today's snapshot may have been written before this column
 *   existed (first-write-wins), and a COALESCE('0') would read that absence
 *   as a real SEK zero and swing the day-over-day change to a fabricated
 *   -100%. The dashboard treats NULL as "no SEK figure for that day" and
 *   reports the change as unavailable rather than wrong.
 * - `payment_refusals.sek_value` — the refusal ledger mirrors the settled
 *   payment booking (same price path per its module doc), so its analytics
 *   figure stays consistent with spend for the same currency choice.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE payment_intents
      ADD COLUMN IF NOT EXISTS sek_value NUMERIC(20,6);

    UPDATE payment_intents pi
       SET sek_value = mpe.amount_sek
      FROM machine_payment_evidence mpe
     WHERE mpe.payment_intent_id = pi.id
       AND mpe.amount_sek IS NOT NULL
       AND pi.sek_value IS NULL;

    ALTER TABLE user_daily_portfolio_snapshots
      ADD COLUMN IF NOT EXISTS total_sek NUMERIC(20,6);

    ALTER TABLE payment_refusals
      ADD COLUMN IF NOT EXISTS sek_value NUMERIC(20,6);
  `)
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE payment_refusals DROP COLUMN IF EXISTS sek_value;
    ALTER TABLE user_daily_portfolio_snapshots DROP COLUMN IF EXISTS total_sek;
    ALTER TABLE payment_intents DROP COLUMN IF EXISTS sek_value;
  `)
}
