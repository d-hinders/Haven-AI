import { randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from '@x402/core/http'
import type { PaymentPayload, PaymentRequired } from '@x402/core/types'
import { createDemoMerchantServer } from './http.js'
import {
  LEGACY_PAYMENT_SIGNATURE_HEADER,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
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

describe('demo merchant MCP x402 flow', () => {
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
})
