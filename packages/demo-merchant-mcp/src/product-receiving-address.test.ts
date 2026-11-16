/**
 * #4850: the receiving address and the settlement kind are properties of a
 * PRODUCT, not one merchant-wide global.
 *
 * Two halves:
 *  - Characterization. Recorded against the code BEFORE the refactor, and
 *    unchanged after it: what `/healthz`, the discovery document,
 *    `list_products`, every product's 402 and the in-band refusal said. The
 *    snapshot file is the record; a refactor that moves one byte reddens it.
 *  - The new property. A product whose receiving address is NOT the merchant
 *    default is quoted, verified and invoiced against its own address, and a
 *    payment made out to the merchant default for that product is refused.
 */
import { randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { encodePaymentSignatureHeader } from '@x402/core/http'
import type { PaymentPayload, PaymentRequired } from '@x402/core/types'
import { createDemoMerchantServer } from './http.js'
import { buildMerchantMcpServer } from './server.js'
import {
  PRODUCTS,
  productReceivingAddress,
  productSettlementKind,
  productToolArgs,
  type Product,
  type ProductId,
} from './products.js'
import {
  PAYMENT_SIGNATURE_HEADER,
  USDC_ADDRESS,
  createX402PaymentProcessor,
  type Eip3009Authorization,
  type SettlementClient,
} from './x402.js'

const MERCHANT = '0x15179876c595922999C2d5DC7c23Cc7711fE799a' as const
const OTHER_RECIPIENT = '0x2222222222222222222222222222222222222222' as const
const PAYER_KEY = `0x${'01'.repeat(32)}` as const
const TX_HASH = `0x${'ef'.repeat(32)}` as const
const PRODUCT_IDS = Object.keys(PRODUCTS) as ProductId[]

let servers: Server[] = []
const restoreProducts: Array<() => void> = []

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  servers = []
  while (restoreProducts.length) restoreProducts.pop()!()
  vi.restoreAllMocks()
})

/** Swap one product definition for the test; `afterEach` puts it back. */
function overrideProduct(id: ProductId, patch: Partial<Product>): void {
  const original = PRODUCTS[id]
  PRODUCTS[id] = { ...original, ...patch }
  restoreProducts.push(() => {
    PRODUCTS[id] = original
  })
}

async function startServer() {
  const submit = vi.fn<SettlementClient['submit']>().mockResolvedValue(TX_HASH)
  const waitForReceipt = vi.fn<SettlementClient['waitForReceipt']>().mockResolvedValue(undefined)
  const settlementClient: SettlementClient = { submit, waitForReceipt }
  const server = createDemoMerchantServer({
    merchantAddress: MERCHANT,
    baseUrl: 'http://127.0.0.1:0',
    paymentProcessor: createX402PaymentProcessor(settlementClient),
    settlementClient,
    readinessCacheMs: 0,
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test server port')
  return { submit, origin: `http://127.0.0.1:${address.port}`, url: `http://127.0.0.1:${address.port}/mcp` }
}

async function postMcp(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  })
}

function buyCall(id: ProductId, rpcId = 3) {
  const { toolName, argumentName, argumentValue } = productToolArgs(PRODUCTS[id])
  return {
    jsonrpc: '2.0',
    id: rpcId,
    method: 'tools/call',
    params: { name: toolName, arguments: { [argumentName]: argumentValue } },
  }
}

/** Sign an EIP-3009 header for the challenge's first option, optionally
 *  addressed somewhere other than the option's own `payTo`. */
async function signedHeader(pr: PaymentRequired, overrideTo?: `0x${string}`): Promise<string> {
  const account = privateKeyToAccount(PAYER_KEY)
  const now = Math.floor(Date.now() / 1000)
  const accepted = overrideTo ? { ...pr.accepts[0], payTo: overrideTo } : pr.accepts[0]
  const authorization: Eip3009Authorization = {
    from: account.address,
    to: accepted.payTo,
    value: accepted.amount,
    validAfter: String(now - 5),
    validBefore: String(now + 300),
    nonce: `0x${randomBytes(32).toString('hex')}`,
  }
  const signature = await account.signTypedData({
    domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC_ADDRESS },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message: {
      from: authorization.from as `0x${string}`,
      to: authorization.to as `0x${string}`,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce as `0x${string}`,
    },
  })
  const payload: PaymentPayload = {
    x402Version: 2,
    resource: pr.resource,
    accepted,
    payload: { authorization, signature },
    ...(pr.extensions ? { extensions: pr.extensions } : {}),
  }
  return encodePaymentSignatureHeader(payload)
}

/** The port is random per run; everything else must be byte-stable. */
function normalize(raw: string): string {
  return raw.replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:PORT')
}

async function inBandRefusal(id: ProductId): Promise<string> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  const processor = createX402PaymentProcessor({
    submit: vi.fn<SettlementClient['submit']>().mockResolvedValue(TX_HASH),
    waitForReceipt: vi.fn<SettlementClient['waitForReceipt']>().mockResolvedValue(undefined),
  })
  const server = buildMerchantMcpServer({
    merchantAddress: MERCHANT,
    baseUrl: 'http://127.0.0.1:0',
    buildPaymentRequired: processor.buildPaymentRequired,
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  const { toolName, argumentName, argumentValue } = productToolArgs(PRODUCTS[id])
  const result = await client.callTool({ name: toolName, arguments: { [argumentName]: argumentValue } })
  await client.close()
  await server.close()
  return (result.content as Array<{ text: string }>)[0].text
}

describe('characterization: merchant-wide surfaces are unchanged by #4850', () => {
  it('/healthz, the discovery document and list_products are byte-identical', async () => {
    const { origin, url } = await startServer()
    const healthz = await (await fetch(`${origin}/healthz`)).text()
    const root = await (await fetch(`${origin}/`)).text()
    const wellKnown = await (await fetch(`${origin}/.well-known/haven-demo-merchant`)).text()
    const listProducts = await (await postMcp(url, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_products', arguments: {} },
    })).text()

    expect(normalize(healthz)).toMatchSnapshot('healthz')
    expect(normalize(root)).toMatchSnapshot('discovery')
    expect(normalize(wellKnown)).toBe(normalize(root))
    expect(normalize(listProducts)).toMatchSnapshot('list_products')
  })

  it.each(PRODUCT_IDS)('the 402 for %s is byte-identical and pays MERCHANT_ADDRESS', async (id) => {
    const { url } = await startServer()
    const unpaid = await postMcp(url, buyCall(id))
    expect(unpaid.status).toBe(402)
    const body = await unpaid.text()
    expect(normalize(body)).toMatchSnapshot(`402 ${id}`)
    const pr = JSON.parse(body) as PaymentRequired
    for (const option of pr.accepts) expect(option.payTo).toBe(MERCHANT)
  })

  it.each(PRODUCT_IDS)('the in-band refusal for %s is byte-identical', async (id) => {
    expect(normalize(await inBandRefusal(id))).toMatchSnapshot(`in-band ${id}`)
  })
})

describe('a product carries its own receiving address and settlement kind (#4850)', () => {
  it('every product today defaults to MERCHANT_ADDRESS and self-settlement', () => {
    for (const id of PRODUCT_IDS) {
      expect(PRODUCTS[id].receivingAddress).toBeUndefined()
      expect(productReceivingAddress(PRODUCTS[id], MERCHANT)).toBe(MERCHANT)
      expect(productSettlementKind(PRODUCTS[id])).toBe('self')
    }
  })

  it('quotes, verifies, settles and invoices against the product address, not MERCHANT_ADDRESS', async () => {
    overrideProduct('vpn_pro', { receivingAddress: OTHER_RECIPIENT })
    const { url, submit } = await startServer()

    const unpaid = await postMcp(url, buyCall('vpn_pro'))
    expect(unpaid.status).toBe(402)
    const pr = (await unpaid.json()) as PaymentRequired
    expect(pr.accepts.length).toBeGreaterThan(0)
    for (const option of pr.accepts) expect(option.payTo).toBe(OTHER_RECIPIENT)

    const paid = await postMcp(url, buyCall('vpn_pro', 4), { [PAYMENT_SIGNATURE_HEADER]: await signedHeader(pr) })
    const text = await paid.text()
    expect(paid.status).toBe(200)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(getAddress(submit.mock.calls[0][0].to)).toBe(getAddress(OTHER_RECIPIENT))

    const receipt = JSON.parse(Buffer.from(paid.headers.get('x-receipt-json')!, 'base64').toString('utf8'))
    expect(receipt.saljare.crypto_address).toBe(OTHER_RECIPIENT)
    // The keys Haven's accounting reads off the seller block are unchanged.
    expect(Object.keys(receipt.saljare)).toEqual(
      expect.arrayContaining(['name', 'org_nr', 'moms_nr', 'crypto_address']),
    )
    expect(text).toContain(`Recipient address: ${OTHER_RECIPIENT}`)
    expect(text).not.toContain(MERCHANT)
  })

  it('refuses a payment for that product made out to MERCHANT_ADDRESS', async () => {
    overrideProduct('vpn_pro', { receivingAddress: OTHER_RECIPIENT })
    const { url, submit } = await startServer()
    const pr = (await (await postMcp(url, buyCall('vpn_pro'))).json()) as PaymentRequired

    const wrong = await postMcp(url, buyCall('vpn_pro', 4), {
      [PAYMENT_SIGNATURE_HEADER]: await signedHeader(pr, MERCHANT),
    })
    expect(wrong.status).toBe(402)
    expect(((await wrong.json()) as { error?: string }).error).toContain('does not match')
    expect(submit).not.toHaveBeenCalled()
  })

  it('refuses an authorization to MERCHANT_ADDRESS even when the echoed option names the product address', async () => {
    // The quoted-option match passes; only the signed EIP-3009 `to` is wrong.
    // This is the verification step itself, not the option comparison.
    overrideProduct('vpn_pro', { receivingAddress: OTHER_RECIPIENT })
    const { url, submit } = await startServer()
    const pr = (await (await postMcp(url, buyCall('vpn_pro'))).json()) as PaymentRequired
    const header = await signedHeader(pr, MERCHANT)
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as PaymentPayload
    decoded.accepted = { ...decoded.accepted, payTo: OTHER_RECIPIENT }

    const wrong = await postMcp(url, buyCall('vpn_pro', 4), {
      [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader(decoded),
    })
    expect(wrong.status).toBe(402)
    expect(((await wrong.json()) as { error?: string }).error).toContain('not addressed to this merchant')
    expect(submit).not.toHaveBeenCalled()
  })

  it('names the product address in the in-band refusal', async () => {
    overrideProduct('storage_1tb', { receivingAddress: OTHER_RECIPIENT })
    const text = await inBandRefusal('storage_1tb')
    expect(text).toContain(`Payment address: ${OTHER_RECIPIENT}`)
    expect(text).not.toContain(MERCHANT)
  })
})
