import { readFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAddress } from 'viem'
import { createDemoMerchantServer } from './http.js'
import { KIT_DISCOVERY_PATH, buildKitDiscovery } from './kit-discovery.js'
import { CHAIN_ID, USDC_ADDRESS } from './products.js'
import { createSalesReporting, type SalesConfig } from './sales.js'
import type { StripeRecording } from './stripe.js'
import { createX402PaymentProcessor, type SettlementClient } from './x402.js'

/**
 * #4987: the demo merchant serves the merchant kit's discovery document at
 * `/.well-known/x402`, listing only the products that report a sale to Haven,
 * with the Sales account as `pay_to`. The backend's real reader reads the
 * committed fixture this file pins (`catalog/__tests__/demo-merchant-x402.test.ts`).
 */

const FIXTURE = fileURLToPath(
  new URL('../../backend/src/modules/catalog/__tests__/fixtures/demo-merchant-x402.json', import.meta.url),
)

const MERCHANT = '0x15179876c595922999C2d5DC7c23Cc7711fE799a' as const
const SALES = getAddress('0xabcdef0123456789abcdef0123456789abcdef01')
const BASE_SEPOLIA_USDC = getAddress('0x036CbD53842c5426634e7929541eC2318f3dCF7e')
const CONFIG: SalesConfig = { address: SALES, salesKey: 'sk_merchant_test_do_not_log_0123456789', havenBaseUrl: 'https://haven.example' }
/** The route only asks whether Stripe recording is on; nothing here records a payment. */
const STRIPE_ON = { depositAddress: getAddress('0x3333333333333333333333333333333333333333') } as unknown as StripeRecording

let servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  servers = []
})

async function startServer(
  opts: { sales?: SalesConfig | null; stripe?: boolean; cdpConfigured?: boolean; salesAllProducts?: boolean } = {},
) {
  const settlementClient: SettlementClient = { submit: vi.fn(), waitForReceipt: vi.fn() }
  const salesConfig = opts.sales === undefined ? CONFIG : opts.sales
  const server = createDemoMerchantServer({
    merchantAddress: MERCHANT,
    baseUrl: 'http://127.0.0.1:0',
    paymentProcessor: createX402PaymentProcessor(settlementClient),
    settlementClient,
    readinessCacheMs: 0,
    ...(salesConfig ? { sales: createSalesReporting(salesConfig, { chainId: CHAIN_ID, fetch: vi.fn() as never, log: () => {} }) } : {}),
    ...(opts.stripe ? { stripe: STRIPE_ON } : {}),
    ...(opts.cdpConfigured ? { cdpConfigured: true } : {}),
    ...(opts.salesAllProducts ? { salesAllProducts: true } : {}),
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test server port')
  return `http://127.0.0.1:${address.port}`
}

describe('the kit discovery document (#4987)', () => {
  it('pins the backend fixture byte for byte', () => {
    const document = buildKitDiscovery({
      salesAddress: SALES,
      stripeConfigured: true,
      cdpConfigured: true,
      chainId: 84532,
      asset: BASE_SEPOLIA_USDC,
    })
    expect(`${JSON.stringify(document, null, 2)}\n`).toBe(readFileSync(FIXTURE, 'utf8'))
  })

  it('serves version 1 with the Sales account as pay_to, Field Notes and the joke, atomic prices', async () => {
    const origin = await startServer({ stripe: true, cdpConfigured: true })
    const res = await fetch(`${origin}${KIT_DISCOVERY_PATH}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toEqual({
      version: 1,
      operator: { name: 'Haven Demo Merchant' },
      name: 'Haven Demo Merchant',
      network: `eip155:${CHAIN_ID}`,
      asset: USDC_ADDRESS,
      pay_to: SALES,
      products: [
        { id: 'joke', name: 'Haven Joke', description: expect.any(String), price: '10000' },
        { id: 'field_notes', name: 'Haven Field Notes', description: expect.any(String), price: '2500' },
      ],
    })
    expect(body).not.toHaveProperty('mcp_url')
  })

  it('lists Field Notes alone when Stripe recording is off', async () => {
    const origin = await startServer({ cdpConfigured: true })
    const body = (await (await fetch(`${origin}${KIT_DISCOVERY_PATH}`)).json()) as { products: Array<{ id: string }> }
    expect(body.products.map((p) => p.id)).toEqual(['field_notes'])
  })

  it('lists the whole catalogue when MERCHANT_SALES_ALL_PRODUCTS is on', async () => {
    const origin = await startServer({ salesAllProducts: true })
    const body = (await (await fetch(`${origin}${KIT_DISCOVERY_PATH}`)).json()) as { products: Array<{ id: string }> }
    expect(body.products.map((p) => p.id)).toEqual([
      'vpn_basic',
      'vpn_legacy',
      'vpn_pro',
      'vpn_ultra',
      'storage_50gb',
      'storage_200gb',
      'storage_1tb',
      'field_notes',
      'philip_vpn',
      'philip_storage',
      'philip_spoof',
    ])
  })

  it('leaves the joke out when it is not offered (no CDP), even with Stripe on', async () => {
    const origin = await startServer({ stripe: true })
    const body = (await (await fetch(`${origin}${KIT_DISCOVERY_PATH}`)).json()) as { products: Array<{ id: string }> }
    expect(body.products.map((p) => p.id)).toEqual(['field_notes'])
  })

  it('is 404 without sales reporting', async () => {
    const origin = await startServer({ sales: null, stripe: true, cdpConfigured: true })
    expect((await fetch(`${origin}${KIT_DISCOVERY_PATH}`)).status).toBe(404)
  })

  it('is 404 with sales reporting but no Sales address (the joke still reports; there is no pay_to)', async () => {
    const origin = await startServer({
      sales: { salesKey: CONFIG.salesKey, havenBaseUrl: CONFIG.havenBaseUrl },
      stripe: true,
      cdpConfigured: true,
    })
    expect((await fetch(`${origin}${KIT_DISCOVERY_PATH}`)).status).toBe(404)
  })

  it('answers HEAD with 200 and the JSON content type (Node drops the body itself)', async () => {
    const origin = await startServer()
    const res = await fetch(`${origin}${KIT_DISCOVERY_PATH}`, { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
  })

  it('does not answer POST', async () => {
    const origin = await startServer()
    expect((await fetch(`${origin}${KIT_DISCOVERY_PATH}`, { method: 'POST' })).status).toBe(404)
  })

  it('leaves the demo merchant’s own document unchanged: no kit fields at / or its well-known path', async () => {
    const origin = await startServer({ stripe: true, cdpConfigured: true })
    for (const path of ['/', '/.well-known/haven-demo-merchant']) {
      const body = (await (await fetch(`${origin}${path}`)).json()) as { products: Array<Record<string, unknown>> } & Record<string, unknown>
      expect(body).not.toHaveProperty('version')
      expect(body).not.toHaveProperty('pay_to')
      expect(body.mcp_url).toBe('http://127.0.0.1:0/mcp')
      for (const product of body.products) expect(product).not.toHaveProperty('price')
    }
  })
})
