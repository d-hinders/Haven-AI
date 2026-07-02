import type { PoolClient } from 'pg'

export const version = '037_merchant_catalog_asset_transfer_methods'

/**
 * Record which x402 settlement methods each catalog merchant advertises
 * (epic #452, ERC-7710). Today the catalog cannot tell an EIP-3009 (`exact` /
 * `eip3009`) merchant from an ERC-7710-capable one — the verification probe
 * reads the 402 challenge but throws the advertised `assetTransferMethod` away.
 *
 * A merchant can advertise several `accepts[]` options at once (e.g. `eip3009`
 * first, `erc7710` second), so this stores the full comma-separated set of
 * distinct methods the probe saw — not a single scheme — letting the catalog
 * answer "does this merchant support erc7710?" by membership. NULL until the
 * first successful x402 probe; MPP entries (not an x402 rail) stay NULL.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE merchant_catalog
      ADD COLUMN IF NOT EXISTS asset_transfer_methods TEXT
  `)
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE merchant_catalog DROP COLUMN IF EXISTS asset_transfer_methods
  `)
}
