/**
 * #4872: a merchant that requires a checkout detail this agent cannot share
 * is refused by the SDK before the payment is authorised. The local tools that
 * reach that seam (`haven_pay_x402` → `haven.fetch`, `haven_pay_x402_quote` →
 * `haven.payX402Quote`, `haven_resume_x402_payment` → `haven.resumeX402Payment`)
 * must answer it as a typed, machine-readable refusal: the code, the missing
 * field NAMES, the reason, `stop_and_tell_user` and why no tool follows —
 * never the generic `API_ERROR`, and never a value.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CHECKOUT_DETAILS_EXTENSION, HavenClient, checkoutDetailsRefusalError } from '@haven_ai/sdk'
import { createToolHandlers } from './tools.js'

function handlersThrowing(method: 'fetch' | 'payX402Quote' | 'resumeX402Payment', thrown: unknown) {
  const client = new Proxy(
    {},
    {
      get: (_target, prop) => async () => {
        if (prop === method) throw thrown
        if (prop === 'getAgent') return { id: 'agent_4872', execution_rail: 'delegation', chain_id: 8453 }
        throw new Error(`the local handler reached the client (${String(prop)})`)
      },
    },
  )
  return createToolHandlers(client as never) as Record<string, (input: unknown) => Promise<unknown>>
}

const QUOTE = {
  url: 'https://merchant.example/paid',
  paymentRequired: { x402Version: 2, resource: { url: 'https://merchant.example/paid' }, accepts: [] },
  accepted: {},
  request: { url: 'https://merchant.example/paid', method: 'GET', headers: {} },
  idempotencyKey: 'q-4872',
}

describe('#4872 the local tools answer a checkout-details refusal as a typed refusal', () => {
  const cases: Array<[string, 'fetch' | 'payX402Quote', unknown]> = [
    ['haven_pay_x402', 'fetch', { url: 'https://merchant.example/paid', max_amount_human: '1' }],
    ['haven_pay_x402_quote', 'payX402Quote', { quote: QUOTE, max_amount_human: '1' }],
    // haven_pay_mcp_tool reaches the same seam through haven.fetch.
    ['haven_pay_mcp_tool', 'fetch', { merchant_url: 'https://merchant.example/mcp', tool_name: 'joke', idempotency_key: 'k-4872' }],
  ]
  for (const [tool, method, input] of cases) {
    it(`${tool}: CHECKOUT_DETAILS_UNAVAILABLE with the field names, the reason and stop_and_tell_user`, async () => {
      const refusal = checkoutDetailsRefusalError(['receipt_email'], 'not_shared')
      const out = (await handlersThrowing(method, refusal)[tool](input)) as Record<string, unknown>
      expect(out).toMatchObject({
        success: false,
        code: 'CHECKOUT_DETAILS_UNAVAILABLE',
        statusCode: 409,
        missing_fields: ['receipt_email'],
        reason: 'not_shared',
        next_action: 'stop_and_tell_user',
      })
      expect(out.code).not.toBe('API_ERROR')
      expect(typeof out.next_tool_omitted_reason).toBe('string')
      expect(out.next_tool).toBeUndefined()
      expect(String(out.message)).toContain('No payment was created')
    })
  }

  it('haven_resume_x402_payment: the funded wording, the same typed answer', async () => {
    const refusal = checkoutDetailsRefusalError(['billing_address'], 'not_stored', { funded: true })
    const state = {
      rail: 'x402',
      paymentId: 'pay_4872',
      paymentRequired: QUOTE.paymentRequired,
      accepted: {},
      idempotencyKey: 'q-4872',
      request: QUOTE.request,
    }
    const out = (await handlersThrowing('resumeX402Payment', refusal).haven_resume_x402_payment({ resume_state: state })) as Record<string, unknown>
    expect(out).toMatchObject({
      code: 'CHECKOUT_DETAILS_UNAVAILABLE',
      missing_fields: ['billing_address'],
      reason: 'not_stored',
      next_action: 'stop_and_tell_user',
    })
    expect(String(out.message)).toContain('funded but was not delivered')
  })
})

/**
 * #5031: the local answer per stage, driven through the REAL SDK resume path —
 * a `HavenClient` over a stubbed wire, never a hand-built error — so the
 * payment id and the stage are what the SDK actually puts on the refusal.
 */
describe('#5031 the local surface answers a checkout-details refusal per stage', () => {
  const HAVEN = 'https://haven.example'
  const MERCHANT = 'https://api.merchant.example/paid'
  const AGENT = 'agent_5031'
  const paymentRequired = {
    x402Version: 2,
    error: 'Payment required',
    resource: { url: MERCHANT, description: 'paid resource', mimeType: 'application/json' },
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:8453',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        amount: '20000',
        payTo: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
        maxTimeoutSeconds: 300,
        extra: { name: 'USD Coin', version: '2' },
      },
    ],
    extensions: { [CHECKOUT_DETAILS_EXTENSION]: { info: { version: 1, fields: { receipt_email: { required: true } } } } },
  }
  const routes: Record<string, unknown> = {
    '/machine-payments/pay_5031/status': {
      payment_id: 'pay_5031',
      kind: 'payment_intent',
      rail: 'x402',
      status: 'confirmed',
      phase: 'funding_sent',
      next_action: 'retry_original_x402_request',
      amount: '0.02',
      token: 'USDC',
      resource_url: MERCHANT,
      merchant_address: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
      tx_hash: `0x${'ab'.repeat(32)}`,
      expires_at: 'later',
      chain_id: 8453,
      message: 'ready to retry',
    },
    '/machine-payments/agent': {
      id: AGENT,
      name: 'checkout agent',
      status: 'active',
      account_address: '0x135a9215604711AC70d970e12Caa812c53537EF4',
      delegate_address: '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1',
      chain_id: 8453,
      execution_rail: 'delegation',
    },
    [`/agents/${AGENT}/checkout-details`]: { available: false, reason: 'disabled' },
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('haven_resume_x402_payment on a funded payment: phase, the resume-this-payment step, and its payment_id', async () => {
    const merchantCalls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.startsWith(HAVEN)) {
        const path = url.slice(HAVEN.length)
        if (path in routes) return new Response(JSON.stringify(routes[path]), { status: 200 })
        return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      }
      merchantCalls.push(url)
      return new Response('{}', { status: 200 })
    })
    const client = new HavenClient({ apiKey: 'sk_agent_test', delegateKey: `0x${'01'.repeat(32)}`, baseUrl: HAVEN })
    const handlers = createToolHandlers(client) as Record<string, (input: unknown) => Promise<Record<string, unknown>>>
    const out = await handlers.haven_resume_x402_payment({
      resume_state: {
        rail: 'x402',
        paymentId: 'pay_5031',
        paymentRequired,
        accepted: paymentRequired.accepts[0],
        idempotencyKey: 'q-5031',
        request: { url: MERCHANT, method: 'GET', headers: {} },
      },
    })
    expect(out).toMatchObject({
      success: false,
      code: 'CHECKOUT_DETAILS_UNAVAILABLE',
      phase: 'funded_but_unsettled',
      paymentId: 'pay_5031',
      next_action: 'stop_and_tell_user',
    })
    // Not the fixed before-payment reason: it names the resume of THIS payment.
    expect(String(out.next_tool_omitted_reason)).toContain('haven_resume_x402_payment')
    expect(String(out.next_tool_omitted_reason)).toContain('do not start a new purchase')
    expect(String(out.next_tool_omitted_reason)).not.toMatch(/then retry$/)
    expect(merchantCalls).toEqual([])
  })

  it('a pay call refused before payment: not_started and the before-payment reason', async () => {
    const refusal = checkoutDetailsRefusalError(['receipt_email'], 'not_shared')
    const out = (await handlersThrowing('fetch', refusal).haven_pay_x402({ url: MERCHANT, max_amount_human: '1' })) as Record<string, unknown>
    expect(out).toMatchObject({ phase: 'not_started', code: 'CHECKOUT_DETAILS_UNAVAILABLE' })
    expect(String(out.next_tool_omitted_reason)).toMatch(/then retry$/)
    expect(out.paymentId).toBeUndefined()
  })
})
