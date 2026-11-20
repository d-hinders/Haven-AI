/**
 * The discovery document (#4891, #4990, docs/architecture/12-merchant-kit.md §4):
 * the products file, served at the x402 well-known path. Each test is named for
 * the acceptance criterion it proves. The document is a catalogue: answering it
 * verifies nothing, settles nothing and makes no facilitator call.
 */
import { writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { DISCOVERY_PATH, X402_SPEC_URL, formatUsdcPrice } from './discovery.js'
import {
  CHAT_BODY,
  CHAT_PATH,
  CHAT_PRODUCT,
  PAY_TO,
  PLAIN_PRODUCT,
  SEPOLIA_USDC,
  chatRequest,
  newBuyer,
  startHarness,
  type Harness,
} from './test-harness.js'

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
  network_name: string
  testnet: boolean
  asset: string
  asset_symbol: string
  asset_decimals: number
  pay_to: string
  settlement: Record<string, unknown>
  terms: Record<string, unknown> & {
    one_payment_one_call: boolean
    replay: { code: string; statement: string }
    payment_response: { header: string; statement: string }
    upstream_answered: { code: string; statement: string }
    on_failure_after_settlement: { code: string; statement: string; contact?: string }
  }
  payment: { headers: string[]; preferred_header: string; x402_version: number; spec: string }
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
  it('returns every product in the products file with its price, asset, network and how to call it, plus the kit’s own constants and nothing else', async () => {
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
        price_usdc: '0.01',
        output_token_cap: 1000,
        description: 'One chat completion on openai/gpt-6-sol, up to 1,000 output tokens.',
      },
      { id: 'lookup', route: 'GET /v1/lookup', price: '20000', price_usdc: '0.02', description: 'One lookup.' },
    ])

    // Nothing that is not in the file, except the kit's own constants (`terms`,
    // `payment`) and the deployment's settings: no demo-merchant field, no MCP
    // endpoint, no per-product field the products file does not carry.
    expect(Object.keys(doc).sort()).toEqual([
      'asset',
      'asset_decimals',
      'asset_symbol',
      'description',
      'name',
      'network',
      'network_name',
      'operator',
      'pay_to',
      'payment',
      'products',
      'settlement',
      'terms',
      'testnet',
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
      expect(product).not.toHaveProperty('tools')
      expect(product).not.toHaveProperty('category')
      expect(product).not.toHaveProperty('output_schema')
    }

    // `updated` is the products file's last change, an RFC 3339 timestamp.
    expect(Number.isNaN(Date.parse(doc.updated ?? ''))).toBe(false)
  })

  it('keeps every version 1 field byte-identical for the same products file (#4990)', async () => {
    h = await startHarness({ products: [CHAT_PRODUCT, PLAIN_PRODUCT] })
    const doc = await document()
    // The pinned snapshot of the version 1 document: the fields #4891 shipped,
    // with the values they had. `updated` is the products file's mtime, so it is
    // asserted as a timestamp above rather than pinned here.
    const version1 = {
      version: doc.version,
      operator: doc.operator,
      name: doc.name,
      description: doc.description,
      network: doc.network,
      asset: doc.asset,
      pay_to: doc.pay_to,
      settlement: doc.settlement,
      products: doc.products.map((product) => ({
        id: product.id,
        name: product.name,
        route: product.route,
        model: product.model,
        price: product.price,
        output_token_cap: product.output_token_cap,
        description: product.description,
      })),
    }
    expect(version1).toEqual({
      version: 1,
      operator: { name: 'Test operator' },
      name: 'Test endpoint',
      description: 'A test endpoint that sells calls.',
      network: 'eip155:84532',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      pay_to: PAY_TO,
      settlement: { scheme: 'exact', facilitator: 'coinbase-cdp', methods: ['eip3009'] },
      products: [
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
      ],
    })
  })

  it('carries each product’s price as a decimal USDC string with no trailing zeros (#4990)', async () => {
    h = await startHarness({
      products: [
        { id: 'cent', route: 'GET /cent', price: '10000', description: 'One cent.' },
        { id: 'eighteen-mills', route: 'GET /eighteen-mills', price: '18000', description: 'Eighteen mills.' },
        { id: 'ten-thousandth', route: 'GET /ten-thousandth', price: '100', description: 'A ten-thousandth.' },
      ],
    })
    const doc = await document()
    expect(doc.products.map((product) => [product.price, product.price_usdc])).toEqual([
      ['10000', '0.01'],
      ['18000', '0.018'],
      ['100', '0.0001'],
    ])
  })

  it('formats a price with no trailing zeros, in pure bigint math', () => {
    expect(formatUsdcPrice(1n)).toBe('0.000001')
    expect(formatUsdcPrice(100n)).toBe('0.0001')
    expect(formatUsdcPrice(10000n)).toBe('0.01')
    expect(formatUsdcPrice(18000n)).toBe('0.018')
    expect(formatUsdcPrice(1_000_000n)).toBe('1')
    expect(formatUsdcPrice(1_500_000n)).toBe('1.5')
    expect(formatUsdcPrice(12_345_678n)).toBe('12.345678')
    // Past 2^53 base units: a Number round-trip would lose the last digits.
    expect(formatUsdcPrice(9_007_199_254_740_993n)).toBe('9007199254.740993')
  })

  it('names the network and the asset in words as well as ids (#4990)', async () => {
    h = await startHarness()
    const doc = await document()
    expect(doc.network).toBe('eip155:84532')
    expect(doc.network_name).toBe('Base Sepolia testnet')
    expect(doc.testnet).toBe(true)
    expect(doc.asset).toBe(SEPOLIA_USDC)
    expect(doc.asset_symbol).toBe('USDC')
    expect(doc.asset_decimals).toBe(6)
  })

  it('states the rules of the sale in `terms`, and says nothing about retries or the payer-signed proof (#4990)', async () => {
    h = await startHarness()
    const doc = await document()
    expect(doc.terms.one_payment_one_call).toBe(true)
    expect(doc.terms.replay.code).toBe('payment_already_delivered')
    expect(doc.terms.payment_response.header).toBe('PAYMENT-RESPONSE')
    expect(doc.terms.upstream_answered.code).toBe('upstream_answered')
    expect(doc.terms.on_failure_after_settlement.code).toBe('upstream_failed_after_settlement')
    for (const term of [doc.terms.replay, doc.terms.payment_response, doc.terms.upstream_answered, doc.terms.on_failure_after_settlement]) {
      expect(term.statement.length).toBeGreaterThan(0)
    }
    // Owner decision 2 (2026-11-19): the recourse policy is not stated here.
    expect(JSON.stringify(doc.terms)).not.toMatch(/retry|retries|SIGN-IN-WITH-X|sign_in_with_x|forward/i)
  })

  it('names the merchant’s contact in `on_failure_after_settlement` when one is set, and says none was published when it is not (#4990)', async () => {
    h = await startHarness({ env: { OPERATOR_CONTACT: 'https://acme.example/contact' } })
    const withContact = await document()
    expect(withContact.terms.on_failure_after_settlement.contact).toBe('https://acme.example/contact')
    expect(withContact.terms.on_failure_after_settlement.statement).toContain('https://acme.example/contact')

    await h.stop()
    h = await startHarness()
    const withoutContact = await document()
    expect(withoutContact.terms.on_failure_after_settlement).not.toHaveProperty('contact')
    expect(withoutContact.terms.on_failure_after_settlement.statement).toContain('published no contact')
  })

  it('names only codes the handler answers with for that case (#4990)', async () => {
    h = await startHarness()
    const terms = (await document()).terms

    // `replay`: the same payment header again, after the call was delivered.
    const buyer = newBuyer()
    const paid = await buyer.pay(h, CHAT_PATH, chatRequest({}, CHAT_BODY))
    const first = await fetch(`${h.base}${CHAT_PATH}`, chatRequest({ 'payment-signature': paid.header }, CHAT_BODY))
    expect(first.status).toBe(200)
    const replay = await fetch(`${h.base}${CHAT_PATH}`, chatRequest({ 'payment-signature': paid.header }, CHAT_BODY))
    expect(((await replay.json()) as { error: string }).error).toBe(terms.replay.code)

    // `upstream_answered`: a 4xx the buyer caused, wrapped into a 200.
    h.upstream.behaviour = { status: 422, headers: { 'content-type': 'application/json' }, body: '{"detail":"bad prompt"}' }
    const answered = await fetch(`${h.base}${CHAT_PATH}`, chatRequest({ 'payment-signature': (await newBuyer().pay(h, CHAT_PATH, chatRequest({}, CHAT_BODY))).header }, CHAT_BODY))
    expect(answered.status).toBe(200)
    expect(((await answered.json()) as { error: string }).error).toBe(terms.upstream_answered.code)

    // `on_failure_after_settlement`: the upstream failed after the payment settled.
    h.upstream.behaviour = { status: 503, headers: { 'content-type': 'application/json' }, body: '{"detail":"down"}' }
    const failed = await fetch(`${h.base}${CHAT_PATH}`, chatRequest({ 'payment-signature': (await newBuyer().pay(h, CHAT_PATH, chatRequest({}, CHAT_BODY))).header }, CHAT_BODY))
    expect(failed.status).toBe(200)
    expect(((await failed.json()) as { error: string }).error).toBe(terms.on_failure_after_settlement.code)
  })

  it('says how to pay: the accepted headers, the x402 version and the specification (#4990)', async () => {
    h = await startHarness()
    const doc = await document()
    expect(doc.payment).toEqual({
      headers: ['PAYMENT-SIGNATURE', 'X-PAYMENT'],
      preferred_header: 'PAYMENT-SIGNATURE',
      x402_version: 2,
      spec: X402_SPEC_URL,
    })
    expect(X402_SPEC_URL).toBe('https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md')
  })

  it('serves a product’s output_schema when the products file carries one, and no output_schema otherwise (#4990)', async () => {
    h = await startHarness({
      products: [
        {
          ...CHAT_PRODUCT,
          output_schema: { type: 'object', required: ['id', 'choices'], properties: { id: { type: 'string' } } },
        },
      ],
    })
    const doc = await document()
    expect(doc.products[0]).toMatchObject({
      output_schema: { type: 'object', required: ['id', 'choices'], properties: { id: { type: 'string' } } },
    })
    await h.stop()
    h = await startHarness({ products: [CHAT_PRODUCT] })
    expect((await document()).products[0]).not.toHaveProperty('output_schema')
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
    expect(after.products[0]).toMatchObject({ route: 'GET /v1/lookup', price: '20000', price_usdc: '0.02' })
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
