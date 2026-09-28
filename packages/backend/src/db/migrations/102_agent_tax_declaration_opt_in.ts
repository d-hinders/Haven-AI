import type { PoolClient } from 'pg'

/**
 * 102 — per-agent x402 tax declaration opt-in (#3426, wg-tax #5 §2.1).
 *
 * `agents.tax_declaration_enabled` is the OWNER's opt-in for ONE agent to
 * carry a buyer-side x402 tax declaration on its x402 payments (the shape
 * proposed in x402-foundation/wg-tax #5, `buyer-side-tax-declaration.md`
 * §2.1). Default OFF, forever, in every path that creates an agent: sending
 * a declaration is a per-agent, per-owner decision, and an EU tax assertion
 * must never ship as a silent side effect of connecting an agent. The
 * opt-in alone sends nothing — the read gate is
 * `GET /agents/:id/tax-declaration` (agent key) and the owner's toggle is
 * `PUT /agents/:id/tax-declaration` (session); both re-check
 * `owner_company_details.vies_status = 'valid'` at their own call time, so
 * a VAT number VIES later marks `invalid`/`not_verifiable` stops feeding a
 * declaration without this column moving at all.
 *
 * BOOLEAN NOT NULL DEFAULT FALSE, no constraint: the interesting rules (VIES
 * valid, feature flag on) live in rows that CHANGE after this column is
 * written, so encoding today's cross-table state as a table CHECK would be
 * a lie the first time VIES drops. The routes are the gate; the column only
 * remembers the owner's choice.
 *
 * The owner's company details (migration 098, #3332) are unchanged and the
 * Agent Passport EAS schema is untouched (owner decision 2026-09-28 on the
 * issue): the declaration is separate from the passport, computed at read
 * time from data that already exists.
 */
export const version = '102_agent_tax_declaration_opt_in'

export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE agents
      ADD COLUMN IF NOT EXISTS tax_declaration_enabled BOOLEAN NOT NULL DEFAULT false
  `)
}

/** Structural down (#1139): drops exactly what this migration created. */
export async function down(client: PoolClient): Promise<void> {
  await client.query(`ALTER TABLE agents DROP COLUMN IF EXISTS tax_declaration_enabled`)
}
