/**
 * #4552 — the merchant's own reason for refusing a paid request.
 *
 * x402 merchants have started saying WHY they refused: a verify-stage refusal
 * returns `{"error": "<reason>"}` in the 402 body, a stock settlement failure
 * carries it only in the `PAYMENT-RESPONSE` header (`errorReason`), and
 * merchants from before x402-foundation/x402#3795 carry it only in
 * `PAYMENT-REQUIRED` (`error`). The same `error` field sometimes holds a
 * sentence, so only a code-shaped value is accepted.
 *
 * The parser is TOTAL by contract: it runs inside `recordRetryRejected`'s
 * swallowing `try`, where a throw would silently drop the stranded-funds
 * event. Every case below asserts a value, never an exception.
 */
import { describe, expect, it, vi } from 'vitest'
import { encodeBase64Json } from './base64.js'
import { MerchantCompletion, merchantReportedError } from './merchant-completion.js'
import type { CapturedMerchantResponse } from './mcp-merchant-transport.js'

const CODE = 'invalid_exact_evm_non_canonical_signature'

describe('merchantReportedError — the body (#4552)', () => {
  it('returns the code from a JSON object whose error is a code', () => {
    expect(merchantReportedError('{"error":"insufficient_funds"}')).toBe('insufficient_funds')
    expect(merchantReportedError(JSON.stringify({ error: CODE }))).toBe(CODE)
  })

  it('returns null, without throwing, for a body that is not a JSON object', () => {
    for (const body of [
      'not json at all',
      '{"error":', // cut off mid-object
      'null',
      '"insufficient_funds"',
      '["insufficient_funds"]',
      '42',
      'true',
    ]) {
      expect(merchantReportedError(body), body).toBeNull()
    }
  })

  it('returns null for a body cut off at the 1000-character snippet limit', () => {
    // The parser is handed the UNTRUNCATED body; the snippet limit is what the
    // event stores. A code cut in half is not a code.
    const full = JSON.stringify({ error: 'insufficient_funds', pad: 'x'.repeat(2000) })
    expect(merchantReportedError(full)).toBe('insufficient_funds')
    expect(merchantReportedError(full.slice(0, 1000))).toBeNull()
  })

  it('returns null for a non-string error and for free text in error', () => {
    expect(merchantReportedError('{"error":42}')).toBeNull()
    expect(merchantReportedError('{"error":null}')).toBeNull()
    expect(merchantReportedError('{"error":{"code":"insufficient_funds"}}')).toBeNull()
    expect(merchantReportedError('{"error":"No matching payment requirements"}')).toBeNull()
    expect(merchantReportedError('{"error":"Insufficient funds"}')).toBeNull()
    expect(merchantReportedError('{"error":""}')).toBeNull()
  })

  it('returns null for an empty body, and for a body with no error field', () => {
    expect(merchantReportedError('')).toBeNull()
    expect(merchantReportedError(null)).toBeNull()
    expect(merchantReportedError(undefined)).toBeNull()
    expect(merchantReportedError('{"message":"nope"}')).toBeNull()
  })

  it('accepts a 64-character code and refuses a 65-character one', () => {
    expect(merchantReportedError(JSON.stringify({ error: 'a'.repeat(64) }))).toBe('a'.repeat(64))
    expect(merchantReportedError(JSON.stringify({ error: 'a'.repeat(65) }))).toBeNull()
  })
})

describe('merchantReportedError — the header fallback (#4552)', () => {
  it('reads PAYMENT-RESPONSE.errorReason when the body yields nothing', () => {
    const headers = { 'payment-response': encodeBase64Json({ success: false, errorReason: CODE }) }
    expect(merchantReportedError('', headers)).toBe(CODE)
    expect(merchantReportedError('{"error":"free text"}', headers)).toBe(CODE)
  })

  it('reads PAYMENT-REQUIRED.error when the body and PAYMENT-RESPONSE yield nothing', () => {
    const headers = {
      'payment-response': encodeBase64Json({ success: false }),
      'payment-required': encodeBase64Json({ error: 'insufficient_funds' }),
    }
    expect(merchantReportedError('', headers)).toBe('insufficient_funds')
  })

  it('prefers the body, then PAYMENT-RESPONSE, then PAYMENT-REQUIRED', () => {
    const headers = {
      'payment-response': encodeBase64Json({ errorReason: 'from_response' }),
      'payment-required': encodeBase64Json({ error: 'from_required' }),
    }
    expect(merchantReportedError('{"error":"from_body"}', headers)).toBe('from_body')
    expect(merchantReportedError('', headers)).toBe('from_response')
  })

  it('matches header names case-insensitively', () => {
    expect(merchantReportedError('', { 'PAYMENT-RESPONSE': encodeBase64Json({ errorReason: CODE }) })).toBe(CODE)
  })

  it('returns null, without throwing, for undecodable or non-code headers', () => {
    expect(merchantReportedError('', { 'payment-response': 'not base64 json' })).toBeNull()
    expect(merchantReportedError('', { 'payment-response': encodeBase64Json({ errorReason: 'Free text' }) })).toBeNull()
    expect(merchantReportedError('', { 'payment-response': encodeBase64Json(null) })).toBeNull()
    expect(merchantReportedError('', { 'payment-response': encodeBase64Json(['x']) })).toBeNull()
    expect(merchantReportedError('', {})).toBeNull()
    expect(merchantReportedError('', null)).toBeNull()
  })
})

/** A `MerchantCompletion` whose only real collaborator is the `post` spy. */
function completionWithPost() {
  const post = vi.fn(async () => ({}))
  const completion = new MerchantCompletion({
    post: post as never,
    merchantTransport: {} as never,
    getPaymentStatus: vi.fn() as never,
    getAgent: vi.fn() as never,
    delegateAddress: undefined,
    x402Wallet: undefined,
  })
  return { completion, post }
}

const merchant = (overrides: Partial<CapturedMerchantResponse> = {}): CapturedMerchantResponse => ({
  merchant_status: 402,
  merchant_status_text: 'Payment Required',
  merchant_headers: {},
  merchant_body: '',
  ...overrides,
})

const postedDetails = (post: ReturnType<typeof vi.fn>): Record<string, unknown> =>
  ((post.mock.calls[0] as unknown[])[1] as { details: Record<string, unknown> }).details

describe('recordRetryRejected records details.merchant_reported_error (#4552)', () => {
  it('records the code parsed from the body, and leaves retry_body byte-equal', async () => {
    const { completion, post } = completionWithPost()
    const body = JSON.stringify({ error: 'insufficient_funds' })
    await completion.recordRetryRejected({
      rail: 'x402',
      paymentId: 'pay_1',
      txHash: '0xabc',
      resourceUrl: 'https://merchant.example/r',
      merchant: merchant({ merchant_body: body }),
      details: { merchant_to: '0xmerchant', delegate_to: '0xdelegate' },
    })
    const details = postedDetails(post)
    expect(details.merchant_reported_error).toBe('insufficient_funds')
    expect(details.retry_body).toBe(body)
    expect(details).toMatchObject({ merchant_to: '0xmerchant', delegate_to: '0xdelegate' })
  })

  it('records null — never absent — when nothing parses', async () => {
    const { completion, post } = completionWithPost()
    await completion.recordRetryRejected({
      rail: 'x402',
      paymentId: 'pay_1',
      txHash: '0xabc',
      resourceUrl: 'https://merchant.example/r',
      merchant: merchant({ merchant_body: 'Payment required' }),
    })
    expect(postedDetails(post)).toHaveProperty('merchant_reported_error', null)
  })

  it('falls back to the merchant headers when the body is empty', async () => {
    const { completion, post } = completionWithPost()
    await completion.recordRetryRejected({
      rail: 'x402',
      paymentId: 'pay_1',
      txHash: '0xabc',
      resourceUrl: 'https://merchant.example/r',
      merchant: merchant({
        merchant_headers: { 'payment-response': encodeBase64Json({ success: false, errorReason: CODE }) },
      }),
    })
    expect(postedDetails(post).merchant_reported_error).toBe(CODE)
  })

  it('a caller-supplied details.merchant_reported_error cannot override the parse', async () => {
    const { completion, post } = completionWithPost()
    await completion.recordRetryRejected({
      rail: 'x402',
      paymentId: 'pay_1',
      txHash: '0xabc',
      resourceUrl: 'https://merchant.example/r',
      merchant: merchant({ merchant_body: JSON.stringify({ error: 'insufficient_funds' }) }),
      details: { merchant_reported_error: 'caller_override' },
    })
    expect(postedDetails(post).merchant_reported_error).toBe('insufficient_funds')
  })

  it('a header whose value getter throws never drops the event: the post still happens', async () => {
    const { completion, post } = completionWithPost()
    // The pathological case the total parser exists for: a throw inside
    // `recordRetryRejected`'s swallowing `try` would silently drop the
    // stranded-funds event.
    const headers = {
      get 'payment-response'(): string {
        throw new Error('boom')
      },
    }
    await completion.recordRetryRejected({
      rail: 'x402',
      paymentId: 'pay_1',
      txHash: '0xabc',
      resourceUrl: 'https://merchant.example/r',
      merchant: merchant({ merchant_headers: headers }),
    })
    expect(post).toHaveBeenCalledTimes(1)
    expect(postedDetails(post)).toHaveProperty('merchant_reported_error', null)
  })
})
