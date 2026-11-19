import type { PoolClient } from 'pg'

/**
 * 135 — per-agent checkout-details sharing switch (#4871, epic #4868).
 *
 * `agents.checkout_details_sharing_enabled` is the OWNER's switch for ONE
 * agent to share the owner's saved checkout details — the receipt email, the
 * billing address and the shipping address stored by #4870 on
 * `owner_company_details` — with merchants that ask for them in their x402
 * payment challenge (`docs/architecture/13-checkout-details.md` §2).
 *
 * Default OFF, forever, in every path that creates an agent: sharing a
 * receipt email or a home address with a merchant is a per-agent, per-owner
 * decision, and it must never ship as a silent side effect of connecting an
 * agent. The switch alone sends nothing — #4872 attaches the answer to the
 * paid request, and the agent's own read is
 * `GET /agents/:id/checkout-details` (agent key) while the owner's toggle is
 * `PUT /agents/:id/checkout-details-sharing` (session).
 *
 * ## Why a column on `agents`, not a row of its own
 *
 * The switch is one boolean about one agent, exactly like
 * `tax_declaration_enabled` (migration 103). A table keyed on `agent_id`
 * would hold at most one row per agent — the cardinality the agents primary
 * key already enforces — and would need its own lifecycle, its own erasure
 * path and its own join to answer a question the agent row already answers.
 *
 * ## Why it is independent of the tax declaration switch
 *
 * The two switches share a source of data (`owner_company_details`) and
 * nothing else. An owner may share a receipt email and an address without
 * asserting a tax declaration, and may opt an agent in to a tax declaration
 * without sharing a receipt email. Neither column gates the other, and no
 * constraint ties them together: the acceptance criteria require each
 * combination to be reachable.
 *
 * ## Why it can be ON with nothing stored
 *
 * The tax switch refuses an opt-in without a VIES-valid VAT number because
 * the declaration's content rests on that check. Checkout details do not:
 * the owner may turn sharing on before saving a receipt email, and the
 * agent's read then answers `available: false, reason: 'no_details'` until
 * the owner saves one. Refusing the switch would force an ordering the
 * product does not need, and the read already states the honest answer.
 *
 * ## Money path
 *
 * `packages/backend/src/db/migrations/**` is on the money-path perimeter, so
 * this migration is owner-reviewed. It adds one boolean that gates DATA
 * shared with a merchant; it moves no funds, grants no spend authority, and
 * nothing in the delegation, budget or enforcement path reads it.
 *
 * ## Numbering
 *
 * 134 (`merchant_deposit_addresses`) is the latest on `dev`; no in-flight
 * branch carries 135 (checked with `git ls-tree` across every remote head).
 */
export const version = '135_agent_checkout_details_sharing'

export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE agents
      ADD COLUMN IF NOT EXISTS checkout_details_sharing_enabled BOOLEAN NOT NULL DEFAULT false
  `)
}

/** Structural down (#1139): drops exactly what this migration created. */
export async function down(client: PoolClient): Promise<void> {
  await client.query(`ALTER TABLE agents DROP COLUMN IF EXISTS checkout_details_sharing_enabled`)
}
