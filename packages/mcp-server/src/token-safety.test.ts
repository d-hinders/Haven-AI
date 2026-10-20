/**
 * #4107 — the token-safety check, end to end through the handler.
 *
 * The load-bearing properties:
 *  - the tool talks to EXACTLY ONE host — the pinned operator — and only its
 *    FREE preview endpoint; no Haven route, no paid path, no payment
 *    machinery is touched (the paid gate's recipe names the standard rail).
 *  - every transport/parse/shape failure is an explicit "the check did NOT
 *    run" refusal (TOKEN_SAFETY_CHECK_UNAVAILABLE), never a pass-shaped
 *    answer.
 *  - the hosted egress policy runs before anything connects, redirects are
 *    never followed, and the body is read under the policy's byte cap.
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  MerchantEgressRefusedError,
  type MerchantEgressPolicy,
  type HavenClient,
} from '@haven_ai/sdk'
import { createTokenSafetyHandlers } from './tools/token-safety.js'

const OPERATOR = 'https://x402-data-api.sigrunner.workers.dev'

const GATE_BODY = {
  token: '0x4200000000000000000000000000000000000006',
  side: 'buy',
  notional_usd: 100,
  decision: 'go',
  reason: 'token passes safety checks',
  verdict: 'SAFE',
  risk_score: 0,
  liquidity_usd: null,
  impact_pct_of_pool: null,
  flags: ['no honeypot, deep liquidity, no high-risk admin controls detected'],
  token_meta: { symbol: 'WETH', name: 'Wrapped Ether', decimals: 18 },
  analyzed_at: '2026-10-20T11:47:10.142Z',
  disclaimer: 'Heuristic risk signal, not financial advice or a guarantee.',
  trial: { real_token_checks_left_today: 2 },
}

/** A plain-object Haven carrying only the merchantEgress the handler reads. */
function havenWith(egress?: MerchantEgressPolicy): HavenClient {
  return { merchantEgress: egress } as unknown as HavenClient
}

const handlers = () => createTokenSafetyHandlers(havenWith()).haven_check_token_safety

function recordedFetch(responder: (url: string) => Response | Promise<Response> | never) {
  const calls: string[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString()
    calls.push(url)
    return responder(url)
  })
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('haven_check_token_safety', () => {
  it('maps the operator verdict and never names a payment', async () => {
    const calls = recordedFetch(() => new Response(JSON.stringify(GATE_BODY), { status: 200 }))
    const out = (await handlers()({ token: '0x4200000000000000000000000000000000000006' })) as {
      success: boolean
      data: Record<string, any>
    }
    expect(out.success).toBe(true)
    expect(out.data.decision).toBe('go')
    expect(out.data.verdict).toBe('SAFE')
    expect(out.data.risk_score).toBe(0)
    expect(out.data.flags).toEqual(GATE_BODY.flags)
    expect(out.data.trial).toEqual(GATE_BODY.trial)
    expect(out.data.check.payment_made).toBe(false)
    expect(out.data.paid_gate.url).toBe(
      `${OPERATOR}/gate/swap?token=0x4200000000000000000000000000000000000006&side=buy&notional_usd=100`,
    )
    expect(calls).toEqual([
      `${OPERATOR}/gate/swap/preview?token=0x4200000000000000000000000000000000000006&side=buy&notional_usd=100`,
    ])
  })

  it('defaults side to buy and notional_usd to 100, and passes demo aliases through', async () => {
    const calls = recordedFetch(() => new Response(JSON.stringify(GATE_BODY), { status: 200 }))
    await handlers()({ token: 'weth' })
    expect(calls).toEqual([`${OPERATOR}/gate/swap/preview?token=weth&side=buy&notional_usd=100`])
  })

  it('honours an explicit side and notional_usd on both URLs', async () => {
    const calls = recordedFetch(() => new Response(JSON.stringify(GATE_BODY), { status: 200 }))
    const out = (await handlers()({ token: '0x4200000000000000000000000000000000000006', side: 'sell', notional_usd: 50 })) as {
      success: boolean
      data: Record<string, any>
    }
    expect(out.data.paid_gate.url).toBe(
      `${OPERATOR}/gate/swap?token=0x4200000000000000000000000000000000000006&side=sell&notional_usd=50`,
    )
    expect(calls[0]).toContain('side=sell')
    expect(calls[0]).toContain('notional_usd=50')
  })

  it('refuses a malformed token before anything connects', async () => {
    const calls = recordedFetch(() => {
      throw new Error('must not connect')
    })
    const out = (await handlers()({ token: '0xdead' })) as { success: boolean; message?: string }
    expect(out.success).toBe(false)
    expect(out.message).toContain('token must be a 0x-prefixed 20-byte Base address')
    expect(calls).toEqual([])
  })

  it('refuses before connecting when the egress policy refuses the operator URL', async () => {
    const calls = recordedFetch(() => {
      throw new Error('must not connect')
    })
    const refused = createTokenSafetyHandlers(
      havenWith({
        assertUrl: () => {
          throw new MerchantEgressRefusedError('egress denied', 'url', 'url_not_allowed', true)
        },
      }),
    ).haven_check_token_safety
    const out = (await refused({ token: 'weth' })) as { success: boolean; code?: string; message?: string }
    expect(out.success).toBe(false)
    expect(out.code).toBe('MERCHANT_EGRESS_REFUSED')
    expect(calls).toEqual([])
  })

  it('answers an operator 5xx with an explicit did-NOT-run refusal, never a pass', async () => {
    recordedFetch(() => new Response('down', { status: 503 }))
    const out = (await handlers()({ token: 'weth' })) as { success: boolean; code?: string; message?: string }
    expect(out.success).toBe(false)
    expect(out.code).toBe('TOKEN_SAFETY_CHECK_UNAVAILABLE')
    expect(out.message).toContain('did NOT run')
    expect(out.message).toContain('NOT a pass')
    expect(out.message).toContain('Nothing was spent')
  })

  it('never follows a redirect — a 3xx is an unavailable check, not a hop', async () => {
    const calls = recordedFetch(
      () => new Response(null, { status: 302, headers: { location: 'https://evil.example/gate' } }),
    )
    const out = (await handlers()({ token: 'weth' })) as { success: boolean; code?: string; message?: string }
    expect(out.success).toBe(false)
    expect(out.code).toBe('TOKEN_SAFETY_CHECK_UNAVAILABLE')
    expect(out.message).toContain('redirects are not followed')
    expect(calls).toHaveLength(1)
  })

  it('refuses a non-JSON body', async () => {
    recordedFetch(() => new Response('<html>bot wall</html>', { status: 200 }))
    const out = (await handlers()({ token: 'weth' })) as { success: boolean; code?: string; message?: string }
    expect(out.success).toBe(false)
    expect(out.code).toBe('TOKEN_SAFETY_CHECK_UNAVAILABLE')
    expect(out.message).toContain('not JSON')
  })

  it('refuses an operator error object and carries its message', async () => {
    recordedFetch(() => new Response(JSON.stringify({ error: 'rate limited' }), { status: 200 }))
    const out = (await handlers()({ token: 'weth' })) as { success: boolean; code?: string; message?: string }
    expect(out.success).toBe(false)
    expect(out.code).toBe('TOKEN_SAFETY_CHECK_UNAVAILABLE')
    expect(out.message).toContain('rate limited')
  })

  it('refuses a body without the operator decision shape', async () => {
    recordedFetch(() => new Response(JSON.stringify({ hello: 'world' }), { status: 200 }))
    const out = (await handlers()({ token: 'weth' })) as { success: boolean; code?: string; message?: string }
    expect(out.success).toBe(false)
    expect(out.code).toBe('TOKEN_SAFETY_CHECK_UNAVAILABLE')
    expect(out.message).toContain('decision and verdict')
  })

  it('aborts a body that grows past the policy cap while it is being read', async () => {
    const big = JSON.stringify({ ...GATE_BODY, flags: ['x'.repeat(4096)] })
    recordedFetch(() => new Response(big, { status: 200 }))
    const capped = createTokenSafetyHandlers(
      havenWith({ assertUrl: () => undefined, maxResponseBytes: 16 }),
    ).haven_check_token_safety
    const out = (await capped({ token: 'weth' })) as { success: boolean; code?: string; message?: string }
    expect(out.success).toBe(false)
    expect(out.code).toBe('TOKEN_SAFETY_CHECK_UNAVAILABLE')
    expect(out.message).toContain('read cap')
  })

  it('answers a transport failure with the same explicit refusal', async () => {
    recordedFetch(() => {
      throw new TypeError('fetch failed')
    })
    const out = (await handlers()({ token: 'weth' })) as { success: boolean; code?: string; message?: string }
    expect(out.success).toBe(false)
    expect(out.code).toBe('TOKEN_SAFETY_CHECK_UNAVAILABLE')
    expect(out.message).toContain('preview request failed')
  })

  it('the refusal hands back an omitted-tool next step, not a spend', async () => {
    recordedFetch(() => new Response('down', { status: 500 }))
    const out = (await handlers()({ token: 'weth' })) as { success: boolean; next_tool_omitted_reason?: string }
    expect(out.next_tool_omitted_reason).toContain('re-call haven_check_token_safety')
    expect(out.next_tool_omitted_reason).toContain('no payment')
  })
})
