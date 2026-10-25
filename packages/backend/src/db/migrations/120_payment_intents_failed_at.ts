import type { PoolClient } from 'pg'

export const version = '120_payment_intents_failed_at'

/**
 * 120 — `payment_intents.failed_at` (#4378, follow-up to #4324/PR #4370).
 *
 * `payment_intents` had no column recording WHEN a row became `failed` (no
 * `updated_at`; the failure writers set only `status` and `error_message`).
 * #4324's unattributed "A payment failed" acknowledgement therefore re-armed
 * on the latest RECORDED STEP of a failed intent —
 * `GREATEST(created_at, signed_at, submitted_at)` — which is the right time
 * only for intents that fail at submit. An intent the reconciler moves to
 * `failed` long after its last step (and after the owner acknowledged the
 * item) never brought the item back; #4370 disclosed that limitation and the
 * captain accepted it for v1, pending this column.
 *
 * With `failed_at`:
 *
 * - the three failure writers in
 *   `infra/repositories/payment-intents.ts` (`FAIL_SUBMITTED_INTENT_SQL`,
 *   `RECONCILE_OUTCOME_FAILED_SQL`, `FAIL_MACHINE_INTENT_SQL`) stamp it in
 *   the same UPDATE that flips the status;
 * - `FAILED_INTENTS_7D_SQL`'s `lastFailedIntentAt` becomes
 *   `MAX(COALESCE(failed_at, GREATEST(created_at, signed_at,
 *   submitted_at)))`, so a row stamped at its true failure time re-arms the
 *   item at that time and a row with no stamp (pre-migration rows) keeps the
 *   #4370 fallback.
 *
 * Nullable, no backfill: existing `failed` rows have no recorded failure
 * time, and the fallback is exactly the behaviour #4370 shipped. The column
 * is write-only bookkeeping — no read path outside the dashboard aggregate
 * uses it, nothing on the payment path gates on it, and it carries no
 * authority or custody weight (presentation only, like 118).
 *
 * `ADD COLUMN ... NULL` is metadata-only in Postgres 11+ — no table rewrite,
 * no lock beyond a brief `ACCESS EXCLUSIVE`. `down()` drops the column; the
 * pre-120 read path (the #4370 fallback expression) is restored by the code
 * reverting in the same PR.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE payment_intents
      ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ;
  `)
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE payment_intents
      DROP COLUMN IF EXISTS failed_at;
  `)
}
