import type { PoolClient } from 'pg'

export const version = '058_demo_merchant_catalog'

/**
 * Add product-variant call metadata to the catalog and seed Haven's hosted demo
 * merchant entries for both live environments (#1297). These rows are
 * discovery guidance only: the live merchant 402 remains authoritative for
 * price, network, recipient, and settlement before any funds move.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE merchant_catalog
      ADD COLUMN IF NOT EXISTS tool_arguments JSONB
  `)

  await client.query(`
    DROP INDEX IF EXISTS idx_merchant_catalog_resource_tool;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_merchant_catalog_resource_tool_args
      ON merchant_catalog(
        resource_url,
        COALESCE(tool_name, ''),
        md5(COALESCE(tool_arguments::text, ''))
      );
  `)

  await client.query(`
    INSERT INTO merchant_catalog
      (name, description, category, resource_url, rail, protocol, tool_name,
       tool_arguments, price_display, price_atomic, asset, network, asset_transfer_methods, status, verified_at)
    VALUES
      ('CloudNest 50 GB — demo merchant (Base Sepolia)',
       'Haven demo merchant CloudNest storage. 50 GB for one month on the dev Base Sepolia testnet deployment.',
       'storage', 'https://demo-merchant-dev-84e4.up.railway.app/mcp', 'x402', 'mcp', 'buy_cloud_storage',
       '{"tier":"50gb"}'::jsonb, '$0.0005 USDC', '500', 'USDC', 'eip155:84532', 'eip3009,erc7710', 'active', now()),
      ('CloudNest 50 GB — demo merchant (Base mainnet)',
       'Haven demo merchant CloudNest storage. 50 GB for one month on the production Base mainnet deployment.',
       'storage', 'https://enthusiastic-blessing-production-171f.up.railway.app/mcp', 'x402', 'mcp', 'buy_cloud_storage',
       '{"tier":"50gb"}'::jsonb, '$0.0005 USDC', '500', 'USDC', 'eip155:8453', 'eip3009', 'active', now()),
      ('CloudNest 200 GB — demo merchant (Base Sepolia)',
       'Haven demo merchant CloudNest storage. 200 GB for one month on the dev Base Sepolia testnet deployment.',
       'storage', 'https://demo-merchant-dev-84e4.up.railway.app/mcp', 'x402', 'mcp', 'buy_cloud_storage',
       '{"tier":"200gb"}'::jsonb, '$0.0015 USDC', '1500', 'USDC', 'eip155:84532', 'eip3009,erc7710', 'active', now()),
      ('CloudNest 200 GB — demo merchant (Base mainnet)',
       'Haven demo merchant CloudNest storage. 200 GB for one month on the production Base mainnet deployment.',
       'storage', 'https://enthusiastic-blessing-production-171f.up.railway.app/mcp', 'x402', 'mcp', 'buy_cloud_storage',
       '{"tier":"200gb"}'::jsonb, '$0.0015 USDC', '1500', 'USDC', 'eip155:8453', 'eip3009', 'active', now()),
      ('CloudNest 1 TB — demo merchant (Base Sepolia)',
       'Haven demo merchant CloudNest storage. 1 TB for one month on the dev Base Sepolia testnet deployment.',
       'storage', 'https://demo-merchant-dev-84e4.up.railway.app/mcp', 'x402', 'mcp', 'buy_cloud_storage',
       '{"tier":"1tb"}'::jsonb, '$0.004 USDC', '4000', 'USDC', 'eip155:84532', 'eip3009,erc7710', 'active', now()),
      ('CloudNest 1 TB — demo merchant (Base mainnet)',
       'Haven demo merchant CloudNest storage. 1 TB for one month on the production Base mainnet deployment.',
       'storage', 'https://enthusiastic-blessing-production-171f.up.railway.app/mcp', 'x402', 'mcp', 'buy_cloud_storage',
       '{"tier":"1tb"}'::jsonb, '$0.004 USDC', '4000', 'USDC', 'eip155:8453', 'eip3009', 'active', now()),
      ('NordShield VPN Basic — demo merchant (Base Sepolia)',
       'Haven demo merchant NordShield VPN Basic for one month on the dev Base Sepolia testnet deployment.',
       'vpn', 'https://demo-merchant-dev-84e4.up.railway.app/mcp', 'x402', 'mcp', 'buy_vpn',
       '{"plan":"basic"}'::jsonb, '$0.001 USDC', '1000', 'USDC', 'eip155:84532', 'eip3009,erc7710', 'active', now()),
      ('NordShield VPN Basic — demo merchant (Base mainnet)',
       'Haven demo merchant NordShield VPN Basic for one month on the production Base mainnet deployment.',
       'vpn', 'https://enthusiastic-blessing-production-171f.up.railway.app/mcp', 'x402', 'mcp', 'buy_vpn',
       '{"plan":"basic"}'::jsonb, '$0.001 USDC', '1000', 'USDC', 'eip155:8453', 'eip3009', 'active', now()),
      ('NordShield VPN Pro — demo merchant (Base Sepolia)',
       'Haven demo merchant NordShield VPN Pro for one month on the dev Base Sepolia testnet deployment.',
       'vpn', 'https://demo-merchant-dev-84e4.up.railway.app/mcp', 'x402', 'mcp', 'buy_vpn',
       '{"plan":"pro"}'::jsonb, '$0.003 USDC', '3000', 'USDC', 'eip155:84532', 'eip3009,erc7710', 'active', now()),
      ('NordShield VPN Pro — demo merchant (Base mainnet)',
       'Haven demo merchant NordShield VPN Pro for one month on the production Base mainnet deployment.',
       'vpn', 'https://enthusiastic-blessing-production-171f.up.railway.app/mcp', 'x402', 'mcp', 'buy_vpn',
       '{"plan":"pro"}'::jsonb, '$0.003 USDC', '3000', 'USDC', 'eip155:8453', 'eip3009', 'active', now()),
      ('NordShield VPN Ultra — demo merchant (Base Sepolia)',
       'Haven demo merchant NordShield VPN Ultra for one month on the dev Base Sepolia testnet deployment.',
       'vpn', 'https://demo-merchant-dev-84e4.up.railway.app/mcp', 'x402', 'mcp', 'buy_vpn',
       '{"plan":"ultra"}'::jsonb, '$0.005 USDC', '5000', 'USDC', 'eip155:84532', 'eip3009,erc7710', 'active', now()),
      ('NordShield VPN Ultra — demo merchant (Base mainnet)',
       'Haven demo merchant NordShield VPN Ultra for one month on the production Base mainnet deployment.',
       'vpn', 'https://enthusiastic-blessing-production-171f.up.railway.app/mcp', 'x402', 'mcp', 'buy_vpn',
       '{"plan":"ultra"}'::jsonb, '$0.005 USDC', '5000', 'USDC', 'eip155:8453', 'eip3009', 'active', now())
    ON CONFLICT DO NOTHING;
  `)
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    DELETE FROM merchant_catalog
    WHERE resource_url IN (
      'https://demo-merchant-dev-84e4.up.railway.app/mcp',
      'https://enthusiastic-blessing-production-171f.up.railway.app/mcp'
    )
      AND name LIKE '%demo merchant%'
  `)

  await client.query(`
    DROP INDEX IF EXISTS idx_merchant_catalog_resource_tool_args;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_merchant_catalog_resource_tool
      ON merchant_catalog(resource_url, COALESCE(tool_name, ''));

    ALTER TABLE merchant_catalog DROP COLUMN IF EXISTS tool_arguments;
  `)
}
