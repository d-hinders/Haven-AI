/**
 * #3747 — the merchant-egress policy: the strict hosted string check, the
 * transport's policy path (pre-connect refusals, re-checked GET redirects,
 * while-reading byte caps, per-use budgets), discovery under the policy, and
 * the characterization that WITHOUT a policy nothing changes.
 */
import { describe, expect, it, vi } from 'vitest'
import { McpMerchantTransport } from './mcp-merchant-transport.js'
import {
  HOSTED_EGRESS_TIMEOUTS,
  HOSTED_MAX_GET_REDIRECTS,
  HOSTED_RESPONSE_BYTE_CAPS,
  MerchantEgressRefusedError,
  MerchantEgressResponseCapError,
  MerchantTimeoutError,
  assertPublicHttpsMerchantUrl,
  discoverMerchantMcpUrl,
  isPublicHttpsMerchantUrl,
  strictMerchantEgressPolicy,
} from './index.js'
import type { MerchantEgressPolicy } from './index.js'

type FetchSpy = (url: string | URL | Request, init?: RequestInit) => Promise<Response>

const ALLOW_FIXTURES: MerchantEgressPolicy = {
  // The explicit test seam shape: strict rules, but the http loopback fixture
  // origin is admitted. Budgets stay enforced.
  assertUrl(url: string) {
    if (url.startsWith('http://127.0.0.1')) return
    assertPublicHttpsMerchantUrl(url)
  },
  maxResponseBytes: 4096,
  maxGetRedirects: 3,
  timeouts: { quote: 100, mcpSession: 100, discovery: 100, delivery: 100 },
}

function transportWith(policy: MerchantEgressPolicy | undefined, fetchImpl: FetchSpy): McpMerchantTransport {
  return new McpMerchantTransport({ merchantTimeout: 300_000, egress: policy, fetch: fetchImpl })
}

function recordingFetch(responder: (url: string, init?: RequestInit) => Response | Promise<Response>): FetchSpy & { calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const impl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    calls.push({ url, init })
    return responder(url, init)
  }
  return Object.assign(impl, { calls }) as FetchSpy & { calls: Array<{ url: string; init?: RequestInit }> }
}

const okText = (body: string, init: ResponseInit = {}): Response =>
  new Response(body, { status: 200, ...init })

/** Settle a promise, so a wrong outcome fails on an assertion rather than on a thrown error. */
async function settleOf<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await p }
  } catch (error) {
    return { ok: false, error }
  }
}

describe('isPublicHttpsMerchantUrl — the strict hosted string check', () => {
  it('allows https to a public host on any port', () => {
    expect(isPublicHttpsMerchantUrl('https://merchant.dev')).toBe(true)
    expect(isPublicHttpsMerchantUrl('https://merchant.dev:8443/mcp')).toBe(true)
  })

  it('refuses http', () => {
    expect(isPublicHttpsMerchantUrl('http://merchant.example')).toBe(false)
  })

  it('refuses IP literals, v4 and v6', () => {
    expect(isPublicHttpsMerchantUrl('https://192.168.1.10/')).toBe(false)
    expect(isPublicHttpsMerchantUrl('https://[::1]:3000/')).toBe(false)
    expect(isPublicHttpsMerchantUrl('https://[fe80::1]/')).toBe(false)
    // URL normalises the exotic spellings to dotted decimal before the check.
    expect(isPublicHttpsMerchantUrl('https://2130706433/')).toBe(false)
    expect(isPublicHttpsMerchantUrl('https://0x7f.0.0.1/')).toBe(false)
  })

  it('refuses localhost, single-label hosts and internal/reserved suffixes', () => {
    expect(isPublicHttpsMerchantUrl('https://localhost:3001/')).toBe(false)
    expect(isPublicHttpsMerchantUrl('https://myhost/')).toBe(false)
    expect(isPublicHttpsMerchantUrl('https://haven-ai.railway.internal/')).toBe(false)
    expect(isPublicHttpsMerchantUrl('https://printer.local/')).toBe(false)
    expect(isPublicHttpsMerchantUrl('https://api.localhost/')).toBe(false)
    expect(isPublicHttpsMerchantUrl('https://fixture.test/')).toBe(false)
    expect(isPublicHttpsMerchantUrl('https://nope.invalid/')).toBe(false)
    expect(isPublicHttpsMerchantUrl('https://doc.example/')).toBe(false)
  })

  it('refuses the acceptance-criteria host forms: trailing dots, IPv4-mapped v6, short integer hosts', () => {
    // Trailing-dot forms (the dot-strip trick), the IPv4-mapped IPv6 literal
    // (its mapped v4 is loopback), and the short integer form URL normalises
    // to 0.0.0.0. Round-2 review probe: all four were already refused — these
    // rows pin them.
    expect(isPublicHttpsMerchantUrl('https://localhost./')).toBe(false)
    expect(isPublicHttpsMerchantUrl('https://x.railway.internal./')).toBe(false)
    expect(isPublicHttpsMerchantUrl('https://[::ffff:7f00:1]/')).toBe(false)
    expect(isPublicHttpsMerchantUrl('https://0/')).toBe(false)
  })

  it('assertPublicHttpsMerchantUrl throws a before-request refusal naming the reason', () => {
    expect(() => assertPublicHttpsMerchantUrl('https://haven-ai.railway.internal/')).toThrowError(
      MerchantEgressRefusedError,
    )
    try {
      assertPublicHttpsMerchantUrl('https://192.168.1.10/')
    } catch (err) {
      const refused = err as MerchantEgressRefusedError
      expect(refused.code).toBe('MERCHANT_EGRESS_REFUSED')
      expect(refused.beforeRequest).toBe(true)
      expect(refused.refusal).toBe('url_not_allowed')
      expect(refused.message).toContain('IP-literal host (IPv4)')
    }
  })
})

describe('strictMerchantEgressPolicy — the hosted budgets are pinned', () => {
  it('carries the short probe budgets, the finite delivery budget, 3 hops and a while-reading cap', () => {
    const policy = strictMerchantEgressPolicy()
    expect(policy.timeouts).toEqual(HOSTED_EGRESS_TIMEOUTS)
    expect(HOSTED_EGRESS_TIMEOUTS.quote).toBe(15_000)
    expect(HOSTED_EGRESS_TIMEOUTS.mcpSession).toBe(15_000)
    expect(HOSTED_EGRESS_TIMEOUTS.discovery).toBe(5_000)
    expect(HOSTED_EGRESS_TIMEOUTS.delivery).toBe(300_000)
    expect(policy.maxGetRedirects).toBe(3)
    expect(policy.maxGetRedirects).toBe(HOSTED_MAX_GET_REDIRECTS)
    expect(policy.maxResponseBytes).toBe(HOSTED_RESPONSE_BYTE_CAPS.delivery)
    expect(policy.responseByteCaps).toEqual(HOSTED_RESPONSE_BYTE_CAPS)
    expect(policy.assertUrl).toBe(assertPublicHttpsMerchantUrl)
  })
})

describe('McpMerchantTransport under a policy — refusal before any connection', () => {
  const refusedShapes = [
    'http://merchant.example/paid',
    'https://192.168.1.10/paid',
    'https://[::1]:3000/paid',
    'https://localhost:3001/paid',
    'https://myhost/paid',
    'https://haven-ai.railway.internal/paid',
    // Round-2 review: the acceptance criteria name these four host forms —
    // trailing-dot spellings, the IPv4-mapped v6 literal, and the short
    // integer host (URL normalises it to 0.0.0.0).
    'https://localhost./paid',
    'https://x.railway.internal./paid',
    'https://[::ffff:7f00:1]/paid',
    'https://0/paid',
  ]

  for (const url of refusedShapes) {
    it(`never connects for ${url}`, async () => {
      const fetchSpy = recordingFetch(() => okText('should never be fetched'))
      const transport = transportWith(strictMerchantEgressPolicy(), fetchSpy)
      await expect(transport.fetch(url)).rejects.toMatchObject({
        code: 'MERCHANT_EGRESS_REFUSED',
        beforeRequest: true,
      })
      expect(fetchSpy.calls).toEqual([])
    })
  }

  it('a pre-send refusal during a quote use throws before the timeout machinery matters', async () => {
    const fetchSpy = recordingFetch(() => okText('nope'))
    const transport = transportWith({ ...ALLOW_FIXTURES, timeouts: { quote: 5 } }, fetchSpy)
    await expect(transport.fetch('https://internal.example/x', {}, 5)).rejects.toBeInstanceOf(
      MerchantEgressRefusedError,
    )
    expect(fetchSpy.calls).toEqual([])
  })
})

describe('McpMerchantTransport under a policy — redirects', () => {
  it('follows GET redirects up to the budget with every hop re-checked, and carries no body cap violation', async () => {
    const fetchSpy = recordingFetch((url) => {
      if (url === 'https://a.dev/start') {
        return new Response(null, { status: 302, headers: { location: 'https://b.dev/next' } })
      }
      if (url === 'https://b.dev/next') {
        return new Response(null, { status: 307, headers: { location: 'https://c.dev/end' } })
      }
      return okText('arrived')
    })
    const transport = transportWith(ALLOW_FIXTURES, fetchSpy)
    const response = await transport.fetch('https://a.dev/start')
    expect(await response.text()).toBe('arrived')
    expect(fetchSpy.calls.map((c) => c.url)).toEqual([
      'https://a.dev/start',
      'https://b.dev/next',
      'https://c.dev/end',
    ])
    for (const call of fetchSpy.calls) expect(call.init?.redirect).toBe('manual')
  })

  it('refuses a redirect to a refused host AT THAT HOP, without connecting to it', async () => {
    const fetchSpy = recordingFetch((url) =>
      url === 'https://a.dev/start'
        ? new Response(null, { status: 302, headers: { location: 'https://haven-ai.railway.internal/admin' } })
        : okText('leak'),
    )
    const transport = transportWith(strictMerchantEgressPolicy(), fetchSpy)
    await expect(transport.fetch('https://a.dev/start')).rejects.toMatchObject({
      code: 'MERCHANT_EGRESS_REFUSED',
      beforeRequest: false,
    })
    expect(fetchSpy.calls.map((c) => c.url)).toEqual(['https://a.dev/start'])
  })

  it('refuses a redirect chain past the hop budget', async () => {
    let n = 0
    const fetchSpy = recordingFetch(() =>
      new Response(null, { status: 302, headers: { location: `https://hop${++n}.dev/` } }),
    )
    const transport = transportWith(ALLOW_FIXTURES, fetchSpy)
    await expect(transport.fetch('https://a.dev/start')).rejects.toMatchObject({
      refusal: 'redirect_budget_exceeded',
    })
    // The original plus exactly the three allowed hops; the FOURTH redirect
    // is refused before it connects.
    expect(fetchSpy.calls).toHaveLength(4)
  })

  it('refuses a redirect on a POST — the payment header is never sent to a redirect target', async () => {
    const fetchSpy = recordingFetch(() =>
      new Response(null, { status: 302, headers: { location: 'https://b.dev/catch' } }),
    )
    const transport = transportWith(ALLOW_FIXTURES, fetchSpy)
    await expect(
      transport.deliverPayment('https://a.dev/paid', { method: 'POST' }, 'HEADER'),
    ).rejects.toMatchObject({ refusal: 'redirect_on_non_get', beforeRequest: false })
    // The one request that went out was the checked original; the redirect
    // target was never contacted and never received the header.
    expect(fetchSpy.calls).toHaveLength(1)
    expect(fetchSpy.calls[0].url).toBe('https://a.dev/paid')
  })
})

describe('McpMerchantTransport under a policy — the shared loop keeps the policy branches (#4257)', () => {
  it('a Location-less 3xx is refused, not returned', async () => {
    const fetchSpy = recordingFetch(() => new Response(null, { status: 302 }))
    const result = await settleOf(transportWith(ALLOW_FIXTURES, fetchSpy).fetch('https://a.dev/start'))
    expect(result.ok).toBe(false)
    expect(result.ok ? undefined : result.error).toMatchObject({ refusal: 'redirect_missing_location', beforeRequest: false })
  })

  it('a policy without maxGetRedirects follows no redirect at all', async () => {
    const { maxGetRedirects: _unset, ...noBudget } = ALLOW_FIXTURES
    const fetchSpy = recordingFetch((url) =>
      url === 'https://a.dev/start' ? new Response(null, { status: 302, headers: { location: '/next' } }) : okText('arrived'),
    )
    const result = await settleOf(transportWith(noBudget, fetchSpy).fetch('https://a.dev/start'))
    expect(result.ok).toBe(false)
    expect(result.ok ? undefined : result.error).toMatchObject({ refusal: 'redirect_budget_exceeded' })
    expect(fetchSpy.calls).toHaveLength(1)
  })
})

describe('McpMerchantTransport under a policy — redirect hops and caller headers (#4244)', () => {
  const sentHeaders = (init?: RequestInit): Record<string, string> =>
    Object.fromEntries(new Headers(init?.headers))

  const CALLER_HEADERS = {
    Authorization: 'Bearer merchant-a-token',
    'Proxy-Authorization': 'Basic proxy',
    Cookie: 'session=a',
    'X-Api-Key': 'merchant-a-key',
    'PAYMENT-SIGNATURE': 'signed-for-a',
    Accept: 'application/json',
    'User-Agent': 'haven-test',
    'x402-wallet': '0x0000000000000000000000000000000000000001',
  }

  it('characterization: a same-origin GET redirect still carries every caller header', async () => {
    const fetchSpy = recordingFetch((url) =>
      url === 'https://a.dev/start'
        ? new Response(null, { status: 302, headers: { location: '/next' } })
        : okText('arrived'),
    )
    const transport = transportWith(ALLOW_FIXTURES, fetchSpy)
    await transport.fetch('https://a.dev/start', { headers: CALLER_HEADERS })
    expect(fetchSpy.calls.map((c) => c.url)).toEqual(['https://a.dev/start', 'https://a.dev/next'])
    expect(sentHeaders(fetchSpy.calls[1].init)).toEqual(sentHeaders({ headers: CALLER_HEADERS }))
  })

  it('a same-origin hop from a non-normalised URL (upper-case host, default port) keeps every caller header', async () => {
    const fetchSpy = recordingFetch((url) =>
      url === 'https://A.dev:443/start'
        ? new Response(null, { status: 302, headers: { location: '/next' } })
        : okText('arrived'),
    )
    await transportWith(ALLOW_FIXTURES, fetchSpy).fetch('https://A.dev:443/start', { headers: CALLER_HEADERS })
    expect(fetchSpy.calls.map((c) => c.url)).toEqual(['https://A.dev:443/start', 'https://a.dev/next'])
    expect(sentHeaders(fetchSpy.calls[1].init)).toEqual(sentHeaders({ headers: CALLER_HEADERS }))
  })

  it('a cross-origin hop drops credentials and every caller header outside the allow-list', async () => {
    const fetchSpy = recordingFetch((url) =>
      url === 'https://a.dev/start'
        ? new Response(null, { status: 302, headers: { location: 'https://b.dev/next' } })
        : okText('arrived'),
    )
    const transport = transportWith(ALLOW_FIXTURES, fetchSpy)
    await transport.fetch('https://a.dev/start', { headers: CALLER_HEADERS })
    // The checked original still carries what the caller sent it.
    expect(sentHeaders(fetchSpy.calls[0].init)).toMatchObject({ authorization: 'Bearer merchant-a-token' })
    expect(sentHeaders(fetchSpy.calls[1].init)).toEqual({
      accept: 'application/json',
      'user-agent': 'haven-test',
      'x402-wallet': '0x0000000000000000000000000000000000000001',
    })
  })

  it('a different port is a different origin', async () => {
    const fetchSpy = recordingFetch((url) =>
      url === 'https://a.dev/start'
        ? new Response(null, { status: 302, headers: { location: 'https://a.dev:8443/next' } })
        : okText('arrived'),
    )
    const transport = transportWith(ALLOW_FIXTURES, fetchSpy)
    await transport.fetch('https://a.dev/start', { headers: { Authorization: 'Bearer t' } })
    expect(sentHeaders(fetchSpy.calls[1].init)).toEqual({})
  })

  it('strips headers given as a Headers object or as an array of pairs', async () => {
    for (const headers of [
      new Headers({ Authorization: 'Bearer t', Accept: 'text/plain' }),
      [['Authorization', 'Bearer t'], ['Accept', 'text/plain']] as Array<[string, string]>,
    ]) {
      const fetchSpy = recordingFetch((url) =>
        url === 'https://a.dev/start'
          ? new Response(null, { status: 302, headers: { location: 'https://b.dev/next' } })
          : okText('arrived'),
      )
      await transportWith(ALLOW_FIXTURES, fetchSpy).fetch('https://a.dev/start', { headers })
      expect(sentHeaders(fetchSpy.calls[1].init)).toEqual({ accept: 'text/plain' })
    }
  })

  it('once stripped, a later hop back to the first origin does not regain them', async () => {
    const fetchSpy = recordingFetch((url) => {
      if (url === 'https://a.dev/start') return new Response(null, { status: 302, headers: { location: 'https://b.dev/x' } })
      if (url === 'https://b.dev/x') return new Response(null, { status: 302, headers: { location: 'https://a.dev/back' } })
      return okText('arrived')
    })
    await transportWith(ALLOW_FIXTURES, fetchSpy).fetch('https://a.dev/start', { headers: { Authorization: 'Bearer t' } })
    expect(fetchSpy.calls.map((c) => c.url)).toEqual(['https://a.dev/start', 'https://b.dev/x', 'https://a.dev/back'])
    expect(sentHeaders(fetchSpy.calls[2].init)).toEqual({})
  })
})

describe('McpMerchantTransport under a policy — the byte cap holds WHILE reading', () => {
  it('aborts an endless response mid-read with the cap error, without buffering it', async () => {
    // Pull-based: the source only produces when the (capped) read pulls, so a
    // refusal leaves nothing spinning and nothing buffered.
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024).fill(0x61))
      },
    })
    const fetchSpy = recordingFetch(() => new Response(endless, { status: 200 }))
    const transport = transportWith(ALLOW_FIXTURES, fetchSpy)
    const response = await transport.fetch('https://a.dev/stream')
    await expect(response.text()).rejects.toBeInstanceOf(MerchantEgressResponseCapError)
  }, 5_000)

  it('a body under the cap reads normally', async () => {
    const fetchSpy = recordingFetch(() => okText('small'))
    const transport = transportWith(ALLOW_FIXTURES, fetchSpy)
    const response = await transport.fetch('https://a.dev/small')
    await expect(response.text()).resolves.toBe('small')
  })
})

describe('McpMerchantTransport under a policy — per-use budgets', () => {
  it('budgetFor resolves the policy timeouts per use and falls back to merchantTimeout where unset', () => {
    const transport = transportWith({ ...ALLOW_FIXTURES, timeouts: { quote: 100, delivery: 300_000 } }, recordingFetch(() => okText('')))
    expect(transport.budgetFor('quote')).toBe(100)
    expect(transport.budgetFor('delivery')).toBe(300_000)
    // Unset uses fall back to the client's merchantTimeout (the transport's
    // constructor default here), exactly as without a policy.
    expect(transport.budgetFor('mcpSession')).toBe(300_000)
    expect(transport.budgetFor('discovery')).toBe(300_000)
  })

  it('a per-use byte cap reaches the wire: a ~300 KiB quote body refuses at the 256 KiB quote cap', async () => {
    // Round-1 review (PROVEN at runtime): `fetch` used to drop `maxBytes` on
    // the policy path, so every use ran at the 5 MiB default and the 256 KiB
    // quote/mcpSession caps were dead. 300 KiB is over the quote cap but far
    // under the 5 MiB default, so the refusal can only be the per-use cap.
    const fetchSpy = recordingFetch(() => okText('x'.repeat(300 * 1024)))
    const transport = transportWith(strictMerchantEgressPolicy(), fetchSpy)
    // The client passes budgetFor + capFor explicitly (client.ts quote/complete/
    // resume + initialize) — mirror that call shape exactly.
    const response = await transport.fetch(
      'https://a.dev/quote',
      {},
      transport.budgetFor('quote'),
      transport.capFor('quote'),
    )
    await expect(response.text()).rejects.toBeInstanceOf(MerchantEgressResponseCapError)
  })

  it('a body under the per-use cap reads normally on a quote use', async () => {
    const fetchSpy = recordingFetch(() => okText('x'.repeat(200 * 1024)))
    const transport = transportWith(strictMerchantEgressPolicy(), fetchSpy)
    const response = await transport.fetch(
      'https://a.dev/quote',
      {},
      transport.budgetFor('quote'),
      transport.capFor('quote'),
    )
    await expect(response.text()).resolves.toHaveLength(200 * 1024)
  })

  it('a hanging quote use aborts on the policy quote budget and keeps the MerchantTimeoutError classification', async () => {
    vi.stubGlobal('fetch', (_url: string, init: RequestInit = {}) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal!.reason))
      }),
    )
    const transport = transportWith({ ...ALLOW_FIXTURES, timeouts: { quote: 40 } }, (input, init) => globalThis.fetch(input, init))
    // The client passes the budget explicitly (budgetFor) — mirror that call.
    await expect(transport.fetch('https://a.dev/slow', {}, transport.budgetFor('quote'))).rejects.toBeInstanceOf(MerchantTimeoutError)
    vi.unstubAllGlobals()
  }, 5_000)
})

describe('discoverMerchantMcpUrl under a policy', () => {
  it('refuses a disallowed input origin without fetching anything', async () => {
    const fetchSpy = recordingFetch(() => okText('{}'))
    vi.stubGlobal('fetch', fetchSpy)
    // Spec review 2026-10-07 (#2): a typed egress refusal is RETHROWN from
    // discovery — never degraded to "no discovery document".
    await expect(
      discoverMerchantMcpUrl('https://haven-ai.railway.internal/', strictMerchantEgressPolicy()),
    ).rejects.toBeInstanceOf(MerchantEgressRefusedError)
    expect(fetchSpy.calls).toEqual([])
    vi.unstubAllGlobals()
  })

  it('caps a discovery document WHILE reading it', async () => {
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024).fill(0x7b))
      },
    })
    const fetchSpy = recordingFetch(() => new Response(endless, { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    // The policy cap (64 KB) meets discovery's own 64 KB floor; the
    // never-ending document aborts the read mid-stream and surfaces the cap
    // error — a refusal is never degraded to "no discovery document"
    // (spec review 2026-10-07, #2).
    await expect(
      discoverMerchantMcpUrl('https://a.dev/', { ...ALLOW_FIXTURES, maxResponseBytes: 64 * 1024 }),
    ).rejects.toBeInstanceOf(MerchantEgressResponseCapError)
    vi.unstubAllGlobals()
  }, 5_000)
})

describe('characterization — WITHOUT a policy the transport is unchanged', () => {
  it("passes a caller's redirect: 'manual' straight to the platform and returns the 3xx as-is", async () => {
    const fetchSpy = recordingFetch(() =>
      new Response(null, { status: 302, headers: { location: 'https://b.dev/x' } }),
    )
    const transport = transportWith(undefined, fetchSpy)
    const response = await transport.fetch('https://a.dev/start', { method: 'POST', redirect: 'manual' })
    expect(response.status).toBe(302)
    expect(fetchSpy.calls).toHaveLength(1)
    expect(fetchSpy.calls[0].init?.redirect).toBe('manual')
  })

  it('budgetFor falls back to merchantTimeout for every use', () => {
    const transport = transportWith(undefined, recordingFetch(() => okText('')))
    expect(transport.budgetFor('quote')).toBe(300_000)
    expect(transport.budgetFor('mcpSession')).toBe(300_000)
    expect(transport.budgetFor('delivery')).toBe(300_000)
    expect(transport.budgetFor('discovery')).toBe(300_000)
  })

  it('unbounded bodies read normally', async () => {
    const fetchSpy = recordingFetch(() => okText('x'.repeat(3 * 4096)))
    const transport = transportWith(undefined, fetchSpy)
    const response = await transport.fetch('https://a.dev/big')
    await expect(response.text()).resolves.toHaveLength(3 * 4096)
  })
})

/** Settle a promise, so a wrong outcome fails on an assertion rather than on a thrown error. */
async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await p }
  } catch (error) {
    return { ok: false, error }
  }
}

describe('McpMerchantTransport WITHOUT a policy — the transport follows redirects itself (#4257)', () => {
  const sentHeaders = (init?: RequestInit): Record<string, string> =>
    Object.fromEntries(new Headers(init?.headers))

  const CALLER_HEADERS = {
    Authorization: 'Bearer merchant-a-token',
    Cookie: 'session=a',
    'X-Api-Key': 'merchant-a-key',
    'PAYMENT-SIGNATURE': 'signed-for-a',
    Accept: 'application/json',
  }

  it('follows with redirect: manual so no hop is left to the platform', async () => {
    const fetchSpy = recordingFetch((url) =>
      url === 'https://a.dev/start'
        ? new Response(null, { status: 302, headers: { location: '/next' } })
        : okText('arrived'),
    )
    await transportWith(undefined, fetchSpy).fetch('https://a.dev/start', { headers: CALLER_HEADERS })
    expect(fetchSpy.calls.map((c) => c.init?.redirect)).toEqual(['manual', 'manual'])
    expect(sentHeaders(fetchSpy.calls[1].init)).toEqual(sentHeaders({ headers: CALLER_HEADERS }))
  })

  it('an https → http hop is a different origin: no credential or payment header travels in clear', async () => {
    const fetchSpy = recordingFetch((url) =>
      url === 'https://a.dev/paid'
        ? new Response(null, { status: 302, headers: { location: 'http://a.dev/paid' } })
        : okText('arrived'),
    )
    await transportWith(undefined, fetchSpy).fetch('https://a.dev/paid', { headers: CALLER_HEADERS })
    expect(sentHeaders(fetchSpy.calls[1].init)).toEqual({ accept: 'application/json' })
  })

  it('a 308 to another origin with a body is refused mid-flight and never reaches the target', async () => {
    const fetchSpy = recordingFetch((url) =>
      url === 'https://a.dev/mcp'
        ? new Response(null, { status: 308, headers: { location: 'https://b.dev/mcp' } })
        : okText('arrived'),
    )
    const result = await settle(
      transportWith(undefined, fetchSpy).fetch('https://a.dev/mcp', {
        method: 'POST',
        headers: CALLER_HEADERS,
        body: '{"params":{"_meta":{"x402/payment":"signed-for-a"}}}',
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.ok ? undefined : result.error).toMatchObject({ refusal: 'redirect_cross_origin_body', beforeRequest: false })
    expect(fetchSpy.calls.map((c) => c.url)).toEqual(['https://a.dev/mcp'])
  })

  it('a 308 to another origin on an unpaid POST follows with its body and the headers reduced', async () => {
    const fetchSpy = recordingFetch((url) =>
      url === 'https://a.dev/mcp'
        ? new Response(null, { status: 308, headers: { location: 'https://b.dev/mcp' } })
        : okText('arrived'),
    )
    const result = await settle(
      transportWith(undefined, fetchSpy).fetch('https://a.dev/mcp', { method: 'POST', headers: CALLER_HEADERS, body: '{"q":1}' }),
    )
    expect(result.ok).toBe(true)
    expect(fetchSpy.calls[1]).toMatchObject({ url: 'https://b.dev/mcp', init: { method: 'POST', body: '{"q":1}' } })
    expect(sentHeaders(fetchSpy.calls[1].init)).toEqual({ accept: 'application/json' })
  })

  it('a batch body with an x402 payment in any element is paid: a cross-origin 307 is refused', async () => {
    const fetchSpy = recordingFetch((url) =>
      url === 'https://a.dev/mcp'
        ? new Response(null, { status: 307, headers: { location: 'https://b.dev/mcp' } })
        : okText('arrived'),
    )
    const body = JSON.stringify([
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 't', _meta: { 'x402/payment': { p: 1 } } } },
    ])
    const result = await settle(transportWith(undefined, fetchSpy).fetch('https://a.dev/mcp', { method: 'POST', body }))
    expect(result.ok).toBe(false)
    expect(result.ok ? undefined : result.error).toMatchObject({ refusal: 'redirect_cross_origin_body' })
    expect(fetchSpy.calls).toHaveLength(1)
  })

  it('a byte body (Uint8Array or ArrayBuffer) with an x402 payment in _meta is paid: a cross-origin 307 is refused', async () => {
    const json = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { _meta: { 'x402/payment': { p: 1 } } } })
    const bytes = new TextEncoder().encode(json)
    for (const body of [bytes, bytes.buffer.slice(0) as ArrayBuffer]) {
      const fetchSpy = recordingFetch((url) =>
        url === 'https://a.dev/mcp'
          ? new Response(null, { status: 307, headers: { location: 'https://b.dev/mcp' } })
          : okText('arrived'),
      )
      const result = await settle(transportWith(undefined, fetchSpy).fetch('https://a.dev/mcp', { method: 'POST', body }))
      expect(result.ok).toBe(false)
      expect(result.ok ? undefined : result.error).toMatchObject({ refusal: 'redirect_cross_origin_body' })
      expect(fetchSpy.calls).toHaveLength(1)
    }
  })

  it('a body it cannot read (bytes that are not UTF-8 JSON) is not treated as paid, and follows', async () => {
    const fetchSpy = recordingFetch((url) =>
      url === 'https://a.dev/mcp'
        ? new Response(null, { status: 307, headers: { location: 'https://b.dev/mcp' } })
        : okText('arrived'),
    )
    const body = new Uint8Array([0xff, 0xfe, 0x00])
    const result = await settle(transportWith(undefined, fetchSpy).fetch('https://a.dev/mcp', { method: 'POST', body }))
    expect(result.ok).toBe(true)
    expect(fetchSpy.calls.map((c) => c.url)).toEqual(['https://a.dev/mcp', 'https://b.dev/mcp'])
  })

  it('a 302 on a paid PUT keeps the body, so crossing origin is refused', async () => {
    const fetchSpy = recordingFetch((url) =>
      url === 'https://a.dev/mcp'
        ? new Response(null, { status: 302, headers: { location: 'https://b.dev/mcp' } })
        : okText('arrived'),
    )
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { _meta: { 'x402/payment': { p: 1 } } } })
    const result = await settle(transportWith(undefined, fetchSpy).fetch('https://a.dev/mcp', { method: 'PUT', body }))
    expect(result.ok).toBe(false)
    expect(result.ok ? undefined : result.error).toMatchObject({ refusal: 'redirect_cross_origin_body', redirectStatus: 302 })
    expect(fetchSpy.calls).toHaveLength(1)
  })

  it('a 302 POST becomes a body-less GET, and the body headers go with the body', async () => {
    const fetchSpy = recordingFetch((url) =>
      url === 'https://a.dev/start'
        ? new Response(null, { status: 302, headers: { location: '/next' } })
        : okText('arrived'),
    )
    await transportWith(undefined, fetchSpy).fetch('https://a.dev/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': 'k' },
      body: '{}',
    })
    expect(fetchSpy.calls[1].init).toMatchObject({ method: 'GET', body: null })
    expect(sentHeaders(fetchSpy.calls[1].init)).toEqual({ 'x-api-key': 'k' })
  })

  it('a 307 PUT keeps its method and body on a same-origin hop', async () => {
    const fetchSpy = recordingFetch((url) =>
      url === 'https://a.dev/start'
        ? new Response(null, { status: 307, headers: { location: '/next' } })
        : okText('arrived'),
    )
    await transportWith(undefined, fetchSpy).fetch('https://a.dev/start', { method: 'PUT', body: 'payload' })
    expect(fetchSpy.calls[1].init).toMatchObject({ method: 'PUT', body: 'payload' })
  })

  it('an unresolvable Location fails like the platform, without a second request', async () => {
    const fetchSpy = recordingFetch(() =>
      new Response(null, { status: 302, headers: { location: 'http://[bad' } }),
    )
    const result = await settle(transportWith(undefined, fetchSpy).fetch('https://a.dev/start'))
    expect(result.ok).toBe(false)
    expect(result.ok ? undefined : result.error).toBeInstanceOf(TypeError)
    expect(fetchSpy.calls).toHaveLength(1)
  })
})
