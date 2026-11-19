import { afterEach, describe, expect, it, vi } from 'vitest'
import { HavenClient } from './client.js'
import { MerchantCompletion } from './merchant-completion.js'
import { X402FundingLeg } from './x402-funding-leg.js'
import { McpMerchantTransport } from './mcp-merchant-transport.js'
import { encodeBase64Json } from './base64.js'
import { X_TAX_DECLARATION_HEADER } from './client-tax-declaration.js'
import { addressFromKey } from './edge-signing.js'
import { CHECKOUT_DETAILS_EXTENSION, X_CHECKOUT_DETAILS_HEADER } from './checkout-details.js'
import { CheckoutDetailsUnavailableError } from './types.js'
import { buildFundingLegSignData } from './__fixtures__/valid-userop.js'
import type { X402PaymentOption, X402PaymentRequired, X402Receipt } from './types.js'

/**
 * #4872 flow tests, through the REAL client (`fetch`, `payX402Quote`,
 * `resumeX402Payment`) against a route-table wire stub, the way
 * `x402-tax-declaration-flow.test.ts` drives the tax header:
 *
 * - a challenge with no checkout-details request is paid exactly as today:
 *   no read of the details and no answer header (characterization);
 * - a request for the email only sends the email only;
 * - an optional field that cannot be shared proceeds without it;
 * - a required field that cannot be shared refuses BEFORE authorisation —
 *   no `/x402` intent is created — with a reason per cause (sharing off,
 *   nothing stored, unreadable, older backend);
 * - an unreadable request gets no answer and no refusal;
 * - the values never reach a Haven request, the authorize body, the error,
 *   or the log.
 */

const DELEGATE_KEY = `0x${'01'.repeat(32)}`
const DELEGATE_ADDRESS = addressFromKey(DELEGATE_KEY)
const TX_HASH = `0x${'ab'.repeat(32)}`
const HAVEN_BASE = 'https://haven.example'
const MERCHANT_URL = 'https://api.merchant.example/paid'
const AGENT_ID = 'agent_4872'
const DETAILS_PATH = `/agents/${AGENT_ID}/checkout-details`

const EMAIL = 'owner.secret@example.se'
const ADDRESS = { line1: 'Hemligagatan 7', city: 'Stockholm', postCode: '111 57', country: 'SE' }
const STORED = { available: true, checkout_details: { receipt_email: EMAIL, billing_address: ADDRESS } }
const VALUE_MARKERS = [EMAIL, 'Hemligagatan', '111 57']

const accepted: X402PaymentOption = {
  scheme: 'exact',
  network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  amount: '20000',
  payTo: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
  maxTimeoutSeconds: 300,
  extra: { name: 'USD Coin', version: '2' },
}

function challenge(extensions?: Record<string, unknown>): X402PaymentRequired {
  return {
    x402Version: 2,
    error: 'Payment required',
    resource: { url: MERCHANT_URL, description: 'paid resource', mimeType: 'application/json' },
    accepts: [accepted],
    ...(extensions ? { extensions } : {}),
  }
}

const ask = (fields: Record<string, { required: boolean }>) => ({ [CHECKOUT_DETAILS_EXTENSION]: { info: { version: 1, fields } } })

interface FetchCall {
  url: string
  init: RequestInit | undefined
}

type HavenRoute = unknown | { __status: number; body: unknown }

function stubWire(
  haven: Record<string, HavenRoute>,
  paymentRequired: X402PaymentRequired,
  opts: { paidFromFirstMerchantCall?: boolean } = {},
): { calls: FetchCall[] } {
  const calls: FetchCall[] = []
  let merchantCalls = 0
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    calls.push({ url, init })
    if (url.startsWith(HAVEN_BASE)) {
      const path = url.slice(HAVEN_BASE.length)
      if (Object.prototype.hasOwnProperty.call(haven, path)) {
        const route = haven[path] as { __status?: number; body?: unknown }
        if (route && typeof route === 'object' && typeof route.__status === 'number') {
          return new Response(JSON.stringify(route.body), { status: route.__status })
        }
        return new Response(JSON.stringify(route), { status: 200 })
      }
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
    }
    merchantCalls += 1
    if (merchantCalls === 1 && !opts.paidFromFirstMerchantCall) {
      return new Response(JSON.stringify(paymentRequired), { status: 402, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  return { calls }
}

function fundingStubs(): Record<string, unknown> {
  const signData = buildFundingLegSignData({ asset: accepted.asset, amount: accepted.amount, delegateKey: DELEGATE_KEY })
  return {
    '/x402': {
      payment_id: 'pay_4872',
      status: 'pending_signature',
      expires_at: 'later',
      chain_id: 8453,
      account_address: '0x135a9215604711AC70d970e12Caa812c53537EF4',
      payer: '0x135a9215604711AC70d970e12Caa812c53537EF4',
      token: 'USDC',
      amount: '0.02',
      to: DELEGATE_ADDRESS,
      merchant_to: accepted.payTo,
      resource_url: MERCHANT_URL,
      sign_data: {
        ...signData,
        components: { payer_account: '0x135a9215604711AC70d970e12Caa812c53537EF4', token: accepted.asset, to: DELEGATE_ADDRESS, amount: accepted.amount },
        instructions: 'sign then POST /payments/pay_4872/sign',
      },
    },
    '/payments/pay_4872/sign': { payment_id: 'pay_4872', status: 'confirmed', tx_hash: TX_HASH, chain_id: 8453, token: 'USDC', amount: '0.02', to: DELEGATE_ADDRESS },
    '/machine-payments/agent': {
      id: AGENT_ID,
      name: 'checkout agent',
      status: 'active',
      account_address: '0x135a9215604711AC70d970e12Caa812c53537EF4',
      delegate_address: DELEGATE_ADDRESS,
      chain_id: 8453,
      execution_rail: 'delegation',
    },
    '/agents/agent_4872/tax-declaration': { available: false, reason: 'disabled' },
  }
}

const resumeStatus = {
  '/machine-payments/pay_4872/status': {
    payment_id: 'pay_4872',
    kind: 'payment_intent',
    rail: 'x402',
    status: 'confirmed',
    phase: 'funding_sent',
    next_action: 'retry_original_x402_request',
    amount: '0.02',
    token: 'USDC',
    resource_url: MERCHANT_URL,
    merchant_address: accepted.payTo,
    tx_hash: TX_HASH,
    expires_at: 'later',
    chain_id: 8453,
    message: 'ready to retry',
  },
}

const newClient = () => new HavenClient({ apiKey: 'sk_agent_test', delegateKey: DELEGATE_KEY, baseUrl: HAVEN_BASE })
const merchantCallsOf = (calls: FetchCall[]) => calls.filter((c) => !c.url.startsWith(HAVEN_BASE))
const havenCallsOf = (calls: FetchCall[]) => calls.filter((c) => c.url.startsWith(HAVEN_BASE))
const paidRetry = (calls: FetchCall[]) => merchantCallsOf(calls).at(-1)
const answerOf = (call: FetchCall | undefined) => {
  const header = new Headers(call?.init?.headers).get(X_CHECKOUT_DETAILS_HEADER)
  return header ? (JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as Record<string, unknown>) : undefined
}
const authorizeCalls = (calls: FetchCall[]) => calls.filter((c) => c.url === `${HAVEN_BASE}/x402`)

/** Every byte that left the client toward Haven, for the "never sent to Haven" census. */
function havenTraffic(calls: FetchCall[]): string {
  return havenCallsOf(calls)
    .map((c) => `${c.url} ${JSON.stringify([...new Headers(c.init?.headers).entries()])} ${typeof c.init?.body === 'string' ? c.init.body : ''}`)
    .join('\n')
}

type Path = 'fetch' | 'payX402Quote' | 'resumeX402Payment'
const PATHS: Path[] = ['fetch', 'payX402Quote', 'resumeX402Payment']

async function pay(path: Path, paymentRequired: X402PaymentRequired): Promise<Response> {
  const client = newClient()
  if (path === 'fetch') return client.fetch(MERCHANT_URL, { method: 'GET' })
  if (path === 'payX402Quote') return client.payX402Quote(await client.quoteX402(MERCHANT_URL, { method: 'GET' }, { idempotencyKey: 'q-4872' }))
  return client.resumeX402Payment({ paymentId: 'pay_4872', paymentRequired, url: MERCHANT_URL, init: { method: 'GET' } })
}

function wire(path: Path, haven: Record<string, HavenRoute>, paymentRequired: X402PaymentRequired) {
  return stubWire(
    { ...fundingStubs(), ...(path === 'resumeX402Payment' ? resumeStatus : {}), ...haven },
    paymentRequired,
    { paidFromFirstMerchantCall: path === 'resumeX402Payment' },
  )
}

describe('checkout details on the paid request (#4872)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('a challenge that asks for nothing is paid exactly as today (characterization)', () => {
    for (const path of PATHS) {
      it(`${path}: no read of the details, no answer header, and the same paid-request header names as before`, async () => {
        const { calls } = wire(path, { [DETAILS_PATH]: STORED }, challenge())
        expect((await pay(path, challenge())).status).toBe(200)
        expect(havenCallsOf(calls).some((c) => c.url.includes('/checkout-details'))).toBe(false)
        const retry = paidRetry(calls)
        expect(new Headers(retry?.init?.headers).has(X_CHECKOUT_DETAILS_HEADER)).toBe(false)
        // The header NAMES today's paid request carries, pinned before the change.
        expect([...new Headers(retry?.init?.headers).keys()].sort()).toEqual(['payment-signature', 'x402-wallet'])
      })
    }
  })

  for (const path of PATHS) {
    describe(`${path}`, () => {
      it('a request for the email only sends the email only', async () => {
        const paymentRequired = challenge(ask({ receipt_email: { required: true } }))
        const { calls } = wire(path, { [DETAILS_PATH]: STORED }, paymentRequired)
        expect((await pay(path, paymentRequired)).status).toBe(200)
        expect(answerOf(paidRetry(calls))).toEqual({ version: 1, receipt_email: EMAIL })
      })

      it('an optional field with sharing off: the purchase proceeds and nothing is sent', async () => {
        const paymentRequired = challenge(ask({ billing_address: { required: false } }))
        const { calls } = wire(path, { [DETAILS_PATH]: { available: false, reason: 'disabled' } }, paymentRequired)
        expect((await pay(path, paymentRequired)).status).toBe(200)
        expect(answerOf(paidRetry(calls))).toBeUndefined()
      })

      it('an optional field when the read fails: the purchase is never blocked', async () => {
        const paymentRequired = challenge(ask({ receipt_email: { required: false } }))
        const { calls } = wire(path, { [DETAILS_PATH]: { __status: 500, body: { error: 'boom' } } }, paymentRequired)
        expect((await pay(path, paymentRequired)).status).toBe(200)
        expect(answerOf(paidRetry(calls))).toBeUndefined()
      })

      it('an unreadable request (version 2) gets no answer and no refusal, and reads nothing', async () => {
        const paymentRequired = challenge({ [CHECKOUT_DETAILS_EXTENSION]: { info: { version: 2, fields: { receipt_email: { required: true } } } } })
        const { calls } = wire(path, { [DETAILS_PATH]: STORED }, paymentRequired)
        expect((await pay(path, paymentRequired)).status).toBe(200)
        expect(answerOf(paidRetry(calls))).toBeUndefined()
        expect(havenCallsOf(calls).some((c) => c.url.includes('/checkout-details'))).toBe(false)
      })
    })
  }

  describe('a required field that cannot be shared stops before paying', () => {
    const cases: Array<[string, HavenRoute | undefined, string]> = [
      ['sharing off', { available: false, reason: 'disabled' }, 'not_shared'],
      ['the deployment has it off', { available: false, reason: 'feature_disabled' }, 'feature_disabled'],
      ['nothing stored', { available: false, reason: 'no_details' }, 'not_stored'],
      ['the read fails', { __status: 500, body: { error: 'boom' } }, 'unreadable'],
      ['an older backend (404)', undefined, 'backend_unsupported'],
    ]
    for (const path of ['fetch', 'payX402Quote'] as const) {
      for (const [label, route, reason] of cases) {
        it(`${path}, ${label}: refused with reason ${reason}, no payment created, no paid request`, async () => {
          const paymentRequired = challenge(ask({ receipt_email: { required: true }, shipping_address: { required: false } }))
          const { calls } = wire(path, route === undefined ? {} : { [DETAILS_PATH]: route }, paymentRequired)
          const err = await pay(path, paymentRequired).catch((e: unknown) => e)
          expect(err).toBeInstanceOf(CheckoutDetailsUnavailableError)
          const refusal = err as CheckoutDetailsUnavailableError
          expect(refusal.statusCode).toBe(409)
          expect(refusal.body).toEqual({
            code: 'CHECKOUT_DETAILS_UNAVAILABLE',
            missing_fields: ['receipt_email'],
            reason,
            stage: 'before_payment',
            next_action: 'stop_and_tell_user',
          })
          expect(refusal.message).toContain('No payment was created')
          expect(authorizeCalls(calls)).toEqual([])
          // Only the unpaid probe (fetch) or the quote probe reached the merchant.
          expect(merchantCallsOf(calls).every((c) => !new Headers(c.init?.headers).has('payment-signature'))).toBe(true)
        })
      }
    }

    it('resumeX402Payment (already funded): reports the refusal, does not re-sign and does not send the paid request', async () => {
      const paymentRequired = challenge(ask({ receipt_email: { required: true } }))
      const { calls } = wire('resumeX402Payment', { [DETAILS_PATH]: { available: false, reason: 'disabled' } }, paymentRequired)
      const resign = vi.spyOn(X402FundingLeg.prototype, 'createPaymentHeader')
      const err = await pay('resumeX402Payment', paymentRequired).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(CheckoutDetailsUnavailableError)
      expect((err as Error).message).toContain('funded but was not delivered')
      // Refused BEFORE the re-sign: the authorization stays unused.
      expect(resign).not.toHaveBeenCalled()
      expect(merchantCallsOf(calls)).toEqual([])
      // Decided AFTER the resume's status check (so "funded" is true) and
      // before anything reached the merchant.
      expect(havenCallsOf(calls).some((c) => c.url.includes('/machine-payments/pay_4872/status'))).toBe(true)
      expect(havenCallsOf(calls).some((c) => c.url.includes('/sign'))).toBe(false)
    })

    it('resumeX402Payment on a payment that is not resumable: the true conflict answer, never the checkout-details refusal', async () => {
      const paymentRequired = challenge(ask({ receipt_email: { required: true } }))
      const settled = {
        '/machine-payments/pay_4872/status': {
          ...resumeStatus['/machine-payments/pay_4872/status'],
          status: 'settled',
          phase: 'settled',
          next_action: 'none',
          message: 'This payment has already settled.',
        },
      }
      const { calls } = stubWire(
        { ...fundingStubs(), ...settled, [DETAILS_PATH]: { available: false, reason: 'disabled' } },
        paymentRequired,
        { paidFromFirstMerchantCall: true },
      )
      const err = await pay('resumeX402Payment', paymentRequired).catch((e: unknown) => e)
      expect(err).not.toBeInstanceOf(CheckoutDetailsUnavailableError)
      expect((err as Error).message).toContain('already settled')
      // The details were never read: the resume stopped at its own check.
      expect(havenCallsOf(calls).some((c) => c.url.includes('/checkout-details'))).toBe(false)
    })
  })

  it('the values never reach a Haven request, the authorize body, the refusal or the log', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const paymentRequired = challenge(ask({ receipt_email: { required: true }, billing_address: { required: false } }))
    const { calls } = wire('fetch', { [DETAILS_PATH]: STORED }, paymentRequired)
    await pay('fetch', paymentRequired)
    // Positive control: the merchant DID receive them.
    expect(answerOf(paidRetry(calls))).toEqual({ version: 1, receipt_email: EMAIL, billing_address: ADDRESS })
    const traffic = havenTraffic(calls)
    const logged = stderr.mock.calls.map((c) => String(c[0])).join('')
    expect(logged).toContain('checkout details: outcome=sent fields=receipt_email,billing_address')
    for (const marker of VALUE_MARKERS) {
      expect(traffic, `Haven traffic carries ${marker}`).not.toContain(marker)
      expect(logged, `the log carries ${marker}`).not.toContain(marker)
    }
    // Nor in their encoded form: the answer header's value is never logged or sent to Haven.
    const answerValue = new Headers(paidRetry(calls)?.init?.headers).get(X_CHECKOUT_DETAILS_HEADER) ?? ''
    expect(answerValue.length).toBeGreaterThan(0)
    expect(logged).not.toContain(answerValue)
    expect(traffic).not.toContain(answerValue)
    // The echoed `extensions` in the payment header carry the REQUEST, never the answer.
    const paymentHeader = new Headers(paidRetry(calls)?.init?.headers).get('payment-signature') ?? ''
    const echoed = Buffer.from(paymentHeader, 'base64').toString('utf8')
    expect(echoed).toContain(CHECKOUT_DETAILS_EXTENSION)
    for (const marker of VALUE_MARKERS) expect(echoed).not.toContain(marker)
  })

  it('a refusal names fields, never values, and leaves no value in its body', async () => {
    const paymentRequired = challenge(ask({ billing_address: { required: true } }))
    wire('fetch', { [DETAILS_PATH]: { available: true, checkout_details: { receipt_email: EMAIL } } }, paymentRequired)
    const err = (await pay('fetch', paymentRequired).catch((e: unknown) => e)) as CheckoutDetailsUnavailableError
    expect(err.missingFields).toEqual(['billing_address'])
    expect(err.reason).toBe('not_stored')
    expect(JSON.stringify(err.body) + err.message).not.toContain(EMAIL)
  })

  describe('the paths that are not supported pay as today (§4)', () => {
    // The adapter rebuilds the challenge from tool arguments with
    // `toolX402PaymentRequired`, which carries no `extensions`: even an agent
    // that passes the merchant's request along gets no answer and no refusal.
    const extensions = ask({ receipt_email: { required: true } })
    const base = { url: MERCHANT_URL, payTo: accepted.payTo, amount: accepted.amount, asset: accepted.asset, network: accepted.network, extensions }

    it('authorize_x402_payment: authorised as today, no read of the details, no refusal', async () => {
      const { calls } = wire('fetch', { [DETAILS_PATH]: { available: false, reason: 'disabled' } }, challenge(extensions))
      const out = (await newClient().executeTool('authorize_x402_payment', { ...base, idempotencyKey: 'adapter-4872' })) as Record<string, unknown>
      expect(out.code).not.toBe('CHECKOUT_DETAILS_UNAVAILABLE')
      expect(typeof out.payment_header).toBe('string')
      expect(authorizeCalls(calls)).toHaveLength(1)
      expect(havenCallsOf(calls).some((c) => c.url.includes('/checkout-details'))).toBe(false)
    })

    it('resume_x402_payment: resumed as today, no read of the details, no refusal', async () => {
      const { calls } = wire('resumeX402Payment', { [DETAILS_PATH]: { available: false, reason: 'disabled' } }, challenge(extensions))
      const out = (await newClient().executeTool('resume_x402_payment', { ...base, payment_id: 'pay_4872', idempotencyKey: 'adapter-4872' })) as Record<string, unknown>
      expect(out.code).not.toBe('CHECKOUT_DETAILS_UNAVAILABLE')
      expect(typeof out.payment_header).toBe('string')
      expect(havenCallsOf(calls).some((c) => c.url.includes('/checkout-details'))).toBe(false)
    })
  })

  it("rides beside the tax declaration: an opted-in agent's paid request carries both headers", async () => {
    const declaration = { version: 'x402-tax-1', jurisdiction: 'DE', taxableStatus: 'TAXABLE_PERSON', taxId: 'DE123456789', validUntil: 1790912400000 }
    const paymentRequired = challenge(ask({ receipt_email: { required: true } }))
    const { calls } = wire(
      'fetch',
      { [DETAILS_PATH]: STORED, '/agents/agent_4872/tax-declaration': { available: true, declaration } },
      paymentRequired,
    )
    expect((await pay('fetch', paymentRequired)).status).toBe(200)
    const headers = new Headers(paidRetry(calls)?.init?.headers)
    expect(headers.has(X_TAX_DECLARATION_HEADER)).toBe(true)
    expect(answerOf(paidRetry(calls))).toEqual({ version: 1, receipt_email: EMAIL })
  })

  it("counts the caller's own headers before paying: a required field that would not fit is refused, no payment created", async () => {
    const paymentRequired = challenge(ask({ receipt_email: { required: true } }))
    const { calls } = wire('fetch', { [DETAILS_PATH]: STORED }, paymentRequired)
    const err = await newClient()
      .fetch(MERCHANT_URL, { method: 'GET', headers: { 'x-big': 'b'.repeat(15000) } })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CheckoutDetailsUnavailableError)
    expect((err as CheckoutDetailsUnavailableError).reason).toBe('over_budget')
    expect(authorizeCalls(calls)).toEqual([])
  })

  describe('the safety net at the paid request measures the real block (§3)', () => {
    const receipt: X402Receipt = {
      success: true,
      paymentId: 'pay_net',
      txHash: TX_HASH,
      token: 'USDC',
      amount: '0.02',
      to: DELEGATE_ADDRESS,
      resourceUrl: MERCHANT_URL,
      explorerUrl: '',
      accepted,
      paymentHeader: encodeBase64Json({ x402Version: 2, accepted, payload: {} }),
    }
    const completion = () =>
      new MerchantCompletion({
        post: (async () => ({})) as unknown as <T>(path: string, body: Record<string, unknown>) => Promise<T>,
        merchantTransport: new McpMerchantTransport(),
        getPaymentStatus: (async () => {
          throw new Error('not read')
        }) as never,
        getAgent: (async () => {
          throw new Error('not read')
        }) as never,
        delegateAddress: DELEGATE_ADDRESS,
        x402Wallet: undefined,
      })
    const delivered = () => vi.mocked(globalThis.fetch).mock.calls.at(-1) as unknown as [string, RequestInit]
    const ok = () =>
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      )

    it('a block that fits: the answer is attached', async () => {
      ok()
      await completion().retryRequest(MERCHANT_URL, { method: 'GET' }, challenge(), receipt, 'ANSWER')
      expect(new Headers(delivered()[1]?.headers).get(X_CHECKOUT_DETAILS_HEADER)).toBe('ANSWER')
    })

    it("a block the request's own headers push past 16 KB: the answer is dropped (never the payment header), and the drop is logged without a value", async () => {
      ok()
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
      await completion().retryRequest(
        MERCHANT_URL,
        { method: 'GET', headers: { 'x-big': 'b'.repeat(15500) } },
        challenge(),
        receipt,
        'A'.repeat(1400),
      )
      const headers = new Headers(delivered()[1]?.headers)
      expect(headers.has(X_CHECKOUT_DETAILS_HEADER)).toBe(false)
      expect(headers.has('payment-signature')).toBe(true)
      const logged = stderr.mock.calls.map((c) => String(c[0])).join('')
      expect(logged).toContain('outcome=dropped_over_budget')
      expect(logged).not.toContain('A'.repeat(50))
    })
  })

  it('a challenge with no compatible option keeps its own refusal: no read of the details and no checkout-details refusal', async () => {
    const erc7710Only = { ...challenge(ask({ receipt_email: { required: true } })), accepts: [{ ...accepted, extra: { assetTransferMethod: 'erc7710' } }] }
    const { calls } = wire('fetch', { [DETAILS_PATH]: { available: false, reason: 'disabled' } }, erc7710Only)
    const err = await pay('fetch', erc7710Only).catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(CheckoutDetailsUnavailableError)
    expect(havenCallsOf(calls).some((c) => c.url.includes('/checkout-details'))).toBe(false)
  })

  it('the hosted settle reads the merchant request back: getX402MerchantCallContext carries checkout_details_request verbatim, and omits it when absent', async () => {
    const request = { info: { version: 1, fields: { receipt_email: { required: true } } } }
    const base = { payment_id: 'pay_ctx', merchant_url: 'https://merchant.example/mcp', tool_name: 't', arguments: {} }
    const answers = [{ ...base, checkout_details_request: request }, base]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(answers.shift()), { status: 200 }))
    const client = newClient()
    expect((await client.getX402MerchantCallContext('pay_ctx')).checkoutDetailsRequest).toEqual(request)
    expect('checkoutDetailsRequest' in (await client.getX402MerchantCallContext('pay_ctx'))).toBe(false)
  })

  it('readCheckoutDetails: the keyless hosted read of the agent\'s own details, never throwing', async () => {
    const { calls } = wire('fetch', { [DETAILS_PATH]: STORED }, challenge())
    expect(await newClient().readCheckoutDetails()).toEqual({ available: true, values: STORED.checkout_details })
    expect(havenCallsOf(calls).some((c) => c.url.endsWith(DETAILS_PATH))).toBe(true)
  })

  it('completeX402MerchantCall (the hosted delivery): paidRequestHeaders ride ONLY the paid tools/call, never the MCP initialize or notifications/initialized', async () => {
    const seen: Array<{ method: string; headers: Headers }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.startsWith(HAVEN_BASE)) {
        if (url.endsWith('/machine-payments/pay_hs/status')) {
          return new Response(JSON.stringify({ ...resumeStatus['/machine-payments/pay_4872/status'], payment_id: 'pay_hs', status: 'submitted', phase: 'awaiting_merchant', tx_hash: null, resource_url: 'https://merchant.example/mcp' }), { status: 200 })
        }
        return new Response(JSON.stringify({}), { status: 200 })
      }
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { method?: string }) : {}
      seen.push({ method: body.method ?? '?', headers: new Headers(init?.headers) })
      if (body.method === 'initialize') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), { status: 200, headers: { 'Content-Type': 'application/json', 'mcp-session-id': 'sess-1' } })
      }
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [] } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    await newClient()
      .completeX402MerchantCall({
        url: 'https://merchant.example/mcp',
        init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 't', arguments: {} } }) },
        paymentId: 'pay_hs',
        paymentHeader: 'eyJ4IjoxfQ==',
        mcpTransport: { handshakeRequired: true, source: 'path' },
        noFundingLeg: true,
        paidRequestHeaders: { [X_CHECKOUT_DETAILS_HEADER]: 'ANSWER' },
      })
      .catch(() => undefined)
    const byMethod = (m: string) => seen.filter((r) => r.method === m)
    expect(byMethod('initialize').length).toBeGreaterThan(0)
    for (const r of [...byMethod('initialize'), ...byMethod('notifications/initialized')]) {
      expect(r.headers.has(X_CHECKOUT_DETAILS_HEADER), r.method).toBe(false)
    }
    expect(byMethod('tools/call').at(-1)?.headers.get(X_CHECKOUT_DETAILS_HEADER)).toBe('ANSWER')
  })
})

