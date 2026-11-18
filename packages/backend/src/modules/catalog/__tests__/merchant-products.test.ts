/**
 * The merchant catalogue, read from a kit's discovery document (#4899, epic
 * #4885), on the REAL Postgres harness.
 *
 * The document is fetched through an injected seam, so no test touches the
 * network; everything else is real — the migration, the repository SQL, the
 * upserts and the retirement of a product the document no longer lists.
 *
 * What is pinned, against the issue's acceptance criteria:
 *
 * 1. After the owner saves an address, the account's product list matches the
 *    document.
 * 2. A product removed from the document stays as a name on past sales and is
 *    marked as no longer offered.
 * 3. A document whose receiving address or network is not the account's is a
 *    mismatch, and its products are not used for labelling.
 * 4. An address that resolves into private space is refused (the guard's
 *    refusal reaches the source row as `refused`), and a redirect off the host
 *    is refused by the guard — the guard's own tests cover the hop policy; here
 *    the refusal is what the catalogue records.
 * 5. An unreachable or malformed document leaves the last good list in place
 *    and records when it was last read.
 * 6. A sale's product name comes from the catalogue when the id is known there,
 *    and otherwise from the record.
 * 7. The list is stored in its own table: `merchant_catalog` is untouched.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import type { SafeFetchResult } from '../../../infra/http/ssrf-guard.js'
import {
  labelSaleProduct,
  parseDiscoveryDocument,
  readMerchantCatalogue,
  readMerchantCatalogueView,
  refreshAllMerchantCatalogues,
} from '../merchant-products.js'

const ACCOUNT_ADDRESS = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
const OTHER_ADDRESS = '0x7a3f9c2e1b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a'
const NETWORK = 'eip155:84532'
const DEPLOYMENT = 'https://kit.example.com'

interface Seeded {
  userId: string
  accountId: string
}

async function seedMerchantAccount(): Promise<Seeded> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`catalogue-${randomUUID()}@test.example`],
  )
  const userId = user.rows[0].id
  const account = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type, is_default, is_merchant_account)
     VALUES ($1, $2, 84532, 'delegation', 'delegator_hybrid', false, true) RETURNING id`,
    [userId, ACCOUNT_ADDRESS],
  )
  return { userId, accountId: account.rows[0].id }
}

/** A kit document, as `12-merchant-kit.md` §4 spells it. */
function document(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    operator: { name: 'Haven' },
    name: 'Haven inference demo',
    description: 'Opper inference paid per call on Base Sepolia.',
    network: NETWORK,
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    pay_to: ACCOUNT_ADDRESS,
    settlement: { scheme: 'exact', facilitator: 'coinbase-cdp', methods: ['eip3009'] },
    products: [
      {
        id: 'opper-gpt-6-sol-1k',
        name: 'Opper GPT-6 Sol, 1,000 output tokens',
        route: 'POST /v3/compat/chat/completions',
        model: 'openai/gpt-6-sol',
        price: '10000',
        output_token_cap: 1000,
        description: 'One chat completion on openai/gpt-6-sol, up to 1,000 output tokens.',
      },
      {
        id: 'opper-gpt-6-sol-4k',
        name: 'Opper GPT-6 Sol, 4,000 output tokens',
        route: 'POST /v3/compat/chat/completions',
        model: 'openai/gpt-6-sol-4k',
        price: '40000',
        output_token_cap: 4000,
        description: 'One chat completion on openai/gpt-6-sol-4k, up to 4,000 output tokens.',
      },
    ],
    updated: '2026-11-17T00:00:00Z',
    ...overrides,
  })
}

function ok(body: string): SafeFetchResult {
  return { ok: true, status: 200, body, headers: {}, finalUrl: `${DEPLOYMENT}/.well-known/x402` }
}

function refusal(reason: 'address_not_public' | 'redirect_off_host' | 'timeout' | 'http_status'): SafeFetchResult {
  return { ok: false, reason, detail: `test refusal: ${reason}` }
}

async function read(
  accountId: string,
  fetchText: (url: string) => Promise<SafeFetchResult>,
  overrides: { accountAddress?: string; chainId?: number; deploymentUrl?: string } = {},
) {
  return readMerchantCatalogue({
    merchantAccountId: accountId,
    deploymentUrl: overrides.deploymentUrl ?? DEPLOYMENT,
    accountAddress: overrides.accountAddress ?? ACCOUNT_ADDRESS,
    chainId: overrides.chainId ?? 84532,
    fetchText,
  })
}

async function products(accountId: string) {
  const rows = await db.query<{
    product_id: string
    name: string | null
    price_atomic: string
    network: string
    offered: boolean
    removed_at: Date | null
  }>(
    `SELECT product_id, name, price_atomic, network, offered, removed_at
     FROM merchant_products WHERE merchant_account_id = $1 ORDER BY product_id`,
    [accountId],
  )
  return rows.rows
}

async function source(accountId: string) {
  const rows = await db.query<{
    last_read_status: string
    last_read_at: Date | null
    mismatch: boolean
    mismatch_reason: string | null
    document_pay_to: string | null
    document_network: string | null
  }>(
    `SELECT last_read_status, last_read_at, mismatch, mismatch_reason, document_pay_to, document_network
     FROM merchant_catalogue_sources WHERE merchant_account_id = $1`,
    [accountId],
  )
  return rows.rows[0] ?? null
}

describeDb('the merchant catalogue (#4899)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  afterAll(async () => {
    await db.query('SELECT 1')
  })

  it('keeps the product list the document lists, with its price and network', async () => {
    const { accountId } = await seedMerchantAccount()
    await db.query(
      `INSERT INTO merchant_catalogue_sources (merchant_account_id, deployment_url) VALUES ($1, $2)`,
      [accountId, DEPLOYMENT],
    )

    const outcome = await read(accountId, async () => ok(document()))
    expect(outcome).toMatchObject({ status: 'ok', mismatch: false, productsWritten: 2 })

    const list = await products(accountId)
    expect(list).toEqual([
      {
        product_id: 'opper-gpt-6-sol-1k',
        name: 'Opper GPT-6 Sol, 1,000 output tokens',
        price_atomic: '10000',
        network: NETWORK,
        offered: true,
        removed_at: null,
      },
      {
        product_id: 'opper-gpt-6-sol-4k',
        name: 'Opper GPT-6 Sol, 4,000 output tokens',
        price_atomic: '40000',
        network: NETWORK,
        offered: true,
        removed_at: null,
      },
    ])

    const row = await source(accountId)
    expect(row).toMatchObject({
      last_read_status: 'ok',
      mismatch: false,
      document_pay_to: ACCOUNT_ADDRESS,
      document_network: NETWORK,
    })
    expect(row?.last_read_at).not.toBeNull()
  })

  it('reads the discovery document at /.well-known/x402, never the deployment root', async () => {
    const { accountId } = await seedMerchantAccount()
    const seen: string[] = []

    const outcome = await read(accountId, async (url) => {
      seen.push(url)
      return ok(document())
    })
    expect(outcome.status).toBe('ok')
    // The kit serves the document at this path and nowhere else; the root is a
    // 404, so a read of the bare deployment would never produce a catalogue.
    expect(seen).toEqual(['https://kit.example.com/.well-known/x402'])
  })

  it('reads the well-known path even when the saved address carries a path', async () => {
    const { accountId } = await seedMerchantAccount()
    const seen: string[] = []

    const outcome = await read(
      accountId,
      async (url) => {
        seen.push(url)
        return ok(document())
      },
      { deploymentUrl: 'https://kit.example.com/foo?bar=1' },
    )
    expect(outcome.status).toBe('ok')
    expect(seen).toEqual(['https://kit.example.com/.well-known/x402'])
  })

  it('records a saved address that is not a URL as refused, without fetching', async () => {
    const { accountId } = await seedMerchantAccount()
    let fetched = false

    const outcome = await read(
      accountId,
      async () => {
        fetched = true
        return ok(document())
      },
      { deploymentUrl: 'not-a-url' },
    )
    expect(outcome).toMatchObject({ status: 'refused', productsWritten: 0 })
    expect(outcome.detail).toContain('invalid_url')
    expect(fetched).toBe(false)
  })

  it('keeps a product the document removed, marks it not offered, and still names it on a sale', async () => {
    const { accountId } = await seedMerchantAccount()
    await db.query(
      `INSERT INTO merchant_catalogue_sources (merchant_account_id, deployment_url) VALUES ($1, $2)`,
      [accountId, DEPLOYMENT],
    )
    await read(accountId, async () => ok(document()))

    // The merchant drops the 4k product from the products file.
    const trimmed = JSON.parse(document()) as { products: unknown[] }
    trimmed.products = trimmed.products.slice(0, 1)
    const outcome = await read(accountId, async () => ok(JSON.stringify(trimmed)))
    expect(outcome.status).toBe('ok')

    const list = await products(accountId)
    const removed = list.find((p) => p.product_id === 'opper-gpt-6-sol-4k')
    expect(removed).toBeDefined()
    expect(removed?.offered).toBe(false)
    expect(removed?.removed_at).not.toBeNull()
    // The row is KEPT, so a past sale still names it.
    expect(removed?.name).toBe('Opper GPT-6 Sol, 4,000 output tokens')
    expect(await labelSaleProduct({ merchantAccountId: accountId, productId: 'opper-gpt-6-sol-4k', recordName: null })).toBe(
      'Opper GPT-6 Sol, 4,000 output tokens',
    )
  })

  it('records a mismatch when the receiving address is not the account, and does not use its products', async () => {
    const { accountId } = await seedMerchantAccount()
    await db.query(
      `INSERT INTO merchant_catalogue_sources (merchant_account_id, deployment_url) VALUES ($1, $2)`,
      [accountId, DEPLOYMENT],
    )
    // A good read first, so there is a last good list to protect.
    await read(accountId, async () => ok(document()))

    const outcome = await read(accountId, async () => ok(document({ pay_to: OTHER_ADDRESS })))
    expect(outcome.status).toBe('mismatch')
    expect(outcome.mismatch).toBe(true)
    expect(outcome.productsWritten).toBe(0)

    const row = await source(accountId)
    expect(row).toMatchObject({ last_read_status: 'mismatch', mismatch: true })
    expect(row?.mismatch_reason).toContain('receiving address')

    // The last good list is untouched, and the mismatched document's products
    // were never written: the list is still the two products of the good read.
    const list = await products(accountId)
    expect(list).toHaveLength(2)
    expect(list.every((p) => p.offered)).toBe(true)
  })

  it('records a mismatch when the network is not the account chain', async () => {
    const { accountId } = await seedMerchantAccount()
    await db.query(
      `INSERT INTO merchant_catalogue_sources (merchant_account_id, deployment_url) VALUES ($1, $2)`,
      [accountId, DEPLOYMENT],
    )

    const outcome = await read(accountId, async () => ok(document({ network: 'eip155:8453' })))
    expect(outcome.status).toBe('mismatch')
    expect(outcome.mismatchReason).toContain('network')
    expect(await products(accountId)).toHaveLength(0)
  })

  it('leaves the last good list in place when the kit is unreachable, and records when it was last read', async () => {
    const { accountId } = await seedMerchantAccount()
    await db.query(
      `INSERT INTO merchant_catalogue_sources (merchant_account_id, deployment_url) VALUES ($1, $2)`,
      [accountId, DEPLOYMENT],
    )
    await read(accountId, async () => ok(document()))

    const outcome = await read(accountId, async () => refusal('timeout'))
    expect(outcome.status).toBe('unreachable')

    const row = await source(accountId)
    expect(row?.last_read_status).toBe('unreachable')
    expect(row?.last_read_at).not.toBeNull()
    // The last good list survives, and the document identity it came from too.
    expect(await products(accountId)).toHaveLength(2)
    expect(row?.document_pay_to).toBe(ACCOUNT_ADDRESS)
  })

  it('leaves the last good list in place when the document is malformed', async () => {
    const { accountId } = await seedMerchantAccount()
    await db.query(
      `INSERT INTO merchant_catalogue_sources (merchant_account_id, deployment_url) VALUES ($1, $2)`,
      [accountId, DEPLOYMENT],
    )
    await read(accountId, async () => ok(document()))

    const outcome = await read(accountId, async () => ok('{"not":"a kit document"}'))
    expect(outcome.status).toBe('malformed')
    expect((await source(accountId))?.last_read_status).toBe('malformed')
    expect(await products(accountId)).toHaveLength(2)
  })

  it('records a refused address as refused, not unreachable, and keeps the list', async () => {
    const { accountId } = await seedMerchantAccount()
    await db.query(
      `INSERT INTO merchant_catalogue_sources (merchant_account_id, deployment_url) VALUES ($1, $2)`,
      [accountId, DEPLOYMENT],
    )
    await read(accountId, async () => ok(document()))

    // The guard's resolution-time refusal: the host resolves into private space.
    const privateOutcome = await read(accountId, async () => refusal('address_not_public'))
    expect(privateOutcome.status).toBe('refused')
    expect((await source(accountId))?.last_read_status).toBe('refused')

    // And a redirect off the host is refused by the same guard, for the same
    // reason: the document is not the one the owner named.
    const offHost = await read(accountId, async () => refusal('redirect_off_host'))
    expect(offHost.status).toBe('refused')
    expect(await products(accountId)).toHaveLength(2)
  })

  it('names a sale from the catalogue when the id is known, and from the record otherwise', async () => {
    const { accountId } = await seedMerchantAccount()
    await db.query(
      `INSERT INTO merchant_catalogue_sources (merchant_account_id, deployment_url) VALUES ($1, $2)`,
      [accountId, DEPLOYMENT],
    )
    await read(accountId, async () => ok(document()))

    expect(
      await labelSaleProduct({
        merchantAccountId: accountId,
        productId: 'opper-gpt-6-sol-1k',
        recordName: 'the record’s own name',
      }),
    ).toBe('Opper GPT-6 Sol, 1,000 output tokens')

    // Not in the catalogue: the record's name is the answer.
    expect(
      await labelSaleProduct({
        merchantAccountId: accountId,
        productId: 'not-in-the-catalogue',
        recordName: 'the record’s own name',
      }),
    ).toBe('the record’s own name')

    // No product id at all: the record's name.
    expect(
      await labelSaleProduct({ merchantAccountId: accountId, productId: null, recordName: 'the record’s own name' }),
    ).toBe('the record’s own name')
  })

  it('never writes merchant_catalog — the list is its own table', async () => {
    const { accountId } = await seedMerchantAccount()
    await db.query(
      `INSERT INTO merchant_catalogue_sources (merchant_account_id, deployment_url) VALUES ($1, $2)`,
      [accountId, DEPLOYMENT],
    )
    const before = await db.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM merchant_catalog`)
    await read(accountId, async () => ok(document()))
    const after = await db.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM merchant_catalog`)
    expect(after.rows[0].count).toBe(before.rows[0].count)
  })

  it('retires the old list when the owner saves a different address', async () => {
    const { accountId } = await seedMerchantAccount()
    await db.query(
      `INSERT INTO merchant_catalogue_sources (merchant_account_id, deployment_url) VALUES ($1, $2)`,
      [accountId, DEPLOYMENT],
    )
    await read(accountId, async () => ok(document()))

    const { saveCatalogueDeployment } = await import('../../../infra/repositories/merchant-catalogue.js')
    const saved = await saveCatalogueDeployment({
      merchantAccountId: accountId,
      deploymentUrl: 'https://other-kit.example.com',
    })
    expect(saved.changed).toBe(true)

    const list = await products(accountId)
    expect(list).toHaveLength(2)
    expect(list.every((p) => !p.offered)).toBe(true)
    expect(list.every((p) => p.removed_at !== null)).toBe(true)
  })

  it('reads every configured source in one pass, and one failure does not stop the others', async () => {
    const first = await seedMerchantAccount()
    const second = await seedMerchantAccount()
    await db.query(
      `INSERT INTO merchant_catalogue_sources (merchant_account_id, deployment_url) VALUES ($1, $2), ($3, $4)`,
      [first.accountId, DEPLOYMENT, second.accountId, 'https://broken.example.com'],
    )

    const report = await refreshAllMerchantCatalogues(undefined, {
      fetchText: async (url) =>
        url === `${DEPLOYMENT}/.well-known/x402` ? ok(document()) : refusal('http_status'),
    })
    expect(report).toEqual({ read: 2, ok: 1, mismatch: 0, failed: 1 })
    expect(await products(first.accountId)).toHaveLength(2)
    expect(await products(second.accountId)).toHaveLength(0)
  })

  it('answers the owner view with the source and the list', async () => {
    const { accountId } = await seedMerchantAccount()
    await db.query(
      `INSERT INTO merchant_catalogue_sources (merchant_account_id, deployment_url) VALUES ($1, $2)`,
      [accountId, DEPLOYMENT],
    )
    await read(accountId, async () => ok(document()))

    const view = await readMerchantCatalogueView(accountId)
    expect(view.source?.deployment_url).toBe(DEPLOYMENT)
    expect(view.products).toHaveLength(2)
  })
})

describe('parseDiscoveryDocument (#4899)', () => {
  it('reads the kit document the design specifies', () => {
    const parsed = parseDiscoveryDocument(document())
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.document).toMatchObject({
      version: 1,
      network: NETWORK,
      payTo: ACCOUNT_ADDRESS,
      name: 'Haven inference demo',
      operatorName: 'Haven',
      updated: '2026-11-17T00:00:00Z',
      skippedProducts: 0,
    })
    expect(parsed.document.products).toHaveLength(2)
    expect(parsed.document.products[0]).toMatchObject({
      productId: 'opper-gpt-6-sol-1k',
      priceAtomic: '10000',
      outputTokenCap: 1000,
      network: NETWORK,
    })
  })

  it('refuses a document with no version — it is not a kit document', () => {
    const parsed = parseDiscoveryDocument(JSON.stringify({ network: NETWORK, pay_to: ACCOUNT_ADDRESS, products: [] }))
    expect(parsed).toMatchObject({ ok: false })
  })

  it('refuses a document with no network, no receiving address, or no products array', () => {
    expect(parseDiscoveryDocument(JSON.stringify({ version: 1, pay_to: ACCOUNT_ADDRESS, products: [] }))).toMatchObject({
      ok: false,
    })
    expect(parseDiscoveryDocument(JSON.stringify({ version: 1, network: NETWORK, products: [] }))).toMatchObject({
      ok: false,
    })
    expect(
      parseDiscoveryDocument(JSON.stringify({ version: 1, network: NETWORK, pay_to: ACCOUNT_ADDRESS })),
    ).toMatchObject({ ok: false })
  })

  it('refuses a malformed asset address', () => {
    expect(parseDiscoveryDocument(document({ asset: 'not-an-address' }))).toMatchObject({ ok: false })
  })

  it('refuses a body that is not JSON, or not an object', () => {
    expect(parseDiscoveryDocument('not json')).toMatchObject({ ok: false })
    expect(parseDiscoveryDocument('[]')).toMatchObject({ ok: false })
  })

  it('skips a product it cannot understand rather than refusing the catalogue', () => {
    const parsed = parseDiscoveryDocument(
      document({
        products: [
          { id: 'good', price: '10000', description: 'fine' },
          // A float price is refused by the design (§3): a float cannot
          // represent every atomic amount exactly.
          { id: 'float-price', price: 10000 },
          { id: 'dollar-price', price: '$0.01' },
          { price: '10000' },
        ],
      }),
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.document.products.map((p) => p.productId)).toEqual(['good'])
    expect(parsed.document.skippedProducts).toBe(3)
  })

  it('reads a HIGHER version for the fields it knows and ignores the rest', () => {
    const parsed = parseDiscoveryDocument(document({ version: 2, something_new: { a: 1 } }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.document.version).toBe(2)
    expect(parsed.document.products).toHaveLength(2)
  })
})
