/**
 * Real-Postgres proof for migration 102 — delist the Sepolia CloudNest 50 GB
 * skip-settle catalog row (#3421). No mocks — #1219's rule.
 *
 * Pins the owner decision (delist, not relabel): `up()` sets ONLY the one
 * row matching the full unique key (`resource_url`, `tool_name`,
 * `tool_arguments`) PLUS `network` to `delisted`, leaves every sibling row —
 * the Base-mainnet CloudNest 50 GB row (a different `resource_url`), a
 * Sepolia row that shares `resource_url`/`tool_name` but a different
 * `tool_arguments` (200 GB), and an unrelated merchant's row — untouched
 * field-for-field, is idempotent, and `down()` restores only that one row.
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
import { down, up, version } from '../102_delist_skip_settle_catalog_row.js'

const RESOURCE_URL = 'https://demo-merchant-dev-84e4.up.railway.app/mcp'
const TOOL_NAME = 'buy_cloud_storage'
const TOOL_ARGUMENTS = '{"tier":"50gb"}'
const NETWORK = 'eip155:84532'

interface CatalogRow {
  id: string
  name: string
  description: string
  category: string
  resource_url: string
  rail: string
  protocol: string
  tool_name: string | null
  tool_arguments: unknown
  price_display: string | null
  price_atomic: string | null
  asset: string | null
  network: string | null
  status: string
  verified_at: string | null
  merchant_id: string | null
}

const SELECT_ROW = `
  SELECT id, name, description, category, resource_url, rail, protocol, tool_name,
         tool_arguments, price_display, price_atomic, asset, network, status,
         verified_at, merchant_id
    FROM merchant_catalog WHERE id = $1
`

async function seedMerchant(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO merchants (slug, name) VALUES ('m102-test-merchant', 'M102 test merchant')
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
  )
  return rows[0].id
}

/** Seeds the exact target row migration 058 seeds: Sepolia CloudNest 50 GB. */
async function seedTargetRow(merchantId: string, status = 'active'): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO merchant_catalog
       (name, description, category, resource_url, rail, protocol, tool_name, tool_arguments,
        price_display, price_atomic, asset, network, status, verified_at, merchant_id)
     VALUES
       ('CloudNest 50 GB — demo merchant (Base Sepolia)', 'Haven demo merchant CloudNest storage.',
        'storage', $1, 'x402', 'mcp', $2, $3::jsonb,
        '$0.0005 USDC', '500', 'USDC', $4, $5, now(), $6)
     RETURNING id`,
    [RESOURCE_URL, TOOL_NAME, TOOL_ARGUMENTS, NETWORK, status, merchantId],
  )
  return rows[0].id
}

/** A sibling row differing ONLY in `network` — the Base-mainnet twin, which settles normally. */
async function seedMainnetTwin(merchantId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO merchant_catalog
       (name, description, category, resource_url, rail, protocol, tool_name, tool_arguments,
        price_display, price_atomic, asset, network, status, verified_at, merchant_id)
     VALUES
       ('CloudNest 50 GB — demo merchant (Base mainnet)', 'Haven demo merchant CloudNest storage.',
        'storage', 'https://enthusiastic-blessing-production-171f.up.railway.app/mcp', 'x402', 'mcp',
        $1, $2::jsonb, '$0.0005 USDC', '500', 'USDC', 'eip155:8453', 'active', now(), $3)
     RETURNING id`,
    [TOOL_NAME, TOOL_ARGUMENTS, merchantId],
  )
  return rows[0].id
}

/** A sibling row on the SAME resource_url/network but a DIFFERENT tool_arguments — a different product tier. */
async function seedDifferentTierRow(merchantId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO merchant_catalog
       (name, description, category, resource_url, rail, protocol, tool_name, tool_arguments,
        price_display, price_atomic, asset, network, status, verified_at, merchant_id)
     VALUES
       ('CloudNest 200 GB — demo merchant (Base Sepolia)', 'Haven demo merchant CloudNest storage.',
        'storage', $1, 'x402', 'mcp', $2, '{"tier":"200gb"}'::jsonb,
        '$0.0015 USDC', '1500', 'USDC', $3, 'active', now(), $4)
     RETURNING id`,
    [RESOURCE_URL, TOOL_NAME, NETWORK, merchantId],
  )
  return rows[0].id
}

/** A wholly unrelated row (different merchant, resource, rail). */
async function seedUnrelatedRow(merchantId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO merchant_catalog
       (name, description, category, resource_url, rail, protocol, tool_name,
        price_display, asset, network, status, merchant_id)
     VALUES
       ('Soundside — text generation', 'unrelated merchant', 'media',
        'https://mcp.soundside.ai/mcp', 'x402', 'mcp', 'create_text',
        '$0.01 USDC', 'USDC', 'eip155:8453', 'active', $1)
     RETURNING id`,
    [merchantId],
  )
  return rows[0].id
}

async function fetchRow(id: string): Promise<CatalogRow> {
  const { rows } = await db.query<CatalogRow>(SELECT_ROW, [id])
  return rows[0]
}

describeDb('migration 102: delist Sepolia CloudNest 50 GB skip-settle row (#3421)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  // #2616: this file hand-drives up()/down() and nothing else undoes it if a
  // revert is left unrestored — fail here rather than letting the next file
  // on this worker inherit an off-head schema. 102 is data-only (like 059),
  // so this is uniformity, not a guard-visible fix.
  afterAll(assertWorkerSchemaAtHead)

  beforeEach(async () => {
    await resetDb()
  })

  it('names itself', () => {
    expect(version).toBe('102_delist_skip_settle_catalog_row')
  })

  it('delists ONLY the Sepolia CloudNest 50 GB row, leaving siblings unchanged field-by-field', async () => {
    const merchantId = await seedMerchant()
    const targetId = await seedTargetRow(merchantId, 'active')
    const mainnetId = await seedMainnetTwin(merchantId)
    const tierId = await seedDifferentTierRow(merchantId)
    const unrelatedId = await seedUnrelatedRow(merchantId)

    // Snapshot every OTHER row before up() — field-by-field, not just a count.
    const before = {
      mainnet: await fetchRow(mainnetId),
      tier: await fetchRow(tierId),
      unrelated: await fetchRow(unrelatedId),
    }

    await up(db as never)

    const target = await fetchRow(targetId)
    expect(target.status).toBe('delisted')

    const after = {
      mainnet: await fetchRow(mainnetId),
      tier: await fetchRow(tierId),
      unrelated: await fetchRow(unrelatedId),
    }
    expect(after.mainnet).toEqual(before.mainnet)
    expect(after.tier).toEqual(before.tier)
    expect(after.unrelated).toEqual(before.unrelated)
  })

  it('is idempotent — a second run matches nothing further and does not error', async () => {
    const merchantId = await seedMerchant()
    const targetId = await seedTargetRow(merchantId, 'active')

    await up(db as never)
    const afterFirst = await fetchRow(targetId)
    await up(db as never) // re-run
    const afterSecond = await fetchRow(targetId)

    expect(afterFirst.status).toBe('delisted')
    expect(afterSecond.status).toBe('delisted')
    expect(afterSecond).toEqual(afterFirst)
  })

  it('down() restores only that row, and up()/down() round-trips cleanly', async () => {
    const merchantId = await seedMerchant()
    const targetId = await seedTargetRow(merchantId, 'active')
    const mainnetId = await seedMainnetTwin(merchantId)

    await withMigrationReverted(
      async () => {
        await up(db as never)
        await down(db as never)
      },
      async () => {
        const target = await fetchRow(targetId)
        const mainnet = await fetchRow(mainnetId)
        expect(target.status).toBe('active')
        expect(mainnet.status).toBe('active')
      },
      () => up(db as never),
    )
  })

  it('does not touch the different-tier sibling — proves tool_arguments is part of the match, not just resource_url/tool_name', async () => {
    const merchantId = await seedMerchant()
    await seedTargetRow(merchantId, 'active')
    const tierId = await seedDifferentTierRow(merchantId)

    await up(db as never)

    const tier = await fetchRow(tierId)
    expect(tier.status).toBe('active')
  })
})

describe('migration 102 registration', () => {
  it('exports up and down', () => {
    expect(typeof up).toBe('function')
    expect(typeof down).toBe('function')
  })
})
