import type { PoolClient } from 'pg'

export const version = '107_delivery_reference'

/**
 * #3778: the NON-SECRET delivery pointer an agent reports with an x402
 * outcome ("Bik Bok 5 SEK, order 6ac7…"), recorded on the evidence row so
 * the owner's receipt and dashboard show that a deliverable EXISTS and where
 * to recover it. Never the deliverable itself — credential-shaped values are
 * refused at every accepting surface (`@haven_ai/core`'s
 * `deliveryReferenceError`), and the column is bounded at the same 512 the
 * contracts cap. Null on rows reported without one (the normal case).
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE machine_payment_evidence
      ADD COLUMN IF NOT EXISTS delivery_reference VARCHAR(512);
  `)
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE machine_payment_evidence
      DROP COLUMN IF EXISTS delivery_reference;
  `)
}
