import type { PoolClient } from 'pg'

export const version = '118_payment_refusals_budget_ended_at'

/**
 * Widens `payment_refusals_detail_allowlist_check` with `budget_ended_at`
 * (#4352, epic #4349 slice 3, on #4349 owner decision 6 option 1).
 *
 * ## Why the key exists
 *
 * `delegation_expired` used to mean exactly one thing: the timestamp-caveat
 * revert detected at gas estimation (`classifyRevertForLedger`). #4352 adds a
 * second producer — the PRE-FLIGHT expired-budget refusal (the hosted
 * pre-check and both x402 legs answer `delegation_expired` when the only
 * row for the token has ended) — which never touches the chain. Decision 6
 * option 1 keeps the single reason and distinguishes the provenance by the
 * detail itself: a pre-flight row carries `budget_ended_at` (the ended
 * budget's `expires_at`, ISO 8601); a revert-detected row never does, so
 * the presence of the key IS the provenance. The repository's typed mirror
 * (`REFUSAL_DETAIL_KEYS`) moves in the same PR — a CHECK wider than its
 * TypeScript mirror would let a writer compile a key the database then
 * rejects.
 *
 * ## Mirrors 086/087 exactly
 *
 * Same additive widening 086's `reason` and 087's `source` CHECKs grew by:
 * drop the named constraint, re-add it with the widened allowlist, single
 * statement batch. No existing row carries the key, so the re-added CHECK
 * validates every existing row unchanged.
 *
 * ## down() refuses loudly when budget_ended_at rows exist (#1139)
 *
 * The rows this key introduces are audit records of Haven's own guardrail
 * decisions; deleting or rewriting them is not an option, and the pre-118
 * CHECK would reject them (23514) on any data-preserving rewrite attempt
 * anyway. When no such rows exist (the clean-clone / not-yet-used case),
 * the rollback restores the 086 shape exactly.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE payment_refusals
      DROP CONSTRAINT payment_refusals_detail_allowlist_check;

    ALTER TABLE payment_refusals
      ADD CONSTRAINT payment_refusals_detail_allowlist_check
      CHECK (detail IS NULL OR (
        detail - ARRAY[
          'error_code', 'phase', 'next_action', 'remaining_atomic', 'budget_atomic', 'budget_ended_at'
        ]::text[]
      ) = '{}'::jsonb);
  `)
}

export async function down(client: PoolClient): Promise<void> {
  const { rows } = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM payment_refusals WHERE detail ? 'budget_ended_at'`,
  )
  if (Number(rows[0]?.count ?? '0') > 0) {
    throw new Error(
      `migration 118 down(): ${rows[0].count} payment_refusals row(s) carry detail.budget_ended_at. ` +
        'These are audit records of Haven guardrail decisions (#4352) — deleting or rewriting them is not an option, ' +
        'and the pre-118 CHECK would reject them. Roll back only after the pre-flight expired-budget writer is retired ' +
        'AND the rows are exported/archived by an explicit data-migration decision, never silently here.',
    )
  }
  await client.query(`
    ALTER TABLE payment_refusals
      DROP CONSTRAINT payment_refusals_detail_allowlist_check;

    ALTER TABLE payment_refusals
      ADD CONSTRAINT payment_refusals_detail_allowlist_check
      CHECK (detail IS NULL OR (
        detail - ARRAY[
          'error_code', 'phase', 'next_action', 'remaining_atomic', 'budget_atomic'
        ]::text[]
      ) = '{}'::jsonb);
  `)
}
