/**
 * Real-Postgres proof for migration 088 — the merchant layer (#3078, epic
 * #3077). No mocks — #1219's rule.
 *
 * The harness applies the FULL migration set, so the table exists at head
 * shape when a test runs; tests that need the pre-088 state call `down()`
 * (through `withMigrationReverted`), which doubles as the reversibility proof.
 *
 * What this file pins, per the issue's acceptance criteria:
 *  - on the seeded database the backfill yields exactly the NINE mapped
 *    merchants plus ONE from an unknown-host row inserted before `up()`
 *    (the fallback), every `merchant_catalog` row carrying a `merchant_id`;
 *  - Anchor's two rows share one merchant; both demo-store hosts share one;
 *    Ampersend's six seeded offers share one across its two hosts;
 *  - a second unknown host whose slug collides gets a suffixed slug;
 *  - `merchant_id` is NOT NULL and `listing_status` is the closed two-value
 *    set; `catalog_submissions` gained its three nullable columns;
 *  - `down()` removes the Ampersend rows and the columns before the table,
 *    and `up()` round-trips.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import db from '../../../db.js'
import {
  assertWorkerSchemaAtHead,
  describeDb,
  initDbHarness,
  resetDb,
  withMigrationReverted,
} from '../../../infra/__tests__/helpers/db-harness.js'
import { AMPERSEND_OFFERS, HOST_OF_URL_SQL, SEED_MERCHANTS, down, up, version } from '../088_merchants.js'
import { down as down097, up as up097 } from '../097_merchant_pay_to.js'

async function onClient(fn: (c: import('pg').PoolClient) => Promise<void>): Promise<void> {
  const c = await db.connect()
  try {
    await fn(c)
  } finally {
    c.release()
  }
}

/**
 * Revert to the pre-088 schema. Migration 097 (#3331) points
 * `agent_delegations.merchant_id` at `merchants`, so 088's `down()` cannot
 * drop the table while 097 is applied: revert 097 first, and re-apply it
 * last, after the test's own restore has brought 088 back (the 080 test's
 * precedent with 092).
 */
async function with088Reverted<T>(body: () => Promise<T>, restore: () => Promise<unknown>): Promise<T> {
  return withMigrationReverted(
    () => onClient(down097),
    () => withMigrationReverted(() => onClient(down), body, restore),
    () => onClient(up097),
  )
}

async function tableExists(name: string): Promise<boolean> {
  const { rows } = await db.query<{ exists: boolean }>(
    `SELECT to_regclass(current_schema() || '.' || $1) IS NOT NULL AS exists`,
    [name],
  )
  return rows[0].exists
}

async function columnInfo(table: string, column: string): Promise<{ exists: boolean; nullable: boolean | null }> {
  const { rows } = await db.query<{ is_nullable: string }>(
    `SELECT is_nullable FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
    [table, column],
  )
  if (!rows[0]) return { exists: false, nullable: null }
  return { exists: true, nullable: rows[0].is_nullable === 'YES' }
}

async function constraintDef(table: string, conname: string): Promise<string | null> {
  const { rows } = await db.query<{ def: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS def
     FROM pg_constraint c
     WHERE c.conname = $2 AND c.conrelid = (current_schema() || '.' || $1)::regclass`,
    [table, conname],
  )
  return rows[0]?.def ?? null
}

async function insertOffer(resourceUrl: string, name: string, merchantId: string | null = null): Promise<void> {
  await db.query(
    `INSERT INTO merchant_catalog
       (name, description, category, resource_url, rail, protocol, tool_name, network, status, merchant_id)
     VALUES ($1, 'test row', 'api', $2, 'x402', 'http', NULL, 'eip155:8453', 'active', $3)`,
    [name, resourceUrl, merchantId],
  )
}

async function merchantSlugs(): Promise<string[]> {
  const { rows } = await db.query<{ slug: string }>(`SELECT slug FROM merchants ORDER BY slug`)
  return rows.map((r) => r.slug)
}

async function merchantIdForHost(host: string): Promise<string[]> {
  const { rows } = await db.query<{ merchant_id: string }>(
    `SELECT DISTINCT merchant_id FROM merchant_catalog WHERE ${HOST_OF_URL_SQL} = $1`,
    [host],
  )
  return rows.map((r) => r.merchant_id)
}

describeDb('migration 088_merchants', () => {
  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
  })
  afterAll(async () => {
    await assertWorkerSchemaAtHead()
  })

  it('names itself', () => {
    expect(version).toBe('088_merchants')
  })

  it('is at head shape: table, NOT NULL merchant_id, the closed listing_status set, the submission columns', async () => {
    expect(await tableExists('merchants')).toBe(true)
    expect(await columnInfo('merchant_catalog', 'merchant_id')).toEqual({ exists: true, nullable: false })
    for (const column of ['merchant_id', 'merchant_name', 'merchant_website']) {
      expect(await columnInfo('catalog_submissions', column)).toEqual({ exists: true, nullable: true })
    }
    expect(await constraintDef('merchants', 'merchants_listing_status_check')).toBe(
      "CHECK ((listing_status = ANY (ARRAY['live'::text, 'coming_soon'::text])))",
    )
    expect(await constraintDef('merchants', 'merchants_slug_key')).toBe('UNIQUE (slug)')
  })

  it('backfills the seeded database into exactly the nine mapped merchants plus one per unknown host, every row attached', async () => {
    await with088Reverted(
      async () => {
        // Pre-088 state: no merchant column. The harness resets seed data
        // between tests, so plant the rows the map must group — Anchor's two
        // paths on one host, the demo store's two hosts, Minifetch — plus an
        // unknown host the map does not name (the discovery cron's shape).
        expect(await columnInfo('merchant_catalog', 'merchant_id')).toEqual({ exists: false, nullable: null })
        await db.query(
          `INSERT INTO merchant_catalog
             (name, description, category, resource_url, rail, protocol, tool_name, network, status)
           VALUES
             ('Anchor — price', 'x', 'data', 'https://api.anchor-x402.com/v1/price/token', 'x402', 'http', NULL, 'eip155:8453', 'active'),
             ('Anchor — decode', 'x', 'compute', 'https://api.anchor-x402.com/v1/decode/calldata', 'x402', 'http', NULL, 'eip155:8453', 'active'),
             ('CloudNest 50GB (dev)', 'x', 'storage', 'https://demo-merchant-dev-84e4.up.railway.app/mcp', 'x402', 'mcp', 'buy_cloud_storage', 'eip155:84532', 'active'),
             ('CloudNest 50GB (prod)', 'x', 'storage', 'https://enthusiastic-blessing-production-171f.up.railway.app/mcp', 'x402', 'mcp', 'buy_cloud_storage', 'eip155:8453', 'active'),
             ('Minifetch', 'x', 'test-fixture', 'https://minifetch.com/api/v1/x402/extract/url-preview', 'x402', 'http', NULL, 'eip155:8453', 'active'),
             ('Weather API', 'Per-call forecasts.', 'api', 'https://api.weather.example/paid', 'x402', 'http', NULL, 'eip155:8453', 'active')`,
        )
        const before = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM merchant_catalog`)
        // Six Ampersend rows arrive with up(): the count grows by exactly six.
        const client = await db.connect()
        try {
          await up(client)
        } finally {
          client.release()
        }
        const after = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM merchant_catalog`)
        expect(Number(after.rows[0].n) - Number(before.rows[0].n)).toBe(AMPERSEND_OFFERS.length)

        const slugs = await merchantSlugs()
        expect(slugs).toEqual(
          [...SEED_MERCHANTS.map((m) => m.slug), 'api-weather-example'].sort(),
        )
        expect(slugs).toHaveLength(10)

        const orphans = await db.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM merchant_catalog WHERE merchant_id IS NULL`,
        )
        expect(orphans.rows[0].n).toBe('0')

        // Anchor's two rows, one merchant; the demo store's two hosts, one merchant;
        // Ampersend's two hosts, one merchant.
        expect(await merchantIdForHost('api.anchor-x402.com')).toHaveLength(1)
        const demoDev = await merchantIdForHost('demo-merchant-dev-84e4.up.railway.app')
        const demoProd = await merchantIdForHost('enthusiastic-blessing-production-171f.up.railway.app')
        expect(demoDev).toHaveLength(1)
        expect(demoProd).toEqual(demoDev)
        const ampSandbox = await merchantIdForHost('services.sandbox.ampersend.ai')
        const ampMain = await merchantIdForHost('services.ampersend.ai')
        expect(ampSandbox).toHaveLength(1)
        expect(ampMain).toEqual(ampSandbox)

        // The fallback merchant is named after its host and is not a test merchant.
        const weather = await db.query<{ name: string; is_test_merchant: boolean; listing_status: string }>(
          `SELECT name, is_test_merchant, listing_status FROM merchants WHERE slug = 'api-weather-example'`,
        )
        expect(weather.rows[0]).toEqual({ name: 'api.weather.example', is_test_merchant: false, listing_status: 'live' })

        // Test merchants are the two Haven fixtures and Minifetch, nothing else.
        const tests = await db.query<{ slug: string }>(`SELECT slug FROM merchants WHERE is_test_merchant ORDER BY slug`)
        expect(tests.rows.map((r) => r.slug)).toEqual(['haven-demo-store', 'haven-mpp-demo', 'minifetch-test-fixture'])
      },
      async () => {
        // Restore head shape for the tests that follow: the body already ran up().
      },
    )
  })

  it('suffixes a fallback slug that collides with a different merchant', async () => {
    await with088Reverted(
      async () => {
        // Two unknown hosts whose slugs collide: 'a.b.example' and 'a-b.example'
        // both slugify to 'a-b-example'.
        await db.query(
          `INSERT INTO merchant_catalog
             (name, description, category, resource_url, rail, protocol, tool_name, network, status)
           VALUES ('One', 'x', 'api', 'https://a.b.example/paid', 'x402', 'http', NULL, 'eip155:8453', 'active'),
                  ('Two', 'x', 'api', 'https://a-b.example/paid', 'x402', 'http', NULL, 'eip155:8453', 'active')`,
        )
        const client = await db.connect()
        try {
          await up(client)
        } finally {
          client.release()
        }
        const slugs = (await merchantSlugs()).filter((s) => s.startsWith('a-b-example'))
        expect(slugs).toEqual(['a-b-example', 'a-b-example-2'])
        expect(await merchantIdForHost('a.b.example')).not.toEqual(await merchantIdForHost('a-b.example'))
      },
      async () => {},
    )
  })

  it('down() removes the Ampersend seed and the columns before the table; up() round-trips', async () => {
    // A LATER row on an Ampersend host (a verified submission, the cron) is
    // not this migration's to delete: down() removes the six seeded URLs,
    // not a host. Plant one (the harness wiped the seeded merchant, so plant
    // it too) and expect it to survive.
    await db.query(
      `INSERT INTO merchants (slug, name) VALUES ('ampersend-demo-api', 'Ampersend Demo API') ON CONFLICT (slug) DO NOTHING`,
    )
    await db.query(
      `INSERT INTO merchant_catalog
         (name, description, category, resource_url, rail, protocol, tool_name, network, status, merchant_id)
       VALUES ('Later', 'x', 'api', 'https://services.ampersend.ai/api/later', 'x402', 'http', NULL, 'eip155:8453', 'active',
               (SELECT id FROM merchants WHERE slug = 'ampersend-demo-api'))`,
    )
    const client = await db.connect()
    try {
      // 097 first: its agent_delegations.merchant_id FK would block the drop.
      await down097(client)
      await down(client)
      const survivor = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM merchant_catalog WHERE resource_url = 'https://services.ampersend.ai/api/later'`,
      )
      expect(survivor.rows[0].n).toBe('1')
      expect(await tableExists('merchants')).toBe(false)
      expect(await columnInfo('merchant_catalog', 'merchant_id')).toEqual({ exists: false, nullable: null })
      expect(await columnInfo('catalog_submissions', 'merchant_name')).toEqual({ exists: false, nullable: null })
      const amp = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM merchant_catalog WHERE resource_url = ANY($1::text[])`,
        [AMPERSEND_OFFERS.map((o) => o.resourceUrl)],
      )
      expect(amp.rows[0].n).toBe('0')
      await up(client)
      expect(await tableExists('merchants')).toBe(true)
      expect(await columnInfo('merchant_catalog', 'merchant_id')).toEqual({ exists: true, nullable: false })
      const ampAgain = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM merchant_catalog WHERE resource_url = ANY($1::text[])`,
        [AMPERSEND_OFFERS.map((o) => o.resourceUrl)],
      )
      expect(ampAgain.rows[0].n).toBe(String(AMPERSEND_OFFERS.length))
      // The survivor is back under its merchant (the backfill's map knows the host).
      const survivorAgain = await db.query<{ slug: string }>(
        `SELECT m.slug FROM merchant_catalog mc JOIN merchants m ON m.id = mc.merchant_id
         WHERE mc.resource_url = 'https://services.ampersend.ai/api/later'`,
      )
      expect(survivorAgain.rows[0]?.slug).toBe('ampersend-demo-api')
    } finally {
      await up097(client)
      client.release()
    }
  })

  it('fails loudly, naming the rows, when a resource_url has no readable host — instead of an anonymous NOT NULL error three statements later', async () => {
    await with088Reverted(
      async () => {
        const planted = await db.query<{ id: string }>(
          `INSERT INTO merchant_catalog
             (name, description, category, resource_url, rail, protocol, tool_name, network, status)
           VALUES ('Broken', 'x', 'api', 'not-a-url', 'x402', 'http', NULL, 'eip155:8453', 'active')
           RETURNING id`,
        )
        const client = await db.connect()
        try {
          await expect(up(client)).rejects.toThrow(new RegExp(`unreadable resource_url host: ${planted.rows[0].id} \\(not-a-url\\)`))
        } finally {
          client.release()
        }
        // The operator fixes the row and re-runs: the migration completes.
        await db.query(`UPDATE merchant_catalog SET resource_url = 'https://fixed.example/x' WHERE id = $1`, [planted.rows[0].id])
        const again = await db.connect()
        try {
          await up(again)
        } finally {
          again.release()
        }
        expect((await merchantSlugs())).toContain('fixed-example')
      },
      async () => {},
    )
  })

  it('a second up() on a migrated database is a no-op', async () => {
    // The harness wipes seed rows, so the first up() here re-seeds (the
    // merchants map and the six Ampersend rows); the SECOND is the claim.
    const counts = () =>
      db.query<{ m: string; c: string }>(
        `SELECT (SELECT count(*) FROM merchants)::text AS m, (SELECT count(*) FROM merchant_catalog)::text AS c`,
      )
    const run = async () => {
      const client = await db.connect()
      try {
        await up(client)
      } finally {
        client.release()
      }
    }
    await run()
    const once = (await counts()).rows[0]
    expect(once).toEqual({ m: String(SEED_MERCHANTS.length), c: String(AMPERSEND_OFFERS.length) })
    await run()
    expect((await counts()).rows[0]).toEqual(once)
  })

  it('refuses an offer with no merchant', async () => {
    await expect(insertOffer('https://nobody.example/x', 'orphan')).rejects.toMatchObject({ code: '23502' })
  })
})
