import { afterEach, describe, expect, it, vi } from 'vitest'
import { HavenClient, MerchantEgressRefusedError } from '@haven_ai/sdk'
import { createToolHandlers } from './tools.js'

/**
 * #4257: a refused redirect that interrupted a PAID delivery reaches the
 * local agent as the funded, undelivered state, the local twin of the hosted
 * #1300 treatment: payment id, the status read as the next tool, never a
 * re-pay. A refusal with no payment, or one before any request, keeps the
 * generic envelope.
 */
describe('local runtime: a paid delivery interrupted by a refused redirect (#4257)', () => {
  afterEach(() => vi.restoreAllMocks())

  const haven = () =>
    new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test', delegateKey: '0x' + 'd'.repeat(64) })

  const refusal = (extra: ConstructorParameters<typeof MerchantEgressRefusedError>[4], beforeRequest = false) =>
    new MerchantEgressRefusedError('The paid request was delivered … Do not pay again.', 'https://b.dev/paid', 'redirect_cross_origin_body', beforeRequest, extra)

  async function payWith(err: unknown): Promise<Record<string, unknown>> {
    vi.spyOn(HavenClient.prototype, 'fetch').mockRejectedValue(err)
    const result = await createToolHandlers(haven()).haven_pay_x402({ url: 'https://a.dev/paid' })
    if (result.success) throw new Error('expected failure')
    return result as unknown as Record<string, unknown>
  }

  it('EIP-3009: funded but unsettled, status read first, verify-then-sweep', async () => {
    const out = await payWith(refusal({ paymentId: 'pay_1', settlementScheme: 'eip3009', redirectStatus: 307 }))
    expect(out).toMatchObject({
      code: 'MERCHANT_EGRESS_REFUSED',
      paymentId: 'pay_1',
      status: 'merchant_unresponsive_after_funding',
      phase: 'funded_but_unsettled',
      next_action: 'sweep_stranded_funds',
      nextAction: 'sweep_stranded_funds',
      next_tool: 'haven_get_payment_status',
      next_arguments: { payment_id: 'pay_1' },
      suggested_tool: 'haven_get_payment_status',
    })
    expect(String(out.message)).toContain('Do not pay again')
  })

  it('erc7710: not delivered, no funding leg, check status later', async () => {
    const out = await payWith(refusal({ paymentId: 'pay_1', settlementScheme: 'erc7710', redirectStatus: 307 }))
    expect(out).toMatchObject({
      paymentId: 'pay_1',
      phase: 'not_delivered',
      next_action: 'check_status_later',
      next_tool: 'haven_get_payment_status',
      next_arguments: { payment_id: 'pay_1' },
    })
  })

  it('without a payment, or before any request, the generic envelope stays', async () => {
    for (const err of [refusal({}), refusal({ paymentId: 'pay_1', settlementScheme: 'eip3009' }, true)]) {
      const out = await payWith(err)
      expect(out.code).toBe('MERCHANT_EGRESS_REFUSED')
      expect(out.next_tool).toBeUndefined()
      expect(out.phase).toBeUndefined()
      vi.restoreAllMocks()
    }
  })
})
