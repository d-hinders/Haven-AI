/**
 * #3739 — `haven_pay_x402_quote` REQUEST MODE: the hosted server makes the
 * unpaid request itself and builds the payment from the 402 it fetched, so
 * the challenge never passes through the agent.
 *
 * Field case (2026-10-07, prod, Bitrefill): an agent retyped the ~3 KB
 * `payment_required` blob, dropped `extensions.bazaar.schema`, and the
 * merchant refused the header after funding (`extension_echo_mismatch`),
 * stranding 0.01 USDC. Every fixture below therefore carries a Bitrefill-like
 * `bazaar` extension WITH its nested `schema`, and the echo assertions are
 * deep equality (the backend stores the copy as JSONB, which reorders keys).
 *
 * Fixture hosts are `merchant.test`, which the production egress policy
 * refuses as a reserved name: the suite admits it through the explicit seam
 * (`MERCHANT_TEST_PROBE`), never by weakening the policy.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { AgentPaymentNextAction } from '@haven_ai/sdk'
import {
  AGENT_RESPONSE,
  MERCHANT_TEST_PROBE,
  PAYMENT_REQUIRED,
  X402_INTENT_RESPONSE,
  clearCalls,
  fail,
  handlers,
  installSharedFixtureLifecycle,
  ok,
  recordedCalls,
  stubFetch,
} from '../test-support/hosted-mcp.js'
import {
  assertX402ProbeTargetAllowed,
  probeX402Challenge,
  requestModeIdempotencyKey,
} from './plain-http-x402.js'

installSharedFixtureLifecycle()

beforeEach(() => {
  clearCalls()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const MERCHANT_URL = 'https://merchant.test/paid'
const FACILITATOR = '0x' + 'fa'.repeat(20)

/** Bitrefill's `bazaar` extension shape: `info` AND a nested `schema`. */
const BAZAAR = {
  bazaar: {
    info: { input: { type: 'http', method: 'POST', body: { invoice_id: 'inv_123' } } },
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { input: { type: 'object', properties: { body: { type: 'object' } } } },
      required: ['input'],
    },
  },
}

const CHALLENGE = { ...PAYMENT_REQUIRED, extensions: BAZAAR }
const ERC7710_CHALLENGE = {
  ...CHALLENGE,
  accepts: [
    ...PAYMENT_REQUIRED.accepts,
    {
      ...PAYMENT_REQUIRED.accepts[0],
      extra: { assetTransferMethod: 'erc7710', facilitatorAddresses: [FACILITATOR] },
    },
  ],
}
const DELEGATION_AGENT = { ...AGENT_RESPONSE, execution_rail: 'delegation' }
const CHILD = {
  payment_id: 'pay_req_7710',
  status: 'pending_signature',
  sign_data: {
    hash: '0x' + '11'.repeat(32),
    signature_scheme: 'eip712_delegation',
    typed_data: { domain: {}, types: {}, primaryType: 'Delegation', message: { caveats: [] } },
  },
}

const merchantCalls = () => recordedCalls().filter((c) => new URL(c.url).hostname === 'merchant.test')
const authorizeCalls = () => recordedCalls().filter((c) => new URL(c.url).pathname === '/x402')
const agentFetches = () =>
  recordedCalls().filter((c) => new URL(c.url).pathname.endsWith('/machine-payments/agent')).length

function stubMerchant(
  challenge: unknown,
  agent: Record<string, unknown> = AGENT_RESPONSE,
  intent: unknown = X402_INTENT_RESPONSE,
  extra: Record<string, { status?: number; body?: unknown; responseHeaders?: Record<string, string> }> = {},
) {
  stubFetch({
    'GET /paid': { status: 402, body: challenge },
    'POST /paid': { status: 402, body: challenge },
    'GET /machine-payments/agent': { status: 200, body: agent },
    'POST /x402': { status: 201, body: intent },
    ...extra,
  })
}

async function pay(args: Record<string, unknown>) {
  return handlers(MERCHANT_TEST_PROBE).haven_pay_x402_quote(args)
}

describe('#3739 request mode: works on both schemes', () => {
  it('eip3009: a GET with only { url, max_amount_human } probes and creates the intent from the fetched 402', async () => {
    stubMerchant(CHALLENGE)
    const res = ok(await pay({ url: MERCHANT_URL, max_amount_human: '2' })) as { data: Record<string, any> }

    expect(merchantCalls()).toHaveLength(1)
    expect(merchantCalls()[0].method).toBe('GET')
    expect(res.data.payment_id).toBe('pay_x402')
    expect(res.data.next_tool_name).toBe('haven_sign_x402')
    expect(res.data.retry_url).toBe(MERCHANT_URL)
    // Echo fidelity, point 1: the stored challenge IS the probed one.
    const body = authorizeCalls()[0].body as Record<string, unknown>
    expect(body.paymentRequired).toEqual(CHALLENGE)
    expect(body.settlementScheme).toBe('eip3009')
  })

  it('erc7710: probes and prepares the settlement child from the fetched 402', async () => {
    stubMerchant(ERC7710_CHALLENGE, DELEGATION_AGENT, CHILD)
    const res = ok(await pay({ url: MERCHANT_URL, max_amount_human: '2' })) as { data: Record<string, any> }

    expect(res.data.settlement_scheme).toBe('erc7710')
    expect(res.data.next_tool_name).toBe('haven_sign')
    const body = authorizeCalls()[0].body as Record<string, unknown>
    expect(body.paymentRequired).toEqual(ERC7710_CHALLENGE)
    expect(body.settlementScheme).toBe('erc7710')
  })

  it('a POST with method, headers and a string body probes with exactly that request; headers never reach Haven', async () => {
    stubMerchant(CHALLENGE)
    const requestBody = JSON.stringify({ invoice_id: 'inv_123' })
    ok(
      await pay({
        url: MERCHANT_URL,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Merchant-Session': 's3cr3t' },
        body: requestBody,
        max_amount_human: '2',
      }),
    )

    const probe = merchantCalls()[0]
    expect(probe.method).toBe('POST')
    expect(probe.body).toEqual({ invoice_id: 'inv_123' })
    expect(new Headers(probe.headers).get('content-type')).toBe('application/json')
    // Request headers are never sent to the backend or stored.
    for (const call of recordedCalls().filter((c) => new URL(c.url).hostname === 'haven.test')) {
      expect(JSON.stringify(call.body ?? {})).not.toContain('s3cr3t')
      expect(JSON.stringify(call.headers)).not.toContain('s3cr3t')
    }
  })

  it('keeps the #1348 round-trip budget in request mode: exactly ONE agent fetch on BOTH schemes', async () => {
    stubMerchant(ERC7710_CHALLENGE, DELEGATION_AGENT, CHILD)
    ok(await pay({ url: MERCHANT_URL, max_amount_human: '2' }))
    const onErc7710 = agentFetches()
    clearCalls()
    stubMerchant(CHALLENGE, DELEGATION_AGENT)
    ok(await pay({ url: MERCHANT_URL, max_amount_human: '2' }))
    expect([onErc7710, agentFetches()]).toEqual([1, 1])
  })
})

describe('#3739 request mode: egress policy refuses before any fetch', () => {
  const refused = [
    ['an http URL', 'http://merchant.example.com/paid'],
    ['an IPv4 literal', 'https://127.0.0.1/paid'],
    ['a decimal IPv4 literal', 'https://2130706433/paid'],
    ['the zero address', 'https://0/paid'],
    ['an IPv6 literal', 'https://[::1]/paid'],
    ['an IPv4-mapped IPv6 literal', 'https://[::ffff:7f00:1]/paid'],
    ['localhost', 'https://localhost/paid'],
    ['localhost with a trailing dot', 'https://localhost./paid'],
    ['a .localhost subdomain', 'https://api.localhost/paid'],
    ['an .internal host', 'https://metadata.internal/paid'],
    ['a .local host', 'https://printer.local/paid'],
    ['a single-label host', 'https://intranet/paid'],
    ['a reserved .test host WITHOUT the seam', 'https://merchant.test/paid'],
  ] as const

  for (const [label, url] of refused) {
    it(`refuses ${label}`, async () => {
      stubMerchant(CHALLENGE)
      const res = fail(await handlers().haven_pay_x402_quote({ url, max_amount_human: '2' }))
      expect(res.code).toBe('X402_PROBE_TARGET_REFUSED')
      expect(recordedCalls()).toEqual([])
    })
  }

  it('POSITIVE CONTROL: a public https domain passes the target check', () => {
    expect(assertX402ProbeTargetAllowed('https://api.bitrefill.com/x402/invoice/pay').hostname).toBe('api.bitrefill.com')
  })

  it('refuses a merchant 3xx on the probe instead of following it, and sets redirect: error', async () => {
    let seenRedirect: RequestRedirect | undefined
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit = {}) => {
      seenRedirect = init.redirect
      return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/' } })
    })
    await expect(probeX402Challenge(MERCHANT_URL, {}, MERCHANT_TEST_PROBE.x402Probe)).rejects.toMatchObject({
      code: 'X402_PROBE_REDIRECT_REFUSED',
    })
    expect(seenRedirect).toBe('error')
  })

  it("maps the runtime's redirect:'error' rejection to the same refusal", async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') })
    })
    await expect(probeX402Challenge(MERCHANT_URL, {}, MERCHANT_TEST_PROBE.x402Probe)).rejects.toMatchObject({
      code: 'X402_PROBE_REDIRECT_REFUSED',
    })
  })

  it('refuses a probe that exceeds the timeout', async () => {
    vi.stubGlobal(
      'fetch',
      (_url: string, init: RequestInit = {}) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        }),
    )
    await expect(
      probeX402Challenge(MERCHANT_URL, {}, { ...MERCHANT_TEST_PROBE.x402Probe, timeoutMs: 20 }),
    ).rejects.toMatchObject({ code: 'X402_PROBE_TIMEOUT' })
  })

  it('refuses a response over the size cap, streamed or declared', async () => {
    const big = JSON.stringify({ ...CHALLENGE, padding: 'x'.repeat(4096) })
    vi.stubGlobal('fetch', async () => new Response(big, { status: 402 }))
    await expect(
      probeX402Challenge(MERCHANT_URL, {}, { ...MERCHANT_TEST_PROBE.x402Probe, maxResponseBytes: 1024 }),
    ).rejects.toMatchObject({ code: 'X402_PROBE_TOO_LARGE' })
    vi.stubGlobal(
      'fetch',
      async () => new Response('{}', { status: 402, headers: { 'content-length': String(10 * 1024 * 1024) } }),
    )
    await expect(
      probeX402Challenge(MERCHANT_URL, {}, { ...MERCHANT_TEST_PROBE.x402Probe, maxResponseBytes: 1024 }),
    ).rejects.toMatchObject({ code: 'X402_PROBE_TOO_LARGE' })
  })
})

describe('#3739 request mode: a probe that is not a payable x402 402 refuses before any intent', () => {
  const cases: Array<[string, { status: number; body: unknown }, string | RegExp]> = [
    ['a 2xx', { status: 200, body: { ok: true } }, 'X402_PROBE_NOT_PAYMENT_REQUIRED'],
    ['a non-402 error', { status: 500, body: { error: 'down' } }, 'X402_PROBE_NOT_PAYMENT_REQUIRED'],
    ['a non-x402 402', { status: 402, body: { message: 'pay me' } }, 'X402_PROBE_NOT_PAYMENT_REQUIRED'],
  ]
  for (const [label, answer, code] of cases) {
    it(`refuses ${label}`, async () => {
      stubFetch({ 'GET /paid': answer, 'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE } })
      const res = fail(await pay({ url: MERCHANT_URL, max_amount_human: '2' }))
      expect(res.code).toBe(code)
      expect(authorizeCalls()).toEqual([])
      expect(agentFetches()).toBe(0)
    })
  }

  it('refuses a 402 offering only `upto`, with the missing body / Content-Type hint (field case 1)', async () => {
    const upto = { ...CHALLENGE, accepts: [{ ...PAYMENT_REQUIRED.accepts[0], scheme: 'upto' }] }
    stubMerchant(upto)
    const res = fail(await pay({ url: MERCHANT_URL, max_amount_human: '2' }))
    expect(res.message).toContain("offered only 'upto'")
    expect(res.message).toContain('Content-Type')
    expect(authorizeCalls()).toEqual([])
  })
})

describe('#3739 request mode: the cap', () => {
  it('is REQUIRED — no cap refuses before any fetch', async () => {
    stubMerchant(CHALLENGE)
    const res = fail(await pay({ url: MERCHANT_URL }))
    expect(res.code).toBe('INVALID_INPUT')
    expect(recordedCalls()).toEqual([])
  })

  it('is enforced against the FETCHED challenge: a price rise between quote and pay refuses before funding', async () => {
    // Quoted at 1.5 USDC; the merchant now asks 3 USDC.
    const raised = {
      ...CHALLENGE,
      accepts: [{ ...PAYMENT_REQUIRED.accepts[0], amount: '3000000', maxAmountRequired: '3000000' }],
    }
    stubMerchant(raised)
    const res = fail(await pay({ url: MERCHANT_URL, max_amount_human: '1.5' }))
    expect(res.code).toBe('PRICE_EXCEEDS_MAX')
    expect(authorizeCalls()).toEqual([])
  })

  it('requires url in request mode', async () => {
    stubMerchant(CHALLENGE)
    const res = fail(await pay({ max_amount_human: '2' }))
    expect(res.code).toBe('INVALID_INPUT')
    expect(res.message).toContain('url')
    expect(recordedCalls()).toEqual([])
  })
})

describe('#3739 request mode: oversized challenges', () => {
  it('refuses a challenge too large to store (over 64 KB) before any intent', async () => {
    const huge = { ...CHALLENGE, extensions: { ...BAZAAR, filler: 'x'.repeat(70_000) } }
    stubMerchant(huge)
    const res = fail(await pay({ url: MERCHANT_URL, max_amount_human: '2' }))
    expect(res.code).toBe('X402_CHALLENGE_TOO_LARGE')
    expect(authorizeCalls()).toEqual([])
  })
})

describe('#3739 request mode: repeated calls', () => {
  const lookup = (body: Record<string, unknown>) => ({
    'GET /x402/by-idempotency-key/k1': { status: 200, body },
  })
  const LIVE_3009 = {
    payment_id: 'pay_existing',
    status: 'pending_signature',
    settlement_scheme: 'eip3009',
    resource_url: MERCHANT_URL,
    expires_at: '2099-01-01T00:00:00.000Z',
    window_open: true,
    task_budget_id: null,
    amount_atomic: '1500000',
    network: 'base',
  }

  it('with the same idempotency_key, an existing eip3009 intent answers BEFORE any re-probe', async () => {
    stubMerchant(CHALLENGE, AGENT_RESPONSE, X402_INTENT_RESPONSE, lookup(LIVE_3009))
    const res = ok(await pay({ url: MERCHANT_URL, max_amount_human: '2', idempotency_key: 'k1' })) as {
      data: Record<string, any>
    }
    expect(res.data.payment_id).toBe('pay_existing')
    expect(res.data.idempotent_replay).toBe(true)
    expect(res.data.next_tool_name).toBe('haven_sign_x402')
    expect(res.data.next_arguments).toEqual({ payment_id: 'pay_existing' })
    expect(merchantCalls()).toEqual([])
    expect(authorizeCalls()).toEqual([])
  })

  it('an existing erc7710 intent names haven_sign, still without a probe', async () => {
    stubMerchant(CHALLENGE, AGENT_RESPONSE, X402_INTENT_RESPONSE, lookup({ ...LIVE_3009, settlement_scheme: 'erc7710' }))
    const res = ok(await pay({ url: MERCHANT_URL, max_amount_human: '2', idempotency_key: 'k1' })) as {
      data: Record<string, any>
    }
    expect(res.data.next_tool_name).toBe('haven_sign')
    expect(merchantCalls()).toEqual([])
  })

  it('an intent past the signing step names haven_get_payment_status, still without a probe', async () => {
    stubMerchant(
      CHALLENGE,
      AGENT_RESPONSE,
      X402_INTENT_RESPONSE,
      lookup({ ...LIVE_3009, status: 'confirmed', window_open: false }),
    )
    const res = ok(await pay({ url: MERCHANT_URL, max_amount_human: '2', idempotency_key: 'k1' })) as {
      data: Record<string, any>
    }
    expect(res.data.next_action).toBe(AgentPaymentNextAction.CheckStatusLater)
    expect(res.data.next_tool_name).toBe('haven_get_payment_status')
    expect(merchantCalls()).toEqual([])
  })

  it('a closed signing window, an unknown key, or another task budget falls through to the probe', async () => {
    for (const routes of [
      lookup({ ...LIVE_3009, window_open: false }),
      { 'GET /x402/by-idempotency-key/k1': { status: 404, body: { error: 'none' } } },
      lookup({ ...LIVE_3009, task_budget_id: 'tb_other' }),
    ]) {
      clearCalls()
      stubMerchant(CHALLENGE, AGENT_RESPONSE, X402_INTENT_RESPONSE, routes)
      ok(await pay({ url: MERCHANT_URL, max_amount_human: '2', idempotency_key: 'k1' }))
      expect(merchantCalls()).toHaveLength(1)
      expect((authorizeCalls()[0].body as Record<string, unknown>).idempotencyKey).toBe('k1')
    }
  })

  it('with no key, the derived key covers the WHOLE probed challenge, extensions included', async () => {
    const before = Date.now()
    stubMerchant(CHALLENGE)
    clearCalls()
    ok(await pay({ url: MERCHANT_URL, max_amount_human: '2' }))
    const after = Date.now()
    const key = (authorizeCalls()[0].body as Record<string, unknown>).idempotencyKey as string
    // Either side of a bucket edge, the key is the one over the probed challenge.
    expect([requestModeIdempotencyKey(CHALLENGE as never, before), requestModeIdempotencyKey(CHALLENGE as never, after)]).toContain(key)
    expect(key.startsWith('x402r:')).toBe(true)

    // An edited extension (the field case) is a DIFFERENT key, so it can
    // never replay an intent built from the merchant's own challenge.
    const edited = {
      ...CHALLENGE,
      extensions: { bazaar: { info: BAZAAR.bazaar.info } },
    }
    const now = Date.now()
    expect(requestModeIdempotencyKey(edited as never, now)).not.toBe(requestModeIdempotencyKey(CHALLENGE as never, now))
    // Key order is not identity: a JSONB round trip reorders keys.
    const reordered = JSON.parse(JSON.stringify({ extensions: CHALLENGE.extensions, accepts: CHALLENGE.accepts, resource: CHALLENGE.resource, x402Version: CHALLENGE.x402Version }))
    expect(requestModeIdempotencyKey(reordered, now)).toBe(requestModeIdempotencyKey(CHALLENGE as never, now))
  })
})

describe('#3739 payment_required mode is unchanged', () => {
  it('makes no merchant request and keeps the caller-supplied challenge verbatim', async () => {
    stubMerchant(CHALLENGE)
    ok(await pay({ url: MERCHANT_URL, payment_required: CHALLENGE }))
    expect(merchantCalls()).toEqual([])
    expect((authorizeCalls()[0].body as Record<string, unknown>).paymentRequired).toEqual(CHALLENGE)
  })

  it('still runs uncapped with cap_warning (the cap is required only in request mode)', async () => {
    stubMerchant(CHALLENGE)
    const res = ok(await pay({ url: MERCHANT_URL, payment_required: CHALLENGE })) as { data: Record<string, any> }
    expect(res.data.cap_warning).toBeDefined()
  })
})

describe('#3739 haven_quote_x402 names the request-mode next step', () => {
  it('hands back url, method, headers, body as sent and the quoted amount as the cap', async () => {
    stubMerchant(CHALLENGE)
    const res = ok(
      await handlers().haven_quote_x402({
        url: MERCHANT_URL,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"invoice_id":"inv_123"}',
      }),
    ) as { data: Record<string, any> }

    expect(res.data.next_tool_name).toBe('haven_pay_x402_quote')
    expect(res.data.next_arguments).toEqual({
      url: MERCHANT_URL,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"invoice_id":"inv_123"}',
      max_amount_human: res.data.amount,
    })
    // The handoff is request mode: no challenge to copy.
    expect(res.data.next_arguments).not.toHaveProperty('payment_required')
  })

  it('the named next step parses under the pay tool\'s strict schema', async () => {
    const { toolInputSchema } = await import('./registry.js')
    stubMerchant(CHALLENGE)
    const res = ok(await handlers().haven_quote_x402({ url: MERCHANT_URL })) as { data: Record<string, any> }
    expect(() => (toolInputSchema('haven_pay_x402_quote') as { parse(v: unknown): unknown }).parse(res.data.next_arguments)).not.toThrow()
  })
})

describe('#3739 resume works for a payment created in request mode', () => {
  it('haven_resume_x402_payment resumes it by payment_id, carrying the probed challenge', async () => {
    stubMerchant(CHALLENGE, AGENT_RESPONSE, X402_INTENT_RESPONSE, {
      'GET /payments/pay_x402/resume_state': {
        status: 200,
        body: {
          rail: 'x402',
          paymentId: 'pay_x402',
          paymentRequired: CHALLENGE,
          accepted: CHALLENGE.accepts[0],
          url: MERCHANT_URL,
          resourceUrl: MERCHANT_URL,
          description: null,
          amountAtomic: '1500000',
          amount: '1.50',
          token: 'USDC',
          asset: CHALLENGE.accepts[0].asset,
          network: 'base',
          chainId: 8453,
          merchantAddress: CHALLENGE.accepts[0].payTo,
        },
      },
      'GET /machine-payments/pay_x402/status': {
        status: 200,
        body: {
          payment_id: 'pay_x402',
          status: 'confirmed',
          next_action: 'retry_original_x402_request',
          tx_hash: '0xfunded',
          rail: 'x402',
        },
      },
    })
    const created = ok(await pay({ url: MERCHANT_URL, max_amount_human: '2' })) as { data: Record<string, any> }
    expect(created.data.payment_id).toBe('pay_x402')

    const resumed = ok(
      await handlers(MERCHANT_TEST_PROBE).haven_resume_x402_payment({ payment_id: 'pay_x402', url: MERCHANT_URL }),
    ) as { data: Record<string, any> }
    expect(resumed.data.payment_id).toBe('pay_x402')
    expect(resumed.data.payment_required).toEqual(CHALLENGE)
    expect(resumed.data.x402).toBeDefined()
    expect(resumed.data.tx_hash).toBe('0xfunded')
  })
})
