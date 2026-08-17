import { describe, it, expect } from 'vitest'
import { HavenApiError } from '@haven_ai/sdk'
import { thrownErrorDetail } from './thrown-error-detail.js'

describe('thrownErrorDetail', () => {
  it('surfaces the merchant context the SDK attaches to a funded-retry failure', () => {
    // The real shape from packages/sdk/src/client.ts — a generic message with
    // everything that identifies the failure in `body`.
    const detail = thrownErrorDetail(
      new HavenApiError(
        'x402 retry failed after Haven funded the delegate wallet; reconciliation may be required.',
        402,
        {
          marker: 'x402_retry_rejected_after_funding',
          merchant_status: 402,
          merchant_body: '{"error":"Payment failed — merchant-side fault (HttpRequestError)"}',
          merchant_to: '0x55C9d84427756D6f82480427Bb778F6dc0cC755E',
          delegate_to: '0x0E460D969949f391765B9D2C062d6e4DB386C2D8',
        },
      ),
    )

    expect(detail).toContain('x402 retry failed after Haven funded')
    expect(detail).toContain('merchant-side fault')
    expect(detail).toContain('x402_retry_rejected_after_funding')
    expect(detail).toContain('0x0E460D969949f391765B9D2C062d6e4DB386C2D8')
  })

  it('falls back to the status code when there is no structured body', () => {
    expect(thrownErrorDetail(new HavenApiError('merchant never answered', 504))).toBe(
      'merchant never answered [HTTP 504]',
    )
  })

  it('returns a plain Error message unchanged', () => {
    expect(thrownErrorDetail(new Error('boom'))).toBe('boom')
  })

  it('handles a non-Error throw', () => {
    expect(thrownErrorDetail('just a string')).toBe('just a string')
  })

  it('does not echo the message back as context', () => {
    const detail = thrownErrorDetail(new HavenApiError('duplicated', 500, { message: 'duplicated' }))
    expect(detail).toBe('duplicated')
  })

  it('caps the context so one error cannot flood the report', () => {
    const detail = thrownErrorDetail(
      new HavenApiError('short', 500, { merchant_body: 'x'.repeat(10_000) }),
    )
    expect(detail.length).toBeLessThan(1000)
  })

  it('ignores an array body rather than rendering nonsense', () => {
    expect(thrownErrorDetail(new HavenApiError('arr', 500, ['a', 'b']))).toBe('arr [HTTP 500]')
  })

  it('never throws on a body with an unserialisable value', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() =>
      thrownErrorDetail(new HavenApiError('circular', 500, { marker: 'm', error: circular })),
    ).not.toThrow()
  })
})
