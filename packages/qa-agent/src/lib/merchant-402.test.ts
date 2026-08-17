import { describe, it, expect } from 'vitest'
import { merchant402Reason } from './merchant-402.js'

/**
 * The distinction this helper exists to draw: a 402 carrying `error` is the
 * merchant REJECTING a payment it looked at, and a 402 without one is the
 * merchant never having seen a payment at all. Those have opposite causes and
 * used to read identically in the QA report.
 */
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 402, headers: { 'Content-Type': 'application/json' } })

describe('merchant402Reason', () => {
  it("surfaces the merchant's stated error verbatim", async () => {
    const reason = await merchant402Reason(
      json({ accepts: [], error: 'USDC settlement transaction reverted on-chain: 0xdead' }),
    )
    expect(reason).toContain('USDC settlement transaction reverted on-chain: 0xdead')
  })

  it('distinguishes a bare re-challenge from a rejection', async () => {
    // The x402 default. The merchant did not reject anything — it re-issued the
    // challenge as though no payment had been presented. This is the shape a
    // real merchant sends, so it, not an absent key, is the load-bearing case.
    const reason = await merchant402Reason(
      json({ accepts: [{ scheme: 'exact' }], error: 'Payment required' }),
    )
    expect(reason).toContain('never associated the X-PAYMENT header')
    expect(reason).not.toContain('merchant said')
  })

  it('treats an absent error key as a bare challenge too', async () => {
    const reason = await merchant402Reason(json({ accepts: [{ scheme: 'exact' }] }))
    expect(reason).toContain('never associated the X-PAYMENT header')
  })

  it('flags a merchant-side fault as distinct from a policy rejection', async () => {
    const reason = await merchant402Reason(
      json({ error: 'Payment failed — merchant-side fault (HttpRequestError); see merchant logs' }),
    )
    expect(reason).toContain('HttpRequestError')
    expect(reason).toContain('not a policy rejection')
  })

  it('does not flag an ordinary rejection as a fault', async () => {
    const reason = await merchant402Reason(json({ error: 'Payment payer address is invalid' }))
    expect(reason).toContain('Payment payer address is invalid')
    expect(reason).not.toContain('not a policy rejection')
  })

  it('reports an unparseable body instead of hiding it', async () => {
    const reason = await merchant402Reason(new Response('<html>502 Bad Gateway</html>', { status: 402 }))
    expect(reason).toContain('unparseable')
    expect(reason).toContain('502 Bad Gateway')
  })

  it('reports an empty body', async () => {
    const reason = await merchant402Reason(new Response('', { status: 402 }))
    expect(reason).toContain('empty body')
  })

  it('never throws on a body that cannot be read', async () => {
    const broken = {
      text: () => Promise.reject(new Error('socket hang up')),
    } as unknown as Response
    await expect(merchant402Reason(broken)).resolves.toContain('socket hang up')
  })

  it('caps a hostile error string so one leg cannot flood the report', async () => {
    const reason = await merchant402Reason(json({ error: 'x'.repeat(5000) }))
    expect(reason.length).toBeLessThan(400)
  })

  it('renders a non-string error rather than dropping it', async () => {
    const reason = await merchant402Reason(json({ error: { code: 'INSUFFICIENT_GAS' } }))
    expect(reason).toContain('INSUFFICIENT_GAS')
  })
})
