/**
 * Real-Postgres proof for migration 102 — delist the Sepolia CloudNest 50 GB
 * skip-settle catalog row (#3421). No mocks — #1219's rule.
 *
 * Pins the owner decision (delist, not relabel): `up()` sets ONLY the one
 * row matching the full unique key (`resource_url`, `tool_name`,
 * `tool_arguments`) PLUS `network` to `delisted`, leaves every sibling row —
 * the Base-mainnet CloudNest 50 GB row (a DIFFERENT `network` AND a
 * DIFFERENT `resource_url` — a different host, not just a different chain),
 * a Sepolia row that shares `resource_url`/`tool_name` but a different
 * `tool_arguments` (200 GB), a row that shares `network`/`tool_name`/
 * `tool_arguments` but a DIFFERENT `resource_url` (a different merchant host
 * on the same testnet), and an unrelated merchant's row — untouched
 * field-for-field including `updated_at`, is idempotent (a re-run touches
 * NOTHING, not even `updated_at`, on the already-delisted row), and `down()`
 * restores only that one row (never a different row some other process
 * already delisted).
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
  updated_at: string
}

// `updated_at` is IN this SELECT deliberately (#3421 round-1 review, M1): a
// sibling comparison that omits it cannot see `up()` touching a row's
// `updated_at` without changing its `status` — exactly what dropping the
// `status != 'delisted'` guard would do on a re-run.
const SELECT_ROW = `
  SELECT id, name, description, category, resource_url, rail, protocol, tool_name,
         tool_arguments, price_display, price_atomic, asset, network, status,
         verified_at, merchant_id, updated_at
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

/**
 * A sibling row differing in BOTH `network` (8453 vs 84532) AND
 * `resource_url` (the mainnet host, not the dev host) — the Base-mainnet
 * twin, which settles normally. Never a same-`resource_url` row: the two
 * hosts are genuinely different deployments, seeded by 058 under different
 * URLs. See the migration's own doc comment for why `network` alone cannot
 * be the thing distinguishing these two in today's schema.
 */
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

/**
 * A sibling row that shares `network`/`tool_name`/`tool_arguments` with the
 * target but has a DIFFERENT `resource_url` — a different merchant host that
 * happens to also be on Base Sepolia and happens to offer the identically
 * shaped `buy_cloud_storage {"tier":"50gb"}` call. Nothing in the schema
 * forbids this (unlike the `network`-only split, `resource_url` is part of
 * 058's own unique index, so two DIFFERENT `resource_url`s can freely share
 * everything else). This is the fixture that proves `resource_url` — not
 * merely `tool_name` + `tool_arguments` + `network` — is load-bearing in the
 * `WHERE` (#3421 round-1 review, M5).
 */
async function seedSameNetworkDifferentHostRow(merchantId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO merchant_catalog
       (name, description, category, resource_url, rail, protocol, tool_name, tool_arguments,
        price_display, price_atomic, asset, network, status, verified_at, merchant_id)
     VALUES
       ('CloudNest 50 GB — a different Sepolia merchant', 'Unrelated merchant, same tool shape.',
        'storage', 'https://a-different-sepolia-merchant.example/mcp', 'x402', 'mcp',
        $1, $2::jsonb, '$0.0005 USDC', '500', 'USDC', $3, 'active', now(), $4)
     RETURNING id`,
    [TOOL_NAME, TOOL_ARGUMENTS, NETWORK, merchantId],
  )
  return rows[0].id
}

/** A wholly unrelated row (different merchant, resource, rail). */
async function seedUnrelatedRow(merchantId: string, status = 'active'): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO merchant_catalog
       (name, description, category, resource_url, rail, protocol, tool_name,
        price_display, asset, network, status, merchant_id)
     VALUES
       ('Soundside — text generation', 'unrelated merchant', 'media',
        'https://mcp.soundside.ai/mcp', 'x402', 'mcp', 'create_text',
        '$0.01 USDC', 'USDC', 'eip155:8453', $2, $1)
     RETURNING id`,
    [merchantId, status],
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

  it('delists ONLY the Sepolia CloudNest 50 GB row, leaving every sibling unchanged field-by-field (including updated_at)', async () => {
    const merchantId = await seedMerchant()
    const targetId = await seedTargetRow(merchantId, 'active')
    const mainnetId = await seedMainnetTwin(merchantId)
    const tierId = await seedDifferentTierRow(merchantId)
    const hostId = await seedSameNetworkDifferentHostRow(merchantId)
    const unrelatedId = await seedUnrelatedRow(merchantId)

    // Snapshot every OTHER row before up() — field-by-field, not just a
    // count, and INCLUDING updated_at so a write that leaves status alone
    // but still touches the row cannot pass silently.
    const before = {
      mainnet: await fetchRow(mainnetId),
      tier: await fetchRow(tierId),
      host: await fetchRow(hostId),
      unrelated: await fetchRow(unrelatedId),
    }

    await up(db as never)

    const target = await fetchRow(targetId)
    expect(target.status).toBe('delisted')

    const after = {
      mainnet: await fetchRow(mainnetId),
      tier: await fetchRow(tierId),
      host: await fetchRow(hostId),
      unrelated: await fetchRow(unrelatedId),
    }
    expect(after.mainnet).toEqual(before.mainnet)
    expect(after.tier).toEqual(before.tier)
    expect(after.host).toEqual(before.host)
    expect(after.unrelated).toEqual(before.unrelated)
  })

  it('is idempotent — a second run touches NOTHING on the already-delisted row, not even updated_at', async () => {
    const merchantId = await seedMerchant()
    const targetId = await seedTargetRow(merchantId, 'active')

    await up(db as never)
    const afterFirst = await fetchRow(targetId)
    expect(afterFirst.status).toBe('delisted')

    await up(db as never) // re-run
    const afterSecond = await fetchRow(targetId)

    expect(afterSecond.status).toBe('delisted')
    // Byte-for-byte, including updated_at: the `status != 'delisted'` guard
    // must make the second UPDATE match zero rows, not merely leave status
    // alone while still touching updated_at.
    expect(afterSecond).toEqual(afterFirst)
  })

  it('a row already delisted before up() runs stays delisted with updated_at unchanged', async () => {
    const merchantId = await seedMerchant()
    const targetId = await seedTargetRow(merchantId, 'delisted')
    const before = await fetchRow(targetId)
    expect(before.status).toBe('delisted')

    await up(db as never)

    const after = await fetchRow(targetId)
    expect(after.status).toBe('delisted')
    expect(after).toEqual(before)
  })

  it('down() restores only the target row — an unrelated row delisted for a different reason stays delisted', async () => {
    const merchantId = await seedMerchant()
    const targetId = await seedTargetRow(merchantId, 'active')
    const mainnetId = await seedMainnetTwin(merchantId)
    const unrelatedDelistedId = await seedUnrelatedRow(merchantId, 'delisted')
    const unrelatedBefore = await fetchRow(unrelatedDelistedId)

    await withMigrationReverted(
      async () => {
        await up(db as never)
        await down(db as never)
      },
      async () => {
        const target = await fetchRow(targetId)
        const mainnet = await fetchRow(mainnetId)
        const unrelated = await fetchRow(unrelatedDelistedId)
        expect(target.status).toBe('active')
        expect(mainnet.status).toBe('active')
        // The unrelated row was ALREADY delisted before this test touched
        // anything, for reasons `down()` knows nothing about — it must not
        // be swept up by a WHERE that only checks `status = 'delisted'`.
        expect(unrelated.status).toBe('delisted')
        expect(unrelated).toEqual(unrelatedBefore)
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

  it('does not touch a different host offering the identically shaped call on the same network — proves resource_url is part of the match', async () => {
    const merchantId = await seedMerchant()
    await seedTargetRow(merchantId, 'active')
    const hostId = await seedSameNetworkDifferentHostRow(merchantId)

    await up(db as never)

    const host = await fetchRow(hostId)
    expect(host.status).toBe('active')
  })
})

describe('migration 102 registration', () => {
  it('exports up and down', () => {
    expect(typeof up).toBe('function')
    expect(typeof down).toBe('function')
  })
})
