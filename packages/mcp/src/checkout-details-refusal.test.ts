/**
 * #4872: a merchant that requires a checkout detail this agent cannot share
 * is refused by the SDK before the payment is authorised. The local tools that
 * reach that seam (`haven_pay_x402` → `haven.fetch`, `haven_pay_x402_quote` →
 * `haven.payX402Quote`, `haven_resume_x402_payment` → `haven.resumeX402Payment`)
 * must answer it as a typed, machine-readable refusal: the code, the missing
 * field NAMES, the reason, `stop_and_tell_user` and why no tool follows —
 * never the generic `API_ERROR`, and never a value.
 */
import { describe, expect, it } from 'vitest'
import { checkoutDetailsRefusalError } from '@haven_ai/sdk'
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
