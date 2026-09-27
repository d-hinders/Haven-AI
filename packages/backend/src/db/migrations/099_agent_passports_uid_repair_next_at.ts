import type { PoolClient } from 'pg'

/**
 * 099 — the anchor-UID repair sweep's per-row pacing column (#3395).
 *
 * #3342's `uid_repair_confirmed_at` (096) drains rows the sweep can ANSWER —
 * a repaired phantom, or a stored UID confirmed against its receipt. Rows the
 * sweep can never answer have no such exit: every non-throwing `unrepairable`
 * outcome (`refused`, `no-candidate`, `no-receipt`, `reverted`,
 * `tx-body-unavailable` on a pruned node) writes NOTHING, so the row stays
 * oldest-first and `limit` unanswerable rows at the head re-take the whole
 * batch on every tick — the same stall 096 fixed for answerable rows, now on
 * the class 096 cannot mark. (A repair that THROWS was already deferred by
 * bumping `updated_at`; that bump is what this column replaces, because
 * `updated_at` is the receipt's monotonic epoch elsewhere in this table and
 * #3342 ruled it out as a state stamp for exactly that reason.)
 *
 * So every sweep outcome other than `confirmed` or `repaired` is paced out of
 * the head by stamping `uid_repair_next_at = NOW() + 1h`, and the selector
 * skips a row whose stamp is still in the future. The stamp is GUARDED —
 * `status = 'anchored'` and the row's own `tx_hash` — so a defer can never
 * pace a row that has moved to another lifecycle (a re-anchor reset hands the
 * row back to issuance; an anchored write replaces the anchor tx), and the
 * one statement that still uses the unguarded legacy bump is the throw path
 * where the row's own data may be the problem.
 *
 * Nullable with no default: every existing row reads as not-pacing and is
 * answered once — repaired, confirmed, or paced out — on the first
 * post-deploy tick. No backfill.
 */
export const version = '099_agent_passports_uid_repair_next_at'

export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE agent_passports
      ADD COLUMN IF NOT EXISTS uid_repair_next_at TIMESTAMPTZ
  `)
}

/**
 * Structural down (#1139): drops exactly what this migration created. No
 * index: the selector already filters on `status`, `tx_hash`,
 * `revocation_status` and `updated_at`, and a pacing predicate rides that
 * same scan — a dedicated index would serve only this one qualifier.
 */
export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE agent_passports
      DROP COLUMN IF EXISTS uid_repair_next_at
  `)
}
