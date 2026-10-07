/**
 * #3747 — the hosted egress policy, end to end through
 * `createHostedHavenClient`: refusal before any connection on every path
 * (haven_quote_x402, the quoteMcpToolCall family including discovery, and
 * the paid delivery of haven_complete_mcp_tool / haven_settle_mcp_tool), the
 * money-path routing (refused before funding; a mid-flight paid refusal goes
 * through verify-then-sweep, never a blind sweep; erc7710 never sweeps), the
 * test seam, and the pin that no non-402 body except `merchant_not_ready`
 * reaches the agent.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { encodeBase64Json, strictMerchantEgressPolicy, type MerchantEgressPolicy } from '@haven_ai/sdk'
import { createToolHandlers } from './tools.js'
import type { HostedToolName, ToolPayload } from './tools/contracts.js'
import { createHostedHavenClient } from './server.js'
import { AGENT_RESPONSE, PAYMENT_REQUIRED, fail, ok, x402PreflightStatus } from './test-support/hosted-mcp.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

type MerchantResponder = (url: string, init?: RequestInit) => Response | Promise<Response>

interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
}

/**
 * A fetch stub split by origin: `http://haven.test` answers backend routes,
 * everything else is the MERCHANT and is answered by `merchant`. Records every
 * call so tests can assert the merchant was never contacted.
 */
function installSplitFetch(
  backend: Record<string, { status?: number; body?: unknown }>,
  merchant: MerchantResponder,
): RecordedCall[] {
  const calls: RecordedCall[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers = Object.fromEntries(new Headers(init?.headers).entries())
    calls.push({ url, method, headers })
    const u = new URL(url)
    if (u.origin === 'http://haven.test') {
      const route = backend[`${method} ${u.pathname}`]
      return new Response(JSON.stringify(route?.body ?? {}), { status: route?.status ?? 200 })
    }
    return merchant(url, init)
  })
  return calls
}

const BACKEND_ROUTES = {
  'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
  // A payment whose funding is CONFIRMED — the only state paid delivery may run in.
  // resource_url must match the merchant_url the delivery is addressed to.
  'GET /machine-payments/pay_x402/status': {
    status: 200,
    body: x402PreflightStatus({
      status: 'confirmed',
      next_action: 'retry_original_x402_request',
      tx_hash: '0xfund',
      resource_url: 'https://merchant.dev/api',
    }),
  },
  // erc7710: 'submitted' is the correct and final Haven-side state (no funding leg).
  'GET /machine-payments/pay_7710/status': {
    status: 200,
    body: x402PreflightStatus({
      payment_id: 'pay_7710',
      status: 'submitted',
      resource_url: 'https://merchant.dev/api',
    }),
  },
}

function hostedHandlers(overrides?: { merchantEgress?: MerchantEgressPolicy }): Record<HostedToolName, (input: unknown) => Promise<ToolPayload>> {
  const haven = createHostedHavenClient({
    apiKey: 'sk_agent_test',
    baseUrl: 'http://haven.test',
    ...overrides,
  })
  return createToolHandlers(haven)
}

const REFUSED_URLS = [
  ['http', 'http://merchant.dev/paid'],
  ['IPv4 literal', 'https://192.168.1.10/paid'],
  ['IPv6 literal', 'https://[::1]:3000/paid'],
  ['localhost', 'https://localhost:3001/paid'],
  ['single-label host', 'https://intranet/paid'],
  ['*.railway.internal', 'https://haven-ai.railway.internal/paid'],
  // Round-2 review: the acceptance criteria name these four host forms —
  // trailing-dot spellings, the IPv4-mapped v6 literal, and the short
  // integer host (URL normalises it to 0.0.0.0). The check already refuses
  // all four; these rows pin it.
  ['trailing-dot localhost', 'https://localhost./paid'],
  ['trailing-dot internal', 'https://x.railway.internal./paid'],
  ['IPv4-mapped IPv6 literal', 'https://[::ffff:7f00:1]/paid'],
  ['short integer host', 'https://0/paid'],
] as const

describe('createHostedHavenClient — the policy is strict by default and seamed for tests', () => {
  it('installs strictMerchantEgressPolicy when no override is passed', () => {
    const haven = createHostedHavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    expect(haven.merchantEgress?.assertUrl).toBe(strictMerchantEgressPolicy().assertUrl)
    expect(haven.merchantEgress?.maxGetRedirects).toBe(3)
  })

  it('honours the explicit test seam', () => {
    const seam: MerchantEgressPolicy = { assertUrl() {} }
    const haven = createHostedHavenClient({ apiKey: 'sk_agent_test', merchantEgress: seam })
    expect(haven.merchantEgress).toBe(seam)
  })
})

describe('refusal before any connection — haven_quote_x402', () => {
  for (const [shape, url] of REFUSED_URLS) {
    it(`refuses a ${shape} URL without connecting`, async () => {
      const calls = installSplitFetch(BACKEND_ROUTES, () => new Response('never'))
      const result = fail(await hostedHandlers().haven_quote_x402({ url }))
      expect(result.code).toBe('MERCHANT_EGRESS_REFUSED')
      expect(result.next_tool_omitted_reason).toBeTruthy()
      expect(calls.filter((c) => c.url.startsWith(url) || (!c.url.startsWith('http://haven.test') && !c.url.includes('/machine-payments')))).toEqual([])
    })
  }

  it('the refusal names the agent-chosen URL but no resolved address', async () => {
    installSplitFetch(BACKEND_ROUTES, () => new Response('never'))
    const result = fail(await hostedHandlers().haven_quote_x402({ url: 'https://haven-ai.railway.internal/paid' }))
    expect(result.message).toContain('haven-ai.railway.internal')
    expect(result.message).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/)
  })
})

describe('refusal before any connection — the quoteMcpToolCall family (quote + pay + discovery)', () => {
  it('haven_quote_mcp_tool refuses an http merchant_url before the probe (the hosted egress refusal surfaces, not the SDK INSECURE_RETRY_TARGET)', async () => {
    const calls = installSplitFetch(BACKEND_ROUTES, () => new Response('never'))
    const result = fail(await hostedHandlers().haven_quote_mcp_tool({ merchant_url: 'http://merchant.dev/mcp', tool_name: 'create_text' }))
    // Round 2 of the 2026-10-07 spec review: the hosted egress policy runs
    // FIRST, ahead of assertSecureMerchantUrl — its refusal is the hosted-
    // accurate one (https-only), and the #3097 SDK rule never gets a turn.
    expect(result.code).toBe('MERCHANT_EGRESS_REFUSED')
    expect(calls.filter((c) => !c.url.startsWith('http://haven.test'))).toEqual([])
  })

  for (const [shape, url] of REFUSED_URLS.slice(1)) {
    it(`haven_quote_mcp_tool refuses a ${shape} merchant_url before the probe and before discovery`, async () => {
      const calls = installSplitFetch(BACKEND_ROUTES, () => new Response('never'))
      const result = fail(await hostedHandlers().haven_quote_mcp_tool({ merchant_url: url, tool_name: 'create_text' }))
      expect(result.code).toBe('MERCHANT_EGRESS_REFUSED')
      // No probe, and the #1271 discovery fallback never fetched either.
      expect(calls.filter((c) => !c.url.startsWith('http://haven.test'))).toEqual([])
    })
  }

  it('haven_pay_x402_quote refuses an https:// IP-literal target BEFORE any intent exists', async () => {
    const calls = installSplitFetch(
      { ...BACKEND_ROUTES, 'POST /x402': { status: 201, body: { payment_id: 'SHOULD_NOT_EXIST' } } },
      () => new Response('never'),
    )
    const result = fail(
      await hostedHandlers().haven_pay_x402_quote({
        payment_required: { ...PAYMENT_REQUIRED, resource: { url: 'https://10.0.0.5/paid', description: 'paid' } },
        url: 'https://10.0.0.5/paid',
        max_amount: '1500000',
      }),
    )
    expect(result.code).toBe('MERCHANT_EGRESS_REFUSED')
    expect(result.message).toContain('Nothing was funded or signed')
    expect(calls.find((c) => c.url === 'http://haven.test/x402')).toBeUndefined()
  })
})

describe('refusal BEFORE funding on the settle fast path — the resolveMerchantCallContext half', () => {
  // Explicit context (bad merchant_url supplied by the caller): the handler
  // resolves it BEFORE the funding relay / erc7710 submit, so the egress
  // policy must refuse while the intent is still pending_signature and
  // nothing has been spent. The stored-context rehydration half was validated
  // at quote time — re-asserting is a no-op there.
  const badExplicitContext = {
    signature: `0x${'11'.repeat(65)}`,
    merchant_url: 'https://10.0.0.5/paid',
    tool_name: 'create_text',
    arguments: { prompt: 'Hello' },
  }

  it('x402: an explicitly bad merchant_url refuses before the funding signature relay', async () => {
    const calls = installSplitFetch(BACKEND_ROUTES, () => new Response('never'))
    const result = fail(
      await hostedHandlers().haven_settle_mcp_tool({
        ...badExplicitContext,
        payment_id: 'pay_x402',
        payment_header: 'AAAA',
      }),
    )
    expect(result.code).toBe('MERCHANT_EGRESS_REFUSED')
    expect(result.message).toContain('Nothing was funded or signed')
    // No funding relay (POST /payments/pay_x402/sign), no merchant request —
    // the first transport-side check never got a turn because nothing was
    // sent at all.
    expect(calls.find((c) => c.method === 'POST' && c.url === 'http://haven.test/payments/pay_x402/sign')).toBeUndefined()
    expect(calls.filter((c) => !c.url.startsWith('http://haven.test'))).toEqual([])
  })

  it('erc7710: an explicitly bad merchant_url refuses before the /settle submit', async () => {
    const calls = installSplitFetch(BACKEND_ROUTES, () => new Response('never'))
    const result = fail(
      await hostedHandlers().haven_settle_mcp_tool({
        ...badExplicitContext,
        payment_id: 'pay_7710',
      }),
    )
    expect(result.code).toBe('MERCHANT_EGRESS_REFUSED')
    expect(result.message).toContain('Nothing was funded or signed')
    // The settlement child was never submitted and the merchant never called.
    expect(calls.find((c) => c.method === 'POST' && c.url === 'http://haven.test/x402/pay_7710/settle')).toBeUndefined()
    expect(calls.filter((c) => !c.url.startsWith('http://haven.test'))).toEqual([])
  })
})

describe('paid delivery — a mid-flight egress refusal is the verify-then-sweep state', () => {
  it('a 302 to the paid POST refuses with payment_id and the status-read-first sweep step — the header never reaches the redirect target', async () => {
    const calls = installSplitFetch(BACKEND_ROUTES, () =>
      new Response(null, { status: 302, headers: { location: 'https://elsewhere.dev/catch' } }),
    )
    const result = fail(
      await hostedHandlers().haven_complete_mcp_tool({
        payment_id: 'pay_x402',
        merchant_url: 'https://merchant.dev/api',
        tool_name: 'create_text',
        arguments: { prompt: 'Hello' },
        payment_header: 'AAAA',
      }),
    )
    expect(result.code).toBe('MERCHANT_EGRESS_REFUSED')
    expect(result.paymentId).toBe('pay_x402')
    expect(result.phase).toBe('funded_but_unsettled')
    expect(result.next_action).toBe('sweep_stranded_funds')
    expect(result.next_tool).toBe('mcp__haven__haven_get_payment_status')
    expect(result.next_arguments).toEqual({ payment_id: 'pay_x402' })
    expect(result.message).not.toContain('haven_sweep_delegate')
    // Exactly one merchant request — the checked original. The redirect
    // target was never contacted, so the header can never have leaked there.
    const merchantCalls = calls.filter((c) => !c.url.startsWith('http://haven.test'))
    expect(merchantCalls).toHaveLength(1)
    expect(merchantCalls[0].url).toBe('https://merchant.dev/api')
  })

  it('a response that grows past the while-reading cap refuses with the same verify-then-sweep routing', async () => {
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024).fill(0x61))
      },
    })
    installSplitFetch(BACKEND_ROUTES, () => new Response(endless, { status: 200 }))
    const result = fail(
      await hostedHandlers().haven_complete_mcp_tool({
        payment_id: 'pay_x402',
        merchant_url: 'https://merchant.dev/api',
        tool_name: 'create_text',
        arguments: { prompt: 'Hello' },
        payment_header: 'AAAA',
      }),
    )
    expect(result.code).toBe('MERCHANT_EGRESS_REFUSED')
    expect(result.paymentId).toBe('pay_x402')
    expect(result.next_action).toBe('sweep_stranded_funds')
    expect(result.next_tool).toBe('mcp__haven__haven_get_payment_status')
  }, 10_000)

  it('erc7710: the same mid-flight refusal carries NO sweep — check status later, ignore sweep guidance', async () => {
    const erc7710Header = encodeBase64Json({
      x402Version: 2,
      payload: { paymasterAndData: `0x${'33'.repeat(200)}`, signature: `0x${'11'.repeat(65)}` },
    })
    const calls = installSplitFetch(
      {
        ...BACKEND_ROUTES,
        'POST /x402/pay_7710/settle': { status: 200, body: { payment_header: erc7710Header } },
      },
      () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.dev/catch' } }),
    )
    const result = fail(
      await hostedHandlers().haven_settle_mcp_tool({
        payment_id: 'pay_7710',
        signature: `0x${'11'.repeat(65)}`,
        merchant_url: 'https://merchant.dev/api',
        tool_name: 'create_text',
        arguments: { prompt: 'Hello' },
      }),
    )
    expect(result.code).toBe('MERCHANT_EGRESS_REFUSED')
    expect(result.paymentId).toBe('pay_7710')
    expect(result.rail).toBe('erc7710')
    expect(result.phase).toBe('not_delivered')
    expect(result.next_action).toBe('check_status_later')
    expect(result.next_tool).toBe('mcp__haven__haven_get_payment_status')
    expect(JSON.stringify(result)).not.toContain('haven_sweep_delegate')
    expect(result.message).toContain('no delegate balance to strand or sweep')
  })
})

describe('the body-exposure pin — no non-402 body reaches the agent except merchant_not_ready', () => {
  it('a generic 503 answers status-only: the body never surfaces', async () => {
    installSplitFetch(BACKEND_ROUTES, () => new Response(JSON.stringify({ secret: 'internal detail' }), { status: 503 }))
    const result = fail(await hostedHandlers().haven_quote_x402({ url: 'https://merchant.dev/paid' }))
    expect(JSON.stringify(result)).not.toContain('internal detail')
  })

  it('the merchant_not_ready 503 shape is the one exception, as today (the MCP quote family maps it)', async () => {
    const mcpMerchant = async (url: string, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? init.body : ''
      if (body.includes('"method":"initialize"')) {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } }), {
          status: 200,
          headers: { 'mcp-session-id': 'sess-egress' },
        })
      }
      if (body.includes('notifications/initialized')) return new Response(null, { status: 202 })
      return new Response(
        JSON.stringify({ error: 'merchant_not_ready', reason_code: 'capacity', settlements_remaining: 2, retry_after_s: 30 }),
        { status: 503 },
      )
    }
    installSplitFetch(BACKEND_ROUTES, mcpMerchant)
    const result = fail(
      await hostedHandlers().haven_quote_mcp_tool({ merchant_url: 'https://merchant.dev/mcp', tool_name: 'create_text' }),
    )
    expect(result.code).toBe('MERCHANT_NOT_READY')
    expect(result.message).toContain('capacity')
  })
})
