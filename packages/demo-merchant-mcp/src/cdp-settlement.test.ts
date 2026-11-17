/**
 * #4851: the joke product, verified and settled through Coinbase's hosted
 * facilitator (CDP). The facilitator and the chain are fakes; nothing here
 * needs a real key, and no secret appears in this file.
 */
import { randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { encodePaymentSignatureHeader } from '@x402/core/http'
import { VerifyError, type PaymentPayload, type PaymentRequired, type SettleResponse, type VerifyResponse } from '@x402/core/types'
import { createDemoMerchantServer } from './http.js'
import { TRUSTED_DELEGATION_MANAGER } from './products.js'
import {
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  USDC_ADDRESS,
  createX402PaymentProcessor,
  settlementReadiness,
  type Eip3009Authorization,
  type SettlementClient,
} from './x402.js'
import { resolveCdpCredentials, type AuthorizationOutcome, type CdpChainReader, type CdpFacilitator } from './cdp.js'

const MERCHANT = '0x15179876c595922999C2d5DC7c23Cc7711fE799a' as const
const PAYER_KEY = `0x${'01'.repeat(32)}` as const
const PAYER = privateKeyToAccount(PAYER_KEY).address
const CDP_TX = `0x${'cd'.repeat(32)}` as const
const OWN_KEY_TX = `0x${'ef'.repeat(32)}` as const

let servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  servers = []
  vi.useRealTimers()
  vi.restoreAllMocks()
})

interface Fakes {
  verify: ReturnType<typeof vi.fn<CdpFacilitator['verify']>>
  settle: ReturnType<typeof vi.fn<CdpFacilitator['settle']>>
  authorizationUsed: ReturnType<typeof vi.fn<CdpChainReader['authorizationUsed']>>
  findAuthorizationOutcome: ReturnType<typeof vi.fn<CdpChainReader['findAuthorizationOutcome']>>
  submit: ReturnType<typeof vi.fn<SettlementClient['submit']>>
  waitForReceipt: ReturnType<typeof vi.fn<SettlementClient['waitForReceipt']>>
}

const VALID: VerifyResponse = { isValid: true, payer: PAYER }
const SETTLED: SettleResponse = { success: true, transaction: CDP_TX, network: 'eip155:8453', payer: PAYER }

async function startServer(opts: { cdp?: boolean; readinessFail?: boolean; timeoutMs?: number } = {}) {
  const cdp = opts.cdp ?? true
  const fakes: Fakes = {
    verify: vi.fn<CdpFacilitator['verify']>().mockResolvedValue(VALID),
    settle: vi.fn<CdpFacilitator['settle']>().mockResolvedValue(SETTLED),
    authorizationUsed: vi.fn<CdpChainReader['authorizationUsed']>().mockResolvedValue(false),
    findAuthorizationOutcome: vi.fn<CdpChainReader['findAuthorizationOutcome']>().mockResolvedValue(null),
    submit: vi.fn<SettlementClient['submit']>().mockResolvedValue(OWN_KEY_TX),
    waitForReceipt: vi.fn<SettlementClient['waitForReceipt']>().mockResolvedValue(undefined),
  }
  const settlementClient: SettlementClient = {
    submit: fakes.submit,
    waitForReceipt: fakes.waitForReceipt,
    // A drained own-key wallet: the readiness gate refuses self-settled products.
    ...(opts.readinessFail ? { readiness: async () => settlementReadiness(MERCHANT, 0n) } : {}),
  }
  const settlementMethods = ['eip3009', 'erc7710'] as const
  const server = createDemoMerchantServer({
    merchantAddress: MERCHANT,
    baseUrl: 'http://127.0.0.1:0',
    settlementMethods,
    paymentProcessor: createX402PaymentProcessor(settlementClient, {
      // erc7710 is ON for the merchant, so the joke's EIP-3009-only offer is a
      // property of the product, not of a merchant that offers nothing else.
      erc7710: { delegationManager: TRUSTED_DELEGATION_MANAGER },
      settlementMethods,
      ...(cdp
        ? {
            cdp: {
              facilitator: { verify: fakes.verify, settle: fakes.settle },
              chain: { authorizationUsed: fakes.authorizationUsed, findAuthorizationOutcome: fakes.findAuthorizationOutcome },
              timeoutMs: opts.timeoutMs ?? 200,
            },
          }
        : {}),
    }),
    settlementClient,
    readinessCacheMs: 0,
    cdpConfigured: cdp,
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test server port')
  return { fakes, origin: `http://127.0.0.1:${address.port}`, url: `http://127.0.0.1:${address.port}/mcp` }
}

async function postMcp(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  })
}

function callTool(name: string, args: Record<string, unknown> = {}, id = 3) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }
}

const buyJoke = (id = 3) => callTool('buy_joke', {}, id)

async function challenge(url: string): Promise<PaymentRequired> {
  const response = await postMcp(url, buyJoke())
  expect(response.status).toBe(402)
  return (await response.json()) as PaymentRequired
}

/** A signed EIP-3009 header for the challenge's first option; `edit` bends one field. */
async function signedHeader(
  pr: PaymentRequired,
  edit: {
    validAfter?: number
    validBefore?: number
    value?: string
    payload?: (payload: PaymentPayload) => PaymentPayload
    signWith?: `0x${string}`
  } = {},
): Promise<string> {
  const account = privateKeyToAccount(edit.signWith ?? PAYER_KEY)
  const signer = privateKeyToAccount(PAYER_KEY)
  const now = Math.floor(Date.now() / 1000)
  const accepted = pr.accepts[0]
  const authorization: Eip3009Authorization = {
    from: signer.address,
    to: accepted.payTo,
    value: edit.value ?? accepted.amount,
    validAfter: String(edit.validAfter ?? now - 5),
    validBefore: String(edit.validBefore ?? now + 300),
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
  let payload: PaymentPayload = {
    x402Version: 2,
    resource: pr.resource,
    accepted,
    payload: { authorization, signature },
    ...(pr.extensions ? { extensions: pr.extensions } : {}),
  }
  if (edit.payload) payload = edit.payload(payload)
  return encodePaymentSignatureHeader(payload)
}

async function pay(url: string, header: string, id = 4) {
  const response = await postMcp(url, buyJoke(id), { [PAYMENT_SIGNATURE_HEADER]: header })
  const raw = await response.text()
  return { response, raw }
}

function refusal(raw: string): { error?: string; reason_code?: string } {
  return JSON.parse(raw) as { error?: string; reason_code?: string }
}

function receiptOf(response: Response): Record<string, unknown> {
  return JSON.parse(Buffer.from(response.headers.get('x-receipt-json')!, 'base64').toString('utf8'))
}

describe('offer: the joke exists only with CDP configured (#4851)', () => {
  it('with CDP: list_products, discovery and the 402 show one EIP-3009 option for 10,000 to MERCHANT_ADDRESS', async () => {
    const { url, origin } = await startServer()

    const list = (await (await postMcp(url, callTool('list_products', {}, 1))).text())
    const listBody = JSON.parse(list.slice(list.indexOf('{'))) as {
      result: { structuredContent: { products: Array<Record<string, unknown>> }; content: Array<{ text: string }> }
    }
    const joke = listBody.result.structuredContent.products.find((p) => p.product_id === 'joke')
    expect(joke).toMatchObject({
      price_atomic: '10000',
      tool_name: 'buy_joke',
      billing_period: 'one_time',
      supported_settlement_methods: ['eip3009'],
      default_settlement_method: 'eip3009',
    })
    // Every other product still offers erc7710 on this merchant: the joke's
    // single option is the product's, not the merchant's.
    const vpnBasic = listBody.result.structuredContent.products.find((p) => p.product_id === 'vpn_basic')
    expect(vpnBasic?.supported_settlement_methods).toEqual(['eip3009', 'erc7710'])
    expect(listBody.result.content[0].text).toContain('buy_joke')

    const discovery = (await (await fetch(`${origin}/`)).json()) as { products: Array<Record<string, unknown>> }
    expect(discovery.products.find((p) => p.id === 'joke')).toMatchObject({
      tools: ['buy_joke'],
      settlement_methods: ['eip3009'],
      price_usdc: '0.01',
    })

    const pr = await challenge(url)
    expect(pr.accepts).toHaveLength(1)
    expect(pr.accepts[0]).toMatchObject({ scheme: 'exact', amount: '10000', payTo: MERCHANT, asset: USDC_ADDRESS })
    expect(pr.accepts[0].extra?.assetTransferMethod).toBeUndefined()
  })

  it('without CDP: absent from list_products, discovery and the tool list, and buy_joke is not gated', async () => {
    const { url, origin, fakes } = await startServer({ cdp: false })
    const list = await (await postMcp(url, callTool('list_products', {}, 1))).text()
    expect(list).not.toContain('joke')
    expect(JSON.stringify(await (await fetch(`${origin}/`)).json())).not.toContain('joke')
    const tools = await (await postMcp(url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })).text()
    expect(tools).not.toContain('buy_joke')
    const call = await postMcp(url, buyJoke())
    expect(call.status).not.toBe(402)
    expect(fakes.verify).not.toHaveBeenCalled()
  })

  it('/healthz reports CDP when configured, naming no credential', async () => {
    const { origin } = await startServer()
    const health = (await (await fetch(`${origin}/healthz`)).json()) as Record<string, unknown>
    expect(health.cdp).toEqual({ configured: true, facilitator: 'coinbase-cdp', products: ['joke'] })
  })

  it('the own-key readiness gate does not refuse the joke when the merchant wallet is drained', async () => {
    const { url } = await startServer({ readinessFail: true })
    const vpn = await postMcp(url, callTool('buy_vpn', { plan: 'basic' }))
    expect(vpn.status).toBe(503)
    const joke = await postMcp(url, buyJoke())
    expect(joke.status).toBe(402)
  })
})

describe('settlement through CDP (#4851)', () => {
  it('success: CDP verifies and settles; the receipt carries its transaction; the own key never submits', async () => {
    const { url, fakes } = await startServer()
    const pr = await challenge(url)
    const { response, raw } = await pay(url, await signedHeader(pr))

    expect(response.status).toBe(200)
    expect(response.headers.get(PAYMENT_RESPONSE_HEADER)).toBeTruthy()
    expect(fakes.verify).toHaveBeenCalledTimes(1)
    expect(fakes.settle).toHaveBeenCalledTimes(1)
    // CDP is handed the merchant's own quoted option, unaltered.
    expect(fakes.settle.mock.calls[0][1]).toEqual(pr.accepts[0])
    expect(fakes.submit).not.toHaveBeenCalled()
    expect(fakes.waitForReceipt).toHaveBeenCalledWith(CDP_TX)
    expect(receiptOf(response)).toMatchObject({ status: 'Betald', blockkedje_referens: `Tx: ${CDP_TX}` })
    expect(raw).toContain('Your joke:')
    expect(raw).toContain('engångsköp')
  })

  it('a retried header settles once', async () => {
    const { url, fakes } = await startServer()
    const header = await signedHeader(await challenge(url))
    const first = await pay(url, header, 4)
    const second = await pay(url, header, 5)
    expect(first.response.status).toBe(200)
    expect(second.response.status).toBe(200)
    expect(fakes.settle).toHaveBeenCalledTimes(1)
    expect(receiptOf(second.response).fakturanummer).toBe(receiptOf(first.response).fakturanummer)
  })

  it('verify refused (isValid false) — including screening — is final: no settle, nothing delivered', async () => {
    const { url, fakes } = await startServer()
    fakes.verify.mockResolvedValue({ isValid: false, invalidReason: 'sanctions_screening_failed' })
    const { response, raw } = await pay(url, await signedHeader(await challenge(url)))
    expect(response.status).toBe(402)
    expect(refusal(raw)).toMatchObject({ reason_code: 'facilitator_refused' })
    expect(refusal(raw).error).toContain('sanctions_screening_failed')
    expect(fakes.settle).not.toHaveBeenCalled()
    expect(raw).not.toContain('Your joke')
  })

  it('verify refused by a thrown VerifyError is the same final refusal', async () => {
    const { url, fakes } = await startServer()
    fakes.verify.mockRejectedValue(new VerifyError(400, { isValid: false, invalidReason: 'invalid_exact_evm_payload' }))
    const { response, raw } = await pay(url, await signedHeader(await challenge(url)))
    expect(response.status).toBe(402)
    expect(refusal(raw).reason_code).toBe('facilitator_refused')
    expect(fakes.settle).not.toHaveBeenCalled()
  })

  it('verify unreachable is retryable, and nothing settles', async () => {
    const { url, fakes } = await startServer()
    fakes.verify.mockRejectedValue(new TypeError('fetch failed'))
    const { response, raw } = await pay(url, await signedHeader(await challenge(url)))
    expect(response.status).toBe(402)
    expect(refusal(raw).reason_code).toBe('facilitator_retryable')
    expect(fakes.settle).not.toHaveBeenCalled()
  })

  it('settle refused and the authorization unused: a retryable refusal', async () => {
    const { url, fakes } = await startServer()
    fakes.settle.mockResolvedValue({ success: false, errorReason: 'insufficient_funds', transaction: '', network: 'eip155:8453' })
    const { response, raw } = await pay(url, await signedHeader(await challenge(url)))
    expect(response.status).toBe(402)
    expect(refusal(raw).reason_code).toBe('facilitator_retryable')
    // The chain was asked AFTER the failure, not only before.
    expect(fakes.authorizationUsed).toHaveBeenCalledTimes(2)
  })

  it('a settle answer of success:false is a failure even when it carries a hash: the chain decides', async () => {
    // Review of #4851 (R5): a well-formed hash must not stand in for success.
    const { url, fakes } = await startServer()
    fakes.settle.mockResolvedValue({ success: false, errorReason: 'transaction_failed', transaction: CDP_TX, network: 'eip155:8453' })
    const { response, raw } = await pay(url, await signedHeader(await challenge(url)))
    expect(response.status).toBe(402)
    expect(refusal(raw).reason_code).toBe('facilitator_retryable')
    expect(fakes.waitForReceipt).not.toHaveBeenCalled()
  })

  it('verify refused but the chain says the authorization was already used: served, not told to stop', async () => {
    // Review of #4851 (nit 6): an earlier settle that timed out lands, then
    // the facilitator refuses the same authorization as already used.
    const { url, fakes } = await startServer()
    fakes.verify.mockResolvedValue({ isValid: false, invalidReason: 'invalid_exact_evm_payload_authorization_nonce' })
    fakes.authorizationUsed.mockResolvedValueOnce(false).mockResolvedValue(true)
    fakes.findAuthorizationOutcome.mockResolvedValue({ kind: 'settled', txHash: CDP_TX })
    const { response } = await pay(url, await signedHeader(await challenge(url)))
    expect(response.status).toBe(200)
    expect(receiptOf(response).blockkedje_referens).toBe(`Tx: ${CDP_TX}`)
    expect(fakes.settle).not.toHaveBeenCalled()
  })

  it('settle error but the authorization used: served, with the transaction recovered from the chain', async () => {
    const { url, fakes } = await startServer()
    fakes.settle.mockRejectedValue(new Error('upstream 502'))
    fakes.authorizationUsed.mockResolvedValueOnce(false).mockResolvedValue(true)
    fakes.findAuthorizationOutcome.mockResolvedValue({ kind: 'settled', txHash: CDP_TX })
    const { response, raw } = await pay(url, await signedHeader(await challenge(url)))
    expect(response.status).toBe(200)
    expect(receiptOf(response)).toMatchObject({ status: 'Betald', blockkedje_referens: `Tx: ${CDP_TX}` })
    expect(raw).toContain('Your joke:')
    expect(fakes.findAuthorizationOutcome.mock.calls[0][0]).toMatchObject({ authorizer: PAYER, to: MERCHANT, value: 10_000n })
  })

  it('settle error, used, transaction not found: served, and the receipt says the reference is unavailable', async () => {
    const { url, fakes } = await startServer()
    fakes.settle.mockRejectedValue(new Error('upstream 502'))
    fakes.authorizationUsed.mockResolvedValueOnce(false).mockResolvedValue(true)
    fakes.findAuthorizationOutcome.mockRejectedValue(new Error('range too wide'))
    const { response } = await pay(url, await signedHeader(await challenge(url)))
    expect(response.status).toBe(200)
    expect(receiptOf(response)).toMatchObject({
      status: 'Betald i tidigare transaktion — referens saknas',
      blockkedje_referens: null,
    })
  })

  it.each<[string, AuthorizationOutcome]>([
    ['not used inside its window (cancelled, or the nonce spent elsewhere)', { kind: 'not_in_window' }],
    ['spent on another transfer', { kind: 'used_elsewhere', txHash: `0x${'aa'.repeat(32)}` }],
  ])('used but %s: refused as final, nothing delivered', async (_label, outcome) => {
    const { url, fakes } = await startServer()
    fakes.settle.mockRejectedValue(new Error('upstream 502'))
    fakes.authorizationUsed.mockResolvedValueOnce(false).mockResolvedValue(true)
    fakes.findAuthorizationOutcome.mockResolvedValue(outcome)
    const { response, raw } = await pay(url, await signedHeader(await challenge(url)))
    expect(response.status).toBe(402)
    expect(refusal(raw).reason_code).toBe('facilitator_refused')
    expect(raw).not.toContain('Your joke')
  })

  it('timeout that later lands: retryable at first, served on a retry inside the window without calling CDP again', async () => {
    const { url, fakes } = await startServer({ timeoutMs: 30 })
    fakes.settle.mockImplementation(() => new Promise<SettleResponse>(() => {}))
    const header = await signedHeader(await challenge(url))

    const first = await pay(url, header, 4)
    expect(first.response.status).toBe(402)
    expect(refusal(first.raw).reason_code).toBe('facilitator_retryable')

    // The settlement CDP was still working on lands on-chain.
    fakes.authorizationUsed.mockResolvedValue(true)
    fakes.findAuthorizationOutcome.mockResolvedValue({ kind: 'settled', txHash: CDP_TX })
    const retry = await pay(url, header, 5)
    expect(retry.response.status).toBe(200)
    expect(receiptOf(retry.response).blockkedje_referens).toBe(`Tx: ${CDP_TX}`)
    expect(fakes.verify).toHaveBeenCalledTimes(1)
    expect(fakes.settle).toHaveBeenCalledTimes(1)
  })

  it('timeout that later lands: served on a retry AFTER validBefore', async () => {
    const { url, fakes } = await startServer({ timeoutMs: 30 })
    fakes.settle.mockImplementation(() => new Promise<SettleResponse>(() => {}))
    const now = Math.floor(Date.now() / 1000)
    const header = await signedHeader(await challenge(url), { validBefore: now + 60 })
    expect((await pay(url, header, 4)).response.status).toBe(402)

    vi.useFakeTimers({ toFake: ['Date'], now: (now + 120) * 1000 })
    fakes.authorizationUsed.mockResolvedValue(true)
    fakes.findAuthorizationOutcome.mockResolvedValue({ kind: 'settled', txHash: CDP_TX })
    const retry = await pay(url, header, 5)
    expect(retry.response.status).toBe(200)
    expect(receiptOf(retry.response).blockkedje_referens).toBe(`Tx: ${CDP_TX}`)
  })

  it('timeout that never lands: retryable, and an expired retry is then refused without calling CDP', async () => {
    const { url, fakes } = await startServer({ timeoutMs: 30 })
    fakes.settle.mockImplementation(() => new Promise<SettleResponse>(() => {}))
    const now = Math.floor(Date.now() / 1000)
    const header = await signedHeader(await challenge(url), { validBefore: now + 60 })
    const first = await pay(url, header, 4)
    expect(refusal(first.raw).reason_code).toBe('facilitator_retryable')

    vi.useFakeTimers({ toFake: ['Date'], now: (now + 120) * 1000 })
    const retry = await pay(url, header, 5)
    expect(retry.response.status).toBe(402)
    expect(refusal(retry.raw).error).toContain('expired')
    expect(fakes.verify).toHaveBeenCalledTimes(1)
  })

  it('network error on settle with the authorization unused: retryable, and the same header can still settle', async () => {
    const { url, fakes } = await startServer()
    fakes.settle.mockRejectedValueOnce(new TypeError('fetch failed'))
    const header = await signedHeader(await challenge(url))
    const first = await pay(url, header, 4)
    expect(refusal(first.raw).reason_code).toBe('facilitator_retryable')
    const second = await pay(url, header, 5)
    expect(second.response.status).toBe(200)
    expect(fakes.settle).toHaveBeenCalledTimes(2)
  })

  it('an ERC-7710 payment for the joke is refused before CDP is called', async () => {
    const { url, fakes } = await startServer()
    const pr = await challenge(url)
    const header = await signedHeader(pr, {
      payload: (p) => ({
        ...p,
        accepted: { ...p.accepted, extra: { ...p.accepted.extra, assetTransferMethod: 'erc7710' } },
      }),
    })
    const { response, raw } = await pay(url, header)
    expect(response.status).toBe(402)
    expect(refusal(raw).error).toContain('EIP-3009 only')
    expect(fakes.verify).not.toHaveBeenCalled()
  })
})

describe("the merchant's own checks run before CDP is called (#4851)", () => {
  const now = () => Math.floor(Date.now() / 1000)
  it.each<[string, Parameters<typeof signedHeader>[1], string]>([
    ['x402 version', { payload: (p) => ({ ...p, x402Version: 1 }) }, 'x402Version'],
    ['extensions echo', { payload: (p) => ({ ...p, extensions: undefined }) }, 'extensions'],
    ['quoted option', { payload: (p) => ({ ...p, accepted: { ...p.accepted, amount: '9999' } }) }, 'quoted'],
    [
      'resource',
      { payload: (p) => ({ ...p, resource: { ...p.resource!, url: 'https://elsewhere.example/mcp' } }) },
      'resource',
    ],
    ['validity window too long', { validBefore: now() + 10_000 }, 'validity window'],
    ['not valid yet', { validAfter: now() + 600, validBefore: now() + 700 }, 'not valid yet'],
    ['signature', { signWith: `0x${'02'.repeat(32)}` }, 'signature'],
    ['amount signed', { value: '9999' }, 'amount'],
    [
      'recipient signed',
      {
        payload: (p) => ({
          ...p,
          payload: {
            ...p.payload,
            authorization: {
              ...(p.payload.authorization as Eip3009Authorization),
              to: '0x2222222222222222222222222222222222222222',
            },
          },
        }),
      },
      'not addressed to this merchant',
    ],
  ])('%s', async (_label, edit, expected) => {
    const { url, fakes } = await startServer()
    const { response, raw } = await pay(url, await signedHeader(await challenge(url), edit))
    expect(response.status).toBe(402)
    expect(refusal(raw).error?.toLowerCase()).toContain(expected.toLowerCase())
    expect(fakes.verify).not.toHaveBeenCalled()
    expect(fakes.settle).not.toHaveBeenCalled()
  })
})

describe('a signed window too long to search is refused up front (#4851)', () => {
  it('validAfter far in the past: refused before any chain read or CDP call', async () => {
    // Review of #4851 (round 2): otherwise the recovery search is capped, an
    // empty capped search serves the buyer, and a cancelled nonce is served.
    const { url, fakes } = await startServer()
    const { response, raw } = await pay(url, await signedHeader(await challenge(url), { validAfter: 0 }))
    expect(response.status).toBe(402)
    expect(refusal(raw).error).toContain('validAfter close to now')
    expect(fakes.authorizationUsed).not.toHaveBeenCalled()
    expect(fakes.verify).not.toHaveBeenCalled()
  })

  it('a window just inside the limit is accepted', async () => {
    const { CDP_MAX_AUTHORIZATION_WINDOW_SECONDS } = await import('./cdp.js')
    const { url } = await startServer()
    const now = Math.floor(Date.now() / 1000)
    const validBefore = now + 300
    const header = await signedHeader(await challenge(url), { validAfter: validBefore - CDP_MAX_AUTHORIZATION_WINDOW_SECONDS, validBefore })
    expect((await pay(url, header)).response.status).toBe(200)
  })
})

describe('the in-band (stdio) refusal for the joke (#4851)', () => {
  it('names one EIP-3009 option, as the HTTP 402 does, even with erc7710 enabled on the merchant', async () => {
    // Review of #4851 (R6): the in-band requirements follow the product.
    const { buildMerchantMcpServer } = await import('./server.js')
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
    const processor = createX402PaymentProcessor(
      { submit: vi.fn(), waitForReceipt: vi.fn() },
      { erc7710: { delegationManager: TRUSTED_DELEGATION_MANAGER }, settlementMethods: ['eip3009', 'erc7710'] },
    )
    const server = buildMerchantMcpServer({
      merchantAddress: MERCHANT,
      baseUrl: 'http://127.0.0.1:0',
      buildPaymentRequired: processor.buildPaymentRequired,
      settlementMethods: ['eip3009', 'erc7710'],
      cdpConfigured: true,
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test', version: '0' })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    const result = await client.callTool({ name: 'buy_joke', arguments: {} })
    await client.close()
    await server.close()
    const text = (result.content as Array<{ text: string }>)[0].text
    const requirements = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as PaymentRequired
    expect(requirements.accepts).toHaveLength(1)
    expect(requirements.accepts[0]).toMatchObject({ amount: '10000', payTo: MERCHANT })
    expect(requirements.accepts[0].extra?.assetTransferMethod).toBeUndefined()
  })
})

describe('CDP credentials (#4851)', () => {
  it('both set: on', () => {
    const warn = vi.fn()
    expect(resolveCdpCredentials(' id ', ' secret-value ', warn)).toEqual({ apiKeyId: 'id', apiKeySecret: 'secret-value' })
    expect(warn).not.toHaveBeenCalled()
  })

  it('neither set: off, silently', () => {
    const warn = vi.fn()
    expect(resolveCdpCredentials(undefined, '', warn)).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
  })

  it.each([
    ['only the id', 'key-id-value', undefined],
    ['only the secret', undefined, 'secret-value'],
  ])('%s: off, with a warning naming both variables and neither value', (_label, id, secret) => {
    const warn = vi.fn()
    expect(resolveCdpCredentials(id, secret, warn)).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    const message = warn.mock.calls[0][0] as string
    expect(message).toContain('CDP_API_KEY_ID')
    expect(message).toContain('CDP_API_KEY_SECRET')
    expect(message).not.toContain('key-id-value')
    expect(message).not.toContain('secret-value')
  })
})
