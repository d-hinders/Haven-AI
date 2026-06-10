import type { PoolClient } from 'pg'

export const version = '019_merchant_catalog'

export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS merchant_catalog (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      resource_url TEXT NOT NULL,
      rail TEXT NOT NULL CHECK (rail IN ('x402', 'mpp')),
      protocol TEXT NOT NULL CHECK (protocol IN ('http', 'mcp')),
      tool_name TEXT,
      price_display TEXT,
      price_atomic TEXT,
      asset TEXT,
      network TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'degraded', 'delisted')),
      verified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_merchant_catalog_resource_tool
      ON merchant_catalog(resource_url, COALESCE(tool_name, ''));

    CREATE INDEX IF NOT EXISTS idx_merchant_catalog_category
      ON merchant_catalog(category) WHERE status != 'delisted';
  `)

  // Starter entries. Prices and availability are confirmed by the
  // verification probe (lib/merchant-catalog.ts); verified_at stays NULL
  // until the first successful probe.
  await client.query(`
    INSERT INTO merchant_catalog
      (name, description, category, resource_url, rail, protocol, tool_name, price_display, asset, network)
    VALUES
      ('Soundside — text generation',
       'Generate text content through the Soundside MCP merchant. Pay per call, no subscription.',
       'media', 'https://mcp.soundside.ai/mcp', 'x402', 'mcp', 'create_text',
       '$0.01 USDC', 'USDC', 'eip155:8453'),
      ('Soundside — image generation',
       'Generate images via Luma through the Soundside MCP merchant.',
       'media', 'https://mcp.soundside.ai/mcp', 'x402', 'mcp', 'create_image',
       '$0.02 USDC', 'USDC', 'eip155:8453'),
      ('Soundside — song generation',
       'Generate short music clips through the Soundside MCP merchant.',
       'media', 'https://mcp.soundside.ai/mcp', 'x402', 'mcp', 'create_song',
       '$0.05 USDC', 'USDC', 'eip155:8453'),
      ('Haven MPP demo resource',
       'Haven''s internal Machine Payment Protocol demo endpoint, useful for first-payment smoke tests.',
       'demo', 'https://havenbackend-production-8a00.up.railway.app/demo/mpp/resource', 'mpp', 'http', NULL,
       '$0.01 USDC', 'USDC', 'eip155:8453')
    ON CONFLICT DO NOTHING;
  `)
}
