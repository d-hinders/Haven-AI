/**
 * Real-Postgres proof for migration 089 — the two marketplace prospects
 * (#3080, epic #3077 slice 3). No mocks — #1219's rule.
 *
 * Pins the acceptance criterion directly: two `coming_soon` merchants, zero
 * offers each, up/down round-trips, and `down()` refuses when a seed has been
 * promoted (the structural-down rule, #1139, narrowed to what this migration
 * itself created).
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
import { down, PROSPECT_SEEDS, up, version } from '../089_marketplace_prospects.js'

interface ProspectMerchantRow {
  name: string
  description: string
  website: string
  category: string
  country: string
  listing_status: string
}

async function merchantRow(slug: string): Promise<ProspectMerchantRow | undefined> {
  const { rows } = await db.query<ProspectMerchantRow>(
    `SELECT name, description, website, category, country, listing_status FROM merchants WHERE slug = $1`,
    [slug],
  )
  return rows[0]
}

async function runUp(): Promise<void> {
  const client = await db.connect()
  try {
    await up(client)
  } finally {
    client.release()
  }
}

describeDb('migration 089_marketplace_prospects', () => {
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
    expect(version).toBe('089_marketplace_prospects')
  })

  it('seeds exactly two coming_soon merchants, zero offers each', async () => {
    expect(PROSPECT_SEEDS.map((s) => s.slug)).toEqual(['berget-ai', 'redpine'])

    const client = await db.connect()
    try {
      await up(client)
    } finally {
      client.release()
    }

    const berget = await merchantRow('berget-ai')
    expect(berget).toEqual({
      name: 'Berget AI',
      description: 'Sovereign Swedish inference — open models on Swedish data centres, OpenAI-compatible API',
      website: 'https://berget.ai',
      category: 'ai',
      country: 'SE',
      listing_status: 'coming_soon',
    })

    const redpine = await merchantRow('redpine')
    expect(redpine).toEqual({
      name: 'Redpine',
      description: 'Grounding API for licensed, non-public data — API, MCP and CLI',
      website: 'https://redpine.ai',
      category: 'data',
      country: 'SE',
      listing_status: 'coming_soon',
    })

    const offers = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM merchant_catalog
       WHERE merchant_id IN (SELECT id FROM merchants WHERE slug = ANY($1::text[]))`,
      [PROSPECT_SEEDS.map((s) => s.slug)],
    )
    expect(offers.rows[0].n).toBe('0')
  })

  it('up() is idempotent (ON CONFLICT DO NOTHING) — a second run does not duplicate or overwrite', async () => {
    const client = await db.connect()
    try {
      await up(client)
      await db.query(`UPDATE merchants SET listing_status = 'live' WHERE slug = 'berget-ai'`)
      await up(client)
    } finally {
      client.release()
    }
    const count = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM merchants WHERE slug = 'berget-ai'`)
    expect(count.rows[0].n).toBe('1')
    // A second up() must not clobber a promotion that happened in between.
    expect((await merchantRow('berget-ai'))?.listing_status).toBe('live')
  })

  it('down() removes exactly the two seeded prospects; up() round-trips', async () => {
    // The harness wiped the seed rows; seed once so there is something to revert.
    await runUp()
    expect(await merchantRow('berget-ai')).toBeDefined()
    expect(await merchantRow('redpine')).toBeDefined()
    await withMigrationReverted(
      () => db.connect().then(async (c) => { try { await down(c) } finally { c.release() } }),
      async () => {
        expect(await merchantRow('berget-ai')).toBeUndefined()
        expect(await merchantRow('redpine')).toBeUndefined()
      },
      runUp,
    )
    // Restored: the helper's `finally` ran up() again.
    expect(await merchantRow('berget-ai')).toBeDefined()
    expect(await merchantRow('redpine')).toBeDefined()
  })

  it('down() refuses loudly, by name, when a seed carries a verified submission — not a raw FK error', async () => {
    await runUp()
    const { rows } = await db.query<{ id: string }>(`SELECT id FROM merchants WHERE slug = 'redpine'`)
    await db.query(
      `INSERT INTO catalog_submissions
         (hostname, resource_url, status, submitter_ip, verify_token, name, entrypoint, last_verified_at, merchant_id)
       VALUES ('redpine.ai', 'https://redpine.ai/mcp', 'verified_payable', '127.0.0.1', 'tok', 'sub', 'ground', now(), $1)`,
      [rows[0].id],
    )
    const client = await db.connect()
    try {
      await expect(down(client)).rejects.toThrow(/refusing to remove merchant "redpine".*1 offer/)
    } finally {
      client.release()
    }
  })

  it('down() refuses loudly when a seed has been promoted to live (#1139 structural-down rule)', async () => {
    const client = await db.connect()
    try {
      await up(client)
      await db.query(`UPDATE merchants SET listing_status = 'live' WHERE slug = 'berget-ai'`)
      await expect(down(client)).rejects.toThrow(/refusing to remove merchant "berget-ai"/)
      // Refused as a whole: redpine (still coming_soon) is untouched too.
      expect(await merchantRow('redpine')).toBeDefined()
      // Clean up for the next test in this file.
      await db.query(`DELETE FROM merchants WHERE slug = ANY($1::text[])`, [PROSPECT_SEEDS.map((s) => s.slug)])
    } finally {
      client.release()
    }
  })

  it('down() refuses loudly when a seed has offers attached, even if still coming_soon', async () => {
    const client = await db.connect()
    try {
      await up(client)
      const { rows } = await db.query<{ id: string }>(`SELECT id FROM merchants WHERE slug = 'redpine'`)
      await db.query(
        `INSERT INTO merchant_catalog
           (name, description, category, resource_url, rail, protocol, tool_name, network, status, merchant_id)
         VALUES ('x', 'x', 'data', 'https://redpine.ai/api', 'x402', 'http', NULL, 'eip155:8453', 'active', $1)`,
        [rows[0].id],
      )
      await expect(down(client)).rejects.toThrow(/refusing to remove merchant "redpine"/)
      await db.query(`DELETE FROM merchant_catalog WHERE merchant_id = $1`, [rows[0].id])
      await db.query(`DELETE FROM merchants WHERE slug = ANY($1::text[])`, [PROSPECT_SEEDS.map((s) => s.slug)])
    } finally {
      client.release()
    }
  })
})
