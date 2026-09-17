import type { PoolClient } from 'pg'
import { HOST_OF_URL_SQL } from '../url-host.js'

/**
 * 088 — the merchant layer over the catalog (#3078, slice 1 of epic #3077).
 *
 * `merchant_catalog` is one flat table, one row per payable endpoint, and the
 * marketplace needs the seller those rows belong to: a `merchants` table,
 * every offer pointing at one (`merchant_catalog.merchant_id NOT NULL`), and
 * the self-submitted directory able to point at one too
 * (`catalog_submissions.merchant_id`, set when a submission becomes
 * `verified_payable`; `merchant_name`/`merchant_website` carry what the
 * submitter told us until then).
 *
 * Two status vocabularies, deliberately named apart: `merchants.listing_status`
 * is `live | coming_soon` (a prospect we are talking to, shown on dev only
 * behind a flag — epic decision 2); `merchant_catalog.status` stays
 * `active | degraded | delisted`. `entry.status === 'live'` therefore does
 * not type-check as a plausible mistake.
 *
 * The backfill is an EXPLICIT host → merchant map with a hostname fallback
 * (epic decision, spec review): grouping by host alone would have split the
 * Haven demo store (two hosts) and Ampersend (two hosts) and merged nothing
 * that should be merged. Every host the seeds know is named below; any other
 * host — the Bazaar discovery cron writes rows that differ per environment —
 * becomes a merchant named after the host, so `SET NOT NULL` holds on every
 * database this runs against.
 *
 * Seeds the Ampersend Demo API (epic decision 5): six offers, three paths on
 * the Sepolia sandbox host and three on the mainnet host, `verified_at NULL`
 * so the catalog probe is the one that vouches for them.
 *
 * `down()` drops the columns before the table (the FK order) and removes the
 * Ampersend rows this migration added; the merchants rows go with the table.
 */
export const version = '088_merchants'

/** The one host definition, shared with the repository (`db/url-host.ts`). */
export { HOST_OF_URL_SQL }

interface SeedMerchant {
  slug: string
  name: string
  description: string
  website: string | null
  category: string
  country: string | null
  isTest: boolean
  /** Hosts whose existing catalog rows this merchant owns. */
  hosts: string[]
}

/**
 * The explicit map. Hosts are matched lowercased; a merchant may own several
 * hosts (the demo store and Ampersend each run a dev and a prod host).
 */
export const SEED_MERCHANTS: readonly SeedMerchant[] = [
  {
    slug: 'soundside',
    name: 'Soundside',
    description: 'Text, image and song generation through an MCP merchant. Pay per call, no subscription.',
    website: 'https://soundside.ai',
    category: 'media',
    country: null,
    isTest: false,
    hosts: ['mcp.soundside.ai'],
  },
  {
    slug: 'coingecko',
    name: 'CoinGecko',
    description: 'On-chain market data — pool search over the CoinGecko API.',
    website: 'https://www.coingecko.com',
    category: 'search',
    country: null,
    isTest: false,
    hosts: ['pro-api.coingecko.com'],
  },
  {
    slug: 'nansen',
    name: 'Nansen',
    description: 'Smart-money netflow analytics over the Nansen API.',
    website: 'https://www.nansen.ai',
    category: 'data',
    country: null,
    isTest: false,
    hosts: ['api.nansen.ai'],
  },
  {
    slug: 'anchor',
    name: 'Anchor',
    description: 'Token prices and calldata decoding over an x402 API.',
    website: 'https://anchor-x402.com',
    category: 'data',
    country: null,
    isTest: false,
    hosts: ['api.anchor-x402.com'],
  },
  {
    slug: 'linked-panda',
    name: 'Linked Panda',
    description: 'Profile enrichment for agents over an x402 API.',
    website: 'https://linkedpanda.com',
    category: 'data',
    country: null,
    isTest: false,
    hosts: ['api.linkedpanda.com'],
  },
  {
    slug: 'minifetch-test-fixture',
    name: 'Minifetch (test fixture)',
    description:
      'A stranded-funds simulator: its funding leg succeeds and it never settles. Listed so clients can prove they handle that failure mode; not a merchant to buy from.',
    website: null,
    category: 'test-fixture',
    country: null,
    isTest: true,
    hosts: ['minifetch.com'],
  },
  {
    slug: 'haven-demo-store',
    name: 'Haven demo store',
    description:
      'Haven test merchant — real payments, demo goods. CloudNest storage and NordShield VPN tiers on the dev (Base Sepolia) and prod (Base) demo hosts.',
    website: null,
    category: 'storage',
    country: 'SE',
    isTest: true,
    hosts: ['demo-merchant-dev-84e4.up.railway.app', 'enthusiastic-blessing-production-171f.up.railway.app'],
  },
  {
    slug: 'haven-mpp-demo',
    name: 'Haven MPP demo',
    description: "Haven's internal Machine Payment Protocol demo endpoint. Delisted; kept for the record.",
    website: null,
    category: 'demo',
    country: 'SE',
    isTest: true,
    hosts: ['havenbackend-production-8a00.up.railway.app'],
  },
  {
    slug: 'ampersend-demo-api',
    name: 'Ampersend Demo API',
    description: 'Facts, jokes and quotes — x402-payable demo endpoints on Base and Base Sepolia, from $0.001 USDC per call.',
    website: 'https://www.ampersend.ai',
    category: 'api',
    country: null,
    isTest: false,
    hosts: ['services.sandbox.ampersend.ai', 'services.ampersend.ai'],
  },
]

/** Circle's canonical USDC on each chain (packages/core/src/chains.ts). */
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'

interface AmpersendOffer {
  name: string
  description: string
  resourceUrl: string
  network: string
  asset: string
}

const AMPERSEND_PATHS: ReadonlyArray<{ path: string; name: string; description: string }> = [
  { path: '/api/fact', name: 'Ampersend — fact', description: 'One verified fact per call.' },
  { path: '/api/joke', name: 'Ampersend — joke', description: 'One joke per call.' },
  { path: '/api/quote', name: 'Ampersend — quote', description: 'One quotation per call.' },
]

export const AMPERSEND_OFFERS: readonly AmpersendOffer[] = [
  ...AMPERSEND_PATHS.map((p) => ({
    name: `${p.name} (Base Sepolia)`,
    description: p.description,
    resourceUrl: `https://services.sandbox.ampersend.ai${p.path}`,
    network: 'eip155:84532',
    asset: USDC_BASE_SEPOLIA,
  })),
  ...AMPERSEND_PATHS.map((p) => ({
    name: `${p.name} (Base)`,
    description: p.description,
    resourceUrl: `https://services.ampersend.ai${p.path}`,
    network: 'eip155:8453',
    asset: USDC_BASE,
  })),
]

export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS merchants (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      website TEXT,
      logo_url TEXT,
      category TEXT NOT NULL DEFAULT 'api',
      country VARCHAR(2),
      listing_status TEXT NOT NULL DEFAULT 'live'
        CHECK (listing_status IN ('live', 'coming_soon')),
      is_test_merchant BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    ALTER TABLE merchant_catalog
      ADD COLUMN IF NOT EXISTS merchant_id UUID REFERENCES merchants(id);

    ALTER TABLE catalog_submissions
      ADD COLUMN IF NOT EXISTS merchant_id UUID REFERENCES merchants(id),
      ADD COLUMN IF NOT EXISTS merchant_name TEXT,
      ADD COLUMN IF NOT EXISTS merchant_website TEXT;
  `)

  // The explicit map: one merchant per entry, its hosts' rows attached.
  for (const m of SEED_MERCHANTS) {
    await client.query(
      `INSERT INTO merchants (slug, name, description, website, category, country, is_test_merchant)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (slug) DO NOTHING`,
      [m.slug, m.name, m.description, m.website, m.category, m.country, m.isTest],
    )
    await client.query(
      `UPDATE merchant_catalog
       SET merchant_id = (SELECT id FROM merchants WHERE slug = $1)
       WHERE merchant_id IS NULL AND ${HOST_OF_URL_SQL} = ANY($2::text[])`,
      [m.slug, m.hosts],
    )
  }

  // Ampersend's six offers (epic decision 5). `verified_at NULL`: the probe
  // vouches, not the seed. The unique index on (resource_url, tool_name)
  // makes a re-run a no-op.
  for (const o of AMPERSEND_OFFERS) {
    await client.query(
      `INSERT INTO merchant_catalog
         (name, description, category, resource_url, rail, protocol, tool_name,
          price_display, price_atomic, asset, network, status, verified_at, merchant_id)
       VALUES ($1, $2, 'api', $3, 'x402', 'http', NULL, '0.001 USDC', '1000', $4, $5, 'active', NULL,
               (SELECT id FROM merchants WHERE slug = 'ampersend-demo-api'))
       ON CONFLICT DO NOTHING`,
      [o.name, o.description, o.resourceUrl, o.asset, o.network],
    )
  }

  // The fallback: any remaining host becomes a merchant named after itself,
  // slug from the host, a numeric suffix if the slug is already taken by a
  // different merchant. Done in one plpgsql block so a database with rows
  // from the discovery cron needs no operator step.
  await client.query(`
    DO $$
    DECLARE
      h TEXT;
      base_slug TEXT;
      candidate TEXT;
      n INTEGER;
      mid UUID;
    BEGIN
      -- A row whose resource_url the host rule cannot read would be left
      -- without a merchant and SET NOT NULL would fail three statements on
      -- with an error naming no row. Fail here instead, naming every id, so
      -- the operator knows what to fix (review S1). The map's merchant rows
      -- and the Ampersend seeds were inserted above; the migration runner
      -- wraps up() in one transaction (migrate.ts applyInTransaction), so a
      -- throw here rolls them back and the database is as it was. No current
      -- writer can produce such a row; a database this migration meets might.
      IF EXISTS (SELECT 1 FROM merchant_catalog WHERE merchant_id IS NULL AND ${HOST_OF_URL_SQL} IS NULL) THEN
        RAISE EXCEPTION '088_merchants: merchant_catalog rows with an unreadable resource_url host: %',
          (SELECT string_agg(id::text || ' (' || resource_url || ')', ', ')
           FROM merchant_catalog WHERE merchant_id IS NULL AND ${HOST_OF_URL_SQL} IS NULL);
      END IF;
      FOR h IN
        SELECT DISTINCT ${HOST_OF_URL_SQL} AS host
        FROM merchant_catalog
        WHERE merchant_id IS NULL
      LOOP
        base_slug := trim(both '-' from regexp_replace(h, '[^a-z0-9]+', '-', 'g'));
        IF base_slug = '' THEN
          base_slug := 'merchant';
        END IF;
        candidate := base_slug;
        n := 1;
        LOOP
          BEGIN
            INSERT INTO merchants (slug, name, description, category)
            VALUES (candidate, h, 'Discovered x402 merchant (' || h || ').', 'api')
            RETURNING id INTO mid;
            EXIT;
          EXCEPTION WHEN unique_violation THEN
            n := n + 1;
            candidate := base_slug || '-' || n;
          END;
        END LOOP;
        UPDATE merchant_catalog
        SET merchant_id = mid
        WHERE merchant_id IS NULL AND ${HOST_OF_URL_SQL} = h;
      END LOOP;
    END $$;
  `)

  await client.query(`
    ALTER TABLE merchant_catalog ALTER COLUMN merchant_id SET NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_merchant_catalog_merchant_id
      ON merchant_catalog(merchant_id);
    CREATE INDEX IF NOT EXISTS idx_catalog_submissions_merchant_id
      ON catalog_submissions(merchant_id) WHERE merchant_id IS NOT NULL;
  `)
}

export async function down(client: PoolClient): Promise<void> {
  // The Ampersend rows are this migration's seed; every other catalog row
  // predates it and stays — including any OTHER row that later landed on an
  // Ampersend host (a verified submission, the cron), so the delete is by the
  // six seeded URLs, not by host. Columns before the table: the FKs point at it.
  await client.query(`DELETE FROM merchant_catalog WHERE resource_url = ANY($1::text[]) AND tool_name IS NULL`, [
    AMPERSEND_OFFERS.map((o) => o.resourceUrl),
  ])
  await client.query(`
    DROP INDEX IF EXISTS idx_catalog_submissions_merchant_id;
    DROP INDEX IF EXISTS idx_merchant_catalog_merchant_id;
    ALTER TABLE catalog_submissions
      DROP COLUMN IF EXISTS merchant_id,
      DROP COLUMN IF EXISTS merchant_name,
      DROP COLUMN IF EXISTS merchant_website;
    ALTER TABLE merchant_catalog DROP COLUMN IF EXISTS merchant_id;
    DROP TABLE IF EXISTS merchants;
  `)
}
