/**
 * #4872 part 2b: checkout details on the HOSTED plain-HTTP path
 * (`docs/architecture/13-checkout-details.md` §4–§6), through the real
 * handlers and the real keyless `HavenClient` over the shared fetch stub.
 *
 * - **Pay tool.** `haven_pay_x402_quote` refuses a required field the agent
 *   cannot share before any intent: no `POST /x402`, no settlement child.
 * - **State-direct submit.** `haven_submit` reads the merchant's request back
 *   from the stored challenge (`GET /x402/:id/payment-required`) and decides
 *   BEFORE it spends: before the funding relay on EIP-3009, before the
 *   settlement child is submitted on erc7710 (and the real block right after).
 *   The agent sends this paid request itself, so the answer rides the result's
 *   retry headers, and nowhere else in it.
 * - **Never logged.** No value reaches console/stdout/stderr.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HavenClient, X402Erc7710AlreadySettledError, X_CHECKOUT_DETAILS_HEADER, x402RetryHeadersFor } from '@haven_ai/sdk'
import { createToolHandlers } from '../tools.js'
import {
  AGENT_RESPONSE,
  PAYMENT_REQUIRED,
  X402_INTENT_RESPONSE,
  clearCalls,
  fail,
  ok,
  recordedCalls,
  stubFetch,
  x402PreflightStatus,
} from '../test-support/hosted-mcp.js'

const DETAILS_PATH = `GET /agents/${AGENT_RESPONSE.id}/checkout-details`
const EMAIL = 'plain.secret@example.se'
const ADDRESS = { line1: 'Gömda gatan 4', city: 'Lund', country: 'SE' }
const STORED = { available: true, checkout_details: { receipt_email: EMAIL, billing_address: ADDRESS } }
const SHARING_OFF = { available: false, reason: 'disabled' }
const VALUE_MARKERS = [EMAIL, 'Gömda gatan']
const SIG = '0x' + '11'.repeat(65)

const ask = (fields: Record<string, { required: boolean }>) => ({ info: { version: 1, fields } })
const challenge = (request?: unknown) => ({
  ...PAYMENT_REQUIRED,
  ...(request ? { extensions: { 'haven-checkout-details': request } } : {}),
})
const REQUIRED_EMAIL = ask({ receipt_email: { required: true } })

const path = (c: { url: string }) => new URL(c.url).pathname
const intentCalls = () => recordedCalls().filter((c) => c.method === 'POST' && path(c) === '/x402')
const detailReads = () => recordedCalls().filter((c) => path(c).endsWith('/checkout-details'))
const challengeReads = () => recordedCalls().filter((c) => path(c) === '/x402/pay_x402/payment-required')
const fundingRelays = () => recordedCalls().filter((c) => path(c) === '/payments/pay_x402/sign')
const decode = (header: string) => JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as Record<string, unknown>

function captureLogs() {
  const spies = [
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true),
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true),
    vi.spyOn(console, 'log').mockImplementation(() => {}),
    vi.spyOn(console, 'info').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'error').mockImplementation(() => {}),
  ]
  return () => spies.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(' '))).join('\n')
}

beforeEach(() => {
  clearCalls()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('#4872 hosted plain HTTP: haven_pay_x402_quote refuses before any intent', () => {
  const PAY = (request?: unknown) => ({ payment_required: challenge(request), url: PAYMENT_REQUIRED.resource.url, max_amount_human: '2' })
  const payStubs = (details?: unknown) => ({
    'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
    ...(details !== undefined ? { [DETAILS_PATH]: { status: 200, body: details } } : {}),
    'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
  })
  const client = () => createToolHandlers(new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' }))

  it('a required field with sharing off: CHECKOUT_DETAILS_UNAVAILABLE, and no POST /x402', async () => {
    stubFetch(payStubs(SHARING_OFF))
    const out = fail(await client().haven_pay_x402_quote(PAY(REQUIRED_EMAIL)))
    expect(out).toMatchObject({
      code: 'CHECKOUT_DETAILS_UNAVAILABLE',
      statusCode: 409,
      missing_fields: ['receipt_email'],
      reason: 'not_shared',
      phase: 'not_started',
      next_action: 'stop_and_tell_user',
    })
    expect(out.message).toContain('No payment was created')
    expect(intentCalls()).toEqual([])
  })

  it('a required field never saved: refused as not_stored, no POST /x402', async () => {
    stubFetch(payStubs({ available: false, reason: 'no_details' }))
    const out = fail(await client().haven_pay_x402_quote(PAY(ask({ billing_address: { required: true } }))))
    expect(out).toMatchObject({ code: 'CHECKOUT_DETAILS_UNAVAILABLE', missing_fields: ['billing_address'], reason: 'not_stored' })
    expect(intentCalls()).toEqual([])
  })

  it('a challenge that asks for nothing: no read of the details, the intent is created as today', async () => {
    stubFetch(payStubs())
    ok(await client().haven_pay_x402_quote(PAY()))
    expect(detailReads()).toEqual([])
    expect(intentCalls()).toHaveLength(1)
  })

  it('an optional field with sharing off: proceeds, the intent is created', async () => {
    stubFetch(payStubs(SHARING_OFF))
    ok(await client().haven_pay_x402_quote(PAY(ask({ receipt_email: { required: false } }))))
    expect(intentCalls()).toHaveLength(1)
  })

  it('a required field the agent can share: no refusal, and the pay tool never carries the values', async () => {
    stubFetch(payStubs(STORED))
    const result = ok(await client().haven_pay_x402_quote(PAY(REQUIRED_EMAIL)))
    expect(intentCalls()).toHaveLength(1)
    for (const marker of VALUE_MARKERS) expect(JSON.stringify(result)).not.toContain(marker)
  })

  it('with an idempotency_key, the refusal says THIS call created nothing', async () => {
    stubFetch(payStubs(SHARING_OFF))
    const out = fail(await client().haven_pay_x402_quote({ ...PAY(REQUIRED_EMAIL), idempotency_key: 'k-1' }))
    expect(out.code).toBe('CHECKOUT_DETAILS_UNAVAILABLE')
    expect(out.message).not.toContain('No payment was created')
    expect(intentCalls()).toEqual([])
  })
})

describe('#4872 hosted plain HTTP: haven_submit decides before it spends', () => {
  function submitHaven(
    request: unknown,
    details: unknown,
    opts: {
      stored?: { status: number; body: unknown }
      status?: Record<string, unknown> | 'unreadable'
      relay?: { status: number; body: unknown }
      flow?: 'plain_http' | 'mcp_tool'
    } = {},
  ) {
    stubFetch({
      'GET /x402/pay_x402/payment-required':
        opts.stored ?? { status: 200, body: { payment_id: 'pay_x402', payment_required: challenge(request) } },
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      [DETAILS_PATH]: { status: 200, body: details },
      ...(opts.status === 'unreadable'
        ? { 'GET /machine-payments/pay_x402/status': { status: 500, body: { error: 'boom' } } }
        : opts.status
          ? { 'GET /machine-payments/pay_x402/status': { status: 200, body: x402PreflightStatus(opts.status) } }
          : {}),
      'POST /payments/pay_x402/sign': opts.relay ?? { status: 200, body: { status: 'confirmed', tx_hash: '0xfund' } },
      'GET /x402/pay_x402/merchant-call-context':
        opts.flow === 'mcp_tool'
          ? { status: 200, body: { payment_id: 'pay_x402', merchant_url: 'https://merchant.test/mcp', tool_name: 't', arguments: {} } }
          : { status: 409, body: { error: 'No stored merchant call context', error_code: 'merchant_call_context_unavailable' } },
    })
    return new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
  }

  describe('erc7710 (the agent sends the paid request with retry_headers)', () => {
    const HEADER = 'eyJ4IjoxfQ=='
    function erc7710(request: unknown, details: unknown, header = HEADER, opts: Parameters<typeof submitHaven>[2] = {}) {
      const haven = submitHaven(request, details, opts)
      const submit = vi.spyOn(haven, 'submitX402Erc7710').mockResolvedValue(header as never)
      return { haven, submit }
    }
    const SUBMIT = { payment_id: 'pay_x402', signature: SIG, settlement_scheme: 'erc7710' }

    it('only the fields asked for ride retry_headers beside PAYMENT-SIGNATURE; no value reaches the logs or anywhere else in the result', async () => {
      const logs = captureLogs()
      const { haven, submit } = erc7710(REQUIRED_EMAIL, STORED)
      const result = ok<Record<string, any>>(await createToolHandlers(haven).haven_submit(SUBMIT))
      expect(submit).toHaveBeenCalledTimes(1)
      const headers = result.data.retry_headers as Record<string, string>
      expect(Object.keys(headers).sort()).toEqual([...Object.keys(x402RetryHeadersFor(HEADER)), X_CHECKOUT_DETAILS_HEADER].sort())
      expect(decode(headers[X_CHECKOUT_DETAILS_HEADER])).toEqual({ version: 1, receipt_email: EMAIL })
      expect(result.data.reason ?? JSON.stringify(result.data)).toContain('X-Checkout-Details')
      // The answer is in retry_headers ONLY: the result without it carries no value.
      const { retry_headers: _omit, ...rest } = result.data
      for (const marker of VALUE_MARKERS) {
        expect(JSON.stringify(rest)).not.toContain(marker)
        expect(JSON.stringify(rest)).not.toContain(headers[X_CHECKOUT_DETAILS_HEADER])
        expect(logs()).not.toContain(marker)
      }
      expect(logs()).not.toContain(headers[X_CHECKOUT_DETAILS_HEADER])
      expect(detailReads()).toHaveLength(1)
    })

    it('a challenge that asks for nothing: retry_headers are exactly today\'s, and the details are not read', async () => {
      const { haven } = erc7710(undefined, STORED)
      const result = ok<Record<string, any>>(await createToolHandlers(haven).haven_submit(SUBMIT))
      expect(result.data.retry_headers).toEqual(x402RetryHeadersFor(HEADER))
      expect(detailReads()).toEqual([])
    })

    it('a required field with sharing off, still pending: refused BEFORE the settlement child is submitted', async () => {
      const { haven, submit } = erc7710(REQUIRED_EMAIL, SHARING_OFF, HEADER, { status: { status: 'pending_signature' } })
      const out = fail(await createToolHandlers(haven).haven_submit(SUBMIT))
      expect(out).toMatchObject({ code: 'CHECKOUT_DETAILS_UNAVAILABLE', reason: 'not_shared', phase: 'not_started', paymentId: 'pay_x402' })
      expect(out.message).toContain('Nothing was funded, submitted or sent for this payment')
      expect(submit).not.toHaveBeenCalled()
    })

    it('a real header too large for the answer: unsent — no payment_header is handed back, and the step says start a new purchase', async () => {
      const { haven } = erc7710(REQUIRED_EMAIL, STORED, 'h'.repeat(16000))
      const out = fail(await createToolHandlers(haven).haven_submit(SUBMIT))
      expect(out).toMatchObject({ code: 'CHECKOUT_DETAILS_UNAVAILABLE', reason: 'over_budget', phase: 'not_delivered' })
      expect(JSON.stringify(out)).not.toContain('h'.repeat(64))
      expect(out.next_tool_omitted_reason).toContain('start a new purchase')
      // This path's own pay tool and leg, not only the MCP-merchant flow's.
      expect(out.next_tool_omitted_reason).toContain('haven_pay_x402_quote')
      expect(out.next_tool_omitted_reason).toContain('do not settle or submit this payment again')
    })

    it('a REPEATED submit of a payment that already settled, sharing now off: the settled replay, never "nothing moved"', async () => {
      const { haven, submit } = erc7710(REQUIRED_EMAIL, SHARING_OFF, HEADER, {
        status: { status: 'confirmed', phase: 'settled', next_action: 'none', tx_hash: '0x' + 'ab'.repeat(32) },
      })
      submit.mockRejectedValue(new X402Erc7710AlreadySettledError('pay_x402', '0x' + 'ab'.repeat(32)))
      const result = ok<Record<string, any>>(await createToolHandlers(haven).haven_submit(SUBMIT))
      expect(result.data).toMatchObject({ idempotent_replay: true, settlement_scheme: 'erc7710' })
      expect(JSON.stringify(result)).not.toContain('CHECKOUT_DETAILS_UNAVAILABLE')
    })

    it('an unreadable payment state: still refused with nothing submitted, but never "nothing moved" (state_unknown)', async () => {
      const { haven, submit } = erc7710(REQUIRED_EMAIL, SHARING_OFF, HEADER, { status: 'unreadable' })
      const out = fail(await createToolHandlers(haven).haven_submit(SUBMIT))
      expect(out).toMatchObject({ code: 'CHECKOUT_DETAILS_UNAVAILABLE', phase: 'unknown' })
      expect(out.message).not.toContain('Nothing was funded')
      expect(out.next_tool_omitted_reason).toContain('haven_submit')
      expect(submit).not.toHaveBeenCalled()
    })

    it('the stored challenge cannot be read: the submit proceeds as today, with no answer and no details read', async () => {
      const { haven, submit } = erc7710(REQUIRED_EMAIL, STORED, HEADER, { stored: { status: 500, body: { error: 'boom' } } })
      const result = ok<Record<string, any>>(await createToolHandlers(haven).haven_submit(SUBMIT))
      expect(submit).toHaveBeenCalledTimes(1)
      expect(result.data.retry_headers).toEqual(x402RetryHeadersFor(HEADER))
      expect(detailReads()).toEqual([])
    })
  })

  describe('EIP-3009 (the signer builds the payment header; Haven relays the funding)', () => {
    const SUBMIT = { payment_id: 'pay_x402', signature: SIG }

    it('plain HTTP, sharing on: decided before the relay, and the answer rides additional_retry_headers only', async () => {
      const logs = captureLogs()
      const haven = submitHaven(REQUIRED_EMAIL, STORED)
      const result = ok<Record<string, any>>(await createToolHandlers(haven).haven_submit(SUBMIT))
      expect(fundingRelays()).toHaveLength(1)
      // The read happens before the relay.
      const order = recordedCalls().map(path)
      expect(order.indexOf(`/agents/${AGENT_RESPONSE.id}/checkout-details`)).toBeLessThan(order.indexOf('/payments/pay_x402/sign'))
      const extra = result.data.additional_retry_headers as Record<string, string>
      expect(Object.keys(extra)).toEqual([X_CHECKOUT_DETAILS_HEADER])
      expect(decode(extra[X_CHECKOUT_DETAILS_HEADER])).toEqual({ version: 1, receipt_email: EMAIL })
      expect(String(result.data.reason)).toContain('additional_retry_headers')
      const { additional_retry_headers: _omit, ...rest } = result.data
      for (const marker of VALUE_MARKERS) {
        expect(JSON.stringify(rest)).not.toContain(marker)
        expect(logs()).not.toContain(marker)
      }
      expect(logs()).not.toContain(extra[X_CHECKOUT_DETAILS_HEADER])
    })

    it('a required field with sharing off, still pending: refused BEFORE the funding relay — nothing funded', async () => {
      const haven = submitHaven(REQUIRED_EMAIL, SHARING_OFF, { status: { status: 'pending_signature' } })
      const out = fail(await createToolHandlers(haven).haven_submit(SUBMIT))
      expect(out).toMatchObject({ code: 'CHECKOUT_DETAILS_UNAVAILABLE', reason: 'not_shared', phase: 'not_started', paymentId: 'pay_x402' })
      expect(fundingRelays()).toEqual([])
    })

    it('the decomposed MCP-tool flow: the relay is still decided first, but the answer is never in this result (haven_complete_mcp_tool sends it)', async () => {
      const haven = submitHaven(REQUIRED_EMAIL, STORED, { flow: 'mcp_tool', status: { status: 'confirmed', phase: 'funded', tx_hash: '0xfund' } })
      const result = ok<Record<string, any>>(await createToolHandlers(haven).haven_submit(SUBMIT))
      expect(result.data.additional_retry_headers).toBeUndefined()
      for (const marker of VALUE_MARKERS) expect(JSON.stringify(result)).not.toContain(marker)
      expect(String(result.data.next_tool)).toContain('haven_complete_mcp_tool')
    })

    it('a direct payment (no stored challenge: a 409): nothing is read and the result is today\'s', async () => {
      const haven = submitHaven(undefined, STORED, {
        stored: { status: 409, body: { error: 'Not an x402 intent', error_code: 'payment_required_unavailable' } },
      })
      const result = ok<Record<string, any>>(await createToolHandlers(haven).haven_submit(SUBMIT))
      expect(detailReads()).toEqual([])
      expect(result.data.additional_retry_headers).toBeUndefined()
      expect(fundingRelays()).toHaveLength(1)
    })

    it('a REPEATED submit of a confirmed intent, sharing now off: the relay answers (409), never the checkout refusal', async () => {
      const haven = submitHaven(REQUIRED_EMAIL, SHARING_OFF, {
        status: { status: 'confirmed', phase: 'funded', tx_hash: '0xfund' },
        relay: { status: 409, body: { error: 'Payment is not awaiting a signature', code: 'INVALID_STATE', status: 'confirmed' } },
      })
      const out = fail(await createToolHandlers(haven).haven_submit(SUBMIT))
      expect(fundingRelays()).toHaveLength(1)
      expect(out.code).not.toBe('CHECKOUT_DETAILS_UNAVAILABLE')
      expect(String(out.message)).not.toContain('Nothing was funded')
    })

    it('an answer over the estimated block with a required field: refused before the relay', async () => {
      // A merchant challenge large enough that the estimated PAYMENT-SIGNATURE line leaves no room.
      const huge = { ...REQUIRED_EMAIL, padding: 'x'.repeat(14000) }
      const haven = submitHaven(huge, STORED, { status: { status: 'pending_signature' } })
      const out = fail(await createToolHandlers(haven).haven_submit(SUBMIT))
      expect(out).toMatchObject({ code: 'CHECKOUT_DETAILS_UNAVAILABLE', reason: 'over_budget', phase: 'not_started' })
      expect(fundingRelays()).toEqual([])
    })
  })
})
