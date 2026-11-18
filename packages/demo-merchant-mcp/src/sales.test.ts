/**
 * #4950: the Sales product, paid into a Haven Sales account, and the report of
 * each of its sales to Haven through the shared core reporter.
 *
 * Every address, hash and key here is a made-up test value.
 */
import { randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAddress, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { encodePaymentSignatureHeader } from '@x402/core/http'
import type { PaymentPayload, PaymentRequired } from '@x402/core/types'
import { createDemoMerchantServer } from './http.js'
import {
  CHAIN_ID,
  PRODUCTS,
  isProductOffered,
  offeredProducts,
  productReceivingAddress,
  productToolArgs,
  type ProductId,
} from './products.js'
import { createSalesReporting, resolveSalesConfig, saleRecordFor, type SalesConfig } from './sales.js'
import {
  PAYMENT_SIGNATURE_HEADER,
  USDC_ADDRESS,
  createX402PaymentProcessor,
  type Eip3009Authorization,
  type SettledPayment,
  type SettlementClient,
} from './x402.js'

const MERCHANT = '0x15179876c595922999C2d5DC7c23Cc7711fE799a' as const
const SALES = getAddress('0xabcdef0123456789abcdef0123456789abcdef01')
const STRIPE_DEPOSIT = getAddress('0x4444444444444444444444444444444444444444')
const SALES_KEY = 'sk_merchant_test_do_not_log_0123456789'
const HAVEN = 'https://haven.example'
const PAYER_KEY = `0x${'01'.repeat(32)}` as const
const PAYER = privateKeyToAccount(PAYER_KEY).address
const TX_HASH = `0x${'ef'.repeat(32)}` as Hex
const CONFIG: SalesConfig = { address: SALES, salesKey: SALES_KEY, havenBaseUrl: HAVEN }

let servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  servers = []
  vi.restoreAllMocks()
})

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

type HavenMode = 'accept' | 'refuse' | 'slow' | 'unreachable'

/** Holds every 'slow' answer open until the test releases it. */
let releaseSlow: () => void = () => {}

/** A mocked Haven: what `POST /merchant/sales` answers. */
function mockHaven(mode: HavenMode = 'accept') {
  const posts: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = []
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    posts.push({
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    })
    if (mode === 'refuse') return json(422, { error: 'no_payment_to_account', error_code: 'no_payment_to_account', message: 'no' })
    if (mode === 'unreachable') throw new TypeError('fetch failed')
    if (mode === 'slow') {
      return new Promise<Response>((resolve, reject) => {
        const previous = releaseSlow
        releaseSlow = () => {
          previous()
          resolve(json(201, { id: 'sale-1' }))
        }
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    }
    return json(201, { id: 'sale-1' })
  }) as unknown as typeof fetch
  return { posts, fetch: fetchMock }
}

async function startServer(
  opts: { haven?: ReturnType<typeof mockHaven>; sales?: boolean; log?: (line: string) => void; attemptTimeoutMs?: number } = {},
) {
  const submit = vi.fn<SettlementClient['submit']>().mockResolvedValue(TX_HASH)
  const waitForReceipt = vi.fn<SettlementClient['waitForReceipt']>().mockResolvedValue(undefined)
  const settlementClient: SettlementClient = { submit, waitForReceipt }
  const haven = opts.haven ?? mockHaven()
  const sales =
    opts.sales === false
      ? undefined
      : createSalesReporting(CONFIG, {
          chainId: CHAIN_ID,
          fetch: haven.fetch,
          sleep: async () => {},
          attemptTimeoutMs: opts.attemptTimeoutMs ?? 20,
          retryDelaysMs: [1],
          log: opts.log ?? (() => {}),
        })
  const server = createDemoMerchantServer({
    merchantAddress: MERCHANT,
    baseUrl: 'http://127.0.0.1:0',
    paymentProcessor: createX402PaymentProcessor(settlementClient),
    settlementClient,
    readinessCacheMs: 0,
    sales,
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test server port')
  return { submit, sales, haven, origin: `http://127.0.0.1:${address.port}`, url: `http://127.0.0.1:${address.port}/mcp` }
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
    params: { name: toolName, arguments: argumentName ? { [argumentName]: argumentValue } : {} },
  }
}

async function signedHeader(pr: PaymentRequired, nonce: Hex = `0x${randomBytes(32).toString('hex')}`): Promise<string> {
  const account = privateKeyToAccount(PAYER_KEY)
  const now = Math.floor(Date.now() / 1000)
  const accepted = pr.accepts.find((option) => option.extra?.assetTransferMethod !== 'erc7710') ?? pr.accepts[0]
  const authorization: Eip3009Authorization = {
    from: account.address,
    to: accepted.payTo,
    value: accepted.amount,
    validAfter: String(now - 5),
    validBefore: String(now + 300),
    nonce,
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

/** Quote then pay one product; returns the paid answer and the header used. */
async function buy(url: string, id: ProductId, nonce?: Hex) {
  const unpaid = await postMcp(url, buyCall(id))
  expect(unpaid.status).toBe(402)
  const pr = (await unpaid.json()) as PaymentRequired
  const header = await signedHeader(pr, nonce)
  const paid = await postMcp(url, buyCall(id, 4), { [PAYMENT_SIGNATURE_HEADER]: header })
  return { pr, header, paid }
}

function receiptOf(res: Response): Record<string, unknown> {
  return JSON.parse(Buffer.from(res.headers.get('x-receipt-json')!, 'base64').toString('utf8'))
}

describe('resolveSalesConfig', () => {
  const base = {
    addressRaw: SALES,
    keyRaw: SALES_KEY,
    havenBaseUrlRaw: `${HAVEN}/`,
    merchantAddress: MERCHANT,
    stripeDepositAddresses: [STRIPE_DEPOSIT, undefined],
  } as const

  it('is on with both settings, a usable address and the Haven base URL', () => {
    const warn = vi.fn()
    expect(resolveSalesConfig({ ...base, warn })).toEqual(CONFIG)
    expect(warn).not.toHaveBeenCalled()
  })

  it('is off, silently, with neither setting', () => {
    const warn = vi.fn()
    expect(resolveSalesConfig({ ...base, addressRaw: undefined, keyRaw: '  ', warn })).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
  })

  it.each([
    ['only the address', { keyRaw: undefined }],
    ['only the key', { addressRaw: undefined }],
    ['an address that is not checksummed', { addressRaw: SALES.toLowerCase() }],
    ['an address that is not an address', { addressRaw: '0x1234' }],
    ['MERCHANT_ADDRESS as the Sales address', { addressRaw: MERCHANT }],
    ['the Stripe deposit address as the Sales address', { addressRaw: STRIPE_DEPOSIT }],
    ['a key that is not a Sales key', { keyRaw: 'sk_live_not_a_sales_key' }],
    ['no Haven base URL', { havenBaseUrlRaw: undefined }],
    ['a Haven base URL that is not a URL', { havenBaseUrlRaw: 'not a url' }],
  ])('is off, with a warning that names no value, given %s', (_label, patch) => {
    const warn = vi.fn()
    expect(resolveSalesConfig({ ...base, ...patch, warn })).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    const message = String(warn.mock.calls[0][0])
    expect(message).toContain('not offered')
    expect(message).not.toContain(SALES_KEY)
    expect(message).not.toContain('sk_live_not_a_sales_key')
  })
})

describe('the Sales product (#4950)', () => {
  it('is offered only with the Sales settings, and adds nothing else', () => {
    const without = offeredProducts({ cdpConfigured: true }).map((p) => p.id)
    const withSales = offeredProducts({ cdpConfigured: true, salesConfigured: true }).map((p) => p.id)
    expect(without).not.toContain('field_notes')
    expect(withSales).toEqual([...without, 'field_notes'])
    expect(isProductOffered(PRODUCTS.field_notes, { cdpConfigured: false, salesConfigured: true })).toBe(true)
  })

  it('has its own one-product tool, and every other product keeps its address with the Sales account set', () => {
    expect(productToolArgs(PRODUCTS.field_notes)).toEqual({ toolName: 'buy_field_notes' })
    expect(productReceivingAddress(PRODUCTS.field_notes, MERCHANT, { salesAddress: SALES })).toBe(SALES)
    for (const product of Object.values(PRODUCTS)) {
      if (product.id === 'field_notes') continue
      expect(productReceivingAddress(product, MERCHANT, { salesAddress: SALES })).toBe(MERCHANT)
    }
  })

  it('is absent from every surface of a merchant without the Sales settings', async () => {
    const { url, origin } = await startServer({ sales: false })
    const discovery = (await (await fetch(`${origin}/`)).json()) as { products: Array<{ id: string }> }
    expect(discovery.products.map((p) => p.id)).not.toContain('field_notes')
    const healthz = (await (await fetch(`${origin}/healthz`)).json()) as Record<string, unknown>
    expect(healthz.sales).toBeUndefined()
    const unpaid = await postMcp(url, buyCall('field_notes'))
    expect(unpaid.status).not.toBe(402)
  })

  it("quotes the Sales account as payTo, and every existing product's 402 still pays MERCHANT_ADDRESS", async () => {
    const { url, origin } = await startServer()
    const pr = (await (await postMcp(url, buyCall('field_notes'))).json()) as PaymentRequired
    expect(pr.accepts.length).toBeGreaterThan(0)
    for (const option of pr.accepts) expect(option.payTo).toBe(SALES)
    expect(pr.accepts[0].amount).toBe('2500')

    for (const id of offeredProducts({ cdpConfigured: false }).map((p) => p.id)) {
      const other = (await (await postMcp(url, buyCall(id))).json()) as PaymentRequired
      for (const option of other.accepts) expect(option.payTo).toBe(MERCHANT)
    }
    const discovery = (await (await fetch(`${origin}/`)).json()) as { products: Array<{ id: string; tools: string[] }> }
    expect(discovery.products.find((p) => p.id === 'field_notes')?.tools).toEqual(['buy_field_notes'])
  })
})

describe('one report per sale (#4950)', () => {
  it('reports a settled sale once, with the record built from the payment, the product and the receipt', async () => {
    const { url, sales, haven, submit, origin } = await startServer()
    const { paid, header } = await buy(url, 'field_notes')
    expect(paid.status).toBe(200)
    expect(await paid.text()).toContain('Your field note')
    expect(getAddress(submit.mock.calls[0][0].to)).toBe(SALES)
    await sales!.idle()

    expect(haven.posts).toHaveLength(1)
    const post = haven.posts[0]
    expect(post.url).toBe(`${HAVEN}/merchant/sales`)
    expect(post.headers.Authorization).toBe(`Bearer ${SALES_KEY}`)
    const receipt = receiptOf(paid)
    expect(post.body).toEqual({
      version: 1,
      tx_hash: TX_HASH,
      chain: `eip155:${CHAIN_ID}`,
      product_id: 'field_notes',
      product_name: 'Haven Field Notes',
      amount: '2500',
      payer: PAYER,
      merchant_reference: expect.stringMatching(/^sale_[0-9A-HJKMNP-TV-Z]{26}$/),
      receipt_number: receipt.fakturanummer,
      vat_treatment: receipt.momsbehandling,
    })
    expect(['SE_25', 'REVERSE_CHARGE']).toContain(receipt.momsbehandling)

    // Replaying the same payment header re-serves the payment and sends nothing more.
    const replay = await postMcp(url, buyCall('field_notes', 5), { [PAYMENT_SIGNATURE_HEADER]: header })
    expect(replay.status).toBe(200)
    await sales!.idle()
    expect(haven.posts).toHaveLength(1)
    expect(submit).toHaveBeenCalledTimes(1)

    const healthz = (await (await fetch(`${origin}/healthz`)).json()) as { sales: Record<string, unknown> }
    expect(healthz.sales).toEqual({ configured: true, address: SALES, reported: 1, pending: 0, refused: 0, gave_up: 0 })
  })

  it.each(['vpn_basic', 'storage_50gb'] as const)('sends no report for a sale of %s', async (id) => {
    const { url, sales, haven } = await startServer()
    const { paid } = await buy(url, id)
    expect(paid.status).toBe(200)
    await sales!.idle()
    expect(haven.posts).toHaveLength(0)
  })

  it('reports only an on-chain settlement of the Sales product, once per transaction', async () => {
    const haven = mockHaven()
    const sales = createSalesReporting(CONFIG, { chainId: CHAIN_ID, fetch: haven.fetch, log: () => {} })
    const receipt = { fakturanummer: 'FAK-1', momsbehandling: 'SE_25' } as never
    const payment = {
      productId: 'field_notes',
      settlementMethod: 'eip3009',
      from: PAYER,
      to: SALES,
      value: 2_500n,
      nonce: `0x${'12'.repeat(32)}`,
      txHash: TX_HASH,
      paymentResponse: { success: true, transaction: TX_HASH, network: 'eip155:8453' },
      paymentResponseHeader: 'unused',
      settlement: 'settled_onchain',
      passportReference: null,
      merchantReference: 'sale_TEST',
    } as SettledPayment
    sales.report(PRODUCTS.field_notes, { ...payment, settlement: 'already_settled_earlier', txHash: `0x${'00'.repeat(32)}` }, receipt)
    sales.report(PRODUCTS.vpn_basic, { ...payment, productId: 'vpn_basic' }, receipt)
    await sales.idle()
    expect(haven.posts).toHaveLength(0)
    sales.report(PRODUCTS.field_notes, payment, receipt)
    sales.report(PRODUCTS.field_notes, { ...payment, txHash: TX_HASH.toUpperCase().replace('0X', '0x') as Hex }, receipt)
    await sales.idle()
    expect(haven.posts).toHaveLength(1)
    expect(sales.stats()).toEqual({ pending: 0, reported: 1, refused: 0, gaveUp: 0 })
  })

  it('builds the record from the receipt the same way Stripe reads it', () => {
    const record = saleRecordFor(
      PRODUCTS.field_notes,
      { txHash: TX_HASH, from: PAYER, merchantReference: 'sale_X' },
      { fakturanummer: 'FAK-9', momsbehandling: 'REVERSE_CHARGE' },
      84532,
    )
    expect(record).toMatchObject({ chain: 'eip155:84532', receipt_number: 'FAK-9', vat_treatment: 'REVERSE_CHARGE' })
  })
})

describe('retry and refusal (#4950)', () => {
  const payment = {
    productId: 'field_notes',
    from: PAYER,
    txHash: TX_HASH,
    settlement: 'settled_onchain',
    merchantReference: 'sale_TEST',
  } as SettledPayment
  const receipt = { fakturanummer: 'FAK-1', momsbehandling: 'SE_25' } as never

  it('resends after "not visible yet" and stops after a refusal', async () => {
    const answers = [
      json(425, { error: 'transaction_not_visible', error_code: 'transaction_not_visible', message: 'x', retry_after_seconds: 10 }),
      json(201, {}),
    ]
    const fetchMock = vi.fn(async () => answers.shift()!) as unknown as typeof fetch
    const lines: string[] = []
    const sleeps: number[] = []
    const sales = createSalesReporting(CONFIG, {
      chainId: CHAIN_ID,
      fetch: fetchMock,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      log: (line) => lines.push(line),
    })
    sales.report(PRODUCTS.field_notes, payment, receipt)
    await sales.idle()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(sleeps).toEqual([10_000])
    expect(sales.stats().reported).toBe(1)
    expect(lines[0]).toMatch(/^\[sales\] sales_report_retry tx_hash=0xef.* status=425 code=transaction_not_visible/)

    const refusing = vi.fn(async () => json(409, { error_code: 'sale_record_conflict', message: 'x' })) as unknown as typeof fetch
    const refused = createSalesReporting(CONFIG, { chainId: CHAIN_ID, fetch: refusing, sleep: async () => {}, log: (l) => lines.push(l) })
    refused.report(PRODUCTS.field_notes, payment, receipt)
    await refused.idle()
    expect(refusing).toHaveBeenCalledTimes(1)
    expect(refused.stats()).toEqual({ pending: 0, reported: 0, refused: 1, gaveUp: 0 })
    expect(lines.at(-1)).toContain('sales_report_refused')
    expect(lines.at(-1)).toContain('code=sale_record_conflict')
  })
})

describe('the buyer is never affected (#4950)', () => {
  /** Strip what differs between two runs by design: the port and the clock. */
  function normalize(text: string): string {
    return text
      .replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:PORT')
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, 'TIME')
      .replace(/\d{4}-\d{2}-\d{2}/g, 'DATE')
  }

  it('gives the same answer, status and timing whether Haven accepts, refuses, hangs or is unreachable', async () => {
    const nonce = `0x${'5a'.repeat(32)}` as Hex
    const answers: Array<{ status: number; paymentResponse: string | null; receipt: string | null; body: string; ms: number }> = []
    for (const mode of ['accept', 'refuse', 'slow', 'unreachable'] as const) {
      // A 'slow' Haven is held open until released, long past the buyer's answer.
      const { url, sales } = await startServer({ haven: mockHaven(mode), attemptTimeoutMs: 60_000 })
      const unpaid = await postMcp(url, buyCall('field_notes'))
      const pr = (await unpaid.json()) as PaymentRequired
      const header = await signedHeader(pr, nonce)
      const started = Date.now()
      const raced = await Promise.race([
        postMcp(url, buyCall('field_notes', 4), { [PAYMENT_SIGNATURE_HEADER]: header }),
        new Promise<'no answer'>((resolve) => setTimeout(() => resolve('no answer'), 1_500)),
      ])
      // The report is not awaited: a Haven that has not answered adds no wait.
      expect(raced, `buyer answered while Haven was ${mode}`).not.toBe('no answer')
      const paid = raced as Response
      const body = await paid.text()
      answers.push({
        status: paid.status,
        paymentResponse: paid.headers.get('payment-response'),
        receipt: paid.headers.get('x-receipt-json') ? normalize(JSON.stringify(receiptOf(paid))) : null,
        body: normalize(body),
        ms: Date.now() - started,
      })
      releaseSlow()
      await sales!.idle()
    }
    for (const answer of answers) {
      expect(answer.status).toBe(200)
      expect(answer.paymentResponse).toBe(answers[0].paymentResponse)
      expect(answer.receipt).toBe(answers[0].receipt)
      expect(answer.body).toBe(answers[0].body)
      expect(answer.ms).toBeLessThan(1_500)
    }
  })
})

describe('the Sales key is never written out (#4950)', () => {
  it('appears in no log line, response or error, whatever Haven answers', async () => {
    const written: string[] = []
    const capture = (...args: unknown[]) => {
      written.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? String(v) : v)))).join(' '))
    }
    vi.spyOn(console, 'log').mockImplementation(capture)
    vi.spyOn(console, 'warn').mockImplementation(capture)
    vi.spyOn(console, 'error').mockImplementation(capture)
    vi.spyOn(console, 'info').mockImplementation(capture)

    for (const mode of ['accept', 'refuse', 'slow', 'unreachable'] as const) {
      const { url, origin, sales } = await startServer({ haven: mockHaven(mode), log: (line) => written.push(line) })
      const { paid } = await buy(url, 'field_notes')
      written.push(await paid.text(), JSON.stringify([...paid.headers]))
      await sales!.idle()
      written.push(await (await fetch(`${origin}/healthz`)).text(), await (await fetch(`${origin}/`)).text())
    }
    expect(written.some((line) => line.includes('[sales] sales_report_'))).toBe(true)
    const all = written.join('\n')
    expect(all).not.toContain(SALES_KEY)
    expect(all).not.toContain('sk_merchant_')
  })
})
