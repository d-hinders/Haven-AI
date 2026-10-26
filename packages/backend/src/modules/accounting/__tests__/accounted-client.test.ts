import { describe, expect, it, vi } from 'vitest'

/**
 * `accountedVerifyWebhook` (#3019 delta) — the endpoint-verification handshake
 * call, `POST /api/v1/companies/{companyId}/webhooks/{webhookId}/verify`.
 *
 * What runs REAL here: the client function over an in-process `fetch` double.
 * What is asserted: the exact path, the bearer, the `Idempotency-Key` every
 * write in this file carries, the parsed `verification_status`, and the error
 * shape a failed handshake produces — the provider's `error.code` and
 * `details.reason`, never the key.
 *
 * The verify verb needs a LIVE key at the provider (a test key cannot run it);
 * that is a provider-side rule, not something this client can enforce, so the
 * fixture key is a live-shaped one.
 */

import { ACCOUNTED_API_BASE, accountedVerifyWebhook } from '../accounted-client.js'
import { ProviderError } from '../provider.js'

const LIVE_KEY = 'gnubok_sk_live_fixture_key'

/** One subscription as the provider returns it, with its verification status. */
function subscription(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'wh_1',
    name: 'Haven — journal_entry.committed',
    event_type: 'journal_entry.committed',
    webhook_url: 'https://api.test/accounting/webhooks/accounted/token-abc',
    active: true,
    api_version_pinned: '2026-05-12',
    disabled_at: null,
    disabled_reason: null,
    created_at: '2026-09-20T00:00:00Z',
    verification_status: 'verified',
    ...overrides,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function fetchDouble(handler: () => Response) {
  return vi.fn(async (_url: string | URL | globalThis.Request, _init?: RequestInit): Promise<Response> => handler())
}

describe('accountedVerifyWebhook (#3019 delta) — POST …/webhooks/{id}/verify', () => {
  it('POSTs the exact path with the bearer and a fresh Idempotency-Key, and returns the verification status', async () => {
    const fetchImpl = fetchDouble(() =>
      jsonResponse({ data: subscription(), meta: { request_id: 'req_1', api_version: '2026-05-12' } }),
    )

    const data = await accountedVerifyWebhook({
      apiKey: LIVE_KEY,
      companyId: 'comp_1',
      webhookId: 'wh_1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(data.verification_status).toBe('verified')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${ACCOUNTED_API_BASE}/api/v1/companies/comp_1/webhooks/wh_1/verify`)
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${LIVE_KEY}`)
    expect(headers.Accept).toBe('application/json')
    // Every write in this file carries one; the cookbook's verify curl omits
    // it, so the provider ignores an unknown header and the rule stays uniform.
    expect(headers['Idempotency-Key']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('a fresh Idempotency-Key per call (a retry is a new attempt, not a replay)', async () => {
    const fetchImpl = fetchDouble(() =>
      jsonResponse({ data: subscription(), meta: { request_id: 'req_1', api_version: '2026-05-12' } }),
    )
    const call = () =>
      accountedVerifyWebhook({ apiKey: LIVE_KEY, companyId: 'comp_1', webhookId: 'wh_1', fetchImpl: fetchImpl as unknown as typeof fetch })
    await call()
    await call()
    const first = (fetchImpl.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    const second = (fetchImpl.mock.calls[1][1] as RequestInit).headers as Record<string, string>
    expect(first['Idempotency-Key']).not.toBe(second['Idempotency-Key'])
  })

  it('a 422 WEBHOOK_VERIFICATION_FAILED throws a ProviderError carrying the code and details.reason — never the key', async () => {
    const fetchImpl = fetchDouble(() =>
      jsonResponse(
        {
          error: {
            code: 'WEBHOOK_VERIFICATION_FAILED',
            message: 'The endpoint did not echo the challenge.',
            details: { reason: 'challenge_missing' },
          },
        },
        422,
      ),
    )

    let err: unknown
    try {
      await accountedVerifyWebhook({ apiKey: LIVE_KEY, companyId: 'comp_1', webhookId: 'wh_1', fetchImpl: fetchImpl as unknown as typeof fetch })
    } catch (e) {
      err = e
    }

    expect(err).toBeInstanceOf(ProviderError)
    const providerErr = err as ProviderError & { providerCode?: string; details?: Record<string, unknown> }
    expect(providerErr.status).toBe(422)
    expect(providerErr.provider).toBe('accounted')
    expect(providerErr.providerCode).toBe('WEBHOOK_VERIFICATION_FAILED')
    expect(providerErr.details?.reason).toBe('challenge_missing')
    // The message names the request and the provider's code — never the key.
    expect(providerErr.message).toContain('WEBHOOK_VERIFICATION_FAILED')
    expect(providerErr.message).toContain('/webhooks/wh_1/verify')
    expect(providerErr.message).not.toContain(LIVE_KEY)
  })

  it('a 422 with no details still surfaces the code (the reason is optional)', async () => {
    const fetchImpl = fetchDouble(() => jsonResponse({ error: { code: 'WEBHOOK_VERIFICATION_FAILED' } }, 422))
    let err: unknown
    try {
      await accountedVerifyWebhook({ apiKey: LIVE_KEY, companyId: 'comp_1', webhookId: 'wh_1', fetchImpl: fetchImpl as unknown as typeof fetch })
    } catch (e) {
      err = e
    }
    const providerErr = err as ProviderError & { providerCode?: string; details?: Record<string, unknown> }
    expect(providerErr.providerCode).toBe('WEBHOOK_VERIFICATION_FAILED')
    expect(providerErr.details).toBeUndefined()
  })

  it('a 200 without a subscription id is a failure (the answer cannot be trusted)', async () => {
    const fetchImpl = fetchDouble(() => jsonResponse({ data: { verification_status: 'verified' } }))
    await expect(
      accountedVerifyWebhook({ apiKey: LIVE_KEY, companyId: 'comp_1', webhookId: 'wh_1', fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toBeInstanceOf(ProviderError)
  })

  it('an unreachable provider throws a ProviderError with status 0 (an outage is not a verdict)', async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => {
      throw new Error('network down')
    })
    let err: unknown
    try {
      await accountedVerifyWebhook({ apiKey: LIVE_KEY, companyId: 'comp_1', webhookId: 'wh_1', fetchImpl: fetchImpl as unknown as typeof fetch })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ProviderError)
    expect((err as ProviderError).status).toBe(0)
  })

  it('the company and webhook ids are URL-encoded (a provider id is opaque)', async () => {
    const fetchImpl = fetchDouble(() =>
      jsonResponse({ data: subscription({ id: 'wh/1' }), meta: { request_id: 'req_1', api_version: '2026-05-12' } }),
    )
    await accountedVerifyWebhook({ apiKey: LIVE_KEY, companyId: 'comp 1', webhookId: 'wh/1', fetchImpl: fetchImpl as unknown as typeof fetch })
    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${ACCOUNTED_API_BASE}/api/v1/companies/comp%201/webhooks/wh%2F1/verify`)
  })
})
