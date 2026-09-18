import type { PoolClient } from 'pg'

export const version = '087_payment_refusals_source_hosted'

/**
 * Widens `payment_refusals_source_check` with `'hosted_prepare'` (#3054,
 * slice 3 of epic #3056). The hosted MCP's guided purchase
 * (`haven_prepare_catalog_purchase`) refused an over-budget quote in the
 * agent's runtime — a policy refusal the ledger never saw. Slice 3 moves the
 * DECISION server-side: the backend's new `POST
 * /machine-payments/budget-precheck` runs the same derived-budget compare the
 * hosted tool used to run locally and refuses through `refuse()`, so the
 * ledger stays a record of what Haven's guardrail decided — never an
 * agent-asserted row (a self-report endpoint would let any agent-key holder
 * book arbitrary amounts into the owner's Refused tile; Daniel S1, adopted).
 * The new source names where the refusal was decided: at the hosted prepare
 * flow, server-side. `reason` is unchanged — the compare is the same
 * `delegation_budget_exceeded` the x402 legs book.
 *
 * ## Mirrors 086 exactly
 *
 * Same additive widening 086's `reason` CHECK itself grew by (#3053): drop
 * the named constraint, re-add it with the widened closed set, single
 * statement batch. The repository union
 * (`infra/repositories/payment-refusals.ts`) moves in the same PR — a CHECK
 * wider than its TypeScript mirror would let a writer compile a value the
 * database then rejects.
 *
 * ## The dedupe fold key is UNCHANGED (epic decision 4)
 *
 * `RECORD_REFUSAL_SQL`'s 60-second window still keys on
 * `(agent_id, reason, resource_url)`; `source` is not in the key. The hosted
 * refusal lands first, and a backend pre-check on the same URL within the
 * window folds into it as `attempts = 2` with `source =
 * 'hosted_prepare'` — one row per budget fact, not one per writer.
 *
 * ## down() refuses loudly when hosted_prepare rows exist (#1139)
 *
 * The rows this source introduces are audit records of Haven's own guardrail
 * decisions; deleting or rewriting them is not an option, and the pre-087
 * CHECK would reject them (23514) on any data-preserving rewrite attempt
 * anyway. So `down()` refuses to run while `hosted_prepare` rows exist —
 * the deploy-level rollback fails loudly at the guard, exactly the posture
 * 080 documents for its own structural `down()`. When no such rows exist
 * (the clean-clone / not-yet-used case), the rollback restores the 086 shape
 * exactly: same drop-and-re-add, set narrowed back to the three writers.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE payment_refusals
      DROP CONSTRAINT payment_refusals_source_check;

    ALTER TABLE payment_refusals
      ADD CONSTRAINT payment_refusals_source_check
      CHECK (source IN ('x402_authorize', 'payment', 'redeem', 'hosted_prepare'));
  `)
}

export async function down(client: PoolClient): Promise<void> {
  const { rows } = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM payment_refusals WHERE source = 'hosted_prepare'`,
  )
  if (Number(rows[0]?.count ?? '0') > 0) {
    throw new Error(
      `migration 087 down(): ${rows[0].count} payment_refusals row(s) carry source='hosted_prepare'. ` +
        'These are audit records of Haven guardrail decisions (#3054) — deleting or rewriting them is not an option, ' +
        'and the pre-087 CHECK would reject them. Roll back only after the hosted_prepare writer is retired ' +
        'AND the rows are exported/archived by an explicit data-migration decision, never silently here.',
    )
  }
  await client.query(`
    ALTER TABLE payment_refusals
      DROP CONSTRAINT payment_refusals_source_check;

    ALTER TABLE payment_refusals
      ADD CONSTRAINT payment_refusals_source_check
      CHECK (source IN ('x402_authorize', 'payment', 'redeem'));
  `)
}
