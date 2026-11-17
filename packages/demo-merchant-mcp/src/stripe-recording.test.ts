/**
 * #4853: Stripe recording over the real HTTP boundary — the deposit address in
 * the 402, one PaymentIntent per settled payment, no second one on a retried
 * header, nothing at request time for a recovery without a hash, and delivery
 * surviving a Stripe failure. Stripe and the chain are fakes; the key is
 * obviously fake and must never appear in a log.
 */
import { randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { encodePaymentSignatureHeader } from '@x402/core/http'
import type { PaymentPayload, PaymentRequired, SettleResponse, VerifyResponse } from '@x402/core/types'
import { createDemoMerchantServer } from './http.js'
import { TRUSTED_DELEGATION_MANAGER } from './products.js'
import {
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  USDC_ADDRESS,
  createX402PaymentProcessor,
  type Eip3009Authorization,
  type SettlementClient,
} from './x402.js'
import type { AuthorizationOutcome, CdpChainReader, CdpFacilitator } from './cdp.js'
import { reconcileStripe } from './stripe-reconcile.js'
import {
  STRIPE_API_VERSION_SANDBOX,
  createStripeRecording,
  resolveStripeConfig,
  type StripeHttpClient,
  type StripeHttpRequest,
  type StripeRecording,
} from './stripe.js'

const MERCHANT = '0x15179876c595922999C2d5DC7c23Cc7711fE799a' as const
const DEPOSIT = '0x3333333333333333333333333333333333333333' as const
const OLD_DEPOSIT = '0x4444444444444444444444444444444444444444' as const
const PAYER_KEY = `0x${'01'.repeat(32)}` as const
const PAYER = privateKeyToAccount(PAYER_KEY).address
const CDP_TX = `0x${'cd'.repeat(32)}` as const
/** Obviously fake: a test key, never a real one. */
const FAKE_KEY = 'sk_test_fake_key_for_tests_only'

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

function makeFakes(): Fakes {
  return {
    verify: vi.fn<CdpFacilitator['verify']>().mockResolvedValue(VALID),
    settle: vi.fn<CdpFacilitator['settle']>().mockResolvedValue(SETTLED),
    authorizationUsed: vi.fn<CdpChainReader['authorizationUsed']>().mockResolvedValue(false),
    findAuthorizationOutcome: vi.fn<CdpChainReader['findAuthorizationOutcome']>().mockResolvedValue(null),
    submit: vi.fn<SettlementClient['submit']>().mockResolvedValue(CDP_TX),
    waitForReceipt: vi.fn<SettlementClient['waitForReceipt']>().mockResolvedValue(undefined),
  }
}

/** Stripe's idempotency-key retention: about 24 hours, then the key is pruned. */
const IDEMPOTENCY_KEY_RETENTION_MS = 24 * 60 * 60 * 1000

/**
 * An in-memory Stripe: search by metadata, create with an idempotency key.
 *
 * The key store models Stripe's ~24h retention (review S5): a repeated key
 * inside the window returns the SAME PaymentIntent, and after it the key is
 * forgotten, so the same key would create a new one. `advanceClock` moves the
 * fake's clock, as a day passing would.
 */
function fakeStripe(opts: { failCreate?: boolean; hang?: boolean } = {}) {
  const intents = new Map<string, { id: string; form: Record<string, string> }>()
  const byTx = new Map<string, string>()
  const requests: StripeHttpRequest[] = []
  const idempotencyKeys = new Map<string, { id: string; at: number }>()
  let now = Date.now()
  let nextId = 1
  const client: StripeHttpClient = {
    async request(request) {
      requests.push(request)
      if (opts.hang) return new Promise<never>(() => {})
      if (request.method === 'GET') {
        const query = new URLSearchParams(request.path.split('?')[1] ?? '').get('query') ?? ''
        const tx = /transaction_hash'\]\s*:\s*'([^']+)'/.exec(query)?.[1]
        const id = tx ? byTx.get(tx) : undefined
        return { status: 200, body: { data: id ? [{ id, status: 'succeeded' }] : [] } }
      }
      if (opts.failCreate) {
        return { status: 402, body: { error: { type: 'card_error', code: 'crypto_declined' } } }
      }
      const tx = request.form?.['metadata[transaction_hash]']
      if (!tx) return { status: 400, body: { error: { type: 'invalid_request_error' } } }
      const key = request.idempotencyKey
      if (key) {
        const held = idempotencyKeys.get(key)
        if (held && now - held.at < IDEMPOTENCY_KEY_RETENTION_MS) {
          return { status: 200, body: { id: held.id, status: 'succeeded' } }
        }
        // Stripe prunes the key after ~24h: it no longer answers for the create.
        if (held) idempotencyKeys.delete(key)
      }
      const id = `pi_test_${nextId++}`
      intents.set(id, { id, form: request.form ?? {} })
      byTx.set(tx, id)
      if (key) idempotencyKeys.set(key, { id, at: now })
      return { status: 200, body: { id, status: 'succeeded' } }
    },
  }
  return {
    client,
    intents,
    byTx,
    requests,
    idempotencyKeys,
    /** Move the fake's clock forward, as a day passing would. */
    advanceClock(ms: number) {
      now += ms
    },
  }
}

async function startServer(
  opts: {
    depositAddress?: `0x${string}`
    stripe?: boolean
    stripeFail?: boolean
    stripeHang?: boolean
    /** #4866: a recording built by the test, used instead of the default one. */
    recording?: StripeRecording
    cdp?: boolean
    fakes?: Fakes
    previousReceivingAddresses?: readonly `0x${string}`[]
  } = {},
) {
  const fakes = opts.fakes ?? makeFakes()
  const cdp = opts.cdp ?? true
  const settlementClient: SettlementClient = {
    submit: fakes.submit,
    waitForReceipt: fakes.waitForReceipt,
  }
  const settlementMethods = ['eip3009', 'erc7710'] as const
  const stripe = fakeStripe({ failCreate: opts.stripeFail, hang: opts.stripeHang })
  const recording: StripeRecording | undefined = opts.recording ??
    (opts.stripe === false
      ? undefined
      : createStripeRecording(
          {
            depositAddress: opts.depositAddress ?? DEPOSIT,
            secretKey: FAKE_KEY,
            apiVersion: STRIPE_API_VERSION_SANDBOX,
            network: 'base',
          },
          { http: stripe.client, log: (line) => logs.push(line), timeoutMs: 50 },
        ))
  const server = createDemoMerchantServer({
    merchantAddress: MERCHANT,
    baseUrl: 'http://127.0.0.1:0',
    settlementMethods,
    paymentProcessor: createX402PaymentProcessor(settlementClient, {
      erc7710: { delegationManager: TRUSTED_DELEGATION_MANAGER },
      settlementMethods,
      ...(cdp
        ? {
            cdp: {
              facilitator: { verify: fakes.verify, settle: fakes.settle },
              chain: { authorizationUsed: fakes.authorizationUsed, findAuthorizationOutcome: fakes.findAuthorizationOutcome },
              timeoutMs: 200,
            },
          }
        : {}),
      ...(opts.previousReceivingAddresses ? { previousReceivingAddresses: opts.previousReceivingAddresses } : {}),
    }),
    settlementClient,
    readinessCacheMs: 0,
    cdpConfigured: cdp,
    stripe: recording,
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test server port')
  return {
    fakes,
    stripe,
    recording,
    origin: `http://127.0.0.1:${address.port}`,
    url: `http://127.0.0.1:${address.port}/mcp`,
  }
}

const logs: string[] = []

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

async function challenge(url: string, body: unknown = buyJoke()): Promise<PaymentRequired> {
  const response = await postMcp(url, body)
  expect(response.status).toBe(402)
  return (await response.json()) as PaymentRequired
}

/** A signed EIP-3009 header for the challenge's first option; `edit` bends one field. */
async function signedHeader(
  pr: PaymentRequired,
  edit: { payTo?: `0x${string}`; validBefore?: number } = {},
): Promise<string> {
  const account = privateKeyToAccount(PAYER_KEY)
  const now = Math.floor(Date.now() / 1000)
  const accepted = pr.accepts[0]
  const authorization: Eip3009Authorization = {
    from: account.address,
    to: edit.payTo ?? accepted.payTo,
    value: accepted.amount,
    validAfter: String(now - 5),
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
  const payload: PaymentPayload = {
    x402Version: 2,
    resource: pr.resource,
    accepted: { ...accepted, payTo: authorization.to },
    payload: { authorization, signature },
    ...(pr.extensions ? { extensions: pr.extensions } : {}),
  }
  return encodePaymentSignatureHeader(payload)
}

async function pay(url: string, header: string, id = 4, body: unknown = buyJoke(id)) {
  const response = await postMcp(url, body, { [PAYMENT_SIGNATURE_HEADER]: header })
  const raw = await response.text()
  return { response, raw }
}

describe('the deposit address in the 402 (#4853)', () => {
  it('names the deposit address for the joke and MERCHANT_ADDRESS for every other product', async () => {
    const { url } = await startServer()

    const joke = await challenge(url)
    expect(joke.accepts[0]).toMatchObject({ amount: '10000', payTo: DEPOSIT })

    const vpn = await challenge(url, callTool('buy_vpn', { plan: 'basic' }))
    expect(vpn.accepts[0]).toMatchObject({ payTo: MERCHANT })

    const storage = await challenge(url, callTool('buy_cloud_storage', { tier: '50gb' }))
    expect(storage.accepts[0]).toMatchObject({ payTo: MERCHANT })
  })

  it('keeps MERCHANT_ADDRESS for the joke when Stripe is off', async () => {
    const { url } = await startServer({ stripe: false })
    const joke = await challenge(url)
    expect(joke.accepts[0]).toMatchObject({ payTo: MERCHANT })
  })

  it('/healthz reports Stripe when configured, naming no credential', async () => {
    const { origin } = await startServer()
    const health = (await (await fetch(`${origin}/healthz`)).json()) as Record<string, unknown>
    expect(health.stripe).toEqual({
      configured: true,
      deposit_address: DEPOSIT,
      api_version: STRIPE_API_VERSION_SANDBOX,
      network: 'base',
      recorded: 0,
      pending: 0,
      declined: 0,
      record_failures: 0,
    })
    expect(JSON.stringify(health)).not.toContain(FAKE_KEY)
  })

  it('#4866: /healthz counts recorded, pending, declined and failures apart', async () => {
    // One PaymentIntent Stripe declines after create, two it never decides —
    // different counts, so swapping the two keys cannot pass.
    const statusFor = new Map([
      ['pi_3Declined0001', 'requires_payment_method'],
      ['pi_3Pending00001', 'processing'],
      ['pi_3Pending00002', 'processing'],
    ])
    let next = 0
    const ids = ['pi_3Declined0001', 'pi_3Pending00001', 'pi_3Pending00002']
    const http: StripeHttpClient = {
      async request(request) {
        if (request.path.startsWith('/v1/payment_intents/search')) return { status: 200, body: { data: [] } }
        if (request.method === 'GET') {
          const id = request.path.split('/').pop()!
          return { status: 200, body: { id, status: statusFor.get(id) } }
        }
        return { status: 200, body: { id: ids[next++], status: 'processing' } }
      },
    }
    const recording = createStripeRecording(
      { depositAddress: DEPOSIT, secretKey: FAKE_KEY, apiVersion: STRIPE_API_VERSION_SANDBOX, network: 'base' },
      { http, log: () => {}, sleep: async () => {}, verdictPollMs: 1_000, verdictTimeoutMs: 2_000 },
    )
    await recording.record({ txHash: `0x${'d1'.repeat(32)}`, amountAtomic: 10_000n, productId: 'joke' })
    await recording.record({ txHash: `0x${'d2'.repeat(32)}`, amountAtomic: 10_000n, productId: 'joke' })
    await recording.record({ txHash: `0x${'d3'.repeat(32)}`, amountAtomic: 10_000n, productId: 'joke' })

    const { origin } = await startServer({ recording })
    const health = (await (await fetch(`${origin}/healthz`)).json()) as Record<string, unknown>
    expect(health.stripe).toEqual({
      configured: true,
      deposit_address: DEPOSIT,
      api_version: STRIPE_API_VERSION_SANDBOX,
      network: 'base',
      recorded: 0,
      pending: 2,
      declined: 1,
      record_failures: 0,
    })
  })

  it('/healthz has no stripe block when Stripe is off', async () => {
    const { origin } = await startServer({ stripe: false })
    const health = (await (await fetch(`${origin}/healthz`)).json()) as Record<string, unknown>
    expect(health.stripe).toBeUndefined()
  })
})

describe('Stripe configured with CDP not configured (#4853, review S4)', () => {
  it('warns naming CDP and does not offer the joke, even with a recording in hand', async () => {
    // The startup path: both Stripe variables set, CDP not. Stripe stays off
    // with a warning naming CDP — the joke is not offered at all (#4851).
    const warn = vi.fn()
    const resolved = resolveStripeConfig({
      depositAddressRaw: DEPOSIT,
      secretKeyRaw: FAKE_KEY,
      cdpConfigured: false,
      priceAtomic: 10_000n,
      warn,
    })
    expect(resolved).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('CDP')

    // And the server itself: a recording is present, CDP is not, and the joke
    // is absent from every surface — not merely paid to MERCHANT_ADDRESS.
    const { url, origin, stripe } = await startServer({ cdp: false })
    const list = await (await postMcp(url, callTool('list_products', {}, 1))).text()
    expect(list).not.toContain('joke')
    const tools = await (await postMcp(url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })).text()
    expect(tools).not.toContain('buy_joke')
    expect(JSON.stringify(await (await fetch(`${origin}/`)).json())).not.toContain('joke')
    const call = await postMcp(url, buyJoke())
    expect(call.status).not.toBe(402)
    expect(stripe.requests).toHaveLength(0)
  })
})

describe('recording a settled payment (#4853)', () => {
  it('creates one PaymentIntent with the amount in cents and the transaction hash as idempotency key', async () => {
    const { url, stripe, recording } = await startServer()
    const pr = await challenge(url)
    const { response } = await pay(url, await signedHeader(pr))
    expect(response.status).toBe(200)
    await recording!.flush()

    const creates = stripe.requests.filter((request) => request.method === 'POST')
    expect(creates).toHaveLength(1)
    expect(creates[0]!.idempotencyKey).toBe(CDP_TX)
    expect(creates[0]!.form).toMatchObject({
      amount: '1',
      currency: 'usd',
      'payment_method_options[crypto][mode]': 'transaction_verification',
      'payment_method_options[crypto][transaction_verification_options][network]': 'base',
      'payment_method_options[crypto][transaction_verification_options][transaction_hash]': CDP_TX,
    })
    expect(recording!.stats()).toEqual({ attempted: 1, recorded: 1, alreadyRecorded: 0, pending: 0, declined: 0, failed: 0 })
  })

  it('creates no second PaymentIntent when the same header is retried', async () => {
    const { url, stripe, recording } = await startServer()
    const pr = await challenge(url)
    const header = await signedHeader(pr)

    const first = await pay(url, header)
    expect(first.response.status).toBe(200)
    const second = await pay(url, header, 5)
    expect(second.response.status).toBe(200)
    await recording!.flush()

    expect(stripe.requests.filter((request) => request.method === 'POST')).toHaveLength(1)
    expect(recording!.stats()).toEqual({ attempted: 2, recorded: 1, alreadyRecorded: 1, pending: 0, declined: 0, failed: 0 })
  })

  it('creates no PaymentIntent at request time for a recovery without a transaction hash', async () => {
    const { url, stripe, recording, fakes } = await startServer()
    // The authorization is used on-chain, but the event search cannot name the
    // transaction: the buyer is served with no reference (#4851).
    fakes.authorizationUsed.mockResolvedValue(true)
    fakes.findAuthorizationOutcome.mockResolvedValue(null)

    const pr = await challenge(url)
    const { response, raw } = await pay(url, await signedHeader(pr))
    expect(response.status).toBe(200)
    expect(raw).toContain('Paid in an earlier transaction')
    await recording!.flush()

    expect(stripe.requests.filter((request) => request.method === 'POST')).toHaveLength(0)
    expect(recording!.stats()).toEqual({ attempted: 0, recorded: 0, alreadyRecorded: 0, pending: 0, declined: 0, failed: 0 })

    // ...and the reconciliation script picks it up from the chain.
    const report = await reconcileStripe({
      chain: {
        async findTransfersTo() {
          return [{ txHash: CDP_TX, from: PAYER, value: 10_000n }]
        },
        async isEip3009Transfer() {
          return true
        },
      },
      recording: recording!,
      depositAddress: DEPOSIT,
      priceAtomic: 10_000n,
      productId: 'joke',
      fromBlock: 1n,
      toBlock: 2n,
    })
    expect(report.recorded).toEqual([{ tx_hash: CDP_TX, payment_intent: 'pi_test_1' }])
  })

  it('records nothing for a product Stripe does not record', async () => {
    const { url, stripe, recording } = await startServer()
    const vpnCall = callTool('buy_vpn', { plan: 'basic' }, 6)
    const pr = await challenge(url, vpnCall)
    const { response } = await pay(url, await signedHeader(pr), 6, vpnCall)
    expect(response.status).toBe(200)
    await recording!.flush()
    expect(stripe.requests).toHaveLength(0)
  })
})

describe('a Stripe failure never blocks delivery (#4853)', () => {
  it('delivers the goods, logs the hash without the key, and counts the failure in /healthz', async () => {
    logs.length = 0
    const { url, origin, recording } = await startServer({ stripeFail: true })
    const pr = await challenge(url)
    const { response, raw } = await pay(url, await signedHeader(pr))

    expect(response.status).toBe(200)
    expect(raw).toContain('Haven Joke')
    expect(response.headers.get(PAYMENT_RESPONSE_HEADER)).toBeTruthy()
    await recording!.flush()

    expect(logs).toContain(`[stripe] record_failed tx=${CDP_TX} reason=card_error/crypto_declined`)
    for (const line of logs) expect(line).not.toContain(FAKE_KEY)

    const health = (await (await fetch(`${origin}/healthz`)).json()) as {
      stripe: { record_failures: number; recorded: number }
    }
    expect(health.stripe.record_failures).toBe(1)
    expect(health.stripe.recorded).toBe(0)
  })

  it('delivers the goods when Stripe does not answer at all', async () => {
    logs.length = 0
    const { url, origin, recording } = await startServer({ stripeHang: true })
    const pr = await challenge(url)
    const { response, raw } = await pay(url, await signedHeader(pr))

    expect(response.status).toBe(200)
    expect(raw).toContain('Haven Joke')
    await recording!.flush()

    expect(logs).toContain(`[stripe] record_failed tx=${CDP_TX} reason=StripeTimeoutError`)
    const health = (await (await fetch(`${origin}/healthz`)).json()) as {
      stripe: { record_failures: number }
    }
    expect(health.stripe.record_failures).toBe(1)
  })
})

describe('a redeploy that moves the deposit address (#4853, review S7)', () => {
  it('serves a retry of an authorization that settled to the address it was quoted for, when the operator names it', async () => {
    // The buyer was quoted OLD_DEPOSIT, paid it, and lost the answer. The
    // merchant redeployed with a new deposit address and named the old one as
    // the address it still honours, so the retried header is served.
    const fakes = makeFakes()
    fakes.authorizationUsed.mockResolvedValue(true)
    fakes.findAuthorizationOutcome.mockResolvedValue({ kind: 'settled', txHash: CDP_TX } satisfies AuthorizationOutcome)

    const before = await startServer({ depositAddress: OLD_DEPOSIT, fakes })
    const oldChallenge = await challenge(before.url)
    expect(oldChallenge.accepts[0]!.payTo).toBe(OLD_DEPOSIT)
    const header = await signedHeader(oldChallenge)

    const after = await startServer({
      depositAddress: DEPOSIT,
      fakes,
      previousReceivingAddresses: [OLD_DEPOSIT],
    })
    const { response, raw } = await pay(after.url, header)

    expect(response.status).toBe(200)
    expect(raw).toContain('Haven Joke')
    expect(response.headers.get(PAYMENT_RESPONSE_HEADER)).toBeTruthy()
    // The facilitator was never asked to settle it again.
    expect(fakes.settle).not.toHaveBeenCalled()
  })

  it('#4866: sends the recovered payment to Stripe only if it paid the CURRENT deposit address — this one paid the old one', async () => {
    // Stripe declines a transaction that did not pay the deposit address
    // (#4854), and the decline is permanent for that transaction. Before
    // #4866 this recovered payment was sent to Stripe all the same.
    const fakes = makeFakes()
    fakes.authorizationUsed.mockResolvedValue(true)
    fakes.findAuthorizationOutcome.mockResolvedValue({ kind: 'settled', txHash: CDP_TX } satisfies AuthorizationOutcome)

    const before = await startServer({ depositAddress: OLD_DEPOSIT, fakes })
    const header = await signedHeader(await challenge(before.url))
    const after = await startServer({ depositAddress: DEPOSIT, fakes, previousReceivingAddresses: [OLD_DEPOSIT] })
    logs.length = 0
    const { response } = await pay(after.url, header)
    await after.recording!.flush()

    expect(response.status).toBe(200)
    expect(after.stripe.requests).toHaveLength(0)
    expect(logs).toContain(`[stripe] not_recorded tx=${CDP_TX} reason=paid_other_address`)
    expect(after.recording!.stats().attempted).toBe(0)
  })

  it('refuses the same retry when the chain says the authorization is unused', async () => {
    const fakes = makeFakes()
    fakes.authorizationUsed.mockResolvedValue(false)

    const before = await startServer({ depositAddress: OLD_DEPOSIT, fakes })
    const oldChallenge = await challenge(before.url)
    const header = await signedHeader(oldChallenge)

    const after = await startServer({
      depositAddress: DEPOSIT,
      fakes,
      previousReceivingAddresses: [OLD_DEPOSIT],
    })
    const { response, raw } = await pay(after.url, header)

    expect(response.status).toBe(402)
    expect(raw).toContain('does not match')
    expect(fakes.settle).not.toHaveBeenCalled()
  })

  it('refuses a used authorization addressed to an address the merchant never quoted', async () => {
    // The payment's own `payTo` is attacker-chosen. Serving a used
    // authorization addressed to it would hand goods to anyone who paid an
    // address of their own, so only an operator-named previous address counts.
    const fakes = makeFakes()
    fakes.authorizationUsed.mockResolvedValue(true)
    fakes.findAuthorizationOutcome.mockResolvedValue({ kind: 'settled', txHash: CDP_TX } satisfies AuthorizationOutcome)

    const { url } = await startServer({ depositAddress: DEPOSIT, fakes })
    const pr = await challenge(url)
    const header = await signedHeader(pr, { payTo: OLD_DEPOSIT })
    const { response } = await pay(url, header)

    expect(response.status).toBe(402)
    expect(fakes.settle).not.toHaveBeenCalled()
  })
})
