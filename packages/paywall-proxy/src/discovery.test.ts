/**
 * The discovery document (#4891, docs/architecture/12-merchant-kit.md §4): the
 * products file, served at the x402 well-known path. Each test is named for the
 * acceptance criterion it proves. The document is a catalogue: answering it
 * verifies nothing, settles nothing and makes no facilitator call.
 */
import { writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { DISCOVERY_PATH } from './discovery.js'
import { CHAT_PRODUCT, PAY_TO, PLAIN_PRODUCT, SEPOLIA_USDC, startHarness, type Harness } from './test-harness.js'

let h: Harness
afterEach(async () => {
  await h?.stop()
})

const get = (path: string, init?: RequestInit): Promise<Response> => fetch(`${h.base}${path}`, init)

interface Document {
  version: number
  operator: { name: string; contact?: string }
  name: string
  description: string
  network: string
  asset: string
  pay_to: string
  settlement: Record<string, unknown>
  products: Record<string, unknown>[]
  updated?: string
  icon_url?: string
}

async function document(): Promise<Document> {
  const res = await get(DISCOVERY_PATH)
  expect(res.status).toBe(200)
  return (await res.json()) as Document
}

describe('the discovery document', () => {
  it('returns every product in the products file with its price, asset, network and how to call it, and nothing that is not in the file', async () => {
    h = await startHarness({ products: [CHAT_PRODUCT, PLAIN_PRODUCT] })
    const res = await get(DISCOVERY_PATH)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
    const doc = (await res.json()) as Document

    expect(doc.version).toBe(1)
    expect(doc.network).toBe('eip155:84532')
    expect(doc.asset).toBe(SEPOLIA_USDC)
    expect(doc.pay_to).toBe(PAY_TO)
    expect(doc.settlement).toEqual({ scheme: 'exact', facilitator: 'coinbase-cdp', methods: ['eip3009'] })

    // Every product in the file, exactly as the file spells it: the route is how to call it.
    expect(doc.products).toEqual([
      {
        id: 'chat-sol-1k',
        name: 'Chat, 1,000 output tokens',
        route: 'POST /v3/compat/chat/completions',
        model: 'openai/gpt-6-sol',
        price: '10000',
        output_token_cap: 1000,
        description: 'One chat completion on openai/gpt-6-sol, up to 1,000 output tokens.',
      },
      { id: 'lookup', route: 'GET /v1/lookup', price: '20000', description: 'One lookup.' },
    ])

    // Nothing that is not in the file: no demo-merchant field, no MCP endpoint,
    // no per-product field the products file does not carry.
    expect(Object.keys(doc).sort()).toEqual([
      'asset',
      'description',
      'name',
      'network',
      'operator',
      'pay_to',
      'products',
      'settlement',
      'updated',
      'version',
    ])
    expect(doc).not.toHaveProperty('mcp_url')
    expect(doc).not.toHaveProperty('chain_id')
    expect(doc).not.toHaveProperty('environment')
    expect(doc).not.toHaveProperty('hosted_urls')
    expect(doc).not.toHaveProperty('routing')
    expect(doc).not.toHaveProperty('settlement_methods')
    for (const product of doc.products) {
      expect(product).not.toHaveProperty('price_usdc')
      expect(product).not.toHaveProperty('tools')
      expect(product).not.toHaveProperty('category')
    }

    // `updated` is the products file's last change, an RFC 3339 timestamp.
    expect(Number.isNaN(Date.parse(doc.updated ?? ''))).toBe(false)
  })

  it('answers without any facilitator call, any chain read or any upstream call', async () => {
    h = await startHarness()
    for (let i = 0; i < 3; i += 1) expect((await get(DISCOVERY_PATH)).status).toBe(200)
    expect(h.facilitator.verifyCalls).toBe(0)
    expect(h.facilitator.settleCalls).toBe(0)
    expect(h.chain.reads).toBe(0)
    expect(h.upstream.seen).toHaveLength(0)
  })

  it('changes when the products file changes and the proxy restarts', async () => {
    h = await startHarness({ products: [CHAT_PRODUCT] })
    expect((await document()).products.map((p) => p.id)).toEqual(['chat-sol-1k'])

    writeFileSync(h.env.PRODUCTS_FILE!, JSON.stringify({ version: 1, products: [PLAIN_PRODUCT] }))
    await h.restart()

    const after = await document()
    expect(after.products.map((p) => p.id)).toEqual(['lookup'])
    expect(after.products[0]).toMatchObject({ route: 'GET /v1/lookup', price: '20000' })
  })

  it('is served at the x402 well-known path only, not at the demo merchant path or /', async () => {
    h = await startHarness()
    expect((await get(DISCOVERY_PATH)).status).toBe(200)
    for (const path of ['/.well-known/haven-demo-merchant', '/']) {
      const res = await get(path)
      expect(res.status).toBe(404)
      expect(((await res.json()) as { error: string }).error).toBe('unknown_route')
    }
    // The demo merchant's document names an MCP endpoint; the kit's carries none.
    expect(await document()).not.toHaveProperty('mcp_url')
  })

  it('shows who operates the endpoint, and names the endpoint itself', async () => {
    h = await startHarness({
      env: { OPERATOR_NAME: 'Acme Inference', OPERATOR_CONTACT: 'https://acme.example/contact' },
    })
    const doc = await document()
    expect(doc.operator).toEqual({ name: 'Acme Inference', contact: 'https://acme.example/contact' })
    expect(doc.name).toBe('Test endpoint')
    expect(doc.description).toBe('A test endpoint that sells calls.')
  })

  it('carries the optional example fields the products file has, and no others', async () => {
    h = await startHarness({
      products: [
        {
          ...CHAT_PRODUCT,
          input_example: { model: 'openai/gpt-6-sol', messages: [{ role: 'user', content: 'hi' }] },
          input_schema: { type: 'object', required: ['model', 'messages'] },
          output_example: { id: 'cmpl-1', choices: [] },
        },
      ],
    })
    const doc = await document()
    expect(doc.products[0]).toMatchObject({
      input_example: { model: 'openai/gpt-6-sol', messages: [{ role: 'user', content: 'hi' }] },
      input_schema: { type: 'object', required: ['model', 'messages'] },
      output_example: { id: 'cmpl-1', choices: [] },
    })
  })

  it('carries the deployment icon URL when one is set, and no icon_url otherwise', async () => {
    h = await startHarness({ env: { ICON_URL: 'https://acme.example/icon.png' } })
    expect((await document()).icon_url).toBe('https://acme.example/icon.png')
    await h.stop()
    h = await startHarness()
    expect(await document()).not.toHaveProperty('icon_url')
  })

  it('answers HEAD with the same status and no body', async () => {
    h = await startHarness()
    const res = await get(DISCOVERY_PATH, { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })
})
