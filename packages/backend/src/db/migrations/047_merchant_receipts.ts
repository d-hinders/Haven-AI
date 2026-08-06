import type { PoolClient } from 'pg'

export const version = '047_merchant_receipts'

/**
 * Merchant-issued receipt capture (#956, follow-up to #498).
 *
 * The reporting feed's always-present attachment is the HAVEN-generated
 * payment evidence document. When the merchant ALSO provides its own receipt
 * (invoice number, VAT breakdown, org number — facts Haven's evidence cannot
 * carry), the agent reports it after a successful settlement retry and the
 * feed attaches it as a SECOND file on the fed transaction.
 *
 * One row per evidence row, captured best-effort — absence is the normal
 * case. Two tolerated formats: a URL reference (fetched at feed time with
 * strict guards) or inline JSON (size-capped at the route). Additive,
 * non-destructive.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS merchant_receipts (
      evidence_id UUID PRIMARY KEY REFERENCES machine_payment_evidence(id) ON DELETE CASCADE,
      url TEXT,
      inline_json JSONB,
      captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT merchant_receipt_has_content CHECK (url IS NOT NULL OR inline_json IS NOT NULL)
    );
  `)
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS merchant_receipts;`)
}
