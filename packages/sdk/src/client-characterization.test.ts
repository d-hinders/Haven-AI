import { afterEach, describe, expect, it, vi } from 'vitest'
import { HavenClient } from './client.js'

// Hardhat account #0. Test-only and never used for real funds.
const TEST_DELEGATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const SIGN_HASH = `0x${'11'.repeat(32)}`

interface RecordedCall {
  url: string
  method: string
  init: RequestInit
}

type RouteHandler = (call: RecordedCall) => Response | Promise<Response>

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * A strict fetch double: every request must match an explicit method + URL,
 * and repeated routes consume handlers in order. Unexpected calls fail at the
 * network boundary instead of accidentally receiving the next queued fixture.
 */
function installRoutes(routes: Record<string, RouteHandler | RouteHandler[]>): {
  calls: RecordedCall[]
  assertAllUsed: () => void
} {
  const pending = new Map(
    Object.entries(routes).map(([key, value]) => [key, Array.isArray(value) ? [...value] : [value]]),
  )
  const calls: RecordedCall[] = []

  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = (init.method ?? 'GET').toUpperCase()
    const call = { url, method, init }
    calls.push(call)

    const key = `${method} ${url}`
    const handlers = pending.get(key)
    const handler = handlers?.shift()
    if (!handler) throw new Error(`Unexpected fetch: ${key}`)
    return handler(call)
  }))

  return {
    calls,
    assertAllUsed: () => {
      const unused = [...pending.entries()]
        .filter(([, handlers]) => handlers.length > 0)
        .map(([key, handlers]) => `${key} (${handlers.length})`)
      expect(unused, `Unused fetch routes: ${unused.join(', ')}`).toEqual([])
    },
  }
}

function agentWireBody() {
  return {
    id: 'agent-1',
    name: 'Characterization agent',
    status: 'active',
    safe_address: '0x0000000000000000000000000000000000000001',
    delegate_address: '0x0000000000000000000000000000000000000002',
    chain_id: 8453,
    execution_rail: 'legacy',
  }
}

function createIntentBody(paymentId = 'pay-1') {
  return {
    payment_id: paymentId,
    status: 'pending_signature',
    expires_at: '2099-01-01T00:00:00.000Z',
    sign_data: { hash: SIGN_HASH },
  }
}

function confirmedPaymentBody(paymentId = 'pay-1') {
  return {
    payment_id: paymentId,
    status: 'confirmed',
    token: 'USDC',
    amount: '1.25',
    to: '0x0000000000000000000000000000000000000003',
    tx_hash: '0xabc',
    chain_id: 8453,
    fee: null,
    error_message: null,
    created_at: '2026-08-20T10:00:00.000Z',
    signed_at: '2026-08-20T10:00:01.000Z',
    submitted_at: '2026-08-20T10:00:02.000Z',
    confirmed_at: '2026-08-20T10:00:03.000Z',
    expires_at: '2099-01-01T00:00:00.000Z',
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('HavenClient constructor and request boundary characterization', () => {
  it('uses the documented default base URL when baseUrl is omitted', async () => {
    const routes = installRoutes({
      'GET http://localhost:3001/machine-payments/agent': () => json(agentWireBody()),
    })

    const client = new HavenClient({ apiKey: 'sk_agent_test' })
    await expect(client.getAgent()).resolves.toMatchObject({ id: 'agent-1' })

    expect(routes.calls[0]?.method).toBe('GET')
    routes.assertAllUsed()
  })

  it('trims the base URL, scopes context headers to Haven API calls, and never leaks them to merchants', async () => {
    const configuredHeaders = { 'X-Default': 'configured', 'X-Scope': 'default' }
    const routes = installRoutes({
      'GET https://haven.test/machine-payments/agent': () => json(agentWireBody()),
      'GET https://merchant.test/free-resource': () => json({ ok: true }),
    })
    const client = new HavenClient({
      apiKey: 'sk_agent_test',
      baseUrl: 'https://haven.test///',
      defaultHeaders: configuredHeaders,
    })
    configuredHeaders['X-Default'] = 'mutated-after-construction'

    await client.withRequestContext(
      { 'X-Scope': 'context', 'X-Request': 'tool-call' },
      async () => {
        await client.getAgent()
        const response = await client.fetch('https://merchant.test/free-resource', {
          headers: { 'X-Merchant-Caller': 'present' },
        })
        await expect(response.json()).resolves.toEqual({ ok: true })
      },
    )

    const apiHeaders = new Headers(routes.calls[0]?.init.headers)
    expect(apiHeaders.get('authorization')).toBe('Bearer sk_agent_test')
    expect(apiHeaders.get('content-type')).toBe('application/json')
    expect(apiHeaders.get('x-default')).toBe('configured')
    expect(apiHeaders.get('x-scope')).toBe('context')
    expect(apiHeaders.get('x-request')).toBe('tool-call')

    const merchantHeaders = new Headers(routes.calls[1]?.init.headers)
    expect(merchantHeaders.get('x-merchant-caller')).toBe('present')
    expect(merchantHeaders.get('authorization')).toBeNull()
    expect(merchantHeaders.get('x-default')).toBeNull()
    expect(merchantHeaders.get('x-scope')).toBeNull()
    expect(merchantHeaders.get('x-request')).toBeNull()
    routes.assertAllUsed()
  })

  it('aborts a hanging Haven API request at requestTimeout and reports HTTP 408 semantics', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
      expect(String(input)).toBe('https://haven.test/machine-payments/agent')
      expect(init.method).toBe('GET')
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'))
        })
      })
    }))
    const client = new HavenClient({
      apiKey: 'sk_agent_test',
      baseUrl: 'https://haven.test',
      requestTimeout: 10,
    })

    await expect(client.getAgent()).rejects.toMatchObject({
      name: 'HavenApiError',
      statusCode: 408,
      message: 'Request to /machine-payments/agent timed out',
    })
  })
})

describe('HavenClient direct-payment facade characterization', () => {
  it('refuses pay() without a local delegate key before making a request', async () => {
    const fetchMock = vi.fn(() => {
      throw new Error('pay() must fail before fetch')
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'https://haven.test' })

    await expect(client.pay({
      token: 'USDC',
      amount: '1.25',
      to: '0x0000000000000000000000000000000000000003',
    })).rejects.toMatchObject({ name: 'HavenSigningError', code: 'SIGNING_ERROR' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('creates, signs, submits, polls, and maps a confirmed direct payment', async () => {
    vi.useFakeTimers()
    const routes = installRoutes({
      'POST https://haven.test/payments': (call) => {
        expect(JSON.parse(String(call.init.body))).toEqual({
          token: 'USDC',
          amount: '1.25',
          to: '0x0000000000000000000000000000000000000003',
          idempotency_key: 'characterization-direct',
        })
        return json(createIntentBody())
      },
      'POST https://haven.test/payments/pay-1/sign': (call) => {
        expect(JSON.parse(String(call.init.body))).toEqual({
          signature: expect.stringMatching(/^0x[0-9a-f]{130}$/i),
        })
        return json({ status: 'submitted', tx_hash: '0xsubmitted' })
      },
      'GET https://haven.test/payments/pay-1': [
        () => json({
          ...confirmedPaymentBody(),
          status: 'submitted',
          tx_hash: null,
          confirmed_at: null,
        }),
        () => json(confirmedPaymentBody()),
      ],
    })
    const client = new HavenClient({
      apiKey: 'sk_agent_test',
      delegateKey: TEST_DELEGATE_KEY,
      baseUrl: 'https://haven.test',
      pollingInterval: 3_000,
    })

    const payment = client.pay({
      token: 'USDC',
      amount: '1.25',
      to: '0x0000000000000000000000000000000000000003',
      idempotencyKey: 'characterization-direct',
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(routes.calls.filter((call) => call.method === 'GET')).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(2_999)
    expect(routes.calls.filter((call) => call.method === 'GET')).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1)
    await expect(payment).resolves.toMatchObject({
      paymentId: 'pay-1',
      status: 'confirmed',
      token: 'USDC',
      amount: '1.25',
      txHash: '0xabc',
      explorerUrl: 'https://basescan.org/tx/0xabc',
    })
    routes.assertAllUsed()
  })

  it('surfaces the confirmation deadline after create and submit complete', async () => {
    vi.useFakeTimers()
    const routes = installRoutes({
      'POST https://haven.test/payments': () => json(createIntentBody('pay-timeout')),
      'POST https://haven.test/payments/pay-timeout/sign': () => json({ status: 'submitted' }),
      'GET https://haven.test/payments/pay-timeout': [
        () => json({ ...confirmedPaymentBody('pay-timeout'), status: 'submitted' }),
        () => json({ ...confirmedPaymentBody('pay-timeout'), status: 'submitted' }),
      ],
    })
    const client = new HavenClient({
      apiKey: 'sk_agent_test',
      delegateKey: TEST_DELEGATE_KEY,
      baseUrl: 'https://haven.test',
      confirmationTimeout: 50,
      pollingInterval: 25,
    })

    const payment = client.pay({
      token: 'USDC',
      amount: '1.25',
      to: '0x0000000000000000000000000000000000000003',
    })
    const timeout = expect(payment).rejects.toMatchObject({
      name: 'HavenTimeoutError',
      code: 'TIMEOUT',
      paymentId: 'pay-timeout',
    })
    await vi.advanceTimersByTimeAsync(50)
    await timeout
    routes.assertAllUsed()
  })
})

describe('HavenClient representative read, sweep, and tool facades', () => {
  it('maps the agent-actionable payment-status response', async () => {
    const routes = installRoutes({
      'GET https://haven.test/machine-payments/status-1/status': () => json({
        payment_id: 'status-1',
        kind: 'payment_intent',
        rail: 'direct',
        status: 'confirmed',
        phase: 'payment_confirmed',
        next_action: 'none',
        amount: '1.25',
        token: 'USDC',
        resource_url: null,
        merchant_address: null,
        payer_address: '0x0000000000000000000000000000000000000002',
        tx_hash: '0xabc',
        expires_at: '2099-01-01T00:00:00.000Z',
        chain_id: 8453,
        message: 'Payment confirmed.',
        fee: null,
      }),
    })
    const client = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'https://haven.test' })

    await expect(client.getPaymentStatus('status-1')).resolves.toMatchObject({
      paymentId: 'status-1',
      kind: 'payment_intent',
      rail: 'direct',
      status: 'confirmed',
      phase: 'payment_confirmed',
      nextAction: 'none',
      payerAddress: '0x0000000000000000000000000000000000000002',
      fee: null,
    })
    routes.assertAllUsed()
  })

  it('passes the keyless prepare/submit sweep wire contracts through unchanged', async () => {
    const authorization: Parameters<HavenClient['submitSweep']>[0] = {
      from: '0x0000000000000000000000000000000000000002',
      to: '0x0000000000000000000000000000000000000001',
      value: '1250000',
      validAfter: '0',
      validBefore: '2000000000',
      nonce: `0x${'22'.repeat(32)}`,
      token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      chainId: 8453,
    }
    const preparation = {
      authorization,
      expected_auth: { version: 1, message: 'bound', signature: '0xsig', signer: '0xsigner' },
      asset: 'USDC',
      amount: '1.25',
      amount_atomic: '1250000',
      chain_id: 8453,
    }
    const submission = {
      tx_hash: '0xsweep',
      asset: 'USDC',
      amount: '1.25',
      amount_atomic: '1250000',
      from_address: authorization.from,
      to_address: authorization.to,
      chain_id: 8453,
      explorer_url: 'https://basescan.org/tx/0xsweep',
    }
    const routes = installRoutes({
      'POST https://haven.test/machine-payments/sweep/prepare': (call) => {
        expect(JSON.parse(String(call.init.body))).toEqual({})
        return json(preparation)
      },
      'POST https://haven.test/machine-payments/sweep/submit': (call) => {
        expect(JSON.parse(String(call.init.body))).toEqual({ authorization, signature: '0xsigned' })
        return json(submission)
      },
    })
    const client = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'https://haven.test' })

    await expect(client.prepareSweep()).resolves.toEqual(preparation)
    await expect(client.submitSweep(authorization, '0xsigned')).resolves.toEqual(submission)
    routes.assertAllUsed()
  })

  it('keeps the make_payment adapter on the direct-pay facade and maps its result', async () => {
    const routes = installRoutes({
      'POST https://haven.test/payments': () => json(createIntentBody('tool-pay')),
      'POST https://haven.test/payments/tool-pay/sign': () => json({ status: 'submitted' }),
      'GET https://haven.test/payments/tool-pay': () => json(confirmedPaymentBody('tool-pay')),
    })
    const client = new HavenClient({
      apiKey: 'sk_agent_test',
      delegateKey: TEST_DELEGATE_KEY,
      baseUrl: 'https://haven.test',
      pollingInterval: 0,
    })

    await expect(client.executeTool('make_payment', {
      token: 'USDC',
      amount: '1.25',
      to: '0x0000000000000000000000000000000000000003',
    })).resolves.toEqual({
      success: true,
      payment_id: 'tool-pay',
      status: 'confirmed',
      tx_hash: '0xabc',
      token: 'USDC',
      amount: '1.25',
      to: '0x0000000000000000000000000000000000000003',
      explorer_url: 'https://basescan.org/tx/0xabc',
      error: null,
    })
    routes.assertAllUsed()
  })
})

describe('catalog discovery + submission (#1716)', () => {
  function client() {
    return new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'https://haven.test' })
  }

  const MIXED = {
    entries: [
      {
        id: 'dir_1', name: 'Directory Summarizer', description: 'd', category: 'api',
        resource_url: 'https://directory.example.com/mcp', rail: 'x402', protocol: 'mcp',
        tool_name: 'summarize', tool_arguments: null,
        price_display: null, price_atomic: null, asset: null, network: null,
        status: 'active', verified_at: '2026-08-23T10:00:00.000Z',
        source: 'ingestion', domain_verified: true, verified_payable: true,
      },
      {
        id: 'cur_1', name: 'Curated API', description: 'd', category: 'ai',
        resource_url: 'https://api.example.com/paid', rail: 'x402', protocol: 'http',
        tool_name: null, tool_arguments: null,
        price_display: '$0.01 USDC', price_atomic: '10000', asset: 'USDC', network: 'eip155:8453',
        status: 'active', verified_at: '2026-08-01T00:00:00.000Z',
        source: 'operator', domain_verified: false, verified_payable: false,
      },
    ],
  }

  it('maps badge fields and filters on verified/operator without an extra query param', async () => {
    const routes = installRoutes({
      'GET https://haven.test/catalog': [
        () => json(MIXED),
        () => json(MIXED),
        () => json(MIXED),
      ],
    })

    const all = await client().discoverTools({})
    expect(all).toHaveLength(2)
    expect(all[0]).toMatchObject({
      source: 'ingestion',
      domainVerified: true,
      verifiedPayable: true,
    })

    const verified = await client().discoverTools({ verified: 'verified' })
    expect(verified.map((e) => e.id)).toEqual(['dir_1'])

    const operator = await client().discoverTools({ verified: 'operator' })
    expect(operator.map((e) => e.id)).toEqual(['cur_1'])

    for (const call of routes.calls) expect(call.url).not.toContain('verified')
    routes.assertAllUsed()
  })

  it('submits a catalog entry and maps the token response', async () => {
    const routes = installRoutes({
      'POST https://haven.test/catalog/submit': (call) => {
        expect(call.init.body).toContain('"resource_url":"https://merchant.example/mcp"')
        return json(
          { id: 's1', verify_token: 'tok'.repeat(8), status: 'submitted' },
          201,
        )
      },
    })

    const result = await client().submitCatalogEntry('https://merchant.example/mcp')
    expect(result).toEqual({ id: 's1', verifyToken: 'tok'.repeat(8), status: 'submitted' })
    routes.assertAllUsed()
  })

  it('reads back a submission status with instructions', async () => {
    const routes = installRoutes({
      'GET https://haven.test/catalog/submit/s1': () =>
        json({
          id: 's1',
          status: 'submitted',
          created_at: '2026-08-23T00:00:00.000Z',
          updated_at: '2026-08-23T00:00:00.000Z',
          last_verified_at: null,
          name: null,
          description: null,
          entrypoint: null,
          instructions: {
            expires_at: '2026-08-30T00:00:00.000Z',
            well_known: {
              url: 'https://merchant.example/.well-known/haven-verify-token.txt',
              content: 'haven-domain-verification=v1.s1.proof',
              instruction: 'Serve this line',
            },
            dns_txt: {
              name: '_haven-verify.merchant.example',
              value: 'haven-domain-verification=v1.s1.proof',
              instruction: 'Publish this TXT record',
            },
          },
        }),
    })

    const status = await client().getCatalogSubmissionStatus('s1')
    expect(status.status).toBe('submitted')
    expect(status.instructions?.well_known.url).toContain('.well-known/haven-verify-')
    routes.assertAllUsed()
  })
})
