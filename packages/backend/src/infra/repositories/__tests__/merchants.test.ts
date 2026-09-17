/**
 * Real-Postgres proof for the merchants repository (#3078). No mocks —
 * #1219's rule — because the claims are SQL claims: the host is the find
 * key across BOTH tables, a slug collision suffixes, the listing counts
 * offers on the listed chains only and hides a merchant with none, and a
 * prospect appears only when asked for.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import db from '../../../db.js'
import { assertWorkerSchemaAtHead, describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import {
  findOrCreateMerchantByHost,
  getMerchantBySlug,
  listMerchants,
  merchantHostOf,
  slugifyMerchantName,
} from '../merchants.js'

let seq = 0

async function insertOffer(
  merchantId: string,
  resourceUrl: string,
  opts: { network?: string; status?: 'active' | 'degraded' | 'delisted'; verified?: boolean } = {},
): Promise<string> {
  seq += 1
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO merchant_catalog
       (name, description, category, resource_url, rail, protocol, tool_name, network, status, verified_at, merchant_id)
     VALUES ($1, 'x', 'api', $2, 'x402', 'http', NULL, $3, $4, $5, $6)
     RETURNING id`,
    [
      `offer-${seq}`,
      resourceUrl,
      opts.network ?? 'eip155:8453',
      opts.status ?? 'active',
      opts.verified === false ? null : new Date().toISOString(),
      merchantId,
    ],
  )
  return rows[0].id
}

async function insertVerifiedSubmission(host: string, merchantId: string | null): Promise<string> {
  seq += 1
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO catalog_submissions
       (hostname, resource_url, status, submitter_ip, verify_token, name, entrypoint, last_verified_at, merchant_id)
     VALUES ($1, $2, 'verified_payable', '127.0.0.1', $3, $4, 'summarize', now(), $5)
     RETURNING id`,
    [host, `https://${host}/mcp`, `tok-${seq}`, `sub-${seq}`, merchantId],
  )
  return rows[0].id
}

async function insertProspect(slug: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO merchants (slug, name, description, listing_status) VALUES ($1, $2, 'coming', 'coming_soon') RETURNING id`,
    [slug, slug],
  )
  return rows[0].id
}

describe('merchants repository — pure helpers', () => {
  it('slugifies a display name and never yields an empty slug', () => {
    expect(slugifyMerchantName('Ampersend Demo API')).toBe('ampersend-demo-api')
    expect(slugifyMerchantName('  Café — Nörd & Co. ')).toBe('cafe-nord-co')
    expect(slugifyMerchantName('***')).toBe('merchant')
  })

  it('reads the lowercased host of a URL, or null', () => {
    expect(merchantHostOf('https://Services.Sandbox.Ampersend.ai/api/joke')).toBe('services.sandbox.ampersend.ai')
    expect(merchantHostOf('not a url')).toBeNull()
  })
})

describeDb('merchants repository (#3078)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
  })
  afterAll(async () => {
    await assertWorkerSchemaAtHead()
  })

  it('finds the merchant that owns a host through an offer, else through a verified submission, else founds one', async () => {
    const founded = await findOrCreateMerchantByHost('api.weather.example', { name: 'Weather API', website: 'https://weather.example' })
    expect(founded.slug).toBe('weather-api')
    expect(founded.website).toBe('https://weather.example')
    expect(founded.listing_status).toBe('live')

    // Through an offer on the host — the seed's name is ignored.
    await insertOffer(founded.id, 'https://api.weather.example/paid')
    const viaOffer = await findOrCreateMerchantByHost('API.WEATHER.EXAMPLE', { name: 'Something else' })
    expect(viaOffer.id).toBe(founded.id)

    // Through a verified submission on another host.
    await insertVerifiedSubmission('mcp.weather.example', founded.id)
    const viaSubmission = await findOrCreateMerchantByHost('mcp.weather.example', { name: 'Ignored' })
    expect(viaSubmission.id).toBe(founded.id)

    // A host nobody owns founds a new one, even with the same name: suffixed.
    const other = await findOrCreateMerchantByHost('api.other.example', { name: 'Weather API' })
    expect(other.id).not.toBe(founded.id)
    expect(other.slug).toBe('weather-api-2')
    const third = await findOrCreateMerchantByHost('api.third.example', { name: 'Weather API' })
    expect(third.slug).toBe('weather-api-3')
  })

  it('refuses an empty host', async () => {
    await expect(findOrCreateMerchantByHost('  ', { name: 'x' })).rejects.toThrow(/host is empty/)
  })

  it('lists live merchants with an offer on a listed chain, counts and networks per the scope, hides the rest', async () => {
    const base = await findOrCreateMerchantByHost('base.example', { name: 'Base only' })
    await insertOffer(base.id, 'https://base.example/a', { network: 'eip155:8453' })
    await insertOffer(base.id, 'https://base.example/b', { network: 'eip155:8453', status: 'delisted' })
    const sepolia = await findOrCreateMerchantByHost('sepolia.example', { name: 'Sepolia only' })
    await insertOffer(sepolia.id, 'https://sepolia.example/a', { network: 'eip155:84532', verified: false })
    const both = await findOrCreateMerchantByHost('both.example', { name: 'Both' })
    await insertOffer(both.id, 'https://both.example/a', { network: 'eip155:8453' })
    await insertOffer(both.id, 'https://both.example/b', { network: 'eip155:84532' })
    const ingestionOnly = await findOrCreateMerchantByHost('ingest.example', { name: 'Ingestion only' })
    await insertVerifiedSubmission('ingest.example', ingestionOnly.id)
    const empty = await findOrCreateMerchantByHost('empty.example', { name: 'Empty' })
    await insertOffer(empty.id, 'https://empty.example/a', { status: 'delisted' })

    // Every chain.
    const all = await listMerchants({ chainIds: null, includeProspects: false })
    expect(all.map((m) => [m.slug, m.offer_count, m.networks.slice().sort(), m.verified_payable])).toEqual([
      ['base-only', 1, ['eip155:8453'], true],
      ['both', 2, ['eip155:8453', 'eip155:84532'], true],
      ['ingestion-only', 1, [], true],
      ['sepolia-only', 1, ['eip155:84532'], false],
    ])

    // Prod's list: mainnet only — the Sepolia-only merchant is gone, "both"
    // counts one offer, the ingestion merchant stays (never chain-filtered).
    const prod = await listMerchants({ chainIds: [8453], includeProspects: false })
    expect(prod.map((m) => [m.slug, m.offer_count])).toEqual([
      ['base-only', 1],
      ['both', 1],
      ['ingestion-only', 1],
    ])

    // The delisted-only merchant is never listed and its page is a miss.
    expect(all.find((m) => m.slug === 'empty')).toBeUndefined()
    const emptyRow = await getMerchantBySlug('empty', null)
    expect(emptyRow?.offer_count).toBe(0)
  })

  it('sorts real merchants before test merchants', async () => {
    const test = await findOrCreateMerchantByHost('demo.example', { name: 'Aaa demo' })
    await db.query(`UPDATE merchants SET is_test_merchant = true WHERE id = $1`, [test.id])
    await insertOffer(test.id, 'https://demo.example/a')
    const real = await findOrCreateMerchantByHost('zzz.example', { name: 'Zzz real' })
    await insertOffer(real.id, 'https://zzz.example/a')
    const rows = await listMerchants({ chainIds: null, includeProspects: false })
    expect(rows.map((m) => m.slug)).toEqual(['zzz-real', 'aaa-demo'])
  })

  it('includes prospects only when asked, with zero offers', async () => {
    await insertProspect('berget-ai')
    const without = await listMerchants({ chainIds: null, includeProspects: false })
    expect(without.map((m) => m.slug)).toEqual([])
    const withP = await listMerchants({ chainIds: null, includeProspects: true })
    expect(withP.map((m) => [m.slug, m.listing_status, m.offer_count])).toEqual([['berget-ai', 'coming_soon', 0]])
    expect((await getMerchantBySlug('berget-ai', [8453]))?.listing_status).toBe('coming_soon')
    expect(await getMerchantBySlug('nobody', null)).toBeNull()
  })

  it('a submission on a prospect\'s host does not become the prospect: the slug is suffixed', async () => {
    await insertProspect('berget-ai')
    const founded = await findOrCreateMerchantByHost('api.berget.ai', { name: 'Berget AI' })
    expect(founded.slug).toBe('berget-ai-2')
    expect(founded.listing_status).toBe('live')
  })
})
