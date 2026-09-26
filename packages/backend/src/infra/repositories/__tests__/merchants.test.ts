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
import { HOST_OF_URL_SQL } from '../../../db/url-host.js'
import {
  assertMerchantAcceptsOffers,
  findOrCreateMerchantByHost,
  getMerchantBySlug,
  listMerchantFundingTargets,
  listMerchants,
  merchantHostOf,
  resolveFundingTarget,
  ProspectMerchantWriteError,
  slugifyMerchantName,
} from '../merchants.js'

let seq = 0

async function insertOffer(
  merchantId: string,
  resourceUrl: string,
  opts: {
    network?: string
    status?: 'active' | 'degraded' | 'delisted'
    verified?: boolean
    payTo?: string | null
    methods?: string | null
    rail?: 'x402' | 'mpp'
  } = {},
): Promise<string> {
  seq += 1
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO merchant_catalog
       (name, description, category, resource_url, rail, protocol, tool_name, network, status, verified_at, merchant_id,
        pay_to, asset_transfer_methods)
     VALUES ($1, 'x', 'api', $2, $7, 'http', NULL, $3, $4, $5, $6, $8, $9)
     RETURNING id`,
    [
      `offer-${seq}`,
      resourceUrl,
      opts.network ?? 'eip155:8453',
      opts.status ?? 'active',
      opts.verified === false ? null : new Date().toISOString(),
      merchantId,
      opts.rail ?? 'x402',
      opts.payTo ?? null,
      opts.methods ?? null,
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

  it('reads the lowercased host of a URL by the one rule the SQL side uses, or null', () => {
    expect(merchantHostOf('https://Services.Sandbox.Ampersend.ai/api/joke')).toBe('services.sandbox.ampersend.ai')
    expect(merchantHostOf('https://api.example:8443/x?y#z')).toBe('api.example')
    // Userinfo is stripped and an IDN is kept as written — the same answers
    // `HOST_OF_URL_SQL` gives, so the find key cannot disagree with itself.
    expect(merchantHostOf('https://user:pw@api.example/x')).toBe('api.example')
    expect(merchantHostOf('https://bücher.example/x')).toBe('bücher.example')
    expect(merchantHostOf('not a url')).toBeNull()
  })

  it('splits userinfo at the LAST @ like every client, so a crafted URL cannot claim a curated merchant\'s host', () => {
    // Review of 6f6ef7f6: with the first-@ rule these three named
    // services.ampersend.ai / b@c.example / evil.example — a third-party
    // Bazaar URL would have listed under Ampersend. The host must be what a
    // client fetches: WHATWG's answer, asserted against `new URL()` itself.
    const shapes = [
      'https://u@services.ampersend.ai:@evil.example/x',
      'https://a@b@c.example/',
      'https://user:pw@api.example/x',
      'https://api.example/a@b',
      'https://api.example:8443/x?y#z',
      // A backslash ends the authority for a client (WHATWG: `\\` is `/` in a
      // special scheme) — both directions of the spoof, second review.
      'https://evil.example\\@services.ampersend.ai/x',
      'https://services.ampersend.ai\\@evil.example/',
      'https://u@services.ampersend.ai#@evil.example/x',
      'https://u@services.ampersend.ai?@evil.example/x',
    ]
    for (const url of shapes) {
      expect(merchantHostOf(url), url).toBe(new URL(url).hostname)
    }
    expect(merchantHostOf('https://u@services.ampersend.ai:@evil.example/x')).toBe('evil.example')
  })

})

describe('resolveFundingTarget (#3331)', () => {
  const A = '0x' + 'aa'.repeat(20)
  const B = '0x' + 'bb'.repeat(20)
  const row = (o: Partial<Parameters<typeof resolveFundingTarget>[0]>) => ({
    network: 'eip155:84532', pay_tos: [A], any_unstated: false, all_erc7710: true, shared: false, ...o,
  })

  it('is verified only when every offer names the same one payTo', () => {
    expect(resolveFundingTarget(row({}))).toEqual({
      network: 'eip155:84532', chain_id: 84532, pay_to: A, pay_to_status: 'verified', erc7710: true,
    })
  })

  it('withholds the address when offers disagree or one names none', () => {
    expect(resolveFundingTarget(row({ pay_tos: [A, B] }))).toMatchObject({ pay_to: null, pay_to_status: 'conflicting' })
    expect(resolveFundingTarget(row({ any_unstated: true }))).toMatchObject({ pay_to: null, pay_to_status: 'unstated' })
    // Unstated wins over conflicting: some offer's address is simply unknown.
    expect(resolveFundingTarget(row({ pay_tos: [A, B], any_unstated: true }))).toMatchObject({ pay_to_status: 'unstated' })
    expect(resolveFundingTarget(row({ pay_tos: null, any_unstated: true }))).toMatchObject({ pay_to: null, pay_to_status: 'unstated' })
    expect(resolveFundingTarget(row({ pay_tos: [] }))).toMatchObject({ pay_to: null, pay_to_status: 'unstated' })
  })

  it('withholds an address another merchant is also paid at', () => {
    expect(resolveFundingTarget(row({ shared: true }))).toMatchObject({ pay_to: null, pay_to_status: 'shared' })
  })

  it('carries erc7710 through and skips a non-EVM network', () => {
    expect(resolveFundingTarget(row({ all_erc7710: false }))).toMatchObject({ erc7710: false, pay_to: A })
    expect(resolveFundingTarget(row({ network: 'solana:mainnet' }))).toBeNull()
    expect(resolveFundingTarget(row({ network: 'eip155:' }))).toBeNull()
  })
})

describeDb('listMerchantFundingTargets (#3331)', () => {
  const A = '0x' + 'aa'.repeat(20)
  const B = '0x' + 'bb'.repeat(20)

  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
  })
  afterAll(async () => {
    await assertWorkerSchemaAtHead()
  })

  it('agrees per network across active, verified x402 offers only', async () => {
    const m = await findOrCreateMerchantByHost('fund.example', { name: 'Fund' })
    await insertOffer(m.id, 'https://fund.example/a', { network: 'eip155:84532', payTo: A, methods: 'eip3009,erc7710' })
    await insertOffer(m.id, 'https://fund.example/b', { network: 'eip155:84532', payTo: A, methods: 'erc7710' })
    // None of these may move the answer: degraded, unverified, delisted and
    // MPP rows are not evidence of where the merchant is paid now.
    await insertOffer(m.id, 'https://fund.example/c', { network: 'eip155:84532', payTo: B, status: 'degraded' })
    await insertOffer(m.id, 'https://fund.example/d', { network: 'eip155:84532', payTo: B, verified: false })
    await insertOffer(m.id, 'https://fund.example/e', { network: 'eip155:84532', payTo: B, status: 'delisted' })
    await insertOffer(m.id, 'https://fund.example/f', { network: 'eip155:84532', rail: 'mpp' })
    // A second chain whose offers disagree.
    await insertOffer(m.id, 'https://fund.example/g', { network: 'eip155:11155111', payTo: A, methods: 'erc7710' })
    await insertOffer(m.id, 'https://fund.example/h', { network: 'eip155:11155111', payTo: B, methods: 'erc7710' })

    expect(await listMerchantFundingTargets(m.id, null)).toEqual([
      { network: 'eip155:11155111', chain_id: 11155111, pay_to: null, pay_to_status: 'conflicting', erc7710: true },
      { network: 'eip155:84532', chain_id: 84532, pay_to: A, pay_to_status: 'verified', erc7710: true },
    ])
    expect(await listMerchantFundingTargets(m.id, [84532])).toEqual([
      { network: 'eip155:84532', chain_id: 84532, pay_to: A, pay_to_status: 'verified', erc7710: true },
    ])
  })

  it('reports an offer with no payTo as unstated, and erc7710 only when EVERY offer has it', async () => {
    const m = await findOrCreateMerchantByHost('half.example', { name: 'Half' })
    await insertOffer(m.id, 'https://half.example/a', { network: 'eip155:84532', payTo: A, methods: 'erc7710' })
    await insertOffer(m.id, 'https://half.example/b', { network: 'eip155:84532', payTo: A, methods: 'eip3009' })
    expect(await listMerchantFundingTargets(m.id, null)).toEqual([
      { network: 'eip155:84532', chain_id: 84532, pay_to: A, pay_to_status: 'verified', erc7710: false },
    ])
    await insertOffer(m.id, 'https://half.example/c', { network: 'eip155:84532', payTo: null, methods: 'erc7710' })
    expect(await listMerchantFundingTargets(m.id, null)).toEqual([
      { network: 'eip155:84532', chain_id: 84532, pay_to: null, pay_to_status: 'unstated', erc7710: false },
    ])
  })

  it('does not treat a method name containing erc7710 as erc7710', async () => {
    const m = await findOrCreateMerchantByHost('lookalike.example', { name: 'Lookalike' })
    await insertOffer(m.id, 'https://lookalike.example/a', { network: 'eip155:84532', payTo: A, methods: 'erc7710x' })
    const [target] = await listMerchantFundingTargets(m.id, null)
    expect(target.erc7710).toBe(false)
  })

  it('reports a payTo another merchant is paid at on the same network as shared — and only on that network', async () => {
    const m = await findOrCreateMerchantByHost('platform-a.example', { name: 'Platform A' })
    const other = await findOrCreateMerchantByHost('platform-b.example', { name: 'Platform B' })
    await insertOffer(m.id, 'https://platform-a.example/x', { network: 'eip155:84532', payTo: A, methods: 'erc7710' })
    await insertOffer(m.id, 'https://platform-a.example/y', { network: 'eip155:8453', payTo: A, methods: 'erc7710' })
    await insertOffer(other.id, 'https://platform-b.example/x', { network: 'eip155:84532', payTo: A, methods: 'erc7710' })
    // Not evidence: the other merchant's DELISTED row on Base.
    await insertOffer(other.id, 'https://platform-b.example/y', { network: 'eip155:8453', payTo: A, status: 'delisted' })
    expect(await listMerchantFundingTargets(m.id, null)).toEqual([
      { network: 'eip155:8453', chain_id: 8453, pay_to: A, pay_to_status: 'verified', erc7710: true },
      { network: 'eip155:84532', chain_id: 84532, pay_to: null, pay_to_status: 'shared', erc7710: true },
    ])
  })

  it.each([
    ['degraded', { status: 'degraded' as const }],
    ['not yet verified', { verified: false }],
  ])("counts another merchant's %s offer as sharing the payTo — it can recover without a re-issue", async (_label, opts) => {
    const m = await findOrCreateMerchantByHost('solo.example', { name: 'Solo' })
    const other = await findOrCreateMerchantByHost('sleeper.example', { name: 'Sleeper' })
    await insertOffer(m.id, 'https://solo.example/x', { network: 'eip155:84532', payTo: A, methods: 'erc7710' })
    await insertOffer(other.id, 'https://sleeper.example/x', { network: 'eip155:84532', payTo: A, ...opts })
    const [target] = await listMerchantFundingTargets(m.id, null)
    expect(target).toMatchObject({ pay_to: null, pay_to_status: 'shared' })
  })

  it('is empty for a merchant with no qualifying offer', async () => {
    const m = await findOrCreateMerchantByHost('none.example', { name: 'None' })
    await insertOffer(m.id, 'https://none.example/a', { network: 'eip155:84532', payTo: A, status: 'degraded' })
    expect(await listMerchantFundingTargets(m.id, null)).toEqual([])
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

  it('the JavaScript and SQL readers agree — one PATTERN constant in two regex engines; this guards engine divergence, not the rule (a wrong rule wrong on both sides passes here and is caught by the new-URL test above)', async () => {
    const urls = [
      'https://Services.Sandbox.Ampersend.ai/api/joke',
      'https://api.example:8443/x?y#z',
      'https://user:pw@api.example/x',
      'https://u@services.ampersend.ai:@evil.example/x',
      'https://a@b@c.example/',
      'https://api.example/a@b',
      'https://evil.example\\@services.ampersend.ai/x',
      'https://services.ampersend.ai\\@evil.example/',
      'https://bücher.example/x',
      'not a url',
    ]
    const { rows } = await db.query<{ url: string; host: string | null }>(
      `SELECT resource_url AS url, ${HOST_OF_URL_SQL} AS host FROM unnest($1::text[]) AS resource_url`,
      [urls],
    )
    expect(rows.map((r) => r.host)).toEqual(urls.map(merchantHostOf))
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

  it('assertMerchantAcceptsOffers refuses a coming_soon merchant and allows a live one (#3080)', async () => {
    const prospectId = await insertProspect('redpine')
    await expect(assertMerchantAcceptsOffers(prospectId)).rejects.toThrow(ProspectMerchantWriteError)
    await expect(assertMerchantAcceptsOffers(prospectId)).rejects.toThrow(/coming_soon and cannot receive an offer/)

    const live = await findOrCreateMerchantByHost('live.example', { name: 'Live merchant' })
    await expect(assertMerchantAcceptsOffers(live.id)).resolves.toBeUndefined()
  })

  it('the FIND SQL itself never matches a coming_soon merchant through an offer on its host (#3080)', async () => {
    // A prospect with an offer attached is not a shape any real writer
    // produces (`assertMerchantAcceptsOffers` refuses it) — this proves the
    // FIRST line of defence independently: even with the row already in that
    // state, the host lookup does not treat it as "found", so a writer on
    // that host founds a NEW merchant rather than reusing the prospect.
    const prospectId = await insertProspect('bypassed-prospect')
    await insertOffer(prospectId, 'https://bypassed.example/a')
    const founded = await findOrCreateMerchantByHost('bypassed.example', { name: 'Bypassed' })
    expect(founded.id).not.toBe(prospectId)
    expect(founded.listing_status).toBe('live')
  })
})
