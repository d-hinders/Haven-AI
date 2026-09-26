import type { PoolClient } from 'pg'

/**
 * 097 — merchant-locked budgets (#3331, epic #3328).
 *
 * `merchant_catalog.pay_to` is the address an entry's own x402 challenge names
 * as `payTo`, recorded by the read-only refresh probe (`refreshCatalog`) that
 * already records its price. NULL until a successful x402 probe, for MPP rows
 * (not an x402 rail), and whenever a probe finds no single well-formed
 * `payTo` across the challenge's `accepts[]` — a refresh writes what it saw,
 * so a merchant that stops naming one loses it rather than keeping a stale
 * address. Nothing reads `pay_to` as payment authority: it is what the
 * dashboard pins a budget's recipient to, and the owner still signs that
 * delegation (the enforcer on `transfer(to)` is the authority).
 *
 * A merchant's VERIFIED payTo on a chain is derived, never stored: the one
 * address every active, verified x402 entry of that merchant on that network
 * agrees on (`infra/repositories/merchants.ts`). Stored per merchant it would
 * be a second copy the probe must keep in sync — the same drift argument
 * migration 095 makes about a stored "expired".
 *
 * `agent_delegations.merchant_id` records which merchant a pinned budget was
 * issued FOR, so the merchant page can find it and a rotated payTo can be
 * shown as stale (the stored `recipient_address` no longer equals the
 * merchant's current verified payTo). It never widens anything: the
 * recipient pin is still `recipient_address`, and payment selection
 * (`SELECT_DELEGATION_FOR_PAYMENT_SQL`) does not read this column. A merchant
 * row that disappears only drops the label (`ON DELETE SET NULL`); the budget
 * stays pinned to the address it was signed for. A merchant-issued row always
 * carries a recipient — an open budget "for" a merchant is not a thing.
 */
export const version = '097_merchant_pay_to'

export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE merchant_catalog
      ADD COLUMN IF NOT EXISTS pay_to VARCHAR(42);
    ALTER TABLE merchant_catalog
      DROP CONSTRAINT IF EXISTS merchant_catalog_pay_to_chk;
    ALTER TABLE merchant_catalog
      ADD CONSTRAINT merchant_catalog_pay_to_chk
      CHECK (pay_to IS NULL OR pay_to ~ '^0x[0-9a-f]{40}$');

    ALTER TABLE agent_delegations
      ADD COLUMN IF NOT EXISTS merchant_id UUID REFERENCES merchants(id) ON DELETE SET NULL;
    ALTER TABLE agent_delegations
      DROP CONSTRAINT IF EXISTS agent_delegations_merchant_pinned_chk;
    ALTER TABLE agent_delegations
      ADD CONSTRAINT agent_delegations_merchant_pinned_chk
      CHECK (merchant_id IS NULL OR recipient_address IS NOT NULL);
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_agent_delegations_merchant
      ON agent_delegations(merchant_id) WHERE merchant_id IS NOT NULL
  `)
}

/** Structural down (#1139): drops exactly what this migration created. */
export async function down(client: PoolClient): Promise<void> {
  await client.query(`DROP INDEX IF EXISTS idx_agent_delegations_merchant`)
  await client.query(`ALTER TABLE agent_delegations DROP CONSTRAINT IF EXISTS agent_delegations_merchant_pinned_chk`)
  await client.query(`ALTER TABLE agent_delegations DROP COLUMN IF EXISTS merchant_id`)
  await client.query(`ALTER TABLE merchant_catalog DROP CONSTRAINT IF EXISTS merchant_catalog_pay_to_chk`)
  await client.query(`ALTER TABLE merchant_catalog DROP COLUMN IF EXISTS pay_to`)
}
