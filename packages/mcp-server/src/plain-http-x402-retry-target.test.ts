import { describe, expect, it, vi } from 'vitest'
import { HavenClient, HavenInsecureRetryTargetError } from '@haven_ai/sdk'
import { createToolHandlers } from './tools.js'
import {
  AGENT_RESPONSE,
  PAYMENT_REQUIRED,
  X402_INTENT_RESPONSE,
  fail,
  handlers,
  installSharedFixtureLifecycle,
  ok,
  recordedCalls,
  stubFetch,
} from './test-support/hosted-mcp.js'

/**
 * #3097 — the paid retry's target on the hosted surface. The hosted server
 * never retries the merchant itself; it tells the agent where to. So the
 * target is decided BEFORE any intent exists, the caller's quoted `url` wins
 * over the merchant's `resource.url`, and a public http:// target is refused.
 */
installSharedFixtureLifecycle()

/** A challenge that declares http:// for a public host — the Ampersend sandbox's shape. */
const HTTP_DECLARED = {
  ...PAYMENT_REQUIRED,
  resource: { url: 'http://merchant.com/paid', description: 'paid data' },
}

describe('haven_quote_x402 — request_url / retry_url / the disagreement flag', () => {
  it('returns the quoted URL as retry_url and flags a merchant that declares a different resource URL', async () => {
    stubFetch({
      'GET /paid': { status: 402, responseHeaders: { 'PAYMENT-REQUIRED': btoa(JSON.stringify(HTTP_DECLARED)) } },
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
    })
    const result = ok<Record<string, unknown>>(
      await handlers().haven_quote_x402({ url: 'https://merchant.test/paid' }),
    )
    expect(result.data.request_url).toBe('https://merchant.test/paid')
    expect(result.data.retry_url).toBe('https://merchant.test/paid')
    expect(result.data.resource_url).toBe('http://merchant.com/paid')
    expect(result.data.resource_url_differs_from_request).toBe(true)
  })

  it('does not flag a declaration that equals the quoted URL', async () => {
    stubFetch({
      'GET /paid': { status: 402, responseHeaders: { 'PAYMENT-REQUIRED': btoa(JSON.stringify(PAYMENT_REQUIRED)) } },
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
    })
    const result = ok<Record<string, unknown>>(
      await handlers().haven_quote_x402({ url: 'https://merchant.test/paid' }),
    )
    expect(result.data.resource_url_differs_from_request).toBe(false)
  })
})

describe('haven_pay_x402_quote — the retry target is decided before any intent', () => {
  it('refuses an http-declared challenge when the caller named no url — and creates nothing', async () => {
    stubFetch({
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
    })
    const result = fail(await handlers().haven_pay_x402_quote({ payment_required: HTTP_DECLARED }))
    expect(result.code).toBe('INSECURE_RETRY_TARGET')
    expect(result.next_action).toBe('retry_with_explicit_context')
    expect(result.message).toContain('http://merchant.com/paid')
    expect(result.message).toContain('request_url')
    expect(recordedCalls().find((c) => c.url.endsWith('/x402'))).toBeUndefined()
  })

  it('takes the caller\'s https url as retry_url over the merchant\'s http declaration', async () => {
    stubFetch({
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
    })
    const result = ok<Record<string, unknown>>(
      await handlers().haven_pay_x402_quote({
        payment_required: HTTP_DECLARED,
        url: 'https://merchant.test/paid',
        max_amount: '1500000',
      }),
    )
    expect(result.data.payment_id).toBe(X402_INTENT_RESPONSE.payment_id)
    expect(result.data.retry_url).toBe('https://merchant.test/paid')
    expect(result.data.resource_url_differs_from_request).toBe(true)
    // The intent still records the merchant's declared resource as its identity.
    const intentCall = recordedCalls().find((c) => c.url.endsWith('/x402'))
    expect(intentCall).toBeDefined()
    expect(intentCall!.body?.url).toBe('http://merchant.com/paid')
  })

  it('falls back to an https declaration when the caller named no url (unchanged behaviour)', async () => {
    stubFetch({
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
    })
    const result = ok<Record<string, unknown>>(
      await handlers().haven_pay_x402_quote({ payment_required: PAYMENT_REQUIRED, max_amount: '1500000' }),
    )
    expect(result.data.retry_url).toBe('https://merchant.test/paid')
    // Nothing was compared, so the flag is absent rather than a false "false".
    expect('resource_url_differs_from_request' in result.data).toBe(false)
  })

  it('refuses a public DNS name whose first label is 127 (the prefix-test bypass)', async () => {
    stubFetch({
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
    })
    const result = fail(
      await handlers().haven_pay_x402_quote({
        payment_required: { ...PAYMENT_REQUIRED, resource: { url: 'http://127.attacker.io/paid', description: 'paid data' } },
        max_amount: '1500000',
      }),
    )
    expect(result.code).toBe('INSECURE_RETRY_TARGET')
    expect(recordedCalls().find((c) => c.url.endsWith('/x402'))).toBeUndefined()
  })

  it('refuses a public http url even when the caller asks for it explicitly', async () => {
    stubFetch({
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
    })
    const result = fail(
      await handlers().haven_pay_x402_quote({ payment_required: PAYMENT_REQUIRED, url: 'http://merchant.com/paid' }),
    )
    expect(result.code).toBe('INSECURE_RETRY_TARGET')
    expect(recordedCalls().find((c) => c.url.endsWith('/x402'))).toBeUndefined()
  })
})

describe('haven_resume_x402_payment — the same rule on the resume path', () => {
  const funded = (paymentId: string) => ({
    [`GET /machine-payments/${paymentId}/status`]: {
      status: 200,
      body: {
        payment_id: paymentId,
        status: 'confirmed',
        next_action: 'retry_original_x402_request',
        tx_hash: '0xfunded',
        rail: 'x402',
      },
    },
  })
  const state = (paymentId: string, resourceUrl: string, url = resourceUrl) => ({
    rail: 'x402' as const,
    paymentId,
    idempotencyKey: 'x402:test',
    paymentRequired: { ...PAYMENT_REQUIRED, resource: { url: resourceUrl, description: 'paid data' } },
    accepted: PAYMENT_REQUIRED.accepts[0],
    url,
    resourceUrl,
    description: null,
    amountAtomic: '1500000',
    amount: '1.50',
    token: 'USDC',
    asset: PAYMENT_REQUIRED.accepts[0].asset,
    network: 'base',
    chainId: 8453,
    merchantAddress: PAYMENT_REQUIRED.accepts[0].payTo,
  })

  it('refuses to hand out a signing context whose only retry target is a public http URL', async () => {
    stubFetch(funded('pay_http'))
    const result = fail(
      await handlers().haven_resume_x402_payment({ resume_state: state('pay_http', 'http://merchant.com/paid') }),
    )
    expect(result.code).toBe('INSECURE_RETRY_TARGET')
    expect(result.next_action).toBe('retry_with_explicit_context')
  })

  it('takes the caller\'s https url as x402.retry_url over the http declaration', async () => {
    stubFetch(funded('pay_http'))
    const result = ok<{ x402: Record<string, unknown> }>(
      await handlers().haven_resume_x402_payment({
        resume_state: state('pay_http', 'http://merchant.com/paid'),
        url: 'https://merchant.test/paid',
      }),
    )
    expect(result.data.x402.retry_url).toBe('https://merchant.test/paid')
    expect(result.data.x402.resource_url).toBe('http://merchant.com/paid')
  })

  it('reads the https url the SDK builder stored in state.url when no request was captured', async () => {
    stubFetch(funded('pay_http'))
    const result = ok<{ x402: Record<string, unknown> }>(
      await handlers().haven_resume_x402_payment({
        resume_state: state('pay_http', 'http://merchant.com/paid', 'https://merchant.test/paid'),
      }),
    )
    expect(result.data.x402.retry_url).toBe('https://merchant.test/paid')
  })

  it('names the funded-but-unsettled exits when the only retry target is http', async () => {
    stubFetch(funded('pay_http'))
    const result = fail(
      await handlers().haven_resume_x402_payment({ resume_state: state('pay_http', 'http://merchant.com/paid') }),
    )
    expect(result.code).toBe('INSECURE_RETRY_TARGET')
    expect(result.paymentId).toBe('pay_http')
    expect(result.suggested_tool).toBe('haven_get_payment_status')
    expect(result.message).toContain('haven_sweep_delegate')
  })

  it('keeps an https resume byte-compatible apart from the added retry_url', async () => {
    stubFetch(funded('pay_ok'))
    const result = ok<{ x402: Record<string, unknown> }>(
      await handlers().haven_resume_x402_payment({ resume_state: state('pay_ok', 'https://merchant.test/paid') }),
    )
    expect(result.data.x402.retry_url).toBe('https://merchant.test/paid')
  })
})

describe('the MCP-merchant family — refused before the unpaid probe (#3097 review)', () => {
  it('haven_quote_mcp_tool refuses a public http merchant_url and never probes it', async () => {
    stubFetch({})
    const result = fail(
      await handlers().haven_quote_mcp_tool({ merchant_url: 'http://127.attacker.io/mcp', tool_name: 'facts', arguments: {} }),
    )
    expect(result.code).toBe('INSECURE_RETRY_TARGET')
    expect(recordedCalls().find((c) => c.url.includes('127.attacker.io'))).toBeUndefined()
  })

  it('haven_pay_mcp_tool refuses the same URL before any intent', async () => {
    stubFetch({ 'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE } })
    const result = fail(
      await handlers().haven_pay_mcp_tool({
        merchant_url: 'http://merchant.com/mcp',
        tool_name: 'facts',
        arguments: {},
        max_amount: '1500000',
      }),
    )
    expect(result.code).toBe('INSECURE_RETRY_TARGET')
    expect(recordedCalls().find((c) => c.url.endsWith('/x402'))).toBeUndefined()
  })
})

describe('haven_complete_mcp_tool — the post-funding escape is annotated (#3097 review)', () => {
  it('turns the SDK refusal into a funded_but_unsettled failure with payment_id and sweep guidance', async () => {
    stubFetch({})
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    vi.spyOn(haven, 'ensureFundingConfirmed').mockResolvedValue(undefined as never)
    vi.spyOn(haven, 'completeX402MerchantCall').mockRejectedValue(
      new HavenInsecureRetryTargetError('http://merchant.com/mcp'),
    )
    const result = fail(
      await createToolHandlers(haven).haven_complete_mcp_tool({
        payment_id: 'pay_x402',
        merchant_url: 'http://merchant.com/mcp',
        tool_name: 'facts',
        arguments: {},
        payment_header: 'eyJwYXltZW50IjoiaGVhZGVyIn0=',
      }),
    )
    expect(result.code).toBe('INSECURE_RETRY_TARGET')
    expect(result.paymentId).toBe('pay_x402')
    expect(result.phase).toBe('funded_but_unsettled')
    expect(result.next_action).toBe('sweep_stranded_funds')
    expect(result.suggested_tool).toBe('haven_get_payment_status')
  })
})
