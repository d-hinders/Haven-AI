/**
 * #4872 part 2: checkout details on the HOSTED paid paths
 * (`docs/architecture/13-checkout-details.md` §4–§6), through the real
 * handlers and the real keyless `HavenClient` over the shared fetch stub:
 *
 * - **Before any intent.** `haven_pay_mcp_tool` and
 *   `haven_prepare_catalog_purchase` refuse a required field the agent cannot
 *   share with `CHECKOUT_DETAILS_UNAVAILABLE`. No `POST /x402` is made, so no
 *   funding intent and no settlement child exist. A challenge that asks for
 *   nothing reads nothing and is paid as today.
 * - **At settle.** The merchant's request comes back from merchant-call-context
 *   (the stored challenge), the agent's details are read again, and only the
 *   fields asked for ride the paid request the server sends as
 *   `X-Checkout-Details`. A required field that can no longer be shared
 *   refuses delivery before the merchant is contacted. An explicitly threaded
 *   context (no stored challenge) sends nothing and refuses nothing.
 * - **Never logged, never returned.** The values appear in no tool result and
 *   no console/stdout/stderr output.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { HavenClient, X_CHECKOUT_DETAILS_HEADER } from '@haven_ai/sdk'
import { createToolHandlers } from '../tools.js'
import {
  AGENT_RESPONSE,
  PAYMENT_REQUIRED,
  X402_INTENT_RESPONSE,
  VALID_PAYMENT_HEADER_REF,
  clearCalls,
  mintPaymentHeaders,
  fail,
  handlers,
  ok,
  recordedCalls,
  stubFetch,
} from '../test-support/hosted-mcp.js'

const DETAILS_PATH = `GET /agents/${AGENT_RESPONSE.id}/checkout-details`
const EMAIL = 'hosted.secret@example.se'
const ADDRESS = { line1: 'Dolda vägen 9', city: 'Uppsala', country: 'SE' }
const STORED = { available: true, checkout_details: { receipt_email: EMAIL, billing_address: ADDRESS } }
const VALUE_MARKERS = [EMAIL, 'Dolda vägen']

const ask = (fields: Record<string, { required: boolean }>) => ({ info: { version: 1, fields } })
const challengeHeader = (request?: unknown) =>
  btoa(JSON.stringify({ ...PAYMENT_REQUIRED, ...(request ? { extensions: { 'haven-checkout-details': request } } : {}) }))

const intentCalls = () => recordedCalls().filter((c) => c.method === 'POST' && new URL(c.url).pathname === '/x402')
const detailReads = () => recordedCalls().filter((c) => new URL(c.url).pathname.endsWith('/checkout-details'))

beforeAll(async () => {
  // Settle checks the header against the funded intent: the SDK's real signing path mints it.
  await mintPaymentHeaders()
})
beforeEach(() => {
  clearCalls()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const PAY = { merchant_url: 'http://merchant.test/mcp', tool_name: 'create_text', arguments: { prompt: 'Hello' }, max_amount: '2000000' }

describe('#4872 hosted: refused before any intent', () => {
  it('haven_pay_mcp_tool, required field with sharing off: CHECKOUT_DETAILS_UNAVAILABLE and no POST /x402', async () => {
    stubFetch({
      'POST /mcp': { status: 402, responseHeaders: { 'PAYMENT-REQUIRED': challengeHeader(ask({ receipt_email: { required: true } })) } },
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      [DETAILS_PATH]: { status: 200, body: { available: false, reason: 'disabled' } },
      'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
    })
    const out = fail(await handlers().haven_pay_mcp_tool(PAY))
    expect(out).toMatchObject({
      code: 'CHECKOUT_DETAILS_UNAVAILABLE',
      statusCode: 409,
      missing_fields: ['receipt_email'],
      reason: 'not_shared',
      next_action: 'stop_and_tell_user',
    })
    expect(typeof out.next_tool_omitted_reason).toBe('string')
    expect(out.message).toContain('No payment was created')
    expect(intentCalls()).toEqual([])
  })

  it('haven_pay_mcp_tool, a challenge that asks for nothing: no read of the details and the intent is created as today', async () => {
    stubFetch({
      'POST /mcp': { status: 402, responseHeaders: { 'PAYMENT-REQUIRED': challengeHeader() } },
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
    })
    ok(await handlers().haven_pay_mcp_tool(PAY))
    expect(detailReads()).toEqual([])
    expect(intentCalls()).toHaveLength(1)
  })

  it('haven_pay_mcp_tool, a required field the agent can share: no refusal, the intent is created', async () => {
    stubFetch({
      'POST /mcp': { status: 402, responseHeaders: { 'PAYMENT-REQUIRED': challengeHeader(ask({ receipt_email: { required: true } })) } },
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      [DETAILS_PATH]: { status: 200, body: STORED },
      'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
    })
    const result = ok(await handlers().haven_pay_mcp_tool(PAY))
    expect(intentCalls()).toHaveLength(1)
    // The pay tool never carries the values: they are read again at settle.
    for (const marker of VALUE_MARKERS) expect(JSON.stringify(result)).not.toContain(marker)
  })

  it('haven_prepare_catalog_purchase, required field never saved: refused as not_stored, no POST /x402', async () => {
    stubFetch({
      'GET /catalog/cat_1': {
        status: 200,
        body: {
          id: 'cat_1', name: 'create_text', description: 'Generate text', category: 'ai',
          resource_url: 'https://mcp.soundside.ai/mcp', rail: 'x402', protocol: 'mcp', tool_name: 'create_text',
          tool_arguments: { prompt: 'hello' }, price_display: '$1.50 USDC', price_atomic: '1500000',
          asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', network: 'eip155:8453', status: 'active',
          verified_at: '2026-06-16T08:50:39.772Z',
        },
      },
      'POST /mcp': { status: 402, responseHeaders: { 'PAYMENT-REQUIRED': challengeHeader(ask({ billing_address: { required: true } })) } },
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /machine-payments/budget-precheck': { status: 200, body: { sufficient: true, remaining_atomic: '5000000' } },
      [DETAILS_PATH]: { status: 200, body: { available: false, reason: 'no_details' } },
      'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
    })
    const out = fail(await handlers().haven_prepare_catalog_purchase({ catalog_id: 'cat_1', max_amount_human: '2' }))
    expect(out).toMatchObject({ code: 'CHECKOUT_DETAILS_UNAVAILABLE', missing_fields: ['billing_address'], reason: 'not_stored' })
    expect(intentCalls()).toEqual([])
  })
})

describe('#4872 hosted: the answer at settle', () => {
  const SIG = '0x' + '11'.repeat(65)

  function settleHaven(request: unknown, details: unknown) {
    stubFetch({
      'POST /payments/pay_x402/sign': { status: 200, body: { status: 'confirmed', tx_hash: '0xfund' } },
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      [DETAILS_PATH]: { status: 200, body: details },
    })
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    vi.spyOn(haven, 'getX402MerchantCallContext').mockResolvedValue({
      paymentId: 'pay_x402',
      merchantUrl: 'http://merchant.test/mcp',
      toolName: 'buy_cloud_storage',
      arguments: { tier: '50gb' },
      ...(request !== undefined ? { checkoutDetailsRequest: request } : {}),
    })
    const complete = vi.spyOn(haven, 'completeX402MerchantCall').mockResolvedValue({
      status: 200, ok: true, body: { result: 'ok' }, settlementTxHash: '0xsettle',
      settlementEvidenceOutcome: { outcome: 'confirmed' },
    })
    return { haven, complete }
  }
  const sentAnswer = (complete: ReturnType<typeof settleHaven>['complete']) => {
    const header = new Headers(complete.mock.calls[0][0].init?.headers).get(X_CHECKOUT_DETAILS_HEADER)
    return header ? (JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as Record<string, unknown>) : undefined
  }

  it('haven_settle_mcp_tool: only the fields asked for ride the paid request the server sends, and no value reaches the result or the logs', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { haven, complete } = settleHaven(ask({ receipt_email: { required: true } }), STORED)
    const result = await createToolHandlers(haven).haven_settle_mcp_tool({ payment_id: 'pay_x402', signature: SIG, payment_header: VALID_PAYMENT_HEADER_REF.v1 })
    expect(result.success).toBe(true)
    expect(sentAnswer(complete)).toEqual({ version: 1, receipt_email: EMAIL })
    const logged = [out, err, log, warn, error].flatMap((s) => s.mock.calls.map((c) => c.map(String).join(' '))).join('\n')
    for (const marker of VALUE_MARKERS) {
      expect(JSON.stringify(result)).not.toContain(marker)
      expect(logged).not.toContain(marker)
    }
  })

  it('haven_complete_mcp_tool: the same answer on the complete leg', async () => {
    const { haven, complete } = settleHaven(ask({ billing_address: { required: false } }), STORED)
    ok(await createToolHandlers(haven).haven_complete_mcp_tool({ payment_id: 'pay_x402', payment_header: 'eyJ4IjoxfQ==' }))
    expect(sentAnswer(complete)).toEqual({ version: 1, billing_address: ADDRESS })
  })

  it('a required field that can no longer be shared at settle: delivery refused before the merchant is contacted (funded wording on EIP-3009)', async () => {
    const { haven, complete } = settleHaven(ask({ receipt_email: { required: true } }), { available: false, reason: 'disabled' })
    const result = fail(await createToolHandlers(haven).haven_settle_mcp_tool({ payment_id: 'pay_x402', signature: SIG, payment_header: VALID_PAYMENT_HEADER_REF.v1 }))
    expect(result).toMatchObject({ code: 'CHECKOUT_DETAILS_UNAVAILABLE', missing_fields: ['receipt_email'], reason: 'not_shared' })
    expect(result.message).toContain('funded but was not delivered')
    expect(complete).not.toHaveBeenCalled()
  })

  it('a stored challenge that asked for nothing: no read, no header — the paid request is today’s', async () => {
    const { haven, complete } = settleHaven(undefined, STORED)
    ok(await createToolHandlers(haven).haven_complete_mcp_tool({ payment_id: 'pay_x402', payment_header: 'eyJ4IjoxfQ==' }))
    expect(sentAnswer(complete)).toBeUndefined()
    expect(detailReads()).toEqual([])
    expect(complete.mock.calls[0][0].init?.headers).toEqual({ 'Content-Type': 'application/json' })
  })

  it('an explicitly threaded context (no stored challenge) sends nothing and refuses nothing', async () => {
    const { haven, complete } = settleHaven(ask({ receipt_email: { required: true } }), { available: false, reason: 'disabled' })
    ok(
      await createToolHandlers(haven).haven_complete_mcp_tool({
        payment_id: 'pay_x402',
        merchant_url: 'http://merchant.test/mcp',
        tool_name: 'buy_cloud_storage',
        payment_header: 'eyJ4IjoxfQ==',
      }),
    )
    expect(sentAnswer(complete)).toBeUndefined()
    expect(detailReads()).toEqual([])
  })
})
