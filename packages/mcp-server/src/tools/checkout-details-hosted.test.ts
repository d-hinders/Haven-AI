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
import { HavenClient, X402Erc7710AlreadySettledError, X_CHECKOUT_DETAILS_HEADER } from '@haven_ai/sdk'
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
  x402PreflightStatus,
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
          resource_url: 'http://merchant.test/mcp', rail: 'x402', protocol: 'mcp', tool_name: 'create_text',
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

describe('#4872 hosted: the pay tools, more cases', () => {
  it('with an idempotency_key, the refusal says THIS call created nothing and points at an earlier payment', async () => {
    stubFetch({
      'POST /mcp': { status: 402, responseHeaders: { 'PAYMENT-REQUIRED': challengeHeader(ask({ receipt_email: { required: true } })) } },
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      [DETAILS_PATH]: { status: 200, body: { available: false, reason: 'disabled' } },
      'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
    })
    const out = fail(await handlers().haven_pay_mcp_tool({ ...PAY, idempotency_key: 'retry-4872' }))
    expect(out.code).toBe('CHECKOUT_DETAILS_UNAVAILABLE')
    expect(out.message).toContain('This call created no payment')
    expect(out.message).toContain('earlier call with the same idempotency key')
  })

  it('a required request in a challenge too large to store (over 64 KB) is refused at pay time: settle could never answer it', async () => {
    // Large through extra `accepts` entries, which are NOT echoed into the
    // payment header: the header-block check alone would let this through.
    const filler = Array.from({ length: 300 }, (_, i) => ({ ...PAYMENT_REQUIRED.accepts[0], network: `eip155:${900000 + i}`, extra: { note: 'n'.repeat(200) } }))
    const big = { ...PAYMENT_REQUIRED, accepts: [...PAYMENT_REQUIRED.accepts, ...filler], extensions: { 'haven-checkout-details': ask({ receipt_email: { required: true } }) } }
    expect(JSON.stringify(big).length).toBeGreaterThan(65536)
    stubFetch({
      'POST /mcp': { status: 402, responseHeaders: { 'PAYMENT-REQUIRED': btoa(JSON.stringify(big)) } },
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      [DETAILS_PATH]: { status: 200, body: STORED },
      'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
    })
    const out = fail(await handlers().haven_pay_mcp_tool(PAY))
    expect(out).toMatchObject({ code: 'CHECKOUT_DETAILS_UNAVAILABLE', missing_fields: ['receipt_email'], reason: 'over_budget' })
    expect(intentCalls()).toEqual([])
  })
})

describe('#4872 hosted: the answer at settle', () => {
  const SIG = '0x' + '11'.repeat(65)
  const STORED_URL = 'http://merchant.test/mcp'

  function settleHaven(
    request: unknown,
    details: unknown,
    opts: { storedUrl?: string; status?: Record<string, unknown> | 'unreadable'; relay?: { status: number; body: unknown } } = {},
  ) {
    stubFetch({
      ...(opts.status === 'unreadable'
        ? { 'GET /machine-payments/pay_x402/status': { status: 500, body: { error: 'boom' } } }
        : opts.status
          ? { 'GET /machine-payments/pay_x402/status': { status: 200, body: x402PreflightStatus(opts.status) } }
          : {}),
      'POST /payments/pay_x402/sign': opts.relay ?? { status: 200, body: { status: 'confirmed', tx_hash: '0xfund' } },
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      [DETAILS_PATH]: { status: 200, body: details },
    })
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    vi.spyOn(haven, 'getX402MerchantCallContext').mockResolvedValue({
      paymentId: 'pay_x402',
      merchantUrl: opts.storedUrl ?? STORED_URL,
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
    const call = complete.mock.calls[0][0]
    // Never on the handshake init — only on the paid request's own headers.
    expect(new Headers(call.init?.headers).has(X_CHECKOUT_DETAILS_HEADER)).toBe(false)
    const header = call.paidRequestHeaders?.[X_CHECKOUT_DETAILS_HEADER]
    return header ? (JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as Record<string, unknown>) : undefined
  }
  const fundingRelays = () => recordedCalls().filter((c) => new URL(c.url).pathname === '/payments/pay_x402/sign')
  const captureLogs = () => {
    const spies = [
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true),
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true),
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
    ]
    return () => spies.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(' '))).join('\n')
  }

  it('haven_settle_mcp_tool: only the fields asked for ride the paid request, and no value reaches the result or the logs', async () => {
    const logs = captureLogs()
    const { haven, complete } = settleHaven(ask({ receipt_email: { required: true } }), STORED)
    const result = await createToolHandlers(haven).haven_settle_mcp_tool({ payment_id: 'pay_x402', signature: SIG, payment_header: VALID_PAYMENT_HEADER_REF.v1 })
    expect(result.success).toBe(true)
    expect(sentAnswer(complete)).toEqual({ version: 1, receipt_email: EMAIL })
    // Decided ONCE, before the relay — not read again at delivery.
    expect(detailReads()).toHaveLength(1)
    for (const marker of VALUE_MARKERS) {
      expect(JSON.stringify(result)).not.toContain(marker)
      expect(logs()).not.toContain(marker)
    }
  })

  it('EIP-3009 settle: a required field that cannot be shared is refused BEFORE the funding relay — nothing funded, safe to call again', async () => {
    const logs = captureLogs()
    const { haven, complete } = settleHaven(ask({ receipt_email: { required: true } }), { available: false, reason: 'disabled' })
    const result = fail(await createToolHandlers(haven).haven_settle_mcp_tool({ payment_id: 'pay_x402', signature: SIG, payment_header: VALID_PAYMENT_HEADER_REF.v1 }))
    expect(result).toMatchObject({ code: 'CHECKOUT_DETAILS_UNAVAILABLE', missing_fields: ['receipt_email'], reason: 'not_shared', phase: 'not_started', paymentId: 'pay_x402' })
    // The intent exists: the settle-leg wording, not the pay tools'.
    expect(result.message).toContain('Nothing was funded, submitted or sent for this payment')
    expect(result.message).not.toContain('No payment was created')
    expect(fundingRelays()).toEqual([])
    expect(complete).not.toHaveBeenCalled()
    for (const marker of VALUE_MARKERS) expect(logs()).not.toContain(marker)
  })

  it('EIP-3009 repeated settle of a confirmed intent, sharing now off: the relay answers (409), never "Nothing was funded"', async () => {
    const { haven, complete } = settleHaven(ask({ receipt_email: { required: true } }), { available: false, reason: 'disabled' }, {
      status: { status: 'confirmed', phase: 'settled', next_action: 'none', tx_hash: '0xfund' },
      relay: { status: 409, body: { error: 'Payment is not awaiting a signature', code: 'INVALID_STATE', status: 'confirmed' } },
    })
    const result = fail(await createToolHandlers(haven).haven_settle_mcp_tool({ payment_id: 'pay_x402', signature: SIG, payment_header: VALID_PAYMENT_HEADER_REF.v1 }))
    expect(fundingRelays()).toHaveLength(1)
    expect(result.code).not.toBe('CHECKOUT_DETAILS_UNAVAILABLE')
    expect(String(result.message)).not.toContain('Nothing was funded')
    expect(complete).not.toHaveBeenCalled()
  })

  it('after a skipped pre-spend check, a delivery that is reached decides the details itself as funded (defence in depth)', async () => {
    const { haven, complete } = settleHaven(ask({ receipt_email: { required: true } }), { available: false, reason: 'disabled' }, {
      status: { status: 'confirmed', phase: 'funded', tx_hash: '0xfund' },
    })
    const result = fail(await createToolHandlers(haven).haven_settle_mcp_tool({ payment_id: 'pay_x402', signature: SIG, payment_header: VALID_PAYMENT_HEADER_REF.v1 }))
    expect(result).toMatchObject({ code: 'CHECKOUT_DETAILS_UNAVAILABLE', phase: 'funded_but_unsettled' })
    expect(result.message).toContain('funded but was not delivered')
    expect(complete).not.toHaveBeenCalled()
  })

  it('the payment state cannot be read: still refused with nothing spent, but never "nothing moved" — check the status first', async () => {
    const { haven, complete } = settleHaven(ask({ receipt_email: { required: true } }), { available: false, reason: 'disabled' }, { status: 'unreadable' })
    const result = fail(await createToolHandlers(haven).haven_settle_mcp_tool({ payment_id: 'pay_x402', signature: SIG, payment_header: VALID_PAYMENT_HEADER_REF.v1 }))
    expect(result).toMatchObject({ code: 'CHECKOUT_DETAILS_UNAVAILABLE', phase: 'unknown', paymentId: 'pay_x402' })
    expect(result.message).toContain("could not read this payment's state")
    expect(result.message).not.toContain('Nothing was funded')
    expect(result.message).not.toContain('No payment was created')
    expect(result.next_tool_omitted_reason).toContain('haven_get_payment_status')
    expect(fundingRelays()).toEqual([])
    expect(complete).not.toHaveBeenCalled()
  })

  it('haven_complete_mcp_tool (already funded): the same answer on the complete leg', async () => {
    const { haven, complete } = settleHaven(ask({ billing_address: { required: false } }), STORED)
    ok(await createToolHandlers(haven).haven_complete_mcp_tool({ payment_id: 'pay_x402', payment_header: 'eyJ4IjoxfQ==' }))
    expect(sentAnswer(complete)).toEqual({ version: 1, billing_address: ADDRESS })
    // Decided AFTER the funding wait: the payment is known funded first.
    const order = recordedCalls().map((c) => new URL(c.url).pathname)
    expect(order.indexOf('/agents/agt_1/checkout-details')).toBeGreaterThan(order.indexOf('/machine-payments/pay_x402/status'))
  })

  it('haven_complete_mcp_tool, required field no longer shareable: funded-not-delivered, and the step names complete or verify-then-sweep, never settle', async () => {
    const { haven, complete } = settleHaven(ask({ receipt_email: { required: true } }), { available: false, reason: 'disabled' })
    const result = fail(await createToolHandlers(haven).haven_complete_mcp_tool({ payment_id: 'pay_x402', payment_header: 'eyJ4IjoxfQ==' }))
    expect(result).toMatchObject({ code: 'CHECKOUT_DETAILS_UNAVAILABLE', phase: 'funded_but_unsettled', paymentId: 'pay_x402' })
    expect(result.message).toContain('funded but was not delivered')
    expect(result.next_tool_omitted_reason).toContain('haven_complete_mcp_tool')
    expect(result.next_tool_omitted_reason).toContain('haven_sweep_delegate')
    expect(result.next_tool_omitted_reason).not.toContain('haven_settle_mcp_tool')
    expect(complete).not.toHaveBeenCalled()
  })

  it('a stored challenge that asked for nothing: no read, no header — the paid request is today’s', async () => {
    const { haven, complete } = settleHaven(undefined, STORED)
    ok(await createToolHandlers(haven).haven_complete_mcp_tool({ payment_id: 'pay_x402', payment_header: 'eyJ4IjoxfQ==' }))
    expect(sentAnswer(complete)).toBeUndefined()
    expect(complete.mock.calls[0][0].paidRequestHeaders).toBeUndefined()
    expect(detailReads()).toEqual([])
    expect(complete.mock.calls[0][0].init?.headers).toEqual({ 'Content-Type': 'application/json' })
  })

  it('the documented flow (explicit context, matching the stored URL) still answers — the stored request is read', async () => {
    const { haven, complete } = settleHaven(ask({ receipt_email: { required: true } }), STORED)
    ok(
      await createToolHandlers(haven).haven_settle_mcp_tool({
        payment_id: 'pay_x402',
        signature: SIG,
        payment_header: VALID_PAYMENT_HEADER_REF.v1,
        merchant_url: STORED_URL,
        tool_name: 'buy_cloud_storage',
      }),
    )
    expect(sentAnswer(complete)).toEqual({ version: 1, receipt_email: EMAIL })
  })

  it('an explicit merchant_url that is not the one quoted never receives the owner’s details: a required field refuses before funding', async () => {
    const { haven, complete } = settleHaven(ask({ receipt_email: { required: true } }), STORED, { storedUrl: 'http://merchant.test/other' })
    const result = fail(
      await createToolHandlers(haven).haven_settle_mcp_tool({
        payment_id: 'pay_x402',
        signature: SIG,
        payment_header: VALID_PAYMENT_HEADER_REF.v1,
        merchant_url: STORED_URL,
        tool_name: 'buy_cloud_storage',
      }),
    )
    expect(result).toMatchObject({ code: 'CHECKOUT_DETAILS_UNAVAILABLE', reason: 'merchant_mismatch', phase: 'not_started' })
    expect(fundingRelays()).toEqual([])
    expect(detailReads()).toEqual([])
    expect(complete).not.toHaveBeenCalled()
  })

  describe('erc7710 settle', () => {
    function erc7710Haven(request: unknown, details: unknown, header: string, opts: { status?: Record<string, unknown> } = {}) {
      const { haven, complete } = settleHaven(request, details, opts)
      const submit = vi.spyOn(haven, 'submitX402Erc7710').mockResolvedValue(header as never)
      return { haven, complete, submit }
    }

    it('availability is decided BEFORE the settlement child is submitted: sharing off refuses with nothing submitted', async () => {
      const { haven, complete, submit } = erc7710Haven(ask({ receipt_email: { required: true } }), { available: false, reason: 'disabled' }, 'eyJ4IjoxfQ==')
      const result = fail(await createToolHandlers(haven).haven_settle_mcp_tool({ payment_id: 'pay_x402', signature: SIG }))
      expect(result).toMatchObject({ code: 'CHECKOUT_DETAILS_UNAVAILABLE', phase: 'not_started' })
      expect(submit).not.toHaveBeenCalled()
      expect(complete).not.toHaveBeenCalled()
    })

    it('the answer rides the paid request on erc7710 too', async () => {
      const { haven, complete, submit } = erc7710Haven(ask({ receipt_email: { required: true } }), STORED, 'eyJ4IjoxfQ==')
      await createToolHandlers(haven).haven_settle_mcp_tool({ payment_id: 'pay_x402', signature: SIG })
      expect(submit).toHaveBeenCalledTimes(1)
      expect(sentAnswer(complete)).toEqual({ version: 1, receipt_email: EMAIL })
    })

    it('a REPEATED settle of a payment that already settled, sharing now off: the settled replay, never "nothing moved"', async () => {
      const { haven, complete, submit } = erc7710Haven(ask({ receipt_email: { required: true } }), { available: false, reason: 'disabled' }, 'eyJ4IjoxfQ==', {
        status: { status: 'confirmed', phase: 'settled', next_action: 'none', tx_hash: '0x' + 'ab'.repeat(32) },
      })
      submit.mockRejectedValue(new X402Erc7710AlreadySettledError('pay_x402', '0x' + 'ab'.repeat(32)))
      const result = (await createToolHandlers(haven).haven_settle_mcp_tool({ payment_id: 'pay_x402', signature: SIG })) as { success: boolean; data: unknown }
      expect(result).toMatchObject({ success: true })
      expect(result.data).toMatchObject({ idempotent_replay: true, settlement_tx_hash: '0x' + 'ab'.repeat(32), settlement_scheme: 'erc7710' })
      expect(JSON.stringify(result)).not.toContain('CHECKOUT_DETAILS_UNAVAILABLE')
      expect(JSON.stringify(result)).not.toContain('Nothing was funded')
      expect(complete).not.toHaveBeenCalled()
    })

    it('the same refusal while the intent is still pending_signature stands: nothing submitted', async () => {
      const { haven, submit } = erc7710Haven(ask({ receipt_email: { required: true } }), { available: false, reason: 'disabled' }, 'eyJ4IjoxfQ==', {
        status: { status: 'pending_signature' },
      })
      const result = fail(await createToolHandlers(haven).haven_settle_mcp_tool({ payment_id: 'pay_x402', signature: SIG }))
      expect(result).toMatchObject({ code: 'CHECKOUT_DETAILS_UNAVAILABLE', phase: 'not_started' })
      expect(submit).not.toHaveBeenCalled()
    })

    it('a real header too large for the answer after submit: unsent — never sent to the merchant, and the step says start a new purchase', async () => {
      const { haven, complete } = erc7710Haven(ask({ receipt_email: { required: true } }), STORED, 'h'.repeat(16000))
      const result = fail(await createToolHandlers(haven).haven_settle_mcp_tool({ payment_id: 'pay_x402', signature: SIG }))
      expect(result).toMatchObject({ code: 'CHECKOUT_DETAILS_UNAVAILABLE', reason: 'over_budget', phase: 'not_delivered', paymentId: 'pay_x402' })
      expect(result.message).toContain('nothing was redeemed')
      expect(result.next_tool_omitted_reason).toContain('start a new purchase')
      expect(complete).not.toHaveBeenCalled()
    })
  })
})
