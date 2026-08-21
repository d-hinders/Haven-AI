import type { PoolClient } from 'pg'

export const version = '064_label_stranding_fixture'

/**
 * Label the deliberate stranded-funds fixture so agents know it will not
 * settle (#1669).
 *
 * The Minifetch entry (seeded in 035) is a WANTED test fixture, per the
 * 2026-08-21 owner decision: it answers the 402 challenge and accepts the
 * funding leg, then never settles — exercising the recovery path (expiry →
 * sweep → the #1269 below-minimum mapping), all of which behaved correctly
 * when it fired live. What was missing is that nothing told an agent this:
 * the row read like any purchasable service, an agent paid it expecting
 * delivery, and then had to diagnose a silent empty-402 and a stranded
 * balance.
 *
 * Three edits to one row. The unique index is COMPOSITE — (resource_url,
 * COALESCE(tool_name, '')) — so the match includes tool_name IS NULL to name
 * exactly the seeded row, not any future tool at the same URL:
 * the NAME carries an unmissable marker, the DESCRIPTION says exactly what
 * happens and what not to expect, and CATEGORY becomes 'test-fixture' so
 * clients can filter structurally without parsing prose — the column already
 * exists, is indexed, and is filterable through GET /catalog, so no schema
 * change is needed.
 *
 * The label survives both writers: refreshCatalog updates price/status
 * fields only, and discovery ingest is ON CONFLICT DO NOTHING. Idempotent —
 * a re-run matches the same row and writes the same values.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(
    `UPDATE merchant_catalog
        SET name = 'Minifetch — URL preview (TEST FIXTURE: strands funds)',
            description = 'Deliberate stranded-funds simulator. The funding leg succeeds; the '
              || 'merchant never settles; the funded amount is left on the delegate for '
              || 'sweep-path testing. Do not expect delivery.',
            category = 'test-fixture',
            updated_at = now()
      WHERE resource_url = 'https://minifetch.com/api/v1/x402/extract/url-preview'
        AND tool_name IS NULL`,
  )
}

/** Restore the seeded presentation — only meaningful for symmetry. */
export async function down(client: PoolClient): Promise<void> {
  await client.query(
    `UPDATE merchant_catalog
        SET name = 'Minifetch — URL preview',
            description = 'Extract link-preview / Open Graph metadata for a URL. Pay per call.',
            category = 'data',
            updated_at = now()
      WHERE resource_url = 'https://minifetch.com/api/v1/x402/extract/url-preview'
        AND tool_name IS NULL`,
  )
}
