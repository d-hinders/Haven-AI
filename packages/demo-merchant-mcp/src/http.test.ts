import { randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from '@x402/core/http'
import type { PaymentPayload, PaymentRequired } from '@x402/core/types'
import { createDemoMerchantServer } from './http.js'
import { formatUsdc } from './products.js'
import {
  LEGACY_PAYMENT_SIGNATURE_HEADER,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  SettlementRevertedError,
  USDC_ADDRESS,
  createX402PaymentProcessor,
  type Eip3009Authorization,
  type SettlementClient,
} from './x402.js'

const MERCHANT = '0x15179876c595922999C2d5DC7c23Cc7711fE799a' as const
const PAYER_KEY = `0x${'01'.repeat(32)}` as const
const TX_HASH = `0x${'ef'.repeat(32)}` as const
const SECOND_TX_HASH = `0x${'ab'.repeat(32)}` as const

let servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  servers = []
  vi.restoreAllMocks()
})

async function startServer(client: Partial<SettlementClient> = {}) {
  const submit = vi.fn<SettlementClient['submit']>().mockResolvedValue(TX_HASH)
  const waitForReceipt = vi.fn<SettlementClient['waitForReceipt']>().mockResolvedValue(undefined)
  const settlementClient: SettlementClient = {
    submit,
    waitForReceipt,
    ...client,
  }
  const server = createDemoMerchantServer({
    merchantAddress: MERCHANT,
    baseUrl: 'http://127.0.0.1:0',
    paymentProcessor: createX402PaymentProcessor(settlementClient),
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test server port')
  return {
    submit: client.submit ?? submit,
    waitForReceipt: client.waitForReceipt ?? waitForReceipt,
    url: `http://127.0.0.1:${address.port}/mcp`,
  }
}

async function signedHeader(pr: PaymentRequired): Promise<string> {
  const account = privateKeyToAccount(PAYER_KEY)
  const now = Math.floor(Date.now() / 1000)
  const accepted = pr.accepts[0]
  const authorization: Eip3009Authorization = {
    from: account.address,
    to: accepted.payTo,
    value: accepted.amount,
    validAfter: String(now - 5),
    validBefore: String(now + 300),
    nonce: `0x${randomBytes(32).toString('hex')}`,
  }
  const signature = await account.signTypedData({
    domain: {
      name: 'USD Coin',
      version: '2',
      chainId: 8453,
      verifyingContract: USDC_ADDRESS,
    },
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
  }
  return encodePaymentSignatureHeader(payload)
}

async function postMcp(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

/** The streamable HTTP transport may respond as a single SSE `data:` event
 *  rather than plain JSON. Parses either shape into the JSON-RPC envelope. */
async function parseJsonRpcResponse(response: Response): Promise<{ result: Record<string, unknown> }> {
  const raw = await response.text()
  const dataLine = raw.split('\n').find((line) => line.startsWith('data:'))
  return JSON.parse(dataLine ? dataLine.slice('data:'.length).trim() : raw)
}

describe('demo merchant MCP x402 flow', () => {
  it('exposes a machine-readable merchant directory with dev and prod routing', async () => {
    const { url } = await startServer()
    const origin = new URL(url).origin
    const directory = await fetch(`${origin}/`)
    const payload = await directory.json()

    expect(directory.status).toBe(200)
    expect(payload).toMatchObject({
      name: 'Haven Demo Merchant',
      environment: 'prod',
      chain_id: 8453,
      network: 'eip155:8453',
      hosted_urls: {
        dev: 'https://demo-merchant-dev-84e4.up.railway.app/mcp',
        prod: 'https://enthusiastic-blessing-production-171f.up.railway.app/mcp',
      },
      routing: {
        dev: { chain_id: 84532, network: 'eip155:84532' },
        prod: { chain_id: 8453, network: 'eip155:8453' },
      },
    })
    expect(payload.mcp_url).toContain('/mcp')
    expect(payload.products).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'vpn_basic', settlement_methods: ['eip3009'] }),
      expect.objectContaining({ id: 'storage_50gb', settlement_methods: ['eip3009'] }),
    ]))
  })

  it('initializes with an MCP session id and leaves list_products free', async () => {
    const { url } = await startServer()
    const init = await postMcp(url, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    })
    const sessionId = init.headers.get('mcp-session-id')

    expect(init.status).toBe(200)
    expect(sessionId).toBeTruthy()

    const products = await postMcp(url, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'list_products', arguments: {} },
    }, { 'mcp-session-id': sessionId! })
    const text = await products.text()

    expect(products.status).toBe(200)
    expect(text).toContain('vpn_basic')
    expect(text).toContain('$0.001 USDC')
  })

  it('list_products exposes stable machine-readable structured product metadata (#1274)', async () => {
    const { url } = await startServer()
    const products = await postMcp(url, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_products', arguments: {} },
    })
    const body = await parseJsonRpcResponse(products) as {
      result: { structuredContent: { products: Array<Record<string, unknown>>; environment: string; mcp_url: string } }
    }
    const storage50gb = body.result.structuredContent.products.find((p) => p.product_id === 'storage_50gb')

    expect(products.status).toBe(200)
    expect(storage50gb).toMatchObject({
      product_id: 'storage_50gb',
      display_name: 'CloudNest 50 GB',
      price_atomic: '500',
      asset: 'USDC',
      network: 'eip155:8453',
      billing_period: 'monthly',
      tool_name: 'buy_cloud_storage',
      supported_settlement_methods: ['eip3009'],
      default_settlement_method: 'eip3009',
      environment: 'prod',
    })
    // An agent must be able to pick `buy_cloud_storage { tier: "50gb" }` from
    // arguments_schema alone, without parsing the localized `description`.
    expect((storage50gb!.arguments_schema as { properties: { tier: { const: string } } }).properties.tier.const).toBe('50gb')
    expect(body.result.structuredContent.mcp_url).toContain('/mcp')
  })

  it('returns standard payment requirements, settles a paid retry, and returns an invoice', async () => {
    const { url, submit } = await startServer()
    const init = await postMcp(url, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    })
    const sessionId = init.headers.get('mcp-session-id')!

    const unpaid = await postMcp(url, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'buy_vpn', arguments: { plan: 'basic' } },
    }, { 'mcp-session-id': sessionId })
    const paymentRequiredHeader = unpaid.headers.get(PAYMENT_REQUIRED_HEADER)
    const paymentRequired = await unpaid.json() as PaymentRequired

    expect(unpaid.status).toBe(402)
    expect(paymentRequiredHeader).toBeTruthy()
    expect(decodePaymentRequiredHeader(paymentRequiredHeader!)).toEqual(paymentRequired)
    expect(paymentRequired.accepts[0]).toMatchObject({
      network: 'eip155:8453',
      amount: '1000',
      asset: USDC_ADDRESS,
      extra: { name: 'USD Coin', version: '2' },
    })

    const paymentHeader = await signedHeader(paymentRequired)
    const paid = await postMcp(url, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'buy_vpn', arguments: { plan: 'basic' } },
    }, {
      'mcp-session-id': sessionId,
      [PAYMENT_SIGNATURE_HEADER]: paymentHeader,
    })
    const text = await paid.text()

    expect(paid.status).toBe(200)
    expect(paid.headers.get(PAYMENT_RESPONSE_HEADER)).toBeTruthy()
    expect(submit).toHaveBeenCalledTimes(1)
    expect(text).toContain('Köp bekräftat')
    expect(text).toContain(TX_HASH)

    // #956: the paid response carries the merchant's own receipt machine-
    // readably, and it is the SAME invoice the confirmation text renders.
    const receiptHeader = paid.headers.get('x-receipt-json')
    expect(receiptHeader).toBeTruthy()
    const receipt = JSON.parse(Buffer.from(receiptHeader!, 'base64').toString('utf8'))
    expect(receipt.status).toBe('Betald')
    expect(receipt.blockkedje_referens).toContain(TX_HASH)
    expect(text).toContain(receipt.fakturanummer)

    const duplicate = await postMcp(url, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'buy_vpn', arguments: { plan: 'basic' } },
    }, {
      'mcp-session-id': sessionId,
      [PAYMENT_SIGNATURE_HEADER]: paymentHeader,
    })
    const duplicateText = await duplicate.text()

    expect(duplicate.status).toBe(200)
    expect(duplicateText).toContain(TX_HASH)
    expect(duplicateText.match(/FAK-2026-\d+/)?.[0]).toBe(text.match(/FAK-2026-\d+/)?.[0])
    expect(submit).toHaveBeenCalledTimes(1)
    // #1273 + review finding on #1302: the cached-duplicate branch must carry
    // the SAME structured summary as the fresh purchase — an agent retrying a
    // settled payment reports from the identical contract, never a stripped one.
    const freshSummary = (JSON.parse(text.slice(text.indexOf('{'))) as {
      result: { structuredContent?: { summary?: Record<string, unknown> } }
    }).result.structuredContent?.summary
    const duplicateSummary = (JSON.parse(duplicateText.slice(duplicateText.indexOf('{'))) as {
      result: { structuredContent?: { summary?: Record<string, unknown> } }
    }).result.structuredContent?.summary
    expect(duplicateSummary).toBeDefined()
    expect(duplicateSummary).toEqual(freshSummary)
    expect(duplicateSummary?.settlement_tx_hash).toBe(TX_HASH)
  })

  it('a successful paid purchase returns a stable structured summary (#1273)', async () => {
    const { url } = await startServer()
    const unpaid = await postMcp(url, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'buy_cloud_storage', arguments: { tier: '50gb' } },
    })
    const paymentRequired = await unpaid.json() as PaymentRequired
    const paymentHeader = await signedHeader(paymentRequired)

    const paid = await postMcp(url, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'buy_cloud_storage', arguments: { tier: '50gb' } },
    }, { [PAYMENT_SIGNATURE_HEADER]: paymentHeader })
    const body = await parseJsonRpcResponse(paid) as { result: { structuredContent: { summary: Record<string, unknown> } } }
    const summary = body.result.structuredContent.summary

    expect(paid.status).toBe(200)
    expect(summary).toMatchObject({
      status: 'confirmed',
      product_id: 'storage_50gb',
      product_name: 'CloudNest 50 GB',
      amount_atomic: '500',
      amount: formatUsdc(500n),
      asset: 'USDC',
      network: 'eip155:8453',
      settlement_tx_hash: TX_HASH,
    })
    expect(typeof summary.invoice_id).toBe('string')
    expect(summary.invoice_id).toMatch(/^FAK-\d{4}-\d+$/)
  })

  it('accepts the legacy X-PAYMENT retry header alias', async () => {
    const { url, submit } = await startServer()
    const unpaid = await postMcp(url, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'buy_vpn', arguments: { plan: 'basic' } },
    })
    const paymentRequired = await unpaid.json() as PaymentRequired
    const paymentHeader = await signedHeader(paymentRequired)

    const paid = await postMcp(url, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'buy_vpn', arguments: { plan: 'basic' } },
    }, {
      [LEGACY_PAYMENT_SIGNATURE_HEADER]: paymentHeader,
    })
    const text = await paid.text()

    expect(paid.status).toBe(200)
    expect(paid.headers.get(PAYMENT_RESPONSE_HEADER)).toBeTruthy()
    expect(text).toContain(TX_HASH)
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('keeps settled payment state scoped to concurrent requests on the same MCP session', async () => {
    const submit = vi.fn<SettlementClient['submit']>()
      .mockImplementation(async (authorization) => {
        if (authorization.value === '1000') {
          await new Promise((resolve) => setTimeout(resolve, 25))
          return TX_HASH
        }
        return SECOND_TX_HASH
      })
    const { url } = await startServer({ submit })
    const init = await postMcp(url, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    })
    const sessionId = init.headers.get('mcp-session-id')!
    const basicUnpaid = await postMcp(url, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'buy_vpn', arguments: { plan: 'basic' } },
    }, { 'mcp-session-id': sessionId })
    const proUnpaid = await postMcp(url, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'buy_vpn', arguments: { plan: 'pro' } },
    }, { 'mcp-session-id': sessionId })
    const basicHeader = await signedHeader(await basicUnpaid.json() as PaymentRequired)
    const proHeader = await signedHeader(await proUnpaid.json() as PaymentRequired)

    const [basicPaid, proPaid] = await Promise.all([
      postMcp(url, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'buy_vpn', arguments: { plan: 'basic' } },
      }, { 'mcp-session-id': sessionId, [PAYMENT_SIGNATURE_HEADER]: basicHeader }),
      postMcp(url, {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'buy_vpn', arguments: { plan: 'pro' } },
      }, { 'mcp-session-id': sessionId, [PAYMENT_SIGNATURE_HEADER]: proHeader }),
    ])
    const basicText = await basicPaid.text()
    const proText = await proPaid.text()

    expect(basicPaid.status).toBe(200)
    expect(proPaid.status).toBe(200)
    expect(basicText).toContain('NordShield VPN Basic')
    expect(basicText).toContain(TX_HASH)
    expect(proText).toContain('NordShield VPN Pro')
    expect(proText).toContain(SECOND_TX_HASH)
    expect(submit).toHaveBeenCalledTimes(2)
  })

  it('handles stateless MCP calls without creating a reusable session', async () => {
    const { url } = await startServer()
    const products = await postMcp(url, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_products', arguments: {} },
    })
    const text = await products.text()

    expect(products.status).toBe(200)
    expect(products.headers.get('mcp-session-id')).toBeNull()
    expect(text).toContain('vpn_basic')
  })

  /**
   * A refusal and a breakage both leave the payer with a 402, but they are
   * opposite events: one is the merchant working, the other is the merchant
   * broken. #1517 — before this, every fault collapsed to the bare string
   * "Payment failed" and was never logged, so a merchant whose RPC had died
   * was indistinguishable from one enforcing policy, in the response AND in
   * its own logs.
   */
  describe('a merchant-side fault is not reported as a payment rejection (#1517)', () => {
    async function payAndCaptureError(client: Partial<SettlementClient>) {
      const { url } = await startServer(client)
      const init = await postMcp(url, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
      })
      const sessionId = init.headers.get('mcp-session-id')!
      const unpaid = await postMcp(url, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'buy_vpn', arguments: { plan: 'basic' } },
      }, { 'mcp-session-id': sessionId })
      const paymentRequired = await unpaid.json() as PaymentRequired
      const paid = await postMcp(url, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'buy_vpn', arguments: { plan: 'basic' } },
      }, { 'mcp-session-id': sessionId, [PAYMENT_SIGNATURE_HEADER]: await signedHeader(paymentRequired) })
      return { status: paid.status, body: await paid.json() as PaymentRequired & { error?: string } }
    }

    it('names the fault class and points at the logs, instead of "Payment failed"', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      const rpcDown = Object.assign(new Error('fetch failed: ECONNREFUSED'), { name: 'HttpRequestError' })
      const { status, body } = await payAndCaptureError({
        submit: vi.fn<SettlementClient['submit']>().mockRejectedValue(rpcDown),
      })

      expect(status).toBe(402)
      // The old behaviour, which said nothing at all:
      expect(body.error).not.toBe('Payment failed')
      // The fault CLASS reaches the client — enough to tell a broken merchant
      // from a strict one — while the message and stack stay server-side.
      expect(body.error).toContain('merchant-side fault')
      expect(body.error).toContain('HttpRequestError')
      expect(body.error).not.toContain('ECONNREFUSED')

      // And it is no longer silent in the merchant's own logs.
      expect(consoleError).toHaveBeenCalledTimes(1)
      const [message, context] = consoleError.mock.calls[0]
      expect(String(message)).toContain('FAULT')
      expect(context).toMatchObject({ productId: 'vpn_basic', error: rpcDown })
    })

    it('still reports a genuine policy rejection by its own reason, unlogged', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      // SettlementRevertedError extends PaymentError — a DECISION, so its
      // message must survive verbatim and must not be treated as a fault.
      const reverted = new SettlementRevertedError('USDC settlement transaction reverted on-chain: 0xdead')
      const { status, body } = await payAndCaptureError({
        submit: vi.fn<SettlementClient['submit']>().mockRejectedValue(reverted),
      })

      expect(status).toBe(402)
      expect(body.error).toBe('USDC settlement transaction reverted on-chain: 0xdead')
      expect(body.error).not.toContain('merchant-side fault')
      expect(consoleError).not.toHaveBeenCalled()
    })
  })
})
