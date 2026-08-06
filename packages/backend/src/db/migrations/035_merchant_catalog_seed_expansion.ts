import type { PoolClient } from 'pg'

export const version = '035_merchant_catalog_seed_expansion'

/**
 * Broaden the merchant catalog beyond the single `media` merchant (Soundside)
 * it shipped with (#473). Six third-party x402 merchants across new categories —
 * `search`, `data`, `compute` — each sourced from the Coinbase x402 Bazaar, on
 * Base (eip155:8453), and confirmed to return a live HTTP 402 challenge on a GET
 * probe at author time.
 *
 * The hourly verification probe (`lib/merchant-catalog.ts`) re-checks price and
 * availability and degrades any entry that stops responding, so a stale endpoint
 * self-heals rather than misleading users — the probe stays the source of truth.
 *
 * The new categories are BAS-mapped in `lib/bas-accounts.ts` (`search`, `data`,
 * `compute`), so booked spend classifies into the right expense account for the
 * SIE / Fortnox export instead of the default.
 *
 * `ON CONFLICT DO NOTHING` skips any URL the discovery cron already inserted.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    INSERT INTO merchant_catalog
      (name, description, category, resource_url, rail, protocol, tool_name, price_display, asset, network)
    VALUES
      ('CoinGecko — onchain pool search',
       'Search onchain liquidity pools and market data via the CoinGecko x402 API. Pay per call.',
       'search', 'https://pro-api.coingecko.com/api/v3/x402/onchain/search/pools', 'x402', 'http', NULL,
       '$0.01 USDC', 'USDC', 'eip155:8453'),
      ('Nansen — smart money netflow',
       'Onchain smart-money netflow analytics from Nansen. Pay per query.',
       'data', 'https://api.nansen.ai/api/v1/smart-money/netflow', 'x402', 'http', NULL,
       '$0.05 USDC', 'USDC', 'eip155:8453'),
      ('Anchor — token price',
       'Per-call token price and market data in USD. Pay per lookup.',
       'data', 'https://api.anchor-x402.com/v1/price/token', 'x402', 'http', NULL,
       '$0.001 USDC', 'USDC', 'eip155:8453'),
      ('Linked Panda — profile enrichment',
       'Enrich a profile from a LinkedIn URL. Pay per enrichment.',
       'data', 'https://api.linkedpanda.com/agent/v1/profiles/enrich', 'x402', 'http', NULL,
       '$0.05 USDC', 'USDC', 'eip155:8453'),
      ('Minifetch — URL preview',
       'Extract link-preview / Open Graph metadata for a URL. Pay per call.',
       'data', 'https://minifetch.com/api/v1/x402/extract/url-preview', 'x402', 'http', NULL,
       '$0.001 USDC', 'USDC', 'eip155:8453'),
      ('Anchor — calldata decode',
       'Decode EVM calldata against an ABI. Pay per decode.',
       'compute', 'https://api.anchor-x402.com/v1/decode/calldata', 'x402', 'http', NULL,
       '$0.001 USDC', 'USDC', 'eip155:8453')
    ON CONFLICT DO NOTHING;
  `)
}
