import type { PoolClient } from 'pg'

export const version = '030_merchant_catalog_country'

/**
 * Supplier country on the merchant catalog (epic #462, P3 refinement #466).
 *
 * ISO 3166-1 alpha-2 code. Drives VAT precision in the bookkeeping export —
 * domestic (SE) vs EU vs non-EU reverse charge book to different BAS accounts.
 * Nullable: when unknown, the export keeps its flagged reverse-charge default.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE merchant_catalog
      ADD COLUMN IF NOT EXISTS country VARCHAR(2);
  `)
}
