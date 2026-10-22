/**
 * #4257: a paid delivery interrupted by a refused redirect is the funded,
 * undelivered state. `MerchantCompletion.retryRequest` records it with the
 * same reconciliation event a non-2xx answer writes, and re-throws the
 * refusal carrying its payment, so a caller can never read it as "nothing
 * happened".
 */
import { describe, expect, it, vi } from 'vitest'
import { McpMerchantTransport } from './mcp-merchant-transport.js'
import { MerchantCompletion } from './merchant-completion.js'
import { MerchantEgressRefusedError } from './merchant-egress.js'
import type { X402PaymentOption, X402PaymentRequired, X402Receipt } from './types.js'

const paidUrl = 'https://a.dev/paid'
const elsewhere = 'https://b.dev/paid'

const accepted3009: X402PaymentOption = {
  scheme: 'exact',
  network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  amount: '20000',
  payTo: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
  maxTimeoutSeconds: 300,
  extra: { name: 'USD Coin', version: '2' },
}
const accepted7710: X402PaymentOption = { ...accepted3009, extra: { assetTransferMethod: 'erc7710' } }

const headerFor = (accepted: X402PaymentOption): string =>
  btoa(JSON.stringify({ x402Version: 2, resource: { url: paidUrl }, accepted, payload: {} }))

const paymentRequired = { x402Version: 2, resource: { url: paidUrl }, accepts: [accepted3009] } as unknown as X402PaymentRequired

function receiptFor(accepted: X402PaymentOption): X402Receipt {
  return {
    paymentId: 'pay_1',
    txHash: '0xabc',
    resourceUrl: paidUrl,
    accepted,
    paymentHeader: headerFor(accepted),
    merchantTo: accepted.payTo,
    to: '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1',
  } as unknown as X402Receipt
}

async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await p }
  } catch (error) {
    return { ok: false, error }
  }
}

function completionWith(answer: (url: string) => Response | Promise<Response>) {
  const calls: string[] = []
  const transport = new McpMerchantTransport({
    merchantTimeout: 10_000,
    fetch: async (input) => {
      const url = String(input)
      calls.push(url)
      return answer(url)
    },
  })
  const post = vi.fn(async () => ({}))
  const completion = new MerchantCompletion({
    post: post as never,
    merchantTransport: transport,
    getPaymentStatus: vi.fn() as never,
    getAgent: vi.fn() as never,
    delegateAddress: undefined,
    x402Wallet: undefined,
  })
  return { completion, post, calls }
}

const redirectElsewhere = (url: string) =>
  url === paidUrl ? new Response(null, { status: 307, headers: { location: elsewhere } }) : new Response('elsewhere')

describe('MerchantCompletion.retryRequest — a refused redirect on the paid delivery (#4257)', () => {
  it('EIP-3009: recorded as rejected after payment and re-thrown with the payment, never "nothing happened"', async () => {
    const { completion, post, calls } = completionWith(redirectElsewhere)
    const result = await settle(
      completion.retryRequest(paidUrl, { method: 'POST', body: '{"q":1}' }, paymentRequired, receiptFor(accepted3009)),
    )
    expect(result.ok).toBe(false)
    const err = result.ok ? undefined : result.error
    expect(err).toBeInstanceOf(MerchantEgressRefusedError)
    expect(err).toMatchObject({
      paymentId: 'pay_1',
      settlementScheme: 'eip3009',
      beforeRequest: false,
      refusal: 'redirect_cross_origin_body',
      redirectStatus: 307,
    })
    expect((err as Error).message).toContain(`delivered to ${paidUrl}, payment header and body included`)
    expect((err as Error).message).toContain('Do not pay again')
    expect((err as Error).message).toContain('Check haven_get_payment_status before anything else')
    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith(
      '/machine-payments/reconciliation-events',
      expect.objectContaining({
        paymentId: 'pay_1',
        eventType: 'merchant_retry_rejected_after_payment',
        details: expect.objectContaining({ retry_status: 307, refusal: 'redirect_cross_origin_body' }),
      }),
    )
    expect(calls).toEqual([paidUrl])
  })

  it('erc7710: the same record, and the account says there is no funding leg to sweep', async () => {
    const { completion, post } = completionWith(redirectElsewhere)
    const result = await settle(
      completion.retryRequest(paidUrl, { method: 'POST', body: '{"q":1}' }, paymentRequired, receiptFor(accepted7710)),
    )
    expect(result.ok).toBe(false)
    const err = result.ok ? undefined : result.error
    expect(err).toMatchObject({ paymentId: 'pay_1', settlementScheme: 'erc7710' })
    expect((err as Error).message).toContain('erc7710 has no funding leg')
    expect((err as Error).message).toContain('Do not pay again')
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('any other delivery failure is re-thrown as it was, unrecorded', async () => {
    const { completion, post } = completionWith(() => {
      throw new TypeError('socket hang up')
    })
    const result = await settle(
      completion.retryRequest(paidUrl, { method: 'POST', body: '{"q":1}' }, paymentRequired, receiptFor(accepted3009)),
    )
    expect(result.ok).toBe(false)
    expect(result.ok ? undefined : result.error).toBeInstanceOf(TypeError)
    expect(post).not.toHaveBeenCalled()
  })
})
