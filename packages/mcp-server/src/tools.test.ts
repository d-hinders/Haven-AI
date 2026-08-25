import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import {
  AgentPaymentFailureCode,
  AgentPaymentNextAction,
  AgentPaymentPhase,
  HavenApiError,
  HavenClient,
  MerchantTimeoutError,
  SIGNER_UPDATE_FALLBACK,
} from '@haven_ai/sdk'
import { createToolHandlers, type ToolSuccess, type ToolPayload } from './tools.js'

const DELEGATE_KEY = '0x' + 'a'.repeat(64)
const HEADER_SIGNING_KEY = '0x' + '12'.repeat(32)
const X402_EXPECTED_AUTH = {
  version: 1 as const,
  message: 'Haven x402 expected context v1\n{}',
  signature: '0x' + '11'.repeat(65),
  signer: '0x000000000000000000000000000000000000bEEF',
}

interface CapturedCall {
  url: string
  method: string
  body: Record<string, unknown> | undefined
  headers: Record<string, string>
}

let calls: CapturedCall[]

interface RouteDefinition {
  status?: number
  body?: unknown
  /** Extra response headers to include. */
  responseHeaders?: Record<string, string>
}

/** Install a fetch stub that records every request and returns canned bodies. */
function stubFetch(routes: Record<string, RouteDefinition>) {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const path = new URL(url).pathname
    const body = init.body ? JSON.parse(init.body as string) : undefined
    calls.push({
      url,
      method,
      body,
      headers: (init.headers ?? {}) as Record<string, string>,
    })
    const route = routes[`${method} ${path}`]
    // Paid MCP-tool tests model a strict streamable-HTTP merchant: before its
    // configured 402 tool response, it establishes an MCP session and expects
    // the lifecycle notification. This keeps existing route fixtures focused
    // on the payment state they exercise while asserting the hosted flow uses
    // the real transport sequence.
    if (route && route.status !== 404 && method === 'POST' && body?.method === 'initialize') {
      const responseHeaders = new Headers({ 'mcp-session-id': 'sess-tools-test' })
      const bodySnapshot = { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' } }
      return {
        ok: true,
        status: 200,
        headers: responseHeaders,
        json: async () => bodySnapshot,
        text: async () => JSON.stringify(bodySnapshot),
        clone: () => ({
          ok: true,
          status: 200,
          headers: responseHeaders,
          json: async () => bodySnapshot,
          text: async () => JSON.stringify(bodySnapshot),
        }),
      }
    }
    if (route && route.status !== 404 && method === 'POST' && body?.method === 'notifications/initialized') {
      const responseHeaders = new Headers()
      return {
        ok: true,
        status: 202,
        headers: responseHeaders,
        json: async () => ({}),
        text: async () => '',
        clone: () => ({ ok: true, status: 202, headers: responseHeaders, json: async () => ({}), text: async () => '' }),
      }
    }
    const status = route?.status ?? 200
    const responseHeaders = new Headers(route?.responseHeaders ?? {})
    const bodySnapshot = route?.body ?? (
      method === 'GET' && /^\/machine-payments\/[^/]+\/status$/.test(path)
        ? x402PreflightStatus()
        : undefined
    )
    const response = {
      ok: status >= 200 && status < 300,
      status,
      headers: responseHeaders,
      json: async () => bodySnapshot ?? {},
      text: async () => JSON.stringify(bodySnapshot ?? {}),
      clone: () => ({
        ok: status >= 200 && status < 300,
        status,
        headers: responseHeaders,
        json: async () => bodySnapshot ?? {},
        text: async () => JSON.stringify(bodySnapshot ?? {}),
      }),
    }
    return response
  })
}

function ok<T = unknown>(payload: ToolPayload): ToolSuccess<T> {
  if (!payload.success) throw new Error(`expected success, got failure: ${payload.message}`)
  return payload as ToolSuccess<T>
}

function handlers() {
  const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
  return createToolHandlers(haven)
}

beforeEach(() => {
  calls = []
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ── haven_pay ─────────────────────────────────────────────────────────────────

describe('haven_pay', () => {
  it('returns the unsigned payload hash for an in-budget payment', async () => {
    stubFetch({
      'POST /payments': {
        status: 201,
        body: {
          payment_id: 'pay_1',
          status: 'pending_signature',
          expires_at: '2099-01-01T00:00:00.000Z',
          sign_data: { hash: '0xdeadbeef' },
        },
      },
    })

    const result = ok<{ payload_hash: string; payment_id: string; status: string }>(
      await handlers().haven_pay({ token: 'USDC', amount: '12.50', to: '0xabc' }),
    )

    expect(result.data.payment_id).toBe('pay_1')
    expect(result.data.payload_hash).toBe('0xdeadbeef')
    expect(result.data.status).toBe('pending_signature')
  })

  it('forwards signature_scheme + typed_data VERBATIM for delegation-rail intents (#1254)', async () => {
    // Found live during the #908 mainnet canary: the x402 quote path always
    // forwarded these, this direct path dropped them — so the local signer
    // raw-signed the userOp hash and the Hybrid account rejected it (AA24).
    const typedData = {
      domain: { name: 'HybridDeleGator', chainId: 8453 },
      types: { PackedUserOperation: [{ name: 'sender', type: 'address' }] },
      primaryType: 'PackedUserOperation',
      message: { sender: '0xabc' },
    }
    stubFetch({
      'POST /payments': {
        status: 201,
        body: {
          payment_id: 'pay_delegation',
          status: 'pending_signature',
          expires_at: '2099-01-01T00:00:00.000Z',
          sign_data: {
            hash: '0xdeadbeef',
            signature_scheme: 'eip712_userop',
            typed_data: typedData,
          },
        },
      },
    })

    const result = ok<{ signature_scheme?: string; typed_data?: unknown; typed_data_b64?: string; payload_hash: string }>(
      await handlers().haven_pay({ token: 'USDC', amount: '0.10', to: '0xabc' }),
    )

    expect(result.data.signature_scheme).toBe('eip712_userop')
    expect(result.data.typed_data).toEqual(typedData) // verbatim, never reshaped
    // #1255: the copy-through-safe form decodes to exactly the same payload.
    expect(result.data.typed_data_b64).toBeDefined()
    expect(
      JSON.parse(Buffer.from(result.data.typed_data_b64 as string, 'base64').toString('utf8')),
    ).toEqual(typedData)
    expect(result.data.payload_hash).toBe('0xdeadbeef')
  })

  it('omits the delegation fields entirely on legacy-rail intents (#1254)', async () => {
    stubFetch({
      'POST /payments': {
        status: 201,
        body: {
          payment_id: 'pay_legacy',
          status: 'pending_signature',
          expires_at: '2099-01-01T00:00:00.000Z',
          sign_data: { hash: '0xdeadbeef' },
        },
      },
    })

    const result = ok<Record<string, unknown>>(
      await handlers().haven_pay({ token: 'USDC', amount: '0.10', to: '0xabc' }),
    )

    expect('signature_scheme' in result.data).toBe(false)
    expect('typed_data' in result.data).toBe(false)
    expect('typed_data_b64' in result.data).toBe(false)
  })

  it('surfaces pending_approval (no hash) when over budget', async () => {
    stubFetch({
      'POST /payments': {
        status: 202,
        body: {
          payment_id: 'pay_over',
          status: 'pending_approval',
          expires_at: '2099-01-01T00:00:00.000Z',
        },
      },
    })

    const result = ok<{ status: string; payload_hash: unknown }>(
      await handlers().haven_pay({ token: 'USDC', amount: '999999', to: '0xabc' }),
    )

    expect(result.data.status).toBe('pending_approval')
    expect(result.data.payload_hash).toBeNull()
  })

  it('never sends a delegate key in the construct request', async () => {
    stubFetch({
      'POST /payments': {
        status: 201,
        body: { payment_id: 'pay_1', status: 'pending_signature', sign_data: { hash: '0x1' } },
      },
    })

    await handlers().haven_pay({ token: 'USDC', amount: '1', to: '0xabc' })

    const payCall = calls.find((c) => c.url.endsWith('/payments'))
    expect(payCall?.body).toEqual({ token: 'USDC', amount: '1', to: '0xabc' })
    // Custody invariant: no field anywhere in the request carries key material.
    expect(JSON.stringify(calls)).not.toContain(DELEGATE_KEY)
    expect(JSON.stringify(calls)).not.toContain('delegate_key')
  })
})

// ── haven_submit ──────────────────────────────────────────────────────────────

describe('haven_submit', () => {
  it('relays ONLY { signature } and returns the tx hash', async () => {
    stubFetch({
      'POST /payments/pay_1/sign': {
        status: 200,
        body: { status: 'confirmed', tx_hash: '0xtx' },
      },
    })

    const sig = '0x' + '11'.repeat(65)
    const result = ok<{ status: string; tx_hash: string }>(
      await handlers().haven_submit({ payment_id: 'pay_1', signature: sig }),
    )

    expect(result.data.status).toBe('confirmed')
    expect(result.data.tx_hash).toBe('0xtx')

    const signCall = calls.find((c) => c.url.includes('/sign'))
    // The relay payload is exactly the signature — nothing else crosses the wire.
    expect(signCall?.body).toEqual({ signature: sig })
    expect(JSON.stringify(calls)).not.toContain(DELEGATE_KEY)
  })

  it('rejects a malformed signature before any network call', async () => {
    stubFetch({})
    const payload = await handlers().haven_submit({ payment_id: 'pay_1', signature: 'not-hex' })
    expect(payload.success).toBe(false)
    expect(calls).toHaveLength(0)
  })
})

// ── x402 fixtures ─────────────────────────────────────────────────────────────

const PAYMENT_REQUIRED = {
  x402Version: 1,
  resource: { url: 'https://merchant.test/paid', description: 'paid data' },
  accepts: [
    {
      scheme: 'exact',
      network: 'base',
      amount: '1000000',
      maxAmountRequired: '1500000',
      // Base USDC — selectStandardPaymentOption only accepts this asset.
      asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      payTo: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
      maxTimeoutSeconds: 60,
      extra: { name: 'USD Coin', version: '2' },
    },
  ],
}

const headerSigner = new HavenClient({
  apiKey: 'sk_agent_test',
  delegateKey: HEADER_SIGNING_KEY,
  baseUrl: 'http://haven.test',
})
let VALID_PAYMENT_HEADER = ''
let VALID_PAYMENT_HEADER_V2 = ''

beforeAll(async () => {
  // Headers are minted by the SDK's real signing path so these fixtures
  // cannot drift from what a client actually sends. #1618 moved that path
  // off HavenClient onto its private `fundingLeg` module; still reaching
  // through a real client is the point — a hand-rolled header here would
  // stop testing the SDK and start testing this file.
  type HeaderMinter = {
    fundingLeg: {
      createPaymentHeader(
        paymentRequired: typeof PAYMENT_REQUIRED,
        option: (typeof PAYMENT_REQUIRED.accepts)[number],
      ): Promise<string>
    }
  }
  const mint = (headerSigner as unknown as HeaderMinter).fundingLeg
  VALID_PAYMENT_HEADER = await mint.createPaymentHeader(
    PAYMENT_REQUIRED,
    PAYMENT_REQUIRED.accepts[0],
  )
  VALID_PAYMENT_HEADER_V2 = await mint.createPaymentHeader(
    { ...PAYMENT_REQUIRED, x402Version: 2 },
    PAYMENT_REQUIRED.accepts[0],
  )
})

function x402PreflightStatus(overrides: Record<string, unknown> = {}) {
  return {
    payment_id: 'pay_x402',
    kind: 'payment_intent',
    rail: 'x402',
    status: 'pending_signature',
    phase: 'awaiting_agent_signature',
    next_action: 'sign_and_submit',
    amount: '1.50',
    token: 'USDC',
    resource_url: PAYMENT_REQUIRED.resource.url,
    merchant_address: PAYMENT_REQUIRED.accepts[0].payTo,
    payer_address: headerSigner.delegateAddress,
    tx_hash: null,
    expires_at: '2099-01-01T00:00:00.000Z',
    chain_id: 8453,
    message: 'Ready to sign.',
    amount_atomic: PAYMENT_REQUIRED.accepts[0].maxAmountRequired,
    asset: PAYMENT_REQUIRED.accepts[0].asset,
    network: PAYMENT_REQUIRED.accepts[0].network,
    ...overrides,
  }
}

function mutateHeader(
  paymentHeader: string,
  mutate: (header: Record<string, unknown>) => void,
): string {
  const header = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8')) as Record<string, unknown>
  mutate(header)
  return Buffer.from(JSON.stringify(header), 'utf8').toString('base64')
}

// ── haven_sweep_delegate (phase 1 mapping) ────────────────────────────────────

describe('haven_sweep_delegate prepare mapping', () => {
  it('maps a below-floor balance to below_minimum — never a dead-end signature_required (#700)', async () => {
    // Found live on the first prod sweep attempt: the handler only branched on
    // nothing_stranded, so a below-floor response fell through to
    // signature_required with authorization/expected_auth undefined — an
    // instruction to sign a payload that does not exist.
    stubFetch({
      'POST /machine-payments/sweep/prepare': {
        status: 200,
        body: {
          below_min: true,
          asset: 'USDC',
          amount: '0.002',
          amount_atomic: '2000',
          min_usdc: '1',
          chain_id: 8453,
          message: 'Stranded 0.002 USDC is below the sweep floor of 1 USDC',
        },
      },
    })

    const result = ok<Record<string, unknown>>(await handlers().haven_sweep_delegate({}))
    expect(result.data.status).toBe('below_minimum')
    expect(result.data.min_usdc).toBe('1')
    expect('authorization' in result.data).toBe(false)
    expect('sign_with' in result.data).toBe(false)
  })

  it('still returns the full signing payload when a sweep IS prepared', async () => {
    const authorization = {
      from: '0x' + 'aa'.repeat(20), to: '0x' + 'bb'.repeat(20), value: '2000000',
      validAfter: '0', validBefore: '9999999999', nonce: '0x' + 'cc'.repeat(32),
      token: '0x' + 'dd'.repeat(20), chainId: 8453,
    }
    stubFetch({
      'POST /machine-payments/sweep/prepare': {
        status: 201,
        body: {
          authorization,
          expected_auth: { version: 1, message: 'm', signature: '0x' + '11'.repeat(65), signer: '0x' + 'ee'.repeat(20) },
          asset: 'USDC', amount: '2.0', amount_atomic: '2000000', chain_id: 8453,
        },
      },
    })

    const result = ok<Record<string, unknown>>(await handlers().haven_sweep_delegate({}))
    expect(result.data.status).toBe('signature_required')
    expect(result.data.authorization).toEqual(authorization)
    expect(result.data.expected_auth).toBeDefined()
  })
})

// ── haven_discover_tools ────────────────────────────────────────────────────

describe('haven_discover_tools', () => {
  it('marks catalog prices as indicative (not authoritative)', async () => {
    stubFetch({
      'GET /catalog': {
        status: 200,
        body: {
          entries: [
            {
              id: 'cat_1',
              name: 'create_text',
              description: 'Generate text',
              category: 'ai',
              resource_url: 'https://mcp.soundside.ai/mcp',
              rail: 'x402',
              protocol: 'mcp',
              tool_name: 'create_text',
              tool_arguments: { prompt: 'hello' },
              price_display: '$0.01 USDC',
              price_atomic: '10000',
              asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
              network: 'base',
              status: 'active',
              verified_at: '2026-06-16T08:50:39.772Z',
            },
          ],
        },
      },
    })

    const result = ok<Array<{
      price_is_indicative: boolean
      price_atomic: string
      suggested_tool: string
      tool_arguments: Record<string, unknown>
    }>>(
      await handlers().haven_discover_tools({}),
    )

    expect(result.data[0].price_is_indicative).toBe(true)
    expect(result.data[0].price_atomic).toBe('10000')
    // #1547: the structured field agrees with the description prose — MCP
    // entries point at the GUIDED preflight, not the manual tool.
    expect(result.data[0].suggested_tool).toBe('haven_prepare_catalog_purchase')
    expect(result.data[0].tool_arguments).toEqual({ prompt: 'hello' })
  })

  it('forwards case-insensitive category/search filters as one read-only GET', async () => {
    stubFetch({
      'GET /catalog': { status: 200, body: { entries: [] } },
    })

    await handlers().haven_discover_tools({ category: 'VPN', search: 'NordShield' })
    expect(calls[0]?.url).toBe('http://haven.test/catalog?category=VPN&search=NordShield')
    expect(calls).toHaveLength(1)
  })

  it('preserves blank search terms so hosted MCP matches the backend contract', async () => {
    stubFetch({
      'GET /catalog': { status: 200, body: { entries: [] } },
    })

    await handlers().haven_discover_tools({ search: '' })
    expect(calls[0]?.url).toBe('http://haven.test/catalog?search=')
    expect(calls).toHaveLength(1)
  })
})

const X402_INTENT_RESPONSE = {
  payment_id: 'pay_x402',
  status: 'pending_signature',
  expires_at: '2099-01-01T00:00:00.000Z',
  merchant_to: '0xMerchant',
  x402_expected_auth: X402_EXPECTED_AUTH,
  sign_data: { hash: '0xfunding' },
}

const AGENT_RESPONSE = {
  id: 'agt_1',
  name: 'A',
  status: 'active',
  delegate_address: '0xDelegate',
  chain_id: 8453,
}

const AGENT_ALLOWANCES_RESPONSE = {
  agent_id: 'agt_1',
  safe_address: '0xSafe',
  delegate_address: '0xDelegate',
  chain_id: 8453,
  allowances: [{
    id: 'allowance-1',
    // Real Base USDC address (6 decimals) so remainingDisplay exercises the
    // decimals lookup rather than the unknown-token atomic fallback.
    token_address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    token_symbol: 'USDC',
    configured_amount: '10000',
    reset_period_min: 60,
    onchain: {
      amount: '10000', spent: '2500', remaining: '7500', effective_spent: '2500',
      reset_time_min: 60, last_reset_min: 100, nonce: 7, is_reset_pending: false,
    },
  }],
}

// ── haven_get_agent (one-shot bootstrap) ──────────────────────────────────────

describe('haven_get_agent', () => {
  it('returns identity + readiness + live remaining allowance in one call', async () => {
    stubFetch({
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'GET /machine-payments/allowances': { status: 200, body: AGENT_ALLOWANCES_RESPONSE },
    })

    const result = ok<{
      id: string
      status: string
      readiness: string
      allowances: Array<Record<string, unknown>>
    }>(await handlers().haven_get_agent({}))

    expect(result.data.id).toBe('agt_1')
    expect(result.data.readiness).toBe('ready')
    expect(result.data.allowances[0]).toMatchObject({
      tokenSymbol: 'USDC',
      remainingAtomic: '7500',
      remainingDisplay: '0.0075 USDC',
    })
  })
})

// ── haven_pay_x402_quote ──────────────────────────────────────────────────────

describe('haven_pay_x402_quote', () => {
  it('rejects with PRICE_EXCEEDS_MAX before funding when the option price is above max_amount', async () => {
    stubFetch({
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
    })

    const payload = await handlers().haven_pay_x402_quote({
      payment_required: PAYMENT_REQUIRED,
      max_amount: '1000000', // below the fixture's authoritative 1500000
    })

    expect(payload.success).toBe(false)
    if (payload.success) throw new Error('expected failure')
    expect(payload.code).toBe(AgentPaymentFailureCode.PriceExceedsMax)
    // Guard is pure + pre-funding: neither the agent fetch nor the intent ran.
    expect(calls.find((c) => c.url.includes('/agent'))).toBeUndefined()
    expect(calls.find((c) => c.url.endsWith('/x402'))).toBeUndefined()
  })

  it('returns the unsigned funding hash + x402 data for the edge, signing nothing', async () => {
    stubFetch({
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
    })

    const result = ok<{
      payment_id: string
      idempotency_key: string
      payload_hash: string
      x402: Record<string, unknown>
    }>(await handlers().haven_pay_x402_quote({ payment_required: PAYMENT_REQUIRED }))

    expect(result.data.payment_id).toBe('pay_x402')
    expect(result.data.idempotency_key).toMatch(/^x402:/)
    expect(result.data.payload_hash).toBe('0xfunding')
    expect(result.data.x402.funding_to).toBe('0xDelegate')
    expect(result.data.x402.merchant_to).toBe('0xMerchant')
    expect(result.data.x402.expected).toEqual({
      payment_id: 'pay_x402',
      payload_hash: '0xfunding',
      // The value Haven SIGNED — `paymentRequired.resource.url`. This used to
      // mirror the implementation's `accepted.resource ?? resourceUrl`, so it
      // passed whichever way the code went (#1189).
      resource_url: PAYMENT_REQUIRED.resource.url,
      merchant_to: '0xMerchant',
      amount: PAYMENT_REQUIRED.accepts[0].maxAmountRequired,
      asset: PAYMENT_REQUIRED.accepts[0].asset,
      network: PAYMENT_REQUIRED.accepts[0].network,
      expires_at: X402_INTENT_RESPONSE.expires_at,
      auth: X402_EXPECTED_AUTH,
    })

    // Custody: the funding request tops up the delegate EOA but carries no key.
    const x402Call = calls.find((c) => c.url.endsWith('/x402'))
    expect(x402Call?.body).toMatchObject({
      payTo: '0xDelegate',
      merchantPayTo: PAYMENT_REQUIRED.accepts[0].payTo,
      amount: PAYMENT_REQUIRED.accepts[0].maxAmountRequired,
    })
    expect(JSON.stringify(calls)).not.toContain(DELEGATE_KEY)
    expect(JSON.stringify(calls)).not.toContain('delegate_key')
  })

  it('binds resource_url to what Haven signed, even when the option carries its own resource (#1189)', async () => {
    // A merchant may set a `resource` on the accepted option that differs from
    // the top-level one. The backend signs the TOP-LEVEL url, so preferring the
    // option's here reconstructed a different message and the signer refused
    // with "authentication message is invalid" — an error that reads as a
    // credential problem, not a field mismatch. The signature is the authority.
    const optionScopedResource = {
      ...PAYMENT_REQUIRED,
      accepts: [{ ...PAYMENT_REQUIRED.accepts[0], resource: 'https://merchant.test/option-scoped' }],
    }
    stubFetch({
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
    })

    const result = ok<{ x402: { expected: { resource_url: string } } }>(
      await handlers().haven_pay_x402_quote({ payment_required: optionScopedResource }),
    )

    expect(result.data.x402.expected.resource_url).toBe(PAYMENT_REQUIRED.resource.url)
    expect(result.data.x402.expected.resource_url).not.toBe('https://merchant.test/option-scoped')
  })

  it('reports the expected-context version this quote will emit, pre-payment (#1155)', async () => {
    // The hosted half of pre-payment skew detection. The agent holds the
    // signer's advertised set from that server's initialize handshake; this is
    // the number to compare it against, available before haven_sign is called
    // and before haven_submit moves anything.
    stubFetch({
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
    })

    const result = ok<{
      signer_compatibility: {
        x402_expected_context_version: number
        signer_capability: string
        check: string
      }
    }>(await handlers().haven_pay_x402_quote({ payment_required: PAYMENT_REQUIRED }))

    // Read from the binding Haven signed, not re-derived here.
    expect(result.data.signer_compatibility.x402_expected_context_version).toBe(
      X402_EXPECTED_AUTH.version,
    )
    expect(result.data.signer_compatibility.signer_capability).toBe('haven/signer-compatibility')
  })

  it('carries the skew warning in-band, naming the #1143 fix (#1155)', async () => {
    // Warning, not refusal: the quote succeeds either way. The instruction
    // travels with the number so an agent that never reads tool descriptions
    // still sees it at the moment it matters.
    stubFetch({
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
    })

    const result = ok<{ signer_compatibility: { check: string } }>(
      await handlers().haven_pay_x402_quote({ payment_required: PAYMENT_REQUIRED }),
    )

    const check = result.data.signer_compatibility.check
    expect(check).toContain('@haven_ai/signer')
    expect(check).toContain('npx @haven_ai/connect@alpha')
    expect(check).toMatch(/STOP before signing/)
    // Same standing instruction as the signing-time error (#1143).
    expect(check).toMatch(/invalidates the signature/)
  })

  it('carries the recovery guidance as STRUCTURED data too, not only inside check (#1309)', async () => {
    // #1309: signer_compatibility is the stable machine-readable compatibility
    // contract. `fallback` is the same fix `check` states in prose, as a field
    // an agent can read without parsing a sentence — and it is the SAME string
    // (SIGNER_UPDATE_FALLBACK) the local signer's own structured refusal uses,
    // so an agent that meets either surface gets identical guidance.
    stubFetch({
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
    })

    const result = ok<{ signer_compatibility: { fallback: string } }>(
      await handlers().haven_pay_x402_quote({ payment_required: PAYMENT_REQUIRED }),
    )

    expect(result.data.signer_compatibility.fallback).toBe(SIGNER_UPDATE_FALLBACK)
  })

  it('does not refuse a quote whose emitted version the signer may not know (#1155)', async () => {
    // The skew scenario itself. A newer backend emits a version no shipped
    // signer knows; the quote must still succeed and simply report it. Refusing
    // here on reported client metadata would let a false positive block a
    // working payment — strictly worse than the current state.
    const futureVersionIntent = {
      ...X402_INTENT_RESPONSE,
      x402_expected_auth: { ...X402_EXPECTED_AUTH, version: 99 },
    }
    stubFetch({
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /x402': { status: 201, body: futureVersionIntent },
    })

    const result = ok<{
      payload_hash: string
      signer_compatibility: { x402_expected_context_version: number }
    }>(await handlers().haven_pay_x402_quote({ payment_required: PAYMENT_REQUIRED }))

    expect(result.data.payload_hash).toBe('0xfunding')
    expect(result.data.signer_compatibility.x402_expected_context_version).toBe(99)
  })

  it('surfaces pending_approval (no hash) when the x402 amount is over budget', async () => {
    stubFetch({
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /x402': { status: 202, body: { payment_id: 'pay_over', status: 'pending_approval' } },
    })

    const result = ok<{ status: string; payload_hash: unknown }>(
      await handlers().haven_pay_x402_quote({ payment_required: PAYMENT_REQUIRED }),
    )
    expect(result.data.status).toBe('pending_approval')
    expect(result.data.payload_hash).toBeNull()
  })
})

// ── haven_quote_x402 ──────────────────────────────────────────────────────────

describe('haven_quote_x402', () => {
  it('probes the merchant, returns payment_required without creating a Haven payment', async () => {
    // The SDK reads payment_required from the PAYMENT-REQUIRED response header (base64 JSON).
    const paymentRequiredHeader = btoa(JSON.stringify(PAYMENT_REQUIRED))
    stubFetch({
      'GET /paid': {
        status: 402,
        responseHeaders: { 'PAYMENT-REQUIRED': paymentRequiredHeader },
      },
    })

    const result = ok<{
      payment_required: unknown
      amount: string
      resource_url: string
    }>(await handlers().haven_quote_x402({ url: 'http://merchant.test/paid' }))

    expect(result.data.payment_required).toBeDefined()
    // Haven was never contacted — only the merchant URL.
    expect(calls.every((c) => c.url.includes('merchant.test'))).toBe(true)
    // No x402 intent created.
    expect(calls.find((c) => c.url.endsWith('/x402'))).toBeUndefined()
  })
})

// ── haven_resume_x402_payment ─────────────────────────────────────────────────

describe('haven_resume_x402_payment', () => {
  it('returns signing context when payment is ready to retry', async () => {
    const resumeState = {
      rail: 'x402' as const,
      paymentId: 'pay_approved',
      idempotencyKey: 'idem_1',
      paymentRequired: PAYMENT_REQUIRED,
      accepted: PAYMENT_REQUIRED.accepts[0],
      url: 'https://merchant.test/paid',
      resourceUrl: 'https://merchant.test/paid',
      description: null,
      amountAtomic: '1500000',
      amount: '1.50',
      token: 'USDC',
      asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      network: 'base',
      chainId: 8453,
      merchantAddress: '0xMerchant',
    }

    stubFetch({
      // getPaymentStatus calls /machine-payments/:id/status
      'GET /machine-payments/pay_approved/status': {
        status: 200,
        body: {
          payment_id: 'pay_approved',
          status: 'confirmed',
          next_action: 'retry_original_x402_request',
          tx_hash: '0xfunded',
          rail: 'x402',
        },
      },
    })

    const result = ok<{
      payment_id: string
      payment_required: unknown
      x402: Record<string, unknown>
      tx_hash: string
    }>(await handlers().haven_resume_x402_payment({ resume_state: resumeState }))

    expect(result.data.payment_id).toBe('pay_approved')
    expect(result.data.payment_required).toBeDefined()
    expect(result.data.x402).toBeDefined()
    expect(result.data.tx_hash).toBe('0xfunded')
  })

  it('rejects when no payment_id and no resume_state provided', async () => {
    stubFetch({})
    const result = await handlers().haven_resume_x402_payment({})
    expect(result.success).toBe(false)
    // HavenApiError uses code 'API_ERROR'
    expect((result as any).code).toBe('API_ERROR')
  })
})

// ── haven_list_receipts ───────────────────────────────────────────────────────

describe('haven_list_receipts', () => {
  it('calls the receipts endpoint and returns results', async () => {
    // listReceipts calls /machine-payments/receipts
    stubFetch({
      'GET /machine-payments/receipts': {
        status: 200,
        body: { receipts: [{ id: 'rcpt_1', amount: '1.00', payment_id: 'pay_1', rail: 'x402' }] },
      },
    })

    const result = ok<unknown[]>(await handlers().haven_list_receipts({}))
    expect(Array.isArray(result.data)).toBe(true)
  })
})

// ── haven_get_resume_state ────────────────────────────────────────────────────

describe('haven_get_resume_state', () => {
  it('calls the resume state endpoint', async () => {
    // getResumeState calls /payments/:id/resume_state
    stubFetch({
      'GET /payments/pay_1/resume_state': {
        status: 200,
        body: {
          rail: 'x402',
          paymentId: 'pay_1',
          payment_required: PAYMENT_REQUIRED,
        },
      },
    })

    const result = ok<{ rail: string }>(
      await handlers().haven_get_resume_state({ payment_id: 'pay_1' }),
    )
    expect(result.data.rail).toBe('x402')
  })
})

// ── haven_send ────────────────────────────────────────────────────────────────

describe('haven_send', () => {
  it('returns payload_hash for in-budget transfer', async () => {
    stubFetch({
      'POST /payments': {
        status: 201,
        body: {
          payment_id: 'pay_send_1',
          status: 'pending_signature',
          expires_at: '2099-01-01T00:00:00.000Z',
          sign_data: { hash: '0xsendhash' },
        },
      },
    })

    const result = ok<{ payment_id: string; payload_hash: string; asset: string; amount: string }>(
      await handlers().haven_send({ asset: 'USDC', recipient: '0xRecipient', amount: '5.00' }),
    )

    expect(result.data.payment_id).toBe('pay_send_1')
    expect(result.data.payload_hash).toBe('0xsendhash')
    expect(result.data.asset).toBe('USDC')
    expect(result.data.amount).toBe('5.00')

    const postCall = calls.find((c) => c.url.endsWith('/payments'))
    expect(postCall?.body).toEqual({ token: 'USDC', amount: '5.00', to: '0xRecipient' })
    // Custody invariant
    expect(JSON.stringify(calls)).not.toContain(DELEGATE_KEY)
  })

  it('forwards signature_scheme + typed_data VERBATIM for delegation-rail intents (#1254)', async () => {
    // haven_send was named in the live bug alongside haven_pay — reviewer
    // mutation showed the shared helper's use HERE was untested (dropping it
    // from only this handler passed the whole suite).
    const typedData = {
      domain: { name: 'HybridDeleGator', chainId: 8453 },
      types: { PackedUserOperation: [{ name: 'sender', type: 'address' }] },
      primaryType: 'PackedUserOperation',
      message: { sender: '0xRecipient' },
    }
    stubFetch({
      'POST /payments': {
        status: 201,
        body: {
          payment_id: 'pay_send_delegation',
          status: 'pending_signature',
          expires_at: '2099-01-01T00:00:00.000Z',
          sign_data: {
            hash: '0xsendhash',
            signature_scheme: 'eip712_userop',
            typed_data: typedData,
          },
        },
      },
    })

    const result = ok<{ signature_scheme?: string; typed_data?: unknown; typed_data_b64?: string; payload_hash: string }>(
      await handlers().haven_send({ asset: 'USDC', recipient: '0xRecipient', amount: '0.10' }),
    )

    expect(result.data.signature_scheme).toBe('eip712_userop')
    expect(result.data.typed_data).toEqual(typedData) // verbatim, never reshaped
    // #1255: the copy-through-safe form decodes to exactly the same payload.
    expect(
      JSON.parse(Buffer.from(result.data.typed_data_b64 as string, 'base64').toString('utf8')),
    ).toEqual(typedData)
    expect(result.data.payload_hash).toBe('0xsendhash')
  })

  it('omits the delegation fields entirely on legacy-rail intents (#1254)', async () => {
    stubFetch({
      'POST /payments': {
        status: 201,
        body: {
          payment_id: 'pay_send_legacy',
          status: 'pending_signature',
          expires_at: '2099-01-01T00:00:00.000Z',
          sign_data: { hash: '0xsendhash' },
        },
      },
    })

    const result = ok<Record<string, unknown>>(
      await handlers().haven_send({ asset: 'USDC', recipient: '0xRecipient', amount: '0.10' }),
    )

    expect('signature_scheme' in result.data).toBe(false)
    expect('typed_data' in result.data).toBe(false)
    expect('typed_data_b64' in result.data).toBe(false)
  })

  it('surfaces pending_approval when over allowance budget', async () => {
    stubFetch({
      'POST /payments': {
        status: 202,
        body: { payment_id: 'pay_over', status: 'pending_approval' },
      },
    })

    const result = ok<{ status: string; payload_hash: unknown }>(
      await handlers().haven_send({ asset: 'ETH', recipient: '0xRecipient', amount: '999' }),
    )

    expect(result.data.status).toBe('pending_approval')
    expect(result.data.payload_hash).toBeNull()
  })

  it('rejects unknown asset values', async () => {
    stubFetch({})
    const result = await handlers().haven_send({ asset: 'DAI', recipient: '0xRecipient', amount: '1' })
    expect(result.success).toBe(false)
    expect(calls).toHaveLength(0)
  })
})

// ── haven_pay_mcp_tool ────────────────────────────────────────────────────────

describe('haven_quote_mcp_tool', () => {
  const paymentRequiredHeader = btoa(JSON.stringify(PAYMENT_REQUIRED))

  it('returns a compact live MCP quote without creating a Haven payment or reading allowance state', async () => {
    stubFetch({
      'POST /mcp': { status: 402, responseHeaders: { 'PAYMENT-REQUIRED': paymentRequiredHeader } },
    })

    const result = ok<{
      rail: string
      merchant_url: string
      tool_name: string
      arguments: Record<string, unknown>
      amount_atomic: string
      amount: string
      token: string
      decimals: number | null
      resource_url: string
      merchant_address: string
      mcp_transport?: { handshake_required: boolean; source: string }
      quote_is_informational: boolean
      payment_required?: unknown
      payment_id?: unknown
    }>(
      await handlers().haven_quote_mcp_tool({
        merchant_url: 'http://merchant.test/mcp',
        tool_name: 'create_text',
        arguments: { prompt: 'Hello' },
        max_amount: '2000000',
      }),
    )

    expect(result.data).toMatchObject({
      rail: 'x402',
      merchant_url: 'http://merchant.test/mcp',
      tool_name: 'create_text',
      arguments: { prompt: 'Hello' },
      amount_atomic: '1500000',
      amount: '1.5',
      token: 'USDC',
      decimals: 6,
      resource_url: 'https://merchant.test/paid',
      merchant_address: PAYMENT_REQUIRED.accepts[0].payTo,
      mcp_transport: { handshake_required: true, source: 'path' },
      quote_is_informational: true,
    })
    // The raw 402 is intentionally not a resumable payment input; a later
    // paid call must obtain a fresh quote and enforce its explicit cap.
    expect(result.data.payment_required).toBeUndefined()
    expect(result.data.payment_id).toBeUndefined()
    expect(calls.find((call) => new URL(call.url).pathname.endsWith('/x402'))).toBeUndefined()
    // The MCP lifecycle needs the existing public delegate address for
    // x402-wallet. It must not read allowances, create an intent, or write.
    expect(calls.filter((call) => new URL(call.url).pathname.endsWith('/machine-payments/agent'))).toHaveLength(1)
    expect(calls.find((call) => new URL(call.url).pathname.includes('/machine-payments/allowances'))).toBeUndefined()
  })
})

describe('haven_pay_mcp_tool', () => {
  const paymentRequiredHeader = btoa(JSON.stringify(PAYMENT_REQUIRED))

  it('ROUND-TRIP BUDGET: exactly ONE agent fetch on the happy path — the #1348 prefetch feeds createX402Intent', async () => {
    stubFetch({
      'POST /mcp': { status: 402, responseHeaders: { 'PAYMENT-REQUIRED': paymentRequiredHeader } },
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
    })

    ok(
      await handlers().haven_pay_mcp_tool({
        merchant_url: 'http://merchant.test/mcp',
        tool_name: 'create_text',
        arguments: { prompt: 'Hello' },
        max_amount: '2000000',
      }),
    )

    expect(calls.filter((c) => new URL(c.url).pathname.endsWith('/machine-payments/agent')).length).toBe(1)
  })

  it('#1348 prefetch failure is invisible: createX402Intent falls back to its own fetch and the error shape is unchanged', async () => {
    stubFetch({
      'POST /mcp': { status: 402, responseHeaders: { 'PAYMENT-REQUIRED': paymentRequiredHeader } },
      'GET /machine-payments/agent': { status: 500, body: { error: 'agent boom' } },
      'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
    })

    const payload = await handlers().haven_pay_mcp_tool({
      merchant_url: 'http://merchant.test/mcp',
      tool_name: 'create_text',
      arguments: { prompt: 'Hello' },
      max_amount: '2000000',
    })

    // Both the ignored prefetch and createX402Intent's own fetch failed —
    // the surfaced error is createX402Intent's, exactly as before #1348.
    expect(payload.success).toBe(false)
    expect(calls.find((c) => new URL(c.url).pathname.endsWith('/x402'))).toBeUndefined()
  })

  it('probes merchant, creates x402 intent, returns signing context with merchant context', async () => {
    stubFetch({
      // tools/call probe → 402 with PAYMENT-REQUIRED header
      'POST /mcp': {
        status: 402,
        responseHeaders: { 'PAYMENT-REQUIRED': paymentRequiredHeader },
      },
      // createX402Intent first fetches agent (for delegateAddress)
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      // createX402Intent calls POST /x402
      'POST /x402': {
        status: 201,
        body: X402_INTENT_RESPONSE,
      },
    })

    const result = ok<{
      payment_id: string
      idempotency_key: string
      payload_hash: string
      expires_at: string
      merchant_url: string
      tool_name: string
      arguments: Record<string, unknown>
      payment_required: { accepts?: unknown[] }
      mcp_transport: { handshake_required: boolean; source: string }
      x402: unknown
    }>(
      await handlers().haven_pay_mcp_tool({
        merchant_url: 'http://merchant.test/mcp',
        tool_name: 'create_text',
        arguments: { prompt: 'Hello' },
        max_amount: '2000000',
      }),
    )

    expect(result.data.payment_id).toBe(X402_INTENT_RESPONSE.payment_id)
    expect(result.data.idempotency_key).toMatch(/^x402:/)
    expect(result.data.payload_hash).toBe(X402_INTENT_RESPONSE.sign_data.hash)
    expect(result.data.expires_at).toBe(X402_INTENT_RESPONSE.expires_at)
    // Merchant context + payment_required threaded through so the agent can
    // complete the flow (haven_x402_sign_header then haven_complete_mcp_tool).
    expect(result.data.merchant_url).toBe('http://merchant.test/mcp')
    expect(result.data.tool_name).toBe('create_text')
    expect(result.data.arguments).toEqual({ prompt: 'Hello' })
    expect(result.data.mcp_transport).toEqual({ handshake_required: true, source: 'path' })
    // #1549: the raw merchant 402 PaymentRequired is compact-trimmed — the
    // signer fetches it by payment_id (#1355), so echoing it was per-purchase
    // token cost. It returns under include_signing_payload=true (next test).
    expect(result.data.payment_required).toBeUndefined()
    expect(result.data.x402).toBeDefined()
    const initialize = calls.find((call) => call.body?.method === 'initialize')
    const initialized = calls.find((call) => call.body?.method === 'notifications/initialized')
    const quoteProbe = calls.find((call) => call.body?.method === 'tools/call')
    expect(initialize).toBeDefined()
    expect(new Headers(initialized?.headers).get('mcp-session-id')).toBe('sess-tools-test')
    expect(new Headers(quoteProbe?.headers).get('Accept')).toBe('application/json, text/event-stream')
    expect(new Headers(quoteProbe?.headers).get('mcp-session-id')).toBe('sess-tools-test')
    expect(new Headers(quoteProbe?.headers).get('x402-wallet')).toBe(AGENT_RESPONSE.delegate_address)
    // createX402Intent was called (POST /x402 route was hit)
    expect(calls.find((c) => c.url.endsWith('/x402'))).toBeDefined()
  })

  it('persists the merchant call context on the funding request (#1307 settle-leg rehydration)', async () => {
    stubFetch({
      'POST /mcp': {
        status: 402,
        responseHeaders: { 'PAYMENT-REQUIRED': paymentRequiredHeader },
      },
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
    })

    ok(
      await handlers().haven_pay_mcp_tool({
        merchant_url: 'http://merchant.test/mcp',
        tool_name: 'create_text',
        arguments: { prompt: 'Hello' },
        max_amount: '2000000',
      }),
    )

    const intentCall = calls.find((c) => c.url.endsWith('/x402'))
    expect(intentCall?.body?.mcpCallContext).toEqual({
      merchantUrl: 'http://merchant.test/mcp',
      toolName: 'create_text',
      arguments: { prompt: 'Hello' },
      mcpTransport: { handshakeRequired: true, source: 'path' },
    })
  })

  it('rejects with PRICE_EXCEEDS_MAX before funding when the live price is above max_amount', async () => {
    stubFetch({
      'POST /mcp': { status: 402, responseHeaders: { 'PAYMENT-REQUIRED': paymentRequiredHeader } },
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
    })

    // Authoritative price for the fixture is maxAmountRequired = 1500000.
    const payload = await handlers().haven_pay_mcp_tool({
      merchant_url: 'http://merchant.test/mcp',
      tool_name: 'create_text',
      arguments: { prompt: 'Hello' },
      max_amount: '1000000',
    })

    expect(payload.success).toBe(false)
    if (payload.success) throw new Error('expected failure')
    expect(payload.code).toBe(AgentPaymentFailureCode.PriceExceedsMax)
    expect(payload.message).toContain('1500000')
    expect(payload.message).toContain('1000000')
    // No funding intent was created — the guard fired before createX402Intent.
    // The MCP-aware quote resolves the public delegate address through /agent,
    // but it cannot sign, fund, or construct an x402 intent.
    expect(calls.find((c) => c.url.endsWith('/x402'))).toBeUndefined()
  })

  it('accepts a quote EXACTLY at max_amount — the cap is inclusive, no warning (#1275)', async () => {
    stubFetch({
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
    })

    const result = ok<Record<string, unknown>>(
      await handlers().haven_pay_x402_quote({
        payment_required: PAYMENT_REQUIRED,
        // Fixture's authoritative amount is maxAmountRequired 1500000.
        max_amount: '1500000',
      }),
    )
    expect(result.data.payment_id).toBe(X402_INTENT_RESPONSE.payment_id)
    // Cap provided → no warning.
    expect('cap_warning' in result.data).toBe(false)
  })

  it('carries cap_warning when max_amount is omitted — the cap is the normal path (#1275)', async () => {
    stubFetch({
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
    })

    const result = ok<{ cap_warning?: string }>(
      await handlers().haven_pay_x402_quote({ payment_required: PAYMENT_REQUIRED }),
    )
    expect(result.data.cap_warning).toContain('max_amount')
    expect(result.data.cap_warning).toContain('atomic units')
  })

  it('proceeds and returns the live price when max_amount is high enough', async () => {
    stubFetch({
      'POST /mcp': { status: 402, responseHeaders: { 'PAYMENT-REQUIRED': paymentRequiredHeader } },
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
    })

    const result = ok<{ amount_atomic: string; payment_id: string }>(
      await handlers().haven_pay_mcp_tool({
        merchant_url: 'http://merchant.test/mcp',
        tool_name: 'create_text',
        arguments: { prompt: 'Hello' },
        max_amount: '1500000',
      }),
    )

    expect(result.data.payment_id).toBe(X402_INTENT_RESPONSE.payment_id)
    // Live merchant price is surfaced for user-facing confirmation.
    expect(result.data.amount_atomic).toBe('1500000')
    expect(calls.find((c) => c.url.endsWith('/x402'))).toBeDefined()
  })

  it('returns Bazaar MCP transport context for non-/mcp merchants', async () => {
    stubFetch({
      'POST /paid': {
        status: 402,
        body: {
          ...PAYMENT_REQUIRED,
          resource: { url: 'http://merchant.test/paid', description: 'paid tool' },
          extensions: { bazaar: { discovery: 'https://bazaar.example/published' } },
        },
      },
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /x402': {
        status: 201,
        body: X402_INTENT_RESPONSE,
      },
    })

    const result = ok<{
      merchant_url: string
      mcp_transport: { handshake_required: boolean; source: string }
      payment_required: { extensions?: { bazaar?: unknown } }
    }>(
      await handlers().haven_pay_mcp_tool({
        merchant_url: 'http://merchant.test/paid',
        tool_name: 'create_text',
        arguments: { prompt: 'Hello' },
        max_amount: '2000000',
        // #1549: payment_required only rides the full shape now; this test's
        // subject is the bazaar extension threading THROUGH it, so ask for it.
        include_signing_payload: true,
      }),
    )

    expect(result.data.merchant_url).toBe('http://merchant.test/paid')
    expect(result.data.mcp_transport).toEqual({ handshake_required: true, source: 'bazaar' })
    expect(result.data.payment_required.extensions?.bazaar).toBeDefined()
  })

  it('haven_complete_mcp_tool delivers the signed header to the merchant and returns the tool result', async () => {
    stubFetch({})
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    const spy = vi.spyOn(haven, 'completeX402MerchantCall').mockResolvedValue({
      status: 200,
      ok: true,
      body: { jsonrpc: '2.0', id: 'x', result: { content: [{ type: 'text', text: 'a joke about agents' }] } },
      settlementTxHash: '0xsettle',
    })

    const result = ok<{ ok: boolean; result: unknown; settlement_tx_hash: string | null }>(
      await createToolHandlers(haven).haven_complete_mcp_tool({
        payment_id: 'pay_x402',
        merchant_url: 'http://merchant.test/mcp',
        tool_name: 'create_text',
        arguments: { prompt: 'Hello' },
        mcp_transport: { handshake_required: true, source: 'bazaar' },
        payment_header: 'eyJwYXltZW50IjoiaGVhZGVyIn0=',
      }),
    )

    expect(spy).toHaveBeenCalledTimes(1)
    const callArg = spy.mock.calls[0][0]
    expect(callArg.paymentId).toBe('pay_x402')
    expect(callArg.url).toBe('http://merchant.test/mcp')
    expect(callArg.paymentHeader).toBe('eyJwYXltZW50IjoiaGVhZGVyIn0=')
    expect(callArg.mcpTransport).toEqual({ handshakeRequired: true, source: 'bazaar' })
    // Rebuilds the same JSON-RPC tools/call envelope haven_pay_mcp_tool used.
    const envelope = JSON.parse(callArg.init!.body as string)
    expect(envelope.method).toBe('tools/call')
    expect(envelope.params).toEqual({ name: 'create_text', arguments: { prompt: 'Hello' } })

    expect(result.data.ok).toBe(true)
    expect(result.data.result).toMatchObject({ result: { content: [{ text: 'a joke about agents' }] } })
    expect(result.data.settlement_tx_hash).toBe('0xsettle')
  })

  it('haven_complete_mcp_tool requires the funding payment_id for evidence', async () => {
    stubFetch({})
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    const spy = vi.spyOn(haven, 'completeX402MerchantCall')

    const payload = await createToolHandlers(haven).haven_complete_mcp_tool({
      merchant_url: 'http://merchant.test/mcp',
      tool_name: 'create_text',
      arguments: {},
      payment_header: 'eyJ4IjoxfQ==',
    })

    if (payload.success) throw new Error('expected a failure payload')
    expect(payload.code).toBe('INVALID_INPUT')
    expect(payload.message).toContain('payment_id')
    expect(spy).not.toHaveBeenCalled()
  })

  it('routes a merchant TIMEOUT after funding to verify-then-sweep guidance, never a bare 504 (#1300)', async () => {
    stubFetch({})
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    vi.spyOn(haven, 'completeX402MerchantCall').mockRejectedValue(
      new MerchantTimeoutError('Merchant request timed out after 300000ms: http://merchant.test/mcp'),
    )

    const payload = await createToolHandlers(haven).haven_complete_mcp_tool({
      payment_id: 'pay_x402',
      merchant_url: 'http://merchant.test/mcp',
      tool_name: 'create_text',
      arguments: {},
      payment_header: 'eyJ4IjoxfQ==',
    })

    if (payload.success) throw new Error('expected a failure payload')
    // Funding is on-chain; an unanswered retry is the SAME money-at-risk state
    // as a rejection — but a timeout is not proof of rejection, so the
    // guidance is verify-then-sweep, and the code is distinct.
    expect(payload.code).toBe(AgentPaymentFailureCode.MerchantUnresponsiveAfterFunding)
    expect(payload.statusCode).toBe(504)
    expect(payload.paymentId).toBe('pay_x402')
    expect(payload.message).toMatch(/may still settle late/)
    expect(payload.message).toMatch(/haven_get_payment_status/)
    expect(payload.suggested_tool).toBe('haven_get_payment_status')
  })

  it('haven_complete_mcp_tool fails with a typed sweep hint when the merchant rejects after funding', async () => {
    stubFetch({})
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    vi.spyOn(haven, 'completeX402MerchantCall').mockResolvedValue({
      status: 402,
      ok: false,
      body: { error: 'payment verification failed' },
    })
    vi.spyOn(haven, 'getPaymentStatus').mockResolvedValue({
      paymentId: 'pay_x402',
      kind: 'payment_intent',
      rail: 'x402',
      status: 'funded_but_unsettled',
      phase: 'funded_but_unsettled',
      nextAction: AgentPaymentNextAction.SweepStrandedFunds,
      message: 'The merchant rejected the funded payment.',
      amount: '1.50',
      token: 'USDC',
      txHash: null,
      expiresAt: '2099-01-01T00:00:00.000Z',
      chainId: 8453,
      resourceUrl: 'http://merchant.test/mcp',
      merchantAddress: '0xMerchant',
      idempotencyKey: 'idem-rejected',
    })

    const payload = await createToolHandlers(haven).haven_complete_mcp_tool({
      payment_id: 'pay_x402',
      merchant_url: 'http://merchant.test/mcp',
      tool_name: 'create_text',
      arguments: {},
      payment_header: 'eyJ4IjoxfQ==',
    })

    // Funding already happened, so a merchant rejection is a hard failure that
    // points the agent at reconciliation — not a soft ok:false the agent ignores.
    if (payload.success) throw new Error('expected a failure payload')
    expect(payload.code).toBe(AgentPaymentFailureCode.MerchantRejectedAfterFunding)
    expect(payload.statusCode).toBe(402)
    expect(payload.paymentId).toBe('pay_x402')
    expect(payload.status).toBe('funded_but_unsettled')
    expect(payload.phase).toBe('funded_but_unsettled')
    expect(payload.next_action).toBe(AgentPaymentNextAction.SweepStrandedFunds)
    expect(payload.rail).toBe('x402')
    expect(payload.idempotency_key).toBe('idem-rejected')
    expect(payload.suggested_tool).toBe('haven_sweep_delegate')
    expect(payload.message).toContain('haven_sweep_delegate')
    expect(payload.message).toContain('402')
  })

  it('haven_complete_mcp_tool maps expired funding windows to a typed re-quote payload', async () => {
    stubFetch({
      'GET /machine-payments/pay_expired/status': {
        status: 200,
        body: {
          payment_id: 'pay_expired',
          kind: 'payment_intent',
          rail: 'x402',
          status: 'expired',
          phase: 'expired',
          next_action: 'request_again_if_user_still_wants_it',
          amount: '1.50',
          token: 'USDC',
          resource_url: 'http://merchant.test/mcp',
          merchant_address: '0xMerchant',
          tx_hash: null,
          expires_at: '2000-01-01T00:00:00.000Z',
          chain_id: 8453,
          message: 'The payment expired before it was completed.',
          x402: {
            amount_atomic: '1500000',
            asset: PAYMENT_REQUIRED.accepts[0].asset,
            network: PAYMENT_REQUIRED.accepts[0].network,
            resource_url: 'http://merchant.test/mcp',
            merchant_address: '0xMerchant',
            description: null,
            idempotency_key: 'idem-paid-tool',
          },
        },
      },
    })

    const payload = await handlers().haven_complete_mcp_tool({
      payment_id: 'pay_expired',
      merchant_url: 'http://merchant.test/mcp',
      tool_name: 'create_text',
      arguments: {},
      payment_header: 'eyJ4IjoxfQ==',
    })

    if (payload.success) throw new Error('expected a failure payload')
    expect(payload.code).toBe(AgentPaymentFailureCode.PaymentWindowExpired)
    expect(payload.statusCode).toBe(410)
    expect(payload.paymentId).toBe('pay_expired')
    expect(payload.status).toBe('expired')
    expect(payload.phase).toBe('expired')
    expect(payload.next_action).toBe(AgentPaymentNextAction.PaymentWindowExpired)
    expect(payload.rail).toBe('x402')
    expect(payload.idempotency_key).toBe('idem-paid-tool')
    expect(payload.retry_with_new_quote).toBe(true)
    expect(payload.suggested_tool).toBe('haven_pay_mcp_tool')
  })

  it('haven_submit maps expired x402 funding windows after backend rejection', async () => {
    stubFetch({
      'POST /payments/pay_expired/sign': {
        status: 410,
        body: { error: 'Payment expired before it could be completed' },
      },
      'GET /machine-payments/pay_expired/status': {
        status: 200,
        body: {
          payment_id: 'pay_expired',
          kind: 'payment_intent',
          rail: 'x402',
          status: 'expired',
          phase: 'expired',
          next_action: 'request_again_if_user_still_wants_it',
          amount: '1.50',
          token: 'USDC',
          resource_url: 'http://merchant.test/mcp',
          merchant_address: '0xMerchant',
          tx_hash: null,
          expires_at: '2000-01-01T00:00:00.000Z',
          chain_id: 8453,
          message: 'The payment expired before it was completed.',
          idempotency_key: 'idem-submit',
        },
      },
    })

    const payload = await handlers().haven_submit({
      payment_id: 'pay_expired',
      signature: '0x' + '11'.repeat(65),
    })

    if (payload.success) throw new Error('expected a failure payload')
    expect(payload.code).toBe(AgentPaymentFailureCode.PaymentWindowExpired)
    expect(payload.statusCode).toBe(410)
    expect(payload.paymentId).toBe('pay_expired')
    expect(payload.next_action).toBe(AgentPaymentNextAction.PaymentWindowExpired)
    expect(payload.idempotency_key).toBe('idem-submit')
    expect(payload.retry_with_new_quote).toBe(true)
  })

  it('returns pending_approval when over allowance', async () => {
    stubFetch({
      'POST /mcp': {
        status: 402,
        responseHeaders: { 'PAYMENT-REQUIRED': paymentRequiredHeader },
      },
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /x402': {
        status: 202,
        body: { payment_id: 'over_1', status: 'pending_approval' },
      },
    })

    const result = ok<{ status: string; payload_hash: unknown }>(
      await handlers().haven_pay_mcp_tool({
        merchant_url: 'http://merchant.test/mcp',
        tool_name: 'create_text',
        arguments: {},
        max_amount: '2000000',
      }),
    )

    expect(result.data.status).toBe('pending_approval')
    expect(result.data.payload_hash).toBeNull()
  })

  it('rejects invalid merchant_url at schema level', async () => {
    stubFetch({})
    const result = await handlers().haven_pay_mcp_tool({
      merchant_url: 'not-a-url',
      tool_name: 'create_text',
    })
    expect(result.success).toBe(false)
    expect(calls).toHaveLength(0)
  })
})

// ── haven_prepare_catalog_purchase (#1306) ────────────────────────────────────

describe('haven_quote_catalog_purchase', () => {
  const paymentRequiredHeader = btoa(JSON.stringify(PAYMENT_REQUIRED))
  const catalogEntry = {
    id: 'cat_1',
    name: 'CloudNest 50GB',
    description: 'Cloud storage tier',
    category: 'compute',
    resource_url: 'http://merchant.test/mcp',
    rail: 'x402',
    protocol: 'mcp',
    tool_name: 'create_text',
    tool_arguments: { prompt: 'Hello' },
    price_display: '$1.50 USDC',
    price_atomic: '1500000',
    asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    network: 'eip155:8453',
    status: 'active',
    verified_at: '2026-06-16T08:50:39.772Z',
  }

  it('wraps the catalog lookup and live quote without allowance reads or intent creation', async () => {
    stubFetch({
      'GET /catalog/cat_1': { status: 200, body: catalogEntry },
      'POST /mcp': { status: 402, responseHeaders: { 'PAYMENT-REQUIRED': paymentRequiredHeader } },
    })

    const result = ok<{
      catalog_id: string
      catalog_name: string
      catalog_price_atomic: string | null
      catalog_price_is_indicative: boolean
      catalog_price_differs: boolean
      amount_atomic: string
      tool_name: string
      arguments: Record<string, unknown>
      quote_is_informational: boolean
    }>(await handlers().haven_quote_catalog_purchase({ catalog_id: 'cat_1' }))

    expect(result.data).toMatchObject({
      catalog_id: 'cat_1',
      catalog_name: 'CloudNest 50GB',
      catalog_price_atomic: '1500000',
      catalog_price_is_indicative: true,
      catalog_price_differs: false,
      amount_atomic: '1500000',
      tool_name: 'create_text',
      arguments: { prompt: 'Hello' },
      quote_is_informational: true,
    })
    expect(calls.find((call) => new URL(call.url).pathname.endsWith('/x402'))).toBeUndefined()
    expect(calls.filter((call) => new URL(call.url).pathname.endsWith('/machine-payments/agent'))).toHaveLength(1)
    expect(calls.find((call) => new URL(call.url).pathname.includes('/machine-payments/allowances'))).toBeUndefined()
  })

  it('preserves the catalog preflight refusal when a row cannot produce a live MCP quote', async () => {
    stubFetch({
      'GET /catalog/cat_missing': { status: 404, body: { error: 'Catalog entry not found' } },
    })

    const payload = await handlers().haven_quote_catalog_purchase({ catalog_id: 'cat_missing' })
    expect(payload.success).toBe(false)
    if (payload.success) throw new Error('expected failure')
    expect(payload.code).toBe('CATALOG_ENTRY_NOT_FOUND')
    expect(payload.suggested_tool).toBe('haven_discover_tools')
    expect(calls).toHaveLength(1)
  })
})

describe('haven_prepare_catalog_purchase', () => {
  const paymentRequiredHeader = btoa(JSON.stringify(PAYMENT_REQUIRED))

  // Catalog's price_atomic matches the fixture's authoritative maxAmountRequired
  // (1500000) so the baseline tests do not incidentally trip CATALOG_PRICE_DIFFERS.
  const CATALOG_ENTRY_RESPONSE = {
    id: 'cat_1',
    name: 'CloudNest 50GB',
    description: 'Cloud storage tier',
    category: 'compute',
    resource_url: 'http://merchant.test/mcp',
    rail: 'x402',
    protocol: 'mcp',
    tool_name: 'create_text',
    tool_arguments: { prompt: 'Hello' },
    price_display: '$1.50 USDC',
    price_atomic: '1500000',
    asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    network: 'eip155:8453',
    status: 'active',
    verified_at: '2026-06-16T08:50:39.772Z',
  }

  const DELEGATION_AGENT_RESPONSE = { ...AGENT_RESPONSE, execution_rail: 'delegation' }

  // #1319: `remainingIsFromChain` mirrors the wire's `remaining_is_from_chain`
  // — omitted by default (matches a legacy-rail row, and most delegation
  // fixtures don't care), set explicitly where a test exercises the
  // provenance warning.
  function allowancesFixture(
    remaining: string,
    rail: 'legacy' | 'delegation' = 'legacy',
    options: { remainingIsFromChain?: boolean } = {},
  ) {
    return {
      agent_id: 'agt_1',
      safe_address: '0xSafe',
      delegate_address: '0xDelegate',
      chain_id: 8453,
      allowances: [{
        id: rail === 'delegation' ? 'delegation-1' : 'allowance-1',
        token_address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        token_symbol: 'USDC',
        configured_amount: rail === 'delegation' ? '5.00' : '5000000',
        reset_period_min: rail === 'delegation' ? 1440 : 60,
        onchain: {
          amount: remaining, spent: '0', remaining, effective_spent: '0',
          reset_time_min: rail === 'delegation' ? 1440 : 60,
          last_reset_min: rail === 'delegation' ? 0 : 100,
          nonce: rail === 'delegation' ? 0 : 7,
          is_reset_pending: false,
          ...(options.remainingIsFromChain !== undefined
            ? { remaining_is_from_chain: options.remainingIsFromChain }
            : {}),
        },
      }],
    }
  }

  const baseRoutes = {
    'GET /catalog/cat_1': { status: 200, body: CATALOG_ENTRY_RESPONSE },
    'POST /mcp': { status: 402, responseHeaders: { 'PAYMENT-REQUIRED': paymentRequiredHeader } },
    'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
  }

  it('success (legacy rail, sufficient allowance): loads catalog, quotes live, creates the intent, returns the compact ready-to-sign shape + catalog fields + allowance block', async () => {
    stubFetch({
      ...baseRoutes,
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'GET /machine-payments/allowances': { status: 200, body: allowancesFixture('5000000') },
    })

    const result = ok<{
      payment_id: string
      rail: string
      network: string
      asset: string
      amount_atomic: string
      amount: string
      token: string
      merchant_url: string
      tool_name: string
      arguments: Record<string, unknown>
      catalog_id: string
      catalog_name: string
      catalog_price_atomic: string
      catalog_price_display: string
      catalog_price_is_indicative: boolean
      allowance: { rail: string; sufficient: boolean | null; remaining_atomic?: string; source: string }
      next_action: string
      next_tool: string
      next_arguments: Record<string, unknown>
      warnings: Array<{ code: string }>
    }>(await handlers().haven_prepare_catalog_purchase({ catalog_id: 'cat_1', max_amount: '2000000' }))

    // The exact compact quote shape (#1272) — payment_id from the created intent.
    expect(result.data.payment_id).toBe(X402_INTENT_RESPONSE.payment_id)
    // #1318 review: no top-level rail key — allowance.rail is the policy rail.
    expect('rail' in result.data).toBe(false)
    expect(result.data.network).toBe('base')
    expect(result.data.asset).toBe(PAYMENT_REQUIRED.accepts[0].asset)
    expect(result.data.amount_atomic).toBe('1500000')
    expect(result.data.token).toBe('USDC')
    expect(result.data.merchant_url).toBe('http://merchant.test/mcp')
    expect(result.data.tool_name).toBe('create_text')
    expect(result.data.arguments).toEqual({ prompt: 'Hello' })
    // Catalog fields, marked indicative — never authoritative.
    expect(result.data.catalog_id).toBe('cat_1')
    expect(result.data.catalog_name).toBe('CloudNest 50GB')
    expect(result.data.catalog_price_atomic).toBe('1500000')
    expect(result.data.catalog_price_is_indicative).toBe(true)
    // Rail-aware allowance block.
    expect(result.data.allowance).toEqual({
      rail: 'legacy',
      sufficient: true,
      remaining_atomic: '5000000',
      source: 'allowance_module',
    })
    // #1308 guidance — next step is the SAME signer call as haven_pay_mcp_tool.
    expect(result.data.next_action).toBe(AgentPaymentNextAction.SignAndSubmitPayment)
    expect(result.data.next_tool).toBe('mcp__haven-signer__haven_sign_x402')
    // #1588: the runtime-neutral pair rides along; next_tool stays byte-identical.
    expect((result.data as { next_tool_server?: string }).next_tool_server).toBe('haven-signer')
    expect((result.data as { next_tool_name?: string }).next_tool_name).toBe('haven_sign_x402')
    expect(result.data.next_arguments).toEqual({ payment_id: X402_INTENT_RESPONSE.payment_id })
    // Catalog price matched the live quote — no CATALOG_PRICE_DIFFERS warning.
    expect(result.data.warnings.some((w) => w.code === 'CATALOG_PRICE_DIFFERS')).toBe(false)

    // The catalog entry's OWN tool_arguments were what got quoted and funded.
    const intentCall = calls.find((c) => c.url.endsWith('/x402'))
    expect(intentCall?.body?.mcpCallContext).toMatchObject({
      merchantUrl: 'http://merchant.test/mcp',
      toolName: 'create_text',
      arguments: { prompt: 'Hello' },
    })
  })

  it('success (delegation rail, sufficient budget): reports rail: delegation, source: active_delegations, derived from #1090', async () => {
    stubFetch({
      ...baseRoutes,
      'GET /machine-payments/agent': { status: 200, body: DELEGATION_AGENT_RESPONSE },
      'GET /machine-payments/allowances': { status: 200, body: allowancesFixture('5000000', 'delegation') },
    })

    const result = ok<{ allowance: { rail: string; sufficient: boolean | null; remaining_atomic?: string; source: string } }>(
      await handlers().haven_prepare_catalog_purchase({ catalog_id: 'cat_1', max_amount: '2000000' }),
    )

    expect(result.data.allowance).toEqual({
      rail: 'delegation',
      sufficient: true,
      remaining_atomic: '5000000',
      source: 'active_delegations',
    })
    // The intent was still created — sufficient budget does not refuse.
    expect(calls.find((c) => c.url.endsWith('/x402'))).toBeDefined()
  })

  it('refuses an unknown or wrong-chain catalog_id with 404 — chain-scoping is free from #1299 SQL', async () => {
    stubFetch({
      'GET /catalog/cat_missing': { status: 404, body: { error: 'Catalog entry not found' } },
    })

    const payload = await handlers().haven_prepare_catalog_purchase({
      catalog_id: 'cat_missing',
      max_amount: '2000000',
    })

    expect(payload.success).toBe(false)
    if (payload.success) throw new Error('expected failure')
    expect(payload.code).toBe('CATALOG_ENTRY_NOT_FOUND')
    expect(payload.statusCode).toBe(404)
    expect(payload.suggested_tool).toBe('haven_discover_tools')
    // No merchant probe, no agent lookup, no intent — the refusal fires immediately.
    expect(calls).toHaveLength(1)
  })

  it('rejects with PRICE_EXCEEDS_MAX before any funding intent when the live price exceeds max_amount', async () => {
    stubFetch({
      ...baseRoutes,
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'GET /machine-payments/allowances': { status: 200, body: allowancesFixture('5000000') },
    })

    // Fixture's authoritative price is maxAmountRequired = 1500000.
    const payload = await handlers().haven_prepare_catalog_purchase({
      catalog_id: 'cat_1',
      max_amount: '1000000',
    })

    expect(payload.success).toBe(false)
    if (payload.success) throw new Error('expected failure')
    expect(payload.code).toBe(AgentPaymentFailureCode.PriceExceedsMax)
    expect(payload.message).toContain('1500000')
    expect(payload.message).toContain('1000000')
    // The MCP lifecycle reads the public delegate address before quoting, but
    // the cap guard still fires before any funding intent is constructed.
    expect(calls.find((c) => c.url.endsWith('/x402'))).toBeUndefined()
  })

  it('refuses without max_amount — no cap_warning softness on the guided path', async () => {
    stubFetch({})
    const payload = await handlers().haven_prepare_catalog_purchase({ catalog_id: 'cat_1' })
    expect(payload.success).toBe(false)
    if (payload.success) throw new Error('expected failure')
    expect(payload.code).toBe('INVALID_INPUT')
    // Schema validation runs before any network call.
    expect(calls).toHaveLength(0)
  })

  it('legacy rail: insufficient allowance still proceeds — the resulting funding intent queues for approval, like haven_pay_mcp_tool', async () => {
    stubFetch({
      ...baseRoutes,
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'GET /machine-payments/allowances': { status: 200, body: allowancesFixture('7500') },
      'POST /x402': { status: 202, body: { payment_id: 'over_1', status: 'pending_approval' } },
    })

    const result = ok<{ status: string; payload_hash: unknown }>(
      await handlers().haven_prepare_catalog_purchase({ catalog_id: 'cat_1', max_amount: '2000000' }),
    )

    expect(result.data.status).toBe('pending_approval')
    expect(result.data.payload_hash).toBeNull()
    // The intent WAS attempted — legacy over-allowance queues, it does not refuse here.
    expect(calls.find((c) => c.url.endsWith('/x402'))).toBeDefined()
  })

  it('delegation rail: over-budget REFUSES at prepare — no approval queue exists on this rail', async () => {
    stubFetch({
      ...baseRoutes,
      'GET /machine-payments/agent': { status: 200, body: DELEGATION_AGENT_RESPONSE },
      'GET /machine-payments/allowances': { status: 200, body: allowancesFixture('100', 'delegation') },
    })

    const payload = await handlers().haven_prepare_catalog_purchase({
      catalog_id: 'cat_1',
      max_amount: '2000000',
    })

    expect(payload.success).toBe(false)
    if (payload.success) throw new Error('expected failure')
    expect(payload.code).toBe('DELEGATION_BUDGET_EXCEEDED')
    expect(payload.next_action).toBe(AgentPaymentNextAction.FundSafeOrRaiseAllowance)
    // Mutation-tested ordering: no funding intent was created — the refusal
    // fires before createX402Intent, unlike the legacy queue-and-proceed path.
    expect(calls.find((c) => c.url.endsWith('/x402'))).toBeUndefined()
  })

  it('refuses a degraded catalog entry, naming haven_pay_mcp_tool as the manual fallback', async () => {
    stubFetch({
      'GET /catalog/cat_1': { status: 200, body: { ...CATALOG_ENTRY_RESPONSE, status: 'degraded' } },
    })

    const payload = await handlers().haven_prepare_catalog_purchase({
      catalog_id: 'cat_1',
      max_amount: '2000000',
    })

    expect(payload.success).toBe(false)
    if (payload.success) throw new Error('expected failure')
    expect(payload.code).toBe('CATALOG_ENTRY_UNUSABLE')
    expect(payload.suggested_tool).toBe('haven_pay_mcp_tool')
    expect(payload.message).toMatch(/degraded/)
    // No merchant probe was attempted against a row Haven cannot trust.
    expect(calls).toHaveLength(1)
  })

  it('refuses a catalog entry missing MCP tool metadata, naming haven_pay_mcp_tool as the manual fallback', async () => {
    stubFetch({
      'GET /catalog/cat_1': { status: 200, body: { ...CATALOG_ENTRY_RESPONSE, tool_name: null } },
    })

    const payload = await handlers().haven_prepare_catalog_purchase({
      catalog_id: 'cat_1',
      max_amount: '2000000',
    })

    expect(payload.success).toBe(false)
    if (payload.success) throw new Error('expected failure')
    expect(payload.code).toBe('CATALOG_ENTRY_UNUSABLE')
    expect(payload.suggested_tool).toBe('haven_pay_mcp_tool')
    expect(payload.message).toMatch(/tool metadata/)
  })

  it('warns CATALOG_PRICE_DIFFERS when the catalog price is stale relative to the live quote', async () => {
    stubFetch({
      ...baseRoutes,
      'GET /catalog/cat_1': { status: 200, body: { ...CATALOG_ENTRY_RESPONSE, price_atomic: '999999' } },
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'GET /machine-payments/allowances': { status: 200, body: allowancesFixture('5000000') },
    })

    const result = ok<{ warnings: Array<{ code: string; message: string }> }>(
      await handlers().haven_prepare_catalog_purchase({ catalog_id: 'cat_1', max_amount: '2000000' }),
    )

    const warning = result.data.warnings.find((w) => w.code === 'CATALOG_PRICE_DIFFERS')
    expect(warning).toBeDefined()
    expect(warning?.message).toContain('999999')
    expect(warning?.message).toContain('1500000')
  })

  it('reports sufficient: null (never a fabricated guess) when the allowance/budget read fails — the preflight still succeeds', async () => {
    stubFetch({
      ...baseRoutes,
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'GET /machine-payments/allowances': { status: 502, body: { error: 'Failed to read on-chain allowance' } },
    })

    const result = ok<{
      allowance: { rail: string; sufficient: boolean | null; source: string }
      warnings: Array<{ code: string }>
    }>(await handlers().haven_prepare_catalog_purchase({ catalog_id: 'cat_1', max_amount: '2000000' }))

    expect(result.data.allowance).toEqual({ rail: 'legacy', sufficient: null, source: 'allowance_module' })
    expect(result.data.warnings.some((w) => w.code === 'ALLOWANCE_CHECK_UNAVAILABLE')).toBe(true)
    // A failed read never fails the preflight — the intent was still created.
    expect(calls.find((c) => c.url.endsWith('/x402'))).toBeDefined()
  })

  // #1319: the legacy-rail case above was already covered — this is the
  // delegation-rail twin the #1318 review flagged as untested. The strict
  // `sufficient === false` refusal guard (step 6) protects correctness, but
  // that guard never even runs here — `sufficient` is `null`, not `false` —
  // so the intent is still created exactly like the legacy rail.
  it('delegation rail: reports sufficient: null (never a fabricated guess) when the allowance/budget read fails — the preflight still succeeds and creates the intent', async () => {
    stubFetch({
      ...baseRoutes,
      'GET /machine-payments/agent': { status: 200, body: DELEGATION_AGENT_RESPONSE },
      'GET /machine-payments/allowances': { status: 502, body: { error: 'Failed to read on-chain allowance' } },
    })

    const result = ok<{
      allowance: { rail: string; sufficient: boolean | null; source: string }
      warnings: Array<{ code: string }>
    }>(await handlers().haven_prepare_catalog_purchase({ catalog_id: 'cat_1', max_amount: '2000000' }))

    expect(result.data.allowance).toEqual({ rail: 'delegation', sufficient: null, source: 'active_delegations' })
    expect(result.data.warnings.some((w) => w.code === 'ALLOWANCE_CHECK_UNAVAILABLE')).toBe(true)
    // A failed read degrades to null, never to a fabricated false — the
    // delegation-rail refusal guard (step 6) only fires on a genuine false,
    // so it never fires here and the intent is still created.
    expect(calls.find((c) => c.url.endsWith('/x402'))).toBeDefined()
  })

  // #1319: the #1318 review's second untested combination — a hard refusal
  // that must fire BEFORE any funding intent exists, unlike the degrade-and-
  // proceed allowance-read failure above.
  it('refuses before creating any intent when haven.getAgent() fails — a hard refusal, not a degrade-and-proceed', async () => {
    stubFetch({
      ...baseRoutes,
      'GET /machine-payments/agent': { status: 500, body: { error: 'boom' } },
    })

    const payload = await handlers().haven_prepare_catalog_purchase({
      catalog_id: 'cat_1',
      max_amount: '2000000',
    })

    expect(payload.success).toBe(false)
    // No funding intent — the agent lookup is a hard stop before the intent
    // is ever created. (#1348 changed one incidental detail: the allowance
    // READ now starts in parallel with the merchant probe, so it may have
    // fired — a harmless read. The load-bearing invariant is intent-creation,
    // asserted here, plus the refusal itself.)
    expect(calls.find((c) => c.url.endsWith('/x402'))).toBeUndefined()
  })

  // ── #1348: round-trip budget — the characterization the issue asked for ────
  // These counts ARE the regression gate: wall-clock is machine-dependent, but
  // the number of sequential Haven round trips is deterministic. Before #1348
  // a successful preflight made FIVE Haven calls (catalog, agent, allowances,
  // agent AGAIN inside createX402Intent, POST /x402); now it makes four, and
  // the agent/allowance reads overlap the merchant probe instead of following
  // it.
  it('ROUND-TRIP BUDGET: a successful preflight makes exactly one call per Haven surface — no duplicate agent fetch (#1348)', async () => {
    stubFetch({
      ...baseRoutes,
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'GET /machine-payments/allowances': { status: 200, body: allowancesFixture('5000000') },
    })

    ok(await handlers().haven_prepare_catalog_purchase({ catalog_id: 'cat_1', max_amount: '2000000' }))

    const byPath = (suffix: string) => calls.filter((c) => new URL(c.url).pathname.endsWith(suffix)).length
    expect(byPath('/catalog/cat_1')).toBe(1)
    // The mutation this guards: dropping the delegateAddress pass-through to
    // createX402Intent silently re-adds its internal agent fetch → 2.
    expect(byPath('/machine-payments/agent')).toBe(1)
    expect(byPath('/machine-payments/allowances')).toBe(1)
    expect(byPath('/x402')).toBe(1)
    // #1360: the funding-leg intent DECLARES its scheme, so a stale delegate
    // address fails the backend's shape cross-check loudly.
    const intentPost = calls.find((c) => new URL(c.url).pathname.endsWith('/x402'))!
    expect(intentPost.body).toMatchObject({ settlementScheme: 'eip3009' })
  })

  it('ROUND-TRIP OVERLAP: the agent/allowance reads are dispatched BEFORE the merchant probe resolves (#1348)', async () => {
    stubFetch({
      ...baseRoutes,
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'GET /machine-payments/allowances': { status: 200, body: allowancesFixture('5000000') },
    })

    ok(await handlers().haven_prepare_catalog_purchase({ catalog_id: 'cat_1', max_amount: '2000000' }))

    // Call order in the recorded log: both Haven reads must appear before the
    // merchant's tools/call 402 probe response could have been consumed — i.e.
    // they were dispatched during the probe, not after it. The merchant POSTs
    // (initialize/notify/tools-call) and the Haven GETs interleave; asserting
    // the GETs precede the LAST merchant POST proves the overlap without
    // depending on scheduler timing.
    const lastMerchantPost = calls.map((c, i) => ({ c, i })).filter(({ c }) => c.method === 'POST' && new URL(c.url).pathname === '/mcp').at(-1)!.i
    const agentIdx = calls.findIndex((c) => new URL(c.url).pathname.endsWith('/machine-payments/agent'))
    const allowancesIdx = calls.findIndex((c) => new URL(c.url).pathname.endsWith('/machine-payments/allowances'))
    expect(agentIdx).toBeGreaterThan(-1)
    expect(agentIdx).toBeLessThan(lastMerchantPost)
    expect(allowancesIdx).toBeLessThan(lastMerchantPost)
  })

  it('FAILURE PRECEDENCE: when the merchant probe AND the agent read both fail, the quote error wins deterministically (#1348)', async () => {
    stubFetch({
      'GET /catalog/cat_1': { status: 200, body: CATALOG_ENTRY_RESPONSE },
      'POST /mcp': { status: 500, body: {} },
      'GET /machine-payments/agent': { status: 500, body: { error: 'agent boom' } },
      'GET /machine-payments/allowances': { status: 500, body: { error: 'allowance boom' } },
    })

    const payload = await handlers().haven_prepare_catalog_purchase({
      catalog_id: 'cat_1',
      max_amount: '2000000',
    })

    expect(payload.success).toBe(false)
    if (!payload.success) {
      // The quote leg's error — never 'agent boom', regardless of which
      // parallel read settles first.
      expect(payload.message).not.toContain('agent boom')
      expect(payload.message).not.toContain('allowance boom')
    }
    expect(calls.find((c) => new URL(c.url).pathname.endsWith('/x402'))).toBeUndefined()
  })

  // #1319: surfaces the #1145 provenance nuance — the delegation rail's
  // on-chain enforcer read deliberately falls back to the full configured
  // budget (never throws) when the RPC read itself fails, so this preflight's
  // failed-read branch above never fires for that failure mode; it reports
  // `sufficient: true` computed from an OPTIMISTIC number instead. The wire
  // now carries that provenance (`remaining_is_from_chain`), and the
  // preflight surfaces it as a warning rather than presenting the figure as
  // confirmed.
  it('delegation rail: warns ALLOWANCE_READ_OPTIMISTIC when the reported remaining is the #1145 fallback, not a live chain read', async () => {
    stubFetch({
      ...baseRoutes,
      'GET /machine-payments/agent': { status: 200, body: DELEGATION_AGENT_RESPONSE },
      'GET /machine-payments/allowances': {
        status: 200,
        body: allowancesFixture('5000000', 'delegation', { remainingIsFromChain: false }),
      },
    })

    const result = ok<{
      allowance: { rail: string; sufficient: boolean | null; remaining_atomic?: string; source: string }
      warnings: Array<{ code: string; message: string }>
    }>(await handlers().haven_prepare_catalog_purchase({ catalog_id: 'cat_1', max_amount: '2000000' }))

    // sufficient still reports a real true/false — this is a fund-safe
    // optimistic read (the caveat enforcer re-checks at redemption), never a
    // failed read like ALLOWANCE_CHECK_UNAVAILABLE above.
    expect(result.data.allowance).toEqual({
      rail: 'delegation', sufficient: true, remaining_atomic: '5000000', source: 'active_delegations',
    })
    const warning = result.data.warnings.find((w) => w.code === 'ALLOWANCE_READ_OPTIMISTIC')
    expect(warning).toBeDefined()
    expect(warning?.message).toMatch(/on-chain policy .* remains the actual .*gate/)
    // Never a refusal — the intent was still created.
    expect(calls.find((c) => c.url.endsWith('/x402'))).toBeDefined()
  })

  it('delegation rail: does NOT warn ALLOWANCE_READ_OPTIMISTIC when the reported remaining came from a live chain read', async () => {
    stubFetch({
      ...baseRoutes,
      'GET /machine-payments/agent': { status: 200, body: DELEGATION_AGENT_RESPONSE },
      'GET /machine-payments/allowances': {
        status: 200,
        body: allowancesFixture('5000000', 'delegation', { remainingIsFromChain: true }),
      },
    })

    const result = ok<{ warnings: Array<{ code: string }> }>(
      await handlers().haven_prepare_catalog_purchase({ catalog_id: 'cat_1', max_amount: '2000000' }),
    )

    expect(result.data.warnings.some((w) => w.code === 'ALLOWANCE_READ_OPTIMISTIC')).toBe(false)
  })

  it('legacy rail: never warns ALLOWANCE_READ_OPTIMISTIC — the provenance flag is delegation-rail only', async () => {
    stubFetch({
      ...baseRoutes,
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'GET /machine-payments/allowances': { status: 200, body: allowancesFixture('5000000', 'legacy') },
    })

    const result = ok<{ warnings: Array<{ code: string }> }>(
      await handlers().haven_prepare_catalog_purchase({ catalog_id: 'cat_1', max_amount: '2000000' }),
    )

    expect(result.data.warnings.some((w) => w.code === 'ALLOWANCE_READ_OPTIMISTIC')).toBe(false)
  })

  it('passes idempotency_key through to the merchant quote and the funding intent (#1207 replay semantics apply unchanged)', async () => {
    stubFetch({
      ...baseRoutes,
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'GET /machine-payments/allowances': { status: 200, body: allowancesFixture('5000000') },
    })

    ok(
      await handlers().haven_prepare_catalog_purchase({
        catalog_id: 'cat_1',
        max_amount: '2000000',
        idempotency_key: 'catalog-purchase-key-1',
      }),
    )

    const intentCall = calls.find((c) => c.url.endsWith('/x402'))
    expect(intentCall?.body?.idempotencyKey).toBe('catalog-purchase-key-1')
  })

  /**
   * #1547 — the guided path honours the #1450 settlement-scheme preference.
   *
   * Before this, the catalog handler was hard-wired to createX402Intent (the
   * 3009 funding leg) while haven_pay_mcp_tool ran #1453's selector — so the
   * RECOMMENDED guided route forced the fallback scheme and its transient
   * delegate hot balance. The negatives carry this suite for the same reason
   * they carry the #1456 one: a selector that always answered "erc7710" would
   * pass a happy-path-only file.
   */
  describe('settlement-scheme preference (#1547)', () => {
    const ERC7710_PR = {
      ...PAYMENT_REQUIRED,
      accepts: [
        ...PAYMENT_REQUIRED.accepts,
        {
          ...PAYMENT_REQUIRED.accepts[0],
          extra: {
            assetTransferMethod: 'erc7710',
            facilitatorAddresses: ['0x4444444444444444444444444444444444444444'],
          },
        },
      ],
    }
    const erc7710Header = btoa(JSON.stringify(ERC7710_PR))
    const CHILD = {
      payment_id: 'pay_7710',
      status: 'pending_signature',
      sign_data: {
        hash: '0x' + '11'.repeat(32),
        signature_scheme: 'eip712_delegation',
        typed_data: { domain: {}, types: {}, primaryType: 'Delegation', message: { caveats: [] } },
      },
    }

    function xBody() {
      const raw = calls.find((c) => new URL(c.url).pathname === '/x402')!.body
      return (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, any>
    }

    async function prepare(header: string, agent: Record<string, unknown>, expectErc7710 = false) {
      stubFetch({
        'GET /catalog/cat_1': { status: 200, body: CATALOG_ENTRY_RESPONSE },
        'POST /mcp': { status: 402, responseHeaders: { 'PAYMENT-REQUIRED': header } },
        'POST /x402': { status: 201, body: expectErc7710 ? CHILD : X402_INTENT_RESPONSE },
        'GET /machine-payments/agent': { status: 200, body: agent },
        'GET /machine-payments/allowances': {
          status: 200,
          body: allowancesFixture(
            '5000000',
            (agent as { execution_rail?: string }).execution_rail === 'delegation' ? 'delegation' : 'legacy',
          ),
        },
      })
      return ok(
        await handlers().haven_prepare_catalog_purchase({ catalog_id: 'cat_1', max_amount: '2000000' }),
      ) as { data: Record<string, any> }
    }

    it('delegation rail + erc7710 merchant: direct settlement, with the catalog fields and allowance block kept', async () => {
      const res = await prepare(erc7710Header, DELEGATION_AGENT_RESPONSE, true)
      expect(res.data.settlement_scheme).toBe('erc7710')
      expect(res.data.settlement.funding_leg).toBe(false)
      expect(res.data.next_tool).toBe('mcp__haven-signer__haven_sign')
      expect((res.data as { next_tool_server?: string }).next_tool_server).toBe('haven-signer')
      expect((res.data as { next_tool_name?: string }).next_tool_name).toBe('haven_sign')
      expect(res.data.next_arguments).toEqual({ payment_id: 'pay_7710' })
      // The guided-path extras survive the scheme branch — this shape is the
      // SAME contract as the 3009 one, minus the funding leg.
      expect(res.data.catalog_id).toBe('cat_1')
      expect(res.data.catalog_price_is_indicative).toBe(true)
      expect(res.data.allowance).toMatchObject({ rail: 'delegation', sufficient: true })

      const body = xBody()
      // payTo = the MERCHANT is what selects direct settlement server-side.
      expect(body.settlementScheme).toBe('erc7710')
      expect(body.payTo).toBe(PAYMENT_REQUIRED.accepts[0].payTo)
    })

    it('persists the merchant call context on the erc7710 authorize, so settle rehydrates by payment_id (#1307)', async () => {
      await prepare(erc7710Header, DELEGATION_AGENT_RESPONSE, true)
      const body = xBody()
      expect(body.mcpCallContext).toMatchObject({
        merchantUrl: 'http://merchant.test/mcp',
        toolName: 'create_text',
        arguments: { prompt: 'Hello' },
      })
    })

    it('a LEGACY-rail account never takes the branch, even when the merchant offers it', async () => {
      const res = await prepare(erc7710Header, AGENT_RESPONSE)
      expect(res.data.settlement_scheme).toBeUndefined()
      expect(res.data.next_tool).toBe('mcp__haven-signer__haven_sign_x402')
      expect((res.data as { next_tool_server?: string }).next_tool_server).toBe('haven-signer')
      expect((res.data as { next_tool_name?: string }).next_tool_name).toBe('haven_sign_x402')
      expect(xBody().settlementScheme).toBe('eip3009')
    })

    it('a 3009-only merchant stays on the bridge, even on a delegation account', async () => {
      const res = await prepare(paymentRequiredHeader, DELEGATION_AGENT_RESPONSE)
      expect(res.data.settlement_scheme).toBeUndefined()
      expect(xBody().settlementScheme).toBe('eip3009')
    })

    it('the CATALOG_PRICE_DIFFERS warning survives the scheme branch (it fires before it)', async () => {
      stubFetch({
        'GET /catalog/cat_1': {
          status: 200,
          body: { ...CATALOG_ENTRY_RESPONSE, price_atomic: '999' },
        },
        'POST /mcp': { status: 402, responseHeaders: { 'PAYMENT-REQUIRED': erc7710Header } },
        'POST /x402': { status: 201, body: CHILD },
        'GET /machine-payments/agent': { status: 200, body: DELEGATION_AGENT_RESPONSE },
        'GET /machine-payments/allowances': {
          status: 200,
          body: allowancesFixture('5000000', 'delegation'),
        },
      })
      const res = ok<{ settlement_scheme: string; warnings: Array<{ code: string }> }>(
        await handlers().haven_prepare_catalog_purchase({ catalog_id: 'cat_1', max_amount: '2000000' }),
      )
      expect(res.data.settlement_scheme).toBe('erc7710')
      expect(res.data.warnings.map((w) => w.code)).toContain('CATALOG_PRICE_DIFFERS')
    })
  })
})

// ── haven_settle_mcp_tool (fast-path: fund + settle in one call) ──────────────

describe('haven_settle_mcp_tool', () => {
  const SIG = '0x' + '11'.repeat(65)

  it('funds (relays signature) then delivers the merchant header in one call', async () => {
    stubFetch({
      'POST /payments/pay_x402/sign': { status: 200, body: { status: 'confirmed', tx_hash: '0xfund' } },
    })
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    const spy = vi.spyOn(haven, 'completeX402MerchantCall').mockResolvedValue({
      status: 200,
      ok: true,
      body: { jsonrpc: '2.0', id: 'x', result: { content: [{ type: 'text', text: 'a joke' }] } },
      settlementTxHash: '0xsettle',
    })

    const result = ok<{ payment_id: string; funding_tx_hash: string; settled: boolean; settlement_tx_hash: string | null }>(
      await createToolHandlers(haven).haven_settle_mcp_tool({
        payment_id: 'pay_x402',
        signature: SIG,
        merchant_url: 'http://merchant.test/mcp',
        tool_name: 'create_text',
        arguments: { prompt: 'Hello' },
        max_amount: '2000000',
        payment_header: VALID_PAYMENT_HEADER,
      }),
    )

    // Funding signature was relayed (no key in the wire), then the merchant call ran.
    const signCall = calls.find((c) => c.url.includes('/sign'))
    expect(signCall?.body).toEqual({ signature: SIG })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0].paymentId).toBe('pay_x402')
    expect(spy.mock.calls[0][0].paymentHeader).toBe(VALID_PAYMENT_HEADER)
    // payment_id is echoed so the agent can reconcile without retaining it.
    expect(result.data.payment_id).toBe('pay_x402')
    expect(result.data.funding_tx_hash).toBe('0xfund')
    expect(result.data.settled).toBe(true)
    expect(result.data.settlement_tx_hash).toBe('0xsettle')
    expect(JSON.stringify(calls)).not.toContain(DELEGATE_KEY)
  })

  it('accepts the current v2 payment-header envelope before funding', async () => {
    stubFetch({
      'POST /payments/pay_x402/sign': { status: 200, body: { status: 'confirmed', tx_hash: '0xfund' } },
    })
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    vi.spyOn(haven, 'completeX402MerchantCall').mockResolvedValue({ status: 200, ok: true, body: {} })

    const result = await createToolHandlers(haven).haven_settle_mcp_tool({
      payment_id: 'pay_x402', signature: SIG, merchant_url: 'http://merchant.test/mcp', tool_name: 'create_text',
      payment_header: VALID_PAYMENT_HEADER_V2,
    })

    expect(result.success).toBe(true)
    expect(calls.some((call) => call.url.endsWith('/payments/pay_x402/sign'))).toBe(true)
  })

  it.each([
    ['malformed base64', 'not-a-payment-header'],
    ['oversized header', 'A'.repeat(65_540)],
    ['unsupported version', (header: string) => mutateHeader(header, (value) => { value.x402Version = 99 })],
    ['merchant', (header: string) => mutateHeader(header, (value) => { (value.accepted as Record<string, unknown>).payTo = '0x0000000000000000000000000000000000000001' })],
    ['asset', (header: string) => mutateHeader(header, (value) => { (value.accepted as Record<string, unknown>).asset = '0x0000000000000000000000000000000000000001' })],
    ['network', (header: string) => mutateHeader(header, (value) => { (value.accepted as Record<string, unknown>).network = 'eip155:84532' })],
    ['amount', (header: string) => mutateHeader(header, (value) => { (value.accepted as Record<string, unknown>).maxAmountRequired = '1' })],
    ['payer', (header: string) => mutateHeader(header, (value) => { ((value.payload as Record<string, any>).authorization).from = '0x0000000000000000000000000000000000000001' })],
    ['expiry', (header: string) => mutateHeader(header, (value) => { ((value.payload as Record<string, any>).authorization).validBefore = '1' })],
    ['nonce', (header: string) => mutateHeader(header, (value) => { ((value.payload as Record<string, any>).authorization).nonce = '0x01' })],
    ['resource', (header: string) => mutateHeader(header, (value) => { (value.accepted as Record<string, unknown>).resource = 'https://merchant.test/substituted' })],
  ])('rejects a %s mutation before funding or merchant delivery', async (_name, mutation) => {
    const paymentHeader = typeof mutation === 'string' ? mutation : mutation(VALID_PAYMENT_HEADER_V2)
    stubFetch({
      'POST /payments/pay_x402/sign': { status: 200, body: { status: 'confirmed', tx_hash: '0xfund' } },
    })
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    const merchant = vi.spyOn(haven, 'completeX402MerchantCall')
    const result = await createToolHandlers(haven).haven_settle_mcp_tool({
      payment_id: 'pay_x402', signature: SIG, merchant_url: 'http://merchant.test/mcp', tool_name: 'create_text',
      payment_header: paymentHeader,
    })

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected payment-header preflight failure')
    expect(result.code).toBe('INVALID_PAYMENT_HEADER')
    expect(result.message).toContain('No funding was relayed')
    expect(calls.some((call) => call.url.endsWith('/payments/pay_x402/sign'))).toBe(false)
    expect(merchant).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain(paymentHeader)
  })

  it('does NOT contact the merchant when funding does not confirm', async () => {
    stubFetch({
      'POST /payments/pay_pending/sign': { status: 202, body: { status: 'pending_approval' } },
    })
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    const spy = vi.spyOn(haven, 'completeX402MerchantCall')

    const result = ok<{ payment_id: string; settled: boolean; funding_status: string }>(
      await createToolHandlers(haven).haven_settle_mcp_tool({
        payment_id: 'pay_pending',
        signature: SIG,
        merchant_url: 'http://merchant.test/mcp',
        tool_name: 'create_text',
        payment_header: VALID_PAYMENT_HEADER,
      }),
    )

    expect(result.data.settled).toBe(false)
    expect(result.data.funding_status).toBe('pending_approval')
    // payment_id is echoed on the not-settled path too, for status follow-up.
    expect(result.data.payment_id).toBe('pay_pending')
    expect(spy).not.toHaveBeenCalled()
  })

  it('waits for on-chain funding confirmation BEFORE delivering to the merchant', async () => {
    stubFetch({
      'POST /payments/pay_x402/sign': { status: 200, body: { status: 'confirmed', tx_hash: '0xfund' } },
    })
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    const ensureSpy = vi.spyOn(haven, 'ensureFundingConfirmed').mockResolvedValue(undefined)
    const completeSpy = vi.spyOn(haven, 'completeX402MerchantCall').mockResolvedValue({
      status: 200, ok: true, body: {}, settlementTxHash: '0xsettle',
    })

    ok(
      await createToolHandlers(haven).haven_settle_mcp_tool({
        payment_id: 'pay_x402',
        signature: SIG,
        merchant_url: 'http://merchant.test/mcp',
        tool_name: 'create_text',
        payment_header: VALID_PAYMENT_HEADER,
      }),
    )

    // Confirmation is awaited with the funding tx hash, before the merchant call.
    expect(ensureSpy).toHaveBeenCalledWith('pay_x402', '0xfund')
    expect(ensureSpy.mock.invocationCallOrder[0]).toBeLessThan(completeSpy.mock.invocationCallOrder[0])
  })

  it('does NOT deliver to the merchant if funding never confirms on-chain', async () => {
    stubFetch({
      'POST /payments/pay_x402/sign': { status: 200, body: { status: 'confirmed', tx_hash: '0xfund' } },
    })
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    vi.spyOn(haven, 'ensureFundingConfirmed').mockRejectedValue(
      new Error('Funding tx did not confirm on-chain within the timeout window.'),
    )
    const completeSpy = vi.spyOn(haven, 'completeX402MerchantCall')

    const payload = await createToolHandlers(haven).haven_settle_mcp_tool({
      payment_id: 'pay_x402',
      signature: SIG,
      merchant_url: 'http://merchant.test/mcp',
      tool_name: 'create_text',
      payment_header: VALID_PAYMENT_HEADER,
    })

    if (payload.success) throw new Error('expected a failure payload')
    // The header is never delivered to a merchant that would reject an unfunded delegate.
    expect(completeSpy).not.toHaveBeenCalled()
  })

  it('fails with MERCHANT_REJECTED_AFTER_FUNDING when the merchant rejects post-funding', async () => {
    stubFetch({
      'POST /payments/pay_x402/sign': { status: 200, body: { status: 'confirmed', tx_hash: '0xfund' } },
    })
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    vi.spyOn(haven, 'completeX402MerchantCall').mockResolvedValue({
      status: 402,
      ok: false,
      body: { error: 'payment verification failed' },
    })

    const payload = await createToolHandlers(haven).haven_settle_mcp_tool({
      payment_id: 'pay_x402',
      signature: SIG,
      merchant_url: 'http://merchant.test/mcp',
      tool_name: 'create_text',
      payment_header: VALID_PAYMENT_HEADER,
    })

    if (payload.success) throw new Error('expected a failure payload')
    expect(payload.code).toBe(AgentPaymentFailureCode.MerchantRejectedAfterFunding)
    expect(payload.suggested_tool).toBe('haven_sweep_delegate')
  })
})

// ── haven_settle_mcp_tool: post-purchase allowance/budget summary (#1310) ─────

describe('haven_settle_mcp_tool: post-purchase allowance summary (#1310)', () => {
  const SIG = '0x' + '11'.repeat(65)
  const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
  const DELEGATION_AGENT_RESPONSE = { ...AGENT_RESPONSE, execution_rail: 'delegation' }

  function allowancesFixture(remaining: string, rail: 'legacy' | 'delegation' = 'legacy') {
    return {
      agent_id: 'agt_1',
      safe_address: '0xSafe',
      delegate_address: '0xDelegate',
      chain_id: 8453,
      allowances: [{
        id: rail === 'delegation' ? 'delegation-1' : 'allowance-1',
        token_address: USDC,
        token_symbol: 'USDC',
        configured_amount: rail === 'delegation' ? '5.00' : '5000000',
        reset_period_min: rail === 'delegation' ? 1440 : 60,
        onchain: {
          amount: remaining, spent: '0', remaining, effective_spent: '0',
          reset_time_min: rail === 'delegation' ? 1440 : 60,
          last_reset_min: rail === 'delegation' ? 0 : 100,
          nonce: rail === 'delegation' ? 0 : 7,
          is_reset_pending: false,
        },
      }],
    }
  }

  // GET /machine-payments/:id/status fixture — this is how the summary
  // resolves WHICH token was settled, without the caller passing it.
  function statusFixture(overrides: Record<string, unknown> = {}) {
    return {
      payment_id: 'pay_x402',
      kind: 'payment_intent',
      rail: 'x402',
      status: 'confirmed',
      phase: 'payment_confirmed',
      next_action: 'none',
      amount: '1.50',
      token: 'USDC',
      resource_url: PAYMENT_REQUIRED.resource.url,
      merchant_address: PAYMENT_REQUIRED.accepts[0].payTo,
      payer_address: headerSigner.delegateAddress,
      tx_hash: '0xfund',
      expires_at: '2099-01-01T00:00:00.000Z',
      chain_id: 8453,
      message: 'The payment is confirmed.',
      amount_atomic: PAYMENT_REQUIRED.accepts[0].maxAmountRequired,
      asset: USDC,
      network: PAYMENT_REQUIRED.accepts[0].network,
      ...overrides,
    }
  }

  function settleArgs() {
    return {
      payment_id: 'pay_x402',
      signature: SIG,
      merchant_url: 'http://merchant.test/mcp',
      tool_name: 'create_text',
      arguments: { prompt: 'Hello' },
      payment_header: VALID_PAYMENT_HEADER,
    }
  }

  function havenSettled(extraRoutes: Record<string, RouteDefinition>) {
    stubFetch({
      'POST /payments/pay_x402/sign': { status: 200, body: { status: 'confirmed', tx_hash: '0xfund' } },
      ...extraRoutes,
    })
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    // Isolate the summary's OWN getPaymentStatus call (below) from
    // ensureFundingConfirmed's unrelated, pre-existing, uncaught
    // getPaymentStatus call — both would otherwise hit the SAME stubbed
    // status route and conflate two different failure modes.
    vi.spyOn(haven, 'ensureFundingConfirmed').mockResolvedValue(undefined)
    vi.spyOn(haven, 'completeX402MerchantCall').mockResolvedValue({
      status: 200, ok: true, body: { result: 'ok' }, settlementTxHash: '0xsettle',
    })
    return haven
  }

  it('attaches the rail-aware post-purchase allowance summary (legacy rail)', async () => {
    const haven = havenSettled({
      'GET /machine-payments/pay_x402/status': { status: 200, body: statusFixture() },
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'GET /machine-payments/allowances': { status: 200, body: allowancesFixture('3500000') },
    })

    const result = ok<{
      settled: boolean
      allowance: {
        rail: string
        remaining_atomic: string
        remaining_display?: string
        token_symbol?: string
        token_address?: string
        reset_period?: number
        source: string
      } | null
    }>(await createToolHandlers(haven).haven_settle_mcp_tool(settleArgs()))

    expect(result.data.settled).toBe(true)
    // Deliberately the SAME rail-labeled shape as #1306's preflight `allowance`
    // block, minus the preflight-only `sufficient` field.
    expect(result.data.allowance).toEqual({
      rail: 'legacy',
      remaining_atomic: '3500000',
      remaining_display: '3.5 USDC',
      token_symbol: 'USDC',
      token_address: USDC,
      reset_period: 60,
      source: 'allowance_module',
    })
  })

  it('returns a compact Haven-derived purchase_summary while preserving the merchant result as evidence', async () => {
    const haven = havenSettled({
      'GET /machine-payments/pay_x402/status': { status: 200, body: statusFixture() },
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'GET /machine-payments/allowances': { status: 200, body: allowancesFixture('3500000') },
    })
    const merchantResult = {
      structuredContent: {
        summary: {
          status: 'confirmed',
          product_name: 'NordShield VPN Basic',
          invoice_id: 'INV-123',
          amount: '999999', // merchant display data must not overwrite Haven amount
        },
      },
      invoice: 'large merchant blob',
    }
    vi.spyOn(haven, 'completeX402MerchantCall').mockResolvedValue({
      status: 200, ok: true, body: merchantResult, settlementTxHash: '0xsettle',
    })

    const result = ok<{
      result: unknown
      agent_summary: {
        status: string
        purchase_summary: Record<string, unknown>
      }
    }>(await createToolHandlers(haven).haven_settle_mcp_tool(settleArgs()))

    expect(result.data.result).toBe(merchantResult)
    expect(result.data.agent_summary).toMatchObject({
      status: 'settled',
      purchase_summary: {
        status: 'settled',
        product: 'NordShield VPN Basic',
        amount: '1.50',
        amount_atomic: PAYMENT_REQUIRED.accepts[0].maxAmountRequired,
        asset: USDC,
        network: PAYMENT_REQUIRED.accepts[0].network,
        merchant: { address: PAYMENT_REQUIRED.accepts[0].payTo, resource_url: PAYMENT_REQUIRED.resource.url },
        invoice_id: 'INV-123',
        funding_tx_hash: '0xfund',
        settlement_tx_hash: '0xsettle',
        allowance: { remaining_atomic: '3500000' },
      },
    })
    expect(calls.filter((call) => call.method === 'GET' && call.url.endsWith('/machine-payments/pay_x402/status'))).toHaveLength(2)
  })

  it('does not infer settlement or metadata from a merchant result that merely claims payment', async () => {
    const haven = havenSettled({
      'GET /machine-payments/pay_x402/status': { status: 200, body: statusFixture() },
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'GET /machine-payments/allowances': { status: 200, body: allowancesFixture('3500000') },
    })
    const merchantResult = { paid: true, status: 'confirmed', invoice_id: 'UNTRUSTED' }
    vi.spyOn(haven, 'getPaymentStatus')
      .mockResolvedValueOnce({
        paymentId: 'pay_x402', kind: 'payment_intent', rail: 'x402', status: 'pending_signature',
        phase: AgentPaymentPhase.AgentSignatureRequired, nextAction: AgentPaymentNextAction.SignAndSubmitPayment, amount: '1.50', token: 'USDC',
        resourceUrl: PAYMENT_REQUIRED.resource.url, merchantAddress: PAYMENT_REQUIRED.accepts[0].payTo,
        payerAddress: headerSigner.delegateAddress, txHash: null, expiresAt: '2099-01-01T00:00:00.000Z',
        chainId: 8453, message: 'Ready', amountAtomic: PAYMENT_REQUIRED.accepts[0].maxAmountRequired,
        asset: USDC, network: PAYMENT_REQUIRED.accepts[0].network,
      })
      .mockResolvedValueOnce({
        paymentId: 'pay_x402', kind: 'payment_intent', rail: 'x402', status: 'confirmed',
        phase: 'payment_confirmed', nextAction: 'none', amount: '2.00', token: 'DAI',
        resourceUrl: null, merchantAddress: null, txHash: '0xfund', expiresAt: '2099-01-01T00:00:00.000Z',
        chainId: 8453, message: 'Confirmed', asset: null, network: null,
      })
    vi.spyOn(haven, 'completeX402MerchantCall').mockResolvedValue({ status: 200, ok: true, body: merchantResult })

    const result = ok<{ result: unknown; agent_summary: { purchase_summary: Record<string, unknown> } }>(
      await createToolHandlers(haven).haven_settle_mcp_tool(settleArgs()),
    )

    expect(result.data.result).toBe(merchantResult)
    expect(result.data.agent_summary.purchase_summary).toMatchObject({
      status: 'settled',
      product: null,
      asset: null,
      merchant: { address: null, resource_url: null },
      invoice_id: null,
      settlement_tx_hash: null,
    })
    // The reporting status is set by Haven's completed flow, never this blob.
    expect(result.data.agent_summary.purchase_summary.status).toBe('settled')
  })

  it('keeps a merchant receipt transaction hash as optional evidence, not settlement truth', async () => {
    const haven = havenSettled({
      'GET /machine-payments/pay_x402/status': { status: 200, body: statusFixture() },
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'GET /machine-payments/allowances': { status: 200, body: allowancesFixture('3500000') },
    })
    vi.spyOn(haven, 'completeX402MerchantCall').mockResolvedValue({
      status: 200, ok: true, body: {}, settlementTxHash: 'merchant-receipt-reference',
    })

    const result = ok<{ agent_summary: { purchase_summary: Record<string, unknown> } }>(
      await createToolHandlers(haven).haven_settle_mcp_tool(settleArgs()),
    )

    expect(result.data.agent_summary.purchase_summary).toMatchObject({
      status: 'settled',
      funding_tx_hash: '0xfund',
      settlement_tx_hash: 'merchant-receipt-reference',
    })
  })

  it('attaches source: active_delegations on the delegation rail, derived via #1090 (not agent_allowances)', async () => {
    const haven = havenSettled({
      'GET /machine-payments/pay_x402/status': { status: 200, body: statusFixture() },
      'GET /machine-payments/agent': { status: 200, body: DELEGATION_AGENT_RESPONSE },
      'GET /machine-payments/allowances': { status: 200, body: allowancesFixture('4200000', 'delegation') },
    })

    const result = ok<{ allowance: { rail: string; source: string; remaining_atomic: string } | null }>(
      await createToolHandlers(haven).haven_settle_mcp_tool(settleArgs()),
    )

    expect(result.data.allowance).toEqual(
      expect.objectContaining({ rail: 'delegation', source: 'active_delegations', remaining_atomic: '4200000' }),
    )
  })

  it('parity: remaining_atomic matches haven_get_allowances for the SAME fixture — same source, asserted as equality', async () => {
    const haven = havenSettled({
      'GET /machine-payments/pay_x402/status': { status: 200, body: statusFixture() },
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'GET /machine-payments/allowances': { status: 200, body: allowancesFixture('1234567') },
    })
    const h = createToolHandlers(haven)

    const settleResult = ok<{ allowance: { remaining_atomic: string; token_address?: string } | null }>(
      await h.haven_settle_mcp_tool(settleArgs()),
    )
    const allowancesResult = ok<{ allowances: Array<{ tokenAddress: string; onchain: { remaining: string } }> }>(
      await h.haven_get_allowances({}),
    )
    const match = allowancesResult.data.allowances.find((a) => a.tokenAddress.toLowerCase() === USDC)

    expect(settleResult.data.allowance?.remaining_atomic).toBe(match?.onchain.remaining)
    expect(settleResult.data.allowance?.remaining_atomic).toBe('1234567')
  })

  it('a failed allowance/budget read NEVER converts settled:true into failure — degrades to a null block + warning', async () => {
    const haven = havenSettled({
      'GET /machine-payments/pay_x402/status': { status: 200, body: statusFixture() },
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'GET /machine-payments/allowances': { status: 502, body: { error: 'Failed to read on-chain allowance' } },
    })

    const result = ok<{
      settled: boolean
      allowance: unknown
      warnings: Array<{ code: string }>
    }>(await createToolHandlers(haven).haven_settle_mcp_tool(settleArgs()))

    expect(result.data.settled).toBe(true)
    expect(result.data.allowance).toBeNull()
    expect(result.data.warnings.some((w) => w.code === 'ALLOWANCE_CHECK_UNAVAILABLE')).toBe(true)
  })

  it('keeps verified Haven payment fields when only the allowance read fails', async () => {
    const haven = havenSettled({
      'GET /machine-payments/pay_x402/status': { status: 200, body: statusFixture() },
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'GET /machine-payments/allowances': { status: 502, body: { error: 'Failed to read on-chain allowance' } },
    })

    const result = ok<{ allowance: unknown; agent_summary: { purchase_summary: Record<string, unknown> } }>(
      await createToolHandlers(haven).haven_settle_mcp_tool(settleArgs()),
    )

    expect(result.data.allowance).toBeNull()
    expect(result.data.agent_summary.purchase_summary).toMatchObject({
      amount: '1.50',
      asset: USDC,
      network: PAYMENT_REQUIRED.accepts[0].network,
      merchant: { address: PAYMENT_REQUIRED.accepts[0].payTo, resource_url: PAYMENT_REQUIRED.resource.url },
      allowance: null,
    })
  })

  it('a failed payment-status lookup (token resolution) ALSO never converts settled:true into failure', async () => {
    const haven = havenSettled({
      'GET /machine-payments/pay_x402/status': { status: 200, body: statusFixture() },
    })
    vi.spyOn(haven, 'getPaymentStatus')
      .mockResolvedValueOnce({
        paymentId: 'pay_x402', kind: 'payment_intent', rail: 'x402', status: 'pending_signature',
        phase: AgentPaymentPhase.AgentSignatureRequired, nextAction: AgentPaymentNextAction.SignAndSubmitPayment, amount: '1.50', token: 'USDC',
        resourceUrl: PAYMENT_REQUIRED.resource.url, merchantAddress: PAYMENT_REQUIRED.accepts[0].payTo,
        payerAddress: headerSigner.delegateAddress, txHash: null, expiresAt: '2099-01-01T00:00:00.000Z',
        chainId: 8453, message: 'Ready', amountAtomic: PAYMENT_REQUIRED.accepts[0].maxAmountRequired,
        asset: USDC, network: PAYMENT_REQUIRED.accepts[0].network,
      })
      .mockRejectedValueOnce(new HavenApiError('boom', 502))

    const result = ok<{ settled: boolean; allowance: unknown; warnings: Array<{ code: string }> }>(
      await createToolHandlers(haven).haven_settle_mcp_tool(settleArgs()),
    )

    expect(result.data.settled).toBe(true)
    expect(result.data.allowance).toBeNull()
    expect(result.data.warnings.some((w) => w.code === 'ALLOWANCE_CHECK_UNAVAILABLE')).toBe(true)
  })
})

// ── haven_get_payment_status: post-purchase allowance summary (#1310) ─────────

describe('haven_get_payment_status: post-purchase allowance summary (#1310)', () => {
  const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'

  function statusFixture(overrides: Record<string, unknown> = {}) {
    return {
      payment_id: 'pay_x402',
      kind: 'payment_intent',
      rail: 'x402',
      status: 'confirmed',
      phase: 'payment_confirmed',
      next_action: 'none',
      amount: '1.50',
      token: 'USDC',
      resource_url: 'http://merchant.test/mcp',
      merchant_address: '0xMerchant',
      tx_hash: '0xfund',
      expires_at: '2099-01-01T00:00:00.000Z',
      chain_id: 8453,
      message: 'The payment is confirmed.',
      asset: USDC,
      ...overrides,
    }
  }

  function allowancesFixture(remaining: string) {
    return {
      agent_id: 'agt_1',
      safe_address: '0xSafe',
      delegate_address: '0xDelegate',
      chain_id: 8453,
      allowances: [{
        id: 'allowance-1',
        token_address: USDC,
        token_symbol: 'USDC',
        configured_amount: '5000000',
        reset_period_min: 60,
        onchain: {
          amount: remaining, spent: '0', remaining, effective_spent: '0',
          reset_time_min: 60, last_reset_min: 100, nonce: 7, is_reset_pending: false,
        },
      }],
    }
  }

  it('attaches allowance for a genuinely settled x402 payment (rail: x402, phase: payment_confirmed)', async () => {
    stubFetch({
      'GET /machine-payments/pay_x402/status': { status: 200, body: statusFixture() },
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'GET /machine-payments/allowances': { status: 200, body: allowancesFixture('3000000') },
    })

    const result = ok<{ allowance: { rail: string; remaining_atomic: string } | null }>(
      await handlers().haven_get_payment_status({ payment_id: 'pay_x402' }),
    )

    expect(result.data.allowance).toEqual(
      expect.objectContaining({ rail: 'legacy', remaining_atomic: '3000000' }),
    )
  })

  it('does NOT attach allowance for funded_but_unsettled — the merchant did not accept the retry', async () => {
    stubFetch({
      'GET /machine-payments/pay_x402/status': {
        status: 200,
        body: statusFixture({ status: 'funded_but_unsettled', phase: 'funded_but_unsettled' }),
      },
    })

    const result = ok<{ allowance?: unknown }>(
      await handlers().haven_get_payment_status({ payment_id: 'pay_x402' }),
    )

    expect('allowance' in result.data).toBe(false)
    // No allowance/agent reads were made for a non-settled status.
    expect(calls.find((c) => c.url.endsWith('/machine-payments/allowances'))).toBeUndefined()
  })

  it('does NOT attach allowance for a non-x402 rail', async () => {
    stubFetch({
      'GET /machine-payments/pay_direct/status': {
        status: 200,
        body: statusFixture({ payment_id: 'pay_direct', rail: 'direct' }),
      },
    })

    const result = ok<{ allowance?: unknown }>(
      await handlers().haven_get_payment_status({ payment_id: 'pay_direct' }),
    )

    expect('allowance' in result.data).toBe(false)
  })
})

// ── merchant-call-context rehydration by payment_id (#1307) ───────────────────

describe('haven_complete_mcp_tool / haven_settle_mcp_tool merchant-call-context rehydration (#1307)', () => {
  const SIG = '0x' + '11'.repeat(65)

  it('REFUSES half-explicit context (only one of merchant_url/tool_name) instead of silently overriding (#1316 review)', async () => {
    stubFetch({})
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    const spy = vi.spyOn(haven, 'getX402MerchantCallContext')

    const payload = await createToolHandlers(haven).haven_complete_mcp_tool({
      payment_id: 'pay_x402',
      merchant_url: 'http://merchant.test/mcp',
      // tool_name omitted — an agent that supplied merchant_url expects it used
      payment_header: VALID_PAYMENT_HEADER,
    })

    if (payload.success) throw new Error('expected a failure payload')
    expect(payload.code).toBe('INVALID_INPUT')
    expect(payload.message).toMatch(/TOGETHER/)
    expect(payload.next_action).toBe('retry_with_explicit_context')
    // Neither rehydrated nor fetched anything — refused up front.
    expect(spy).not.toHaveBeenCalled()
  })

  it('haven_complete_mcp_tool: explicit merchant_url/tool_name win OUTRIGHT — rehydration is never called', async () => {
    stubFetch({})
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    const rehydrateSpy = vi.spyOn(haven, 'getX402MerchantCallContext')
    const completeSpy = vi.spyOn(haven, 'completeX402MerchantCall').mockResolvedValue({
      status: 200, ok: true, body: { result: 'ok' },
    })

    const result = ok<{ ok: boolean }>(
      await createToolHandlers(haven).haven_complete_mcp_tool({
        payment_id: 'pay_x402',
        merchant_url: 'http://merchant.test/mcp',
        tool_name: 'create_text',
        arguments: { prompt: 'explicit' },
        payment_header: 'eyJ4IjoxfQ==',
      }),
    )

    expect(rehydrateSpy).not.toHaveBeenCalled()
    expect(completeSpy.mock.calls[0][0].url).toBe('http://merchant.test/mcp')
    const envelope = JSON.parse(completeSpy.mock.calls[0][0].init!.body as string)
    expect(envelope.params).toEqual({ name: 'create_text', arguments: { prompt: 'explicit' } })
    expect(result.data.ok).toBe(true)
  })

  it('haven_complete_mcp_tool: omitted merchant_url/tool_name rehydrate the stored context by payment_id', async () => {
    stubFetch({})
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    const rehydrateSpy = vi.spyOn(haven, 'getX402MerchantCallContext').mockResolvedValue({
      paymentId: 'pay_x402',
      merchantUrl: 'http://merchant.test/mcp',
      toolName: 'buy_cloud_storage',
      arguments: { tier: '50gb' },
      mcpTransport: { handshakeRequired: true, source: 'bazaar' },
    })
    const completeSpy = vi.spyOn(haven, 'completeX402MerchantCall').mockResolvedValue({
      status: 200, ok: true, body: { result: 'ok' },
    })

    const result = ok<{ ok: boolean }>(
      await createToolHandlers(haven).haven_complete_mcp_tool({
        payment_id: 'pay_x402',
        payment_header: 'eyJ4IjoxfQ==',
      }),
    )

    expect(rehydrateSpy).toHaveBeenCalledWith('pay_x402')
    expect(completeSpy.mock.calls[0][0].url).toBe('http://merchant.test/mcp')
    expect(completeSpy.mock.calls[0][0].mcpTransport).toEqual({ handshakeRequired: true, source: 'bazaar' })
    const envelope = JSON.parse(completeSpy.mock.calls[0][0].init!.body as string)
    expect(envelope.params).toEqual({ name: 'buy_cloud_storage', arguments: { tier: '50gb' } })
    expect(result.data.ok).toBe(true)
  })

  it('haven_settle_mcp_tool: omitted merchant_url/tool_name rehydrate the stored context by payment_id', async () => {
    stubFetch({
      'POST /payments/pay_x402/sign': { status: 200, body: { status: 'confirmed', tx_hash: '0xfund' } },
    })
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    const rehydrateSpy = vi.spyOn(haven, 'getX402MerchantCallContext').mockResolvedValue({
      paymentId: 'pay_x402',
      merchantUrl: 'http://merchant.test/mcp',
      toolName: 'buy_cloud_storage',
      arguments: { tier: '50gb' },
    })
    const completeSpy = vi.spyOn(haven, 'completeX402MerchantCall').mockResolvedValue({
      status: 200, ok: true, body: { result: 'ok' }, settlementTxHash: '0xsettle',
    })

    const result = ok<{ settled: boolean }>(
      await createToolHandlers(haven).haven_settle_mcp_tool({
        payment_id: 'pay_x402',
        signature: SIG,
        payment_header: VALID_PAYMENT_HEADER,
      }),
    )

    expect(rehydrateSpy).toHaveBeenCalledWith('pay_x402')
    expect(completeSpy.mock.calls[0][0].url).toBe('http://merchant.test/mcp')
    expect(result.data.settled).toBe(true)
  })

  it('refuses with a structured, fallback-naming error when no stored context is available (409)', async () => {
    stubFetch({})
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    vi.spyOn(haven, 'getX402MerchantCallContext').mockRejectedValue(
      new HavenApiError(
        'No stored merchant call context for this intent — pass merchant_url, tool_name, ' +
          'arguments, and mcp_transport explicitly (version-skew fallback).',
        409,
      ),
    )
    const completeSpy = vi.spyOn(haven, 'completeX402MerchantCall')

    const payload = await createToolHandlers(haven).haven_complete_mcp_tool({
      payment_id: 'pay_x402',
      payment_header: 'eyJ4IjoxfQ==',
    })

    if (payload.success) throw new Error('expected a failure payload')
    expect(payload.code).toBe(AgentPaymentFailureCode.MerchantCallContextUnavailable)
    expect(payload.statusCode).toBe(409)
    expect(payload.paymentId).toBe('pay_x402')
    expect(payload.message).toMatch(/merchant_url, tool_name/)
    expect(completeSpy).not.toHaveBeenCalled()
  })

  it('refuses unknown/foreign payment_id the same way as context-missing (404, never a 403 leak)', async () => {
    stubFetch({})
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    vi.spyOn(haven, 'getX402MerchantCallContext').mockRejectedValue(
      new HavenApiError('Payment intent not found', 404),
    )

    const payload = await createToolHandlers(haven).haven_complete_mcp_tool({
      payment_id: 'pay_unknown',
      payment_header: 'eyJ4IjoxfQ==',
    })

    if (payload.success) throw new Error('expected a failure payload')
    expect(payload.code).toBe(AgentPaymentFailureCode.MerchantCallContextUnavailable)
    expect(payload.statusCode).toBe(404)
  })

  it('maps an expired stored context (410) to the standard re-quote payload', async () => {
    stubFetch({})
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    vi.spyOn(haven, 'getX402MerchantCallContext').mockRejectedValue(
      new HavenApiError('Payment window expired', 410),
    )

    const payload = await createToolHandlers(haven).haven_complete_mcp_tool({
      payment_id: 'pay_x402',
      payment_header: 'eyJ4IjoxfQ==',
    })

    if (payload.success) throw new Error('expected a failure payload')
    expect(payload.code).toBe(AgentPaymentFailureCode.PaymentWindowExpired)
    expect(payload.statusCode).toBe(410)
    expect(payload.retry_with_new_quote).toBe(true)
    expect(payload.suggested_tool).toBe('haven_pay_mcp_tool')
  })
})

// ── custody invariant (all tools) ────────────────────────────────────────────

describe('custody invariant', () => {
  it('no tool ever emits a delegate key in the network requests', async () => {
    // Stub enough routes to exercise all tools that touch the Haven API.
    stubFetch({
      'POST /payments': {
        status: 201,
        body: { payment_id: 'p1', status: 'pending_signature', sign_data: { hash: '0x1' } },
      },
      'POST /payments/p1/sign': { status: 200, body: { status: 'confirmed', tx_hash: '0xtx' } },
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /x402': {
        status: 201,
        body: X402_INTENT_RESPONSE,
      },
      // haven_pay_mcp_tool: merchant probe + intent creation
      // (agent fetch reuses GET /machine-payments/agent already stubbed above)
      'POST /mcp': {
        status: 402,
        responseHeaders: { 'PAYMENT-REQUIRED': btoa(JSON.stringify(PAYMENT_REQUIRED)) },
      },
    })

    const h = handlers()
    await h.haven_pay({ token: 'USDC', amount: '1', to: '0xabc' })
    await h.haven_send({ asset: 'USDC', recipient: '0xabc', amount: '1' })
    await h.haven_submit({ payment_id: 'p1', signature: '0x' + '11'.repeat(65) })
    await h.haven_pay_x402_quote({ payment_required: PAYMENT_REQUIRED })
    await h.haven_pay_mcp_tool({ merchant_url: 'http://merchant.test/mcp', tool_name: 'probe_tool' })
    await h.haven_complete_mcp_tool({
      payment_id: 'pay_x402',
      merchant_url: 'http://merchant.test/mcp',
      tool_name: 'probe_tool',
      arguments: {},
      payment_header: 'eyJwYXltZW50X29wYXF1ZSI6dHJ1ZX0=',
    })
    await h.haven_settle_mcp_tool({
      payment_id: 'p1',
      signature: '0x' + '11'.repeat(65),
      merchant_url: 'http://merchant.test/mcp',
      tool_name: 'probe_tool',
      arguments: {},
      payment_header: 'eyJwYXltZW50X29wYXF1ZSI6dHJ1ZX0=',
    })

    const wire = JSON.stringify(calls)
    expect(wire).not.toContain(DELEGATE_KEY)
    expect(wire).not.toContain('delegate_key')
    expect(wire).not.toContain('private_key')
  })
})

// ── #1272: compact x402 signing payload ──────────────────────────────────────
//
// The x402 quote surfaces omit the multi-KB typed_data/typed_data_b64 by
// default — the signer fetches the exact bytes from Haven by payment_id
// (#1263) — and restore them byte-identically on include_signing_payload=true
// (the recovery path for diagnostics and pre-#1263 signers). Direct payments
// (haven_pay/haven_send) keep the bulk unconditionally: no fetch path exists
// there, which the existing haven_pay/haven_send tests above already prove.

describe('compact x402 signing payload (#1272)', () => {
  const TYPED_DATA = {
    domain: { name: 'HybridDeleGator', chainId: 8453 },
    types: { PackedUserOperation: [{ name: 'callData', type: 'bytes' }] },
    primaryType: 'PackedUserOperation',
    // Realistic redemption size: the callData is what makes the payload multi-KB.
    message: { callData: `0x${'ab'.repeat(2600)}` },
  }
  const DELEGATION_INTENT_RESPONSE = {
    ...X402_INTENT_RESPONSE,
    sign_data: {
      hash: '0xfunding',
      signature_scheme: 'eip712_userop',
      typed_data: TYPED_DATA,
    },
  }
  const stubs = () => ({
    'GET /machine-payments/agent': { status: 200 as const, body: AGENT_RESPONSE },
    'POST /x402': { status: 201 as const, body: DELEGATION_INTENT_RESPONSE },
  })

  it('haven_pay_x402_quote omits typed_data/typed_data_b64 by default, keeping the compact contract', async () => {
    stubFetch(stubs())

    const result = ok<Record<string, unknown>>(
      await handlers().haven_pay_x402_quote({ payment_required: PAYMENT_REQUIRED }),
    )

    expect('typed_data' in result.data).toBe(false)
    expect('typed_data_b64' in result.data).toBe(false)
    // Everything the compact three-call flow needs survives.
    expect(result.data.payment_id).toBe('pay_x402')
    expect(result.data.payload_hash).toBe('0xfunding')
    expect(result.data.signature_scheme).toBe('eip712_userop')
    expect(result.data.signer_compatibility).toBeDefined()
    expect((result.data.x402 as { expected?: unknown }).expected).toBeDefined()
  })

  /**
   * #1549 — payment_required joins the compact contract on the MCP tool
   * surfaces. The signer fetches it by payment_id (#1355); the response echo
   * was the largest repeated block on every purchase. Same escape as
   * typed_data: include_signing_payload=true restores it verbatim.
   */
  describe('payment_required compaction (#1549)', () => {
    const mcpStubs = () => ({
      'POST /mcp': {
        status: 402 as const,
        responseHeaders: { 'PAYMENT-REQUIRED': btoa(JSON.stringify(PAYMENT_REQUIRED)) },
      },
      'GET /machine-payments/agent': { status: 200 as const, body: AGENT_RESPONSE },
      'POST /x402': { status: 201 as const, body: X402_INTENT_RESPONSE },
    })
    const CATALOG_ROUTES = {
      'GET /catalog/cat_1': {
        status: 200 as const,
        body: {
          id: 'cat_1', name: 'CloudNest 50GB', description: 'Cloud storage tier',
          category: 'compute', resource_url: 'http://merchant.test/mcp', rail: 'x402',
          protocol: 'mcp', tool_name: 'create_text', tool_arguments: { prompt: 'Hello' },
          price_display: '$1.50 USDC', price_atomic: '1500000',
          asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', network: 'eip155:8453',
          status: 'active', verified_at: '2026-06-16T08:50:39.772Z',
        },
      },
      'GET /machine-payments/allowances': { status: 404 as const, body: {} },
    }

    it('haven_pay_mcp_tool: compact omits payment_required; the replay restores it verbatim and is measurably larger', async () => {
      stubFetch(mcpStubs())
      const compact = ok<Record<string, unknown>>(
        await handlers().haven_pay_mcp_tool({
          merchant_url: 'http://merchant.test/mcp', tool_name: 'create_text',
          arguments: { prompt: 'Hello' }, max_amount: '2000000', idempotency_key: 'k-1549',
        }),
      )
      expect('payment_required' in compact.data).toBe(false)

      stubFetch(mcpStubs())
      const full = ok<{ payment_required?: unknown }>(
        await handlers().haven_pay_mcp_tool({
          merchant_url: 'http://merchant.test/mcp', tool_name: 'create_text',
          arguments: { prompt: 'Hello' }, max_amount: '2000000', idempotency_key: 'k-1549',
          include_signing_payload: true,
        }),
      )
      expect(full.data.payment_required).toEqual(PAYMENT_REQUIRED)
      // The point of the issue: the trim buys real bytes on every purchase.
      expect(JSON.stringify(compact.data).length).toBeLessThan(JSON.stringify(full.data).length)
    })

    it('haven_prepare_catalog_purchase: same contract as haven_pay_mcp_tool', async () => {
      stubFetch({ ...mcpStubs(), ...CATALOG_ROUTES })
      const compact = ok<Record<string, unknown>>(
        await handlers().haven_prepare_catalog_purchase({ catalog_id: 'cat_1', max_amount: '2000000' }),
      )
      expect('payment_required' in compact.data).toBe(false)

      stubFetch({ ...mcpStubs(), ...CATALOG_ROUTES })
      const full = ok<{ payment_required?: unknown }>(
        await handlers().haven_prepare_catalog_purchase({
          catalog_id: 'cat_1', max_amount: '2000000', include_signing_payload: true,
        }),
      )
      expect(full.data.payment_required).toEqual(PAYMENT_REQUIRED)
    })
  })

  it('haven_pay_x402_quote include_signing_payload=true restores the full payload verbatim', async () => {
    stubFetch(stubs())

    const result = ok<{ typed_data?: unknown; typed_data_b64?: string }>(
      await handlers().haven_pay_x402_quote({
        payment_required: PAYMENT_REQUIRED,
        include_signing_payload: true,
      }),
    )

    expect(result.data.typed_data).toEqual(TYPED_DATA) // verbatim, never reshaped
    expect(
      JSON.parse(Buffer.from(result.data.typed_data_b64 as string, 'base64').toString('utf8')),
    ).toEqual(TYPED_DATA)
  })

  it('haven_pay_mcp_tool omits the bulk by default and restores it on request', async () => {
    const paymentRequiredHeader = btoa(JSON.stringify(PAYMENT_REQUIRED))
    const withProbe = () => ({
      'POST /mcp': {
        status: 402 as const,
        responseHeaders: { 'PAYMENT-REQUIRED': paymentRequiredHeader },
      },
      ...stubs(),
    })

    stubFetch(withProbe())
    const compact = ok<Record<string, unknown>>(
      await handlers().haven_pay_mcp_tool({
        merchant_url: 'http://merchant.test/mcp',
        tool_name: 'create_text',
        arguments: { prompt: 'Hello' },
        max_amount: '2000000',
      }),
    )
    expect('typed_data_b64' in compact.data).toBe(false)
    expect(compact.data.signature_scheme).toBe('eip712_userop')

    stubFetch(withProbe())
    const full = ok<{ typed_data_b64?: string }>(
      await handlers().haven_pay_mcp_tool({
        merchant_url: 'http://merchant.test/mcp',
        tool_name: 'create_text',
        arguments: { prompt: 'Hello' },
        max_amount: '2000000',
        include_signing_payload: true,
      }),
    )
    expect(
      JSON.parse(Buffer.from(full.data.typed_data_b64 as string, 'base64').toString('utf8')),
    ).toEqual(TYPED_DATA)
  })
})

// ── #1271: bounded same-origin merchant endpoint discovery ───────────────────

describe('merchant MCP endpoint discovery (#1271)', () => {
  const paymentRequiredHeader = () => btoa(JSON.stringify(PAYMENT_REQUIRED))
  const DISCOVERY_DOC = { name: 'Haven Demo Merchant', mcp_url: 'http://merchant.test/mcp' }
  const havenStubs = () => ({
    'GET /machine-payments/agent': { status: 200 as const, body: AGENT_RESPONSE },
    'POST /x402': { status: 201 as const, body: X402_INTENT_RESPONSE },
  })

  it('uses the same bounded discovery for a read-only generic quote without creating an intent', async () => {
    stubFetch({
      'POST /': { status: 404, body: { error: 'Not found' } },
      'GET /.well-known/haven-demo-merchant': { status: 200, body: DISCOVERY_DOC },
      'POST /mcp': {
        status: 402,
        responseHeaders: { 'PAYMENT-REQUIRED': paymentRequiredHeader() },
      },
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
    })

    const result = ok<{ merchant_url: string; merchant_url_was_discovered: boolean }>(
      await handlers().haven_quote_mcp_tool({
        merchant_url: 'http://merchant.test/',
        tool_name: 'buy_vpn',
        arguments: { plan: 'basic' },
      }),
    )

    expect(result.data).toEqual(expect.objectContaining({
      merchant_url: 'http://merchant.test/mcp',
      merchant_url_was_discovered: true,
    }))
    expect(calls.find((call) => new URL(call.url).pathname.endsWith('/x402'))).toBeUndefined()
    expect(calls.find((call) => new URL(call.url).pathname.includes('/allowances'))).toBeUndefined()
  })

  it('resolves a base URL through /.well-known and returns the RESOLVED merchant_url', async () => {
    stubFetch({
      // The base URL is not the MCP endpoint: POST / misses.
      'POST /': { status: 404, body: { error: 'Not found' } },
      'GET /.well-known/haven-demo-merchant': { status: 200, body: DISCOVERY_DOC },
      'POST /mcp': {
        status: 402,
        responseHeaders: { 'PAYMENT-REQUIRED': paymentRequiredHeader() },
      },
      ...havenStubs(),
    })

    const result = ok<{ merchant_url: string; merchant_url_discovered_from?: string }>(
      await handlers().haven_pay_mcp_tool({
        merchant_url: 'http://merchant.test/',
        tool_name: 'buy_vpn',
        arguments: { plan: 'basic' },
        max_amount: '2000000',
      }),
    )

    expect(result.data.merchant_url).toBe('http://merchant.test/mcp')
    expect(result.data.merchant_url_discovered_from).toBe('http://merchant.test/')
  })

  it('uses the MCP handshake for a discovery-resolved endpoint that is not named /mcp', async () => {
    stubFetch({
      'POST /': { status: 404, body: { error: 'Not found' } },
      'GET /.well-known/haven-demo-merchant': {
        status: 200,
        body: { name: 'Custom MCP Merchant', mcp_url: 'http://merchant.test/v1' },
      },
      'POST /v1': {
        status: 402,
        responseHeaders: { 'PAYMENT-REQUIRED': paymentRequiredHeader() },
      },
      ...havenStubs(),
    })

    const result = ok<{ merchant_url: string }>(
      await handlers().haven_pay_mcp_tool({
        merchant_url: 'http://merchant.test/',
        tool_name: 'buy_vpn',
        arguments: {},
        max_amount: '2000000',
      }),
    )

    expect(result.data.merchant_url).toBe('http://merchant.test/v1')
    const lifecycle = calls.filter((call) => call.url === 'http://merchant.test/v1')
    expect(lifecycle.map((call) => call.body?.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
    ])
    expect(new Headers(lifecycle[2].headers).get('Accept')).toBe('application/json, text/event-stream')
    expect(new Headers(lifecycle[2].headers).get('mcp-session-id')).toBe('sess-tools-test')
  })

  it('uses the MCP handshake for an explicitly supplied custom endpoint path', async () => {
    stubFetch({
      'POST /v1': {
        status: 402,
        responseHeaders: { 'PAYMENT-REQUIRED': paymentRequiredHeader() },
      },
      ...havenStubs(),
    })

    const result = ok<{
      merchant_url: string
      mcp_transport: { handshake_required: boolean; source: string }
    }>(
      await handlers().haven_pay_mcp_tool({
        merchant_url: 'http://merchant.test/v1',
        tool_name: 'buy_vpn',
        arguments: {},
        max_amount: '2000000',
      }),
    )

    expect(result.data.merchant_url).toBe('http://merchant.test/v1')
    expect(result.data.mcp_transport).toEqual({ handshake_required: true, source: 'path' })
    expect(calls.filter((call) => call.url === 'http://merchant.test/v1').map((call) => call.body?.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
    ])
    expect(calls.some((call) => call.url.includes('.well-known'))).toBe(false)
  })

  it('does NOT run discovery when the exact endpoint answers 402', async () => {
    stubFetch({
      'POST /mcp': {
        status: 402,
        responseHeaders: { 'PAYMENT-REQUIRED': paymentRequiredHeader() },
      },
      ...havenStubs(),
    })

    const result = ok<{ merchant_url: string; merchant_url_discovered_from?: string }>(
      await handlers().haven_pay_mcp_tool({
        merchant_url: 'http://merchant.test/mcp',
        tool_name: 'buy_vpn',
        max_amount: '2000000',
      }),
    )

    expect(result.data.merchant_url).toBe('http://merchant.test/mcp')
    expect(result.data.merchant_url_discovered_from).toBeUndefined()
    expect(calls.some((c) => String(c.url).includes('.well-known'))).toBe(false)
  })

  it('fails with actionable guidance when no discovery document exists', async () => {
    stubFetch({
      'POST /': { status: 404, body: { error: 'Not found' } },
      'GET /.well-known/haven-demo-merchant': { status: 404, body: {} },
      'GET /': { status: 404, body: {} },
    })

    const result = await handlers().haven_pay_mcp_tool({
      merchant_url: 'http://merchant.test/',
      tool_name: 'buy_vpn',
      max_amount: '2000000',
    })

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected failure')
    expect(result.message).toMatch(/No same-origin discovery document/)
    expect(result.message).toMatch(/<origin>\/mcp/)
  })

  it('REFUSES an off-origin mcp_url — never even fetches it (SSRF bound)', async () => {
    stubFetch({
      'POST /': { status: 404, body: { error: 'Not found' } },
      'GET /.well-known/haven-demo-merchant': {
        status: 200,
        body: { mcp_url: 'http://evil.example/mcp' },
      },
      // The root fallback also serves the off-origin doc.
      'GET /': { status: 200, body: { mcp_url: 'http://evil.example/mcp' } },
    })

    const result = await handlers().haven_pay_mcp_tool({
      merchant_url: 'http://merchant.test/',
      tool_name: 'buy_vpn',
      max_amount: '2000000',
    })

    expect(result.success).toBe(false)
    // The off-origin URL was refused at validation — no request ever went there.
    expect(calls.some((c) => String(c.url).includes('evil.example'))).toBe(false)
  })

  it('a non-endpoint-miss error (merchant 500) does not trigger discovery', async () => {
    stubFetch({
      'POST /mcp': { status: 500, body: { error: 'boom' } },
    })

    const result = await handlers().haven_pay_mcp_tool({
      merchant_url: 'http://merchant.test/mcp',
      tool_name: 'buy_vpn',
      max_amount: '2000000',
    })

    expect(result.success).toBe(false)
    // 500 IS an endpoint miss by shape (non-402) — discovery may run, but the
    // point pinned here is that failure is reported against the ORIGINAL URL
    // and nothing beyond the two fixed same-origin paths was fetched.
    const fetched = calls.map((c) => String(c.url))
    expect(
      fetched.every(
        (u) =>
          u.startsWith('http://merchant.test/mcp') ||
          u === 'http://merchant.test/.well-known/haven-demo-merchant' ||
          u === 'http://merchant.test/' ||
          u === 'http://haven.test/machine-payments/agent',
      ),
    ).toBe(true)
  })
  it('labels a retry miss with the DISCOVERED endpoint so the agent can tell the URLs apart', async () => {
    stubFetch({
      'POST /': { status: 404, body: { error: 'Not found' } },
      'GET /.well-known/haven-demo-merchant': {
        status: 200,
        body: { mcp_url: 'http://merchant.test/mcp' },
      },
      // The discovered endpoint ALSO misses.
      'POST /mcp': { status: 404, body: { error: 'Not found' } },
    })

    const result = await handlers().haven_pay_mcp_tool({
      merchant_url: 'http://merchant.test/',
      tool_name: 'buy_vpn',
      max_amount: '2000000',
    })

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected failure')
    expect(result.message).toMatch(/DISCOVERED endpoint http:\/\/merchant\.test\/mcp/)
    expect(result.message).toMatch(/resolved from http:\/\/merchant\.test\//)
  })

  it('a discovery echo of the same URL (trailing slash) fails fast instead of burning the retry', async () => {
    stubFetch({
      'POST /': { status: 404, body: { error: 'Not found' } },
      // The document echoes the input back with only a slash difference.
      'GET /.well-known/haven-demo-merchant': {
        status: 200,
        body: { mcp_url: 'http://merchant.test' },
      },
      'GET /': { status: 200, body: { mcp_url: 'http://merchant.test' } },
    })

    const result = await handlers().haven_pay_mcp_tool({
      merchant_url: 'http://merchant.test/',
      tool_name: 'buy_vpn',
      max_amount: '2000000',
    })

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected failure')
    expect(result.message).toMatch(/resolved the same URL/)
    // Exactly one POST probe — the retry was NOT spent on the echo.
    expect(calls.filter((c) => c.method === 'POST').length).toBe(1)
  })
})

// ── #1308: structured next-step contract ─────────────────────────────────────

describe('structured agent guidance (#1308)', () => {
  const paymentRequiredHeader = () => btoa(JSON.stringify(PAYMENT_REQUIRED))
  const stubs = () => ({
    'GET /machine-payments/agent': { status: 200 as const, body: AGENT_RESPONSE },
    'POST /x402': { status: 201 as const, body: X402_INTENT_RESPONSE },
    'POST /mcp': {
      status: 402 as const,
      responseHeaders: { 'PAYMENT-REQUIRED': paymentRequiredHeader() },
    },
  })
  const pay = () =>
    handlers().haven_pay_mcp_tool({
      merchant_url: 'http://merchant.test/mcp',
      tool_name: 'buy_vpn',
      arguments: { plan: 'basic' },
      max_amount: '2000000',
    })

  it('a signable quote tells the agent EXACTLY what to do next — from the existing taxonomy', async () => {
    stubFetch(stubs())
    const result = ok<{
      next_action: string
      next_tool: string
      next_arguments: Record<string, unknown>
      safe_to_continue: boolean
      agent_summary: Record<string, unknown>
      warnings: Array<{ code: string; message: string }>
    }>(await pay())

    expect(result.data.next_action).toBe('sign_and_submit_payment') // AgentPaymentNextAction value, no parallel vocabulary
    expect(result.data.next_tool).toBe('mcp__haven-signer__haven_sign_x402')
    expect(result.data.next_arguments).toEqual({ payment_id: 'pay_x402' })
    expect(result.data.safe_to_continue).toBe(true)
    expect(result.data.agent_summary).toMatchObject({ payment_id: 'pay_x402', status: 'pending_signature' })
  })

  it('refuses an uncapped paid MCP call before contacting the merchant', async () => {
    stubFetch(stubs())
    const payload = await handlers().haven_pay_mcp_tool({
      merchant_url: 'http://merchant.test/mcp',
      tool_name: 'buy_vpn',
      arguments: { plan: 'basic' },
    })

    expect(payload.success).toBe(false)
    if (payload.success) throw new Error('expected failure')
    expect(payload.code).toBe('INVALID_INPUT')
    expect(payload.message).toContain('REQUIRED')
    expect(calls).toHaveLength(0)
  })

  it('passing max_amount clears BOTH the legacy field and the structured warning', async () => {
    stubFetch(stubs())
    const result = ok<{ cap_warning?: string; warnings: Array<{ code: string }> }>(
      await handlers().haven_pay_mcp_tool({
        merchant_url: 'http://merchant.test/mcp',
        tool_name: 'buy_vpn',
        arguments: { plan: 'basic' },
        max_amount: '2000000',
      }),
    )
    expect(result.data.cap_warning).toBeUndefined()
    expect(result.data.warnings.some((w) => w.code === 'MISSING_MAX_AMOUNT')).toBe(false)
  })

  it('the decomposed quote twin carries the SAME unsafe pending signal (#1308 review)', async () => {
    stubFetch({
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /x402': { status: 202, body: { payment_id: 'pay_pending', status: 'pending_approval' } },
    })
    const result = ok<{ next_action: string; safe_to_continue: boolean }>(
      await handlers().haven_pay_x402_quote({ payment_required: PAYMENT_REQUIRED }),
    )
    expect(result.data.next_action).toBe('wait_for_user_approval')
    expect(result.data.safe_to_continue).toBe(false)
  })

  it('pending approval is UNSAFE to continue and points at status polling', async () => {
    stubFetch({
      ...stubs(),
      'POST /x402': {
        status: 202,
        body: { payment_id: 'pay_pending', status: 'pending_approval' },
      },
    })
    const result = ok<{
      status: string
      next_action: string
      next_tool: string
      safe_to_continue: boolean
      agent_summary: Record<string, unknown>
    }>(await pay())

    expect(result.data.status).toBe('pending_approval')
    expect(result.data.next_action).toBe('wait_for_user_approval')
    expect(result.data.next_tool).toBe('mcp__haven__haven_get_payment_status')
    expect((result.data as { next_tool_server?: string }).next_tool_server).toBe('haven')
    expect((result.data as { next_tool_name?: string }).next_tool_name).toBe('haven_get_payment_status')
    expect(result.data.safe_to_continue).toBe(false)
  })
})

// ── #1351: human-unit spending caps ──────────────────────────────────────────

describe('human-unit spending caps (#1351)', () => {
  const paymentRequiredHeader = btoa(JSON.stringify(PAYMENT_REQUIRED))

  // The fixture merchant quotes Base USDC (6 decimals) with an authoritative
  // maxAmountRequired of 1500000 atomic = 1.50 USDC. Every cap below is read
  // against THAT, which is the whole point: the human cap is interpreted with
  // the live quote's own asset/decimals, never a caller-supplied token name.
  const LIVE_PRICE_ATOMIC = '1500000'
  const LIVE_PRICE_HUMAN = '1.5'

  const payRoutes = {
    'POST /mcp': { status: 402, responseHeaders: { 'PAYMENT-REQUIRED': paymentRequiredHeader } },
    'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
    'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
  }

  function payMcpTool(args: Record<string, unknown>) {
    return handlers().haven_pay_mcp_tool({
      merchant_url: 'http://merchant.test/mcp',
      tool_name: 'create_text',
      arguments: { prompt: 'Hello' },
      ...args,
    })
  }

  const fundingCall = () => calls.find((c) => new URL(c.url).pathname.endsWith('/x402'))

  describe('haven_pay_mcp_tool', () => {
    it('FAILS CLOSED: a cap of "1" USDC refuses a 1.50 USDC quote before any funding intent', async () => {
      // The #1351 guard, stated as the issue states it. This is the case the
      // atomic-only contract got wrong in the other direction: an agent that
      // meant "no more than 1 USDC" and wrote max_amount "1" capped itself at
      // 0.000001 USDC. Written as max_amount_human it means what it says —
      // and 1 < 1.50, so this purchase must still be refused.
      // MUTATION TEST: delete the resolveCapAtomic call in haven_pay_mcp_tool
      // (or pass `cap` straight through as atomic) and this test fails —
      // "1" compared as atomic units is 1, still under 1500000, so the
      // purchase would be refused for the WRONG reason; drop the guard
      // entirely and it succeeds, which is the real regression.
      stubFetch(payRoutes)

      const payload = await payMcpTool({ max_amount_human: '1' })

      expect(payload.success).toBe(false)
      if (payload.success) throw new Error('expected failure')
      expect(payload.code).toBe(AgentPaymentFailureCode.PriceExceedsMax)
      // The message quotes the cap back in the units the AGENT wrote, with the
      // atomic figure it resolved to — not a bare 1000000 it never typed.
      expect(payload.message).toContain('max_amount_human 1 USDC')
      expect(payload.message).toContain('1000000')
      expect(payload.message).toContain(LIVE_PRICE_ATOMIC)
      // Pre-funding: no intent was ever created.
      expect(fundingCall()).toBeUndefined()
    })

    it('a cap of "2" USDC clears the same 1.50 USDC quote, and clears the uncapped warning', async () => {
      stubFetch(payRoutes)

      const result = ok<{
        amount_atomic: string
        cap_warning?: string
        warnings: Array<{ code: string }>
      }>(await payMcpTool({ max_amount_human: '2' }))

      expect(result.data.amount_atomic).toBe(LIVE_PRICE_ATOMIC)
      // Either spelling of the cap satisfies #1275 — the warning is about
      // being uncapped, not about which field carried the cap.
      expect(result.data.cap_warning).toBeUndefined()
      expect(result.data.warnings.map((w) => w.code)).not.toContain('MISSING_MAX_AMOUNT')
      expect(fundingCall()).toBeDefined()
    })

    it('the cap is inclusive at the human boundary: "1.5" exactly matches a 1.50 USDC quote', async () => {
      stubFetch(payRoutes)

      const result = ok<{ amount_atomic: string }>(
        await payMcpTool({ max_amount_human: LIVE_PRICE_HUMAN }),
      )

      expect(result.data.amount_atomic).toBe(LIVE_PRICE_ATOMIC)
    })

    it('rejects BOTH caps together with AMBIGUOUS_MAX_AMOUNT — before the merchant is contacted', async () => {
      stubFetch(payRoutes)

      const payload = await payMcpTool({ max_amount: '2000000', max_amount_human: '2' })

      expect(payload.success).toBe(false)
      if (payload.success) throw new Error('expected failure')
      expect(payload.code).toBe(AgentPaymentFailureCode.AmbiguousMaxAmount)
      expect(payload.next_action).toBe(AgentPaymentNextAction.StopAndTellUser)
      expect(payload.statusCode).toBe(400)
      // Not just "before funding" — before ANY network call at all. Even a
      // consistent-looking pair is refused: agreeing here is a coincidence of
      // this fixture, and honouring one silently would teach the pattern.
      expect(calls).toHaveLength(0)
    })

    it('refuses a human cap finer than the asset can represent rather than truncating it', async () => {
      // 7 decimal places against 6-decimal USDC. Truncating to 1.500000 would
      // silently widen the user's cap to exactly the quoted price; rounding
      // down would silently tighten it. Both are the user's decision.
      stubFetch(payRoutes)

      const payload = await payMcpTool({ max_amount_human: '1.5000001' })

      expect(payload.success).toBe(false)
      if (payload.success) throw new Error('expected failure')
      expect(payload.code).toBe(AgentPaymentFailureCode.MaxAmountUnconvertible)
      expect(payload.message).toContain('USDC')
      expect(payload.message).toContain('6')
      expect(fundingCall()).toBeUndefined()
    })

    it('BACKWARD COMPATIBLE: max_amount stays atomic — "1" is still 0.000001 USDC, not 1 USDC', async () => {
      // The compatibility characterization. #1351 does NOT reinterpret the
      // existing field: an atomic caller that passes "1" gets the same
      // refusal it always got. Changing this silently would be the exact
      // failure mode the issue exists to prevent, just pointed the other way.
      stubFetch(payRoutes)

      const payload = await payMcpTool({ max_amount: '1' })

      expect(payload.success).toBe(false)
      if (payload.success) throw new Error('expected failure')
      expect(payload.code).toBe(AgentPaymentFailureCode.PriceExceedsMax)
      // No human-unit framing on the atomic path — the message reads as before.
      expect(payload.message).toContain('max_amount 1')
      expect(payload.message).not.toContain('max_amount_human')
      expect(fundingCall()).toBeUndefined()
    })

    it('rejects a non-decimal human cap at the schema, before any network call', async () => {
      for (const bad of ['1e6', '-1', '1.2.3', '1 USDC', '', '.5']) {
        calls = []
        stubFetch(payRoutes)
        const payload = await payMcpTool({ max_amount_human: bad })
        expect(payload.success, `expected "${bad}" to be rejected`).toBe(false)
        if (payload.success) throw new Error('expected failure')
        expect(payload.code).toBe('INVALID_INPUT')
        expect(calls).toHaveLength(0)
      }
    })

  it('refuses an uncapped paid MCP call before the merchant probe', async () => {
    stubFetch(payRoutes)

      const payload = await payMcpTool({})

      expect(payload.success).toBe(false)
      if (payload.success) throw new Error('expected failure')
      expect(payload.code).toBe('INVALID_INPUT')
      expect(payload.message).toContain('max_amount_human')
      expect(calls).toHaveLength(0)
    })
  })

  describe('haven_pay_x402_quote', () => {
    it('resolves the human cap against the selected payment option and fails closed under it', async () => {
      stubFetch({
        'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
        'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
      })

      const payload = await handlers().haven_pay_x402_quote({
        payment_required: PAYMENT_REQUIRED,
        max_amount_human: '1',
      })

      expect(payload.success).toBe(false)
      if (payload.success) throw new Error('expected failure')
      expect(payload.code).toBe(AgentPaymentFailureCode.PriceExceedsMax)
      expect(payload.message).toContain('max_amount_human 1 USDC')
      expect(fundingCall()).toBeUndefined()
    })

    it('clears a sufficient human cap and creates the intent', async () => {
      stubFetch({
        'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
        'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
      })

      const result = ok<{ cap_warning?: string }>(
        await handlers().haven_pay_x402_quote({
          payment_required: PAYMENT_REQUIRED,
          max_amount_human: '2',
        }),
      )

      expect(result.data.cap_warning).toBeUndefined()
      expect(fundingCall()).toBeDefined()
    })

    it('refuses a human cap when the asset does not belong to the advertised network', async () => {
      // Reachable, not theoretical: the option selector checks network and
      // asset against separate sets, so Base-SEPOLIA USDC advertised on
      // mainnet Base is selectable but resolves to no known token — hence no
      // known decimals. Converting "1" against an assumed 6 would be a guess
      // about an asset Haven could not identify, so the cap is refused and
      // the purchase stops before any funding intent.
      stubFetch({
        'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
        'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
      })

      const payload = await handlers().haven_pay_x402_quote({
        payment_required: {
          ...PAYMENT_REQUIRED,
          accepts: [{
            ...PAYMENT_REQUIRED.accepts[0],
            network: 'eip155:8453',
            asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          }],
        },
        max_amount_human: '1',
      })

      expect(payload.success).toBe(false)
      if (payload.success) throw new Error('expected failure')
      expect(payload.code).toBe(AgentPaymentFailureCode.MaxAmountUnconvertible)
      expect(payload.message).toContain('max_amount')
      expect(fundingCall()).toBeUndefined()
    })

    it('an ATOMIC cap on that same unresolvable asset still works — only the human form needs decimals', async () => {
      // The fail-closed refusal above is scoped to the conversion, not to the
      // purchase: an exact atomic figure needs no decimals to compare.
      stubFetch({
        'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
        'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
      })

      ok(
        await handlers().haven_pay_x402_quote({
          payment_required: {
            ...PAYMENT_REQUIRED,
            accepts: [{
              ...PAYMENT_REQUIRED.accepts[0],
              network: 'eip155:8453',
              asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
            }],
          },
          max_amount: '2000000',
        }),
      )

      expect(fundingCall()).toBeDefined()
    })

    it('refuses EITHER cap spelling when no payment option is settleable — never an unchecked cap', async () => {
      // Review finding (#1351): the human spelling refused here while the
      // atomic one fell through with the cap silently unenforced, leaving the
      // agent believing the purchase was capped when nothing had been
      // compared. Both spellings now refuse. This only narrows — see the
      // uncapped case below, which is unchanged.
      const noSettleableOption = {
        ...PAYMENT_REQUIRED,
        // Neither the network nor the asset is one Haven settles.
        accepts: [{ ...PAYMENT_REQUIRED.accepts[0], network: 'eip155:1', asset: '0x' + 'ab'.repeat(20) }],
      }

      for (const capArgs of [{ max_amount: '2000000' }, { max_amount_human: '2' }]) {
        calls = []
        stubFetch({
          'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
          'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
        })

        const payload = await handlers().haven_pay_x402_quote({
          payment_required: noSettleableOption,
          ...capArgs,
        })

        expect(payload.success, `expected ${JSON.stringify(capArgs)} to refuse`).toBe(false)
        if (payload.success) throw new Error('expected failure')
        expect(payload.code).toBe(AgentPaymentFailureCode.MaxAmountUnconvertible)
        expect(payload.message).toContain(Object.keys(capArgs)[0])
        expect(fundingCall()).toBeUndefined()
      }
    })

    it('an UNCAPPED call with no settleable option still fails the way it always did, at intent creation', async () => {
      // Blast radius of the fix above, characterized: nothing NEW refuses when
      // the caller never asked for a cap. This case already failed — one step
      // later, inside createX402Intent — which is also why the old silent cap
      // drop could never actually fund an unchecked purchase. The fix makes
      // the refusal earlier and names the cap instead of the option.
      stubFetch({
        'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
        'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
      })

      const payload = await handlers().haven_pay_x402_quote({
        payment_required: {
          ...PAYMENT_REQUIRED,
          accepts: [{ ...PAYMENT_REQUIRED.accepts[0], network: 'eip155:1', asset: '0x' + 'ab'.repeat(20) }],
        },
      })

      expect(payload.success).toBe(false)
      if (payload.success) throw new Error('expected failure')
      // The pre-existing SDK-side refusal, NOT the #1351 cap refusal.
      expect(payload.code).not.toBe(AgentPaymentFailureCode.MaxAmountUnconvertible)
      expect(payload.message).toContain('No compatible payment option')
      expect(fundingCall()).toBeUndefined()
    })

    it('rejects both caps together before creating an intent', async () => {
      stubFetch({
        'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
        'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
      })

      const payload = await handlers().haven_pay_x402_quote({
        payment_required: PAYMENT_REQUIRED,
        max_amount: '2000000',
        max_amount_human: '2',
      })

      expect(payload.success).toBe(false)
      if (payload.success) throw new Error('expected failure')
      expect(payload.code).toBe(AgentPaymentFailureCode.AmbiguousMaxAmount)
      expect(calls).toHaveLength(0)
    })
  })

  describe('haven_prepare_catalog_purchase', () => {
    const CATALOG_ENTRY_RESPONSE = {
      id: 'cat_1',
      name: 'create_text',
      description: 'Generate text',
      category: 'ai',
      resource_url: 'https://mcp.soundside.ai/mcp',
      rail: 'x402',
      protocol: 'mcp',
      tool_name: 'create_text',
      tool_arguments: { prompt: 'hello' },
      price_display: '$1.50 USDC',
      price_atomic: '1500000',
      asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      network: 'eip155:8453',
      status: 'active',
      verified_at: '2026-06-16T08:50:39.772Z',
    }

    const catalogRoutes = {
      'GET /catalog/cat_1': { status: 200, body: CATALOG_ENTRY_RESPONSE },
      'POST /mcp': { status: 402, responseHeaders: { 'PAYMENT-REQUIRED': paymentRequiredHeader } },
      'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'GET /machine-payments/allowances': {
        status: 200,
        body: {
          agent_id: 'agt_1',
          safe_address: '0xSafe',
          delegate_address: '0xDelegate',
          chain_id: 8453,
          allowances: [{
            id: 'allowance-1',
            token_address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
            token_symbol: 'USDC',
            configured_amount: '5000000',
            reset_period_min: 60,
            onchain: {
              amount: '5000000', spent: '0', remaining: '5000000', effective_spent: '0',
              reset_time_min: 60, last_reset_min: 100, nonce: 7, is_reset_pending: false,
            },
          }],
        },
      },
    }

    it('accepts the human cap as the REQUIRED cap on the guided path', async () => {
      stubFetch(catalogRoutes)

      const result = ok<{ amount_atomic: string }>(
        await handlers().haven_prepare_catalog_purchase({
          catalog_id: 'cat_1',
          max_amount_human: '2',
        }),
      )

      expect(result.data.amount_atomic).toBe(LIVE_PRICE_ATOMIC)
      expect(fundingCall()).toBeDefined()
    })

    it('FAILS CLOSED: "1" USDC refuses the 1.50 USDC live quote before any funding intent', async () => {
      // The guided path's twin of the haven_pay_mcp_tool mutation test. The
      // catalog's own price_atomic is never the cap's reference point — the
      // LIVE quote is (mutation: resolve the cap against entry.price_atomic
      // and the boundary tests above stop meaning anything).
      stubFetch(catalogRoutes)

      const payload = await handlers().haven_prepare_catalog_purchase({
        catalog_id: 'cat_1',
        max_amount_human: '1',
      })

      expect(payload.success).toBe(false)
      if (payload.success) throw new Error('expected failure')
      expect(payload.code).toBe(AgentPaymentFailureCode.PriceExceedsMax)
      expect(payload.message).toContain('max_amount_human 1 USDC')
      expect(fundingCall()).toBeUndefined()
    })

    it('rejects both caps together with zero network calls — not even the catalog is read', async () => {
      stubFetch(catalogRoutes)

      const payload = await handlers().haven_prepare_catalog_purchase({
        catalog_id: 'cat_1',
        max_amount: '2000000',
        max_amount_human: '2',
      })

      expect(payload.success).toBe(false)
      if (payload.success) throw new Error('expected failure')
      expect(payload.code).toBe(AgentPaymentFailureCode.AmbiguousMaxAmount)
      expect(calls).toHaveLength(0)
    })

    it('still refuses when NEITHER spelling is given — the guided path never runs uncapped', async () => {
      stubFetch(catalogRoutes)

      const payload = await handlers().haven_prepare_catalog_purchase({ catalog_id: 'cat_1' })

      expect(payload.success).toBe(false)
      if (payload.success) throw new Error('expected failure')
      expect(payload.code).toBe('INVALID_INPUT')
      expect(payload.message).toContain('max_amount_human')
      expect(calls).toHaveLength(0)
    })

    it('a generous human cap does NOT widen the on-chain budget: the delegation rail still refuses over-budget', async () => {
      // The cap only ever narrows. An agent cannot buy authority by writing a
      // big number here — the delegation budget remains the hard gate, and
      // this refusal fires with the cap satisfied.
      stubFetch({
        ...catalogRoutes,
        'GET /machine-payments/agent': {
          status: 200,
          body: { ...AGENT_RESPONSE, execution_rail: 'delegation' },
        },
        'GET /machine-payments/allowances': {
          status: 200,
          body: {
            agent_id: 'agt_1',
            safe_address: '0xSafe',
            delegate_address: '0xDelegate',
            chain_id: 8453,
            allowances: [{
              id: 'delegation-1',
              token_address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
              token_symbol: 'USDC',
              configured_amount: '0.10',
              reset_period_min: 1440,
              onchain: {
                amount: '100000', spent: '0', remaining: '100000', effective_spent: '0',
                reset_time_min: 1440, last_reset_min: 0, nonce: 0, is_reset_pending: false,
              },
            }],
          },
        },
      })

      const payload = await handlers().haven_prepare_catalog_purchase({
        catalog_id: 'cat_1',
        max_amount_human: '1000000',
      })

      expect(payload.success).toBe(false)
      if (payload.success) throw new Error('expected failure')
      expect(payload.code).toBe('DELEGATION_BUDGET_EXCEEDED')
      expect(fundingCall()).toBeUndefined()
    })
  })
})

/**
 * #1456 — erc7710 through the hosted tool surface.
 *
 * The negatives carry this suite. A selector that always answered "erc7710"
 * would pass a happy-path-only file, so both halves of the #1450 rule are
 * tested for the case where they must NOT fire.
 */
describe('hosted erc7710 (#1456)', () => {
  const SIG7710 = '0x' + '22'.repeat(65)
  const ERC7710_PR = {
    ...PAYMENT_REQUIRED,
    accepts: [
      ...PAYMENT_REQUIRED.accepts,
      {
        ...PAYMENT_REQUIRED.accepts[0],
        extra: {
          assetTransferMethod: 'erc7710',
          facilitatorAddresses: ['0x4444444444444444444444444444444444444444'],
        },
      },
    ],
  }
  const erc7710Header = btoa(JSON.stringify(ERC7710_PR))
  const plainHeader = btoa(JSON.stringify(PAYMENT_REQUIRED))
  const DELEGATION_AGENT = { ...AGENT_RESPONSE, execution_rail: 'delegation' }
  const CHILD = {
    payment_id: 'pay_7710',
    status: 'pending_signature',
    sign_data: {
      hash: '0x' + '11'.repeat(32),
      signature_scheme: 'eip712_delegation',
      typed_data: { domain: {}, types: {}, primaryType: 'Delegation', message: { caveats: [] } },
    },
  }

  // The intent body is chosen by the EXPECTED scheme, not by the challenge —
  // a legacy account meeting a 7710-advertising merchant must still get the
  // 3009 intent, which is exactly the case this helper got wrong at first.
  async function pay(header: string, agent: Record<string, unknown>, expectErc7710 = false) {
    stubFetch({
      'POST /mcp': { status: 402, responseHeaders: { 'PAYMENT-REQUIRED': header } },
      'GET /machine-payments/agent': { status: 200, body: agent },
      'POST /x402': { status: 201, body: expectErc7710 ? CHILD : X402_INTENT_RESPONSE },
    })
    return ok(
      await handlers().haven_pay_mcp_tool({
        merchant_url: 'http://merchant.test/mcp',
        tool_name: 'create_text',
        arguments: { prompt: 'Hello' },
        max_amount: '2000000',
      }),
    ) as { data: Record<string, any> }
  }

  it('selects erc7710, reports it structurally, and shapes the request for direct settlement', async () => {
    const res = await pay(erc7710Header, DELEGATION_AGENT, true)
    expect(res.data.settlement_scheme).toBe('erc7710')
    expect(res.data.settlement.funding_leg).toBe(false)
    expect(res.data.next_tool).toBe('mcp__haven-signer__haven_sign')

    const raw = calls.find((c) => new URL(c.url).pathname === '/x402')!.body
    const body = typeof raw === 'string' ? JSON.parse(raw) : (raw as Record<string, unknown>)
    // payTo = the MERCHANT is what selects direct settlement server-side.
    expect(body.settlementScheme).toBe('erc7710')
    expect(body.payTo).toBe(PAYMENT_REQUIRED.accepts[0].payTo)
    expect(body).not.toHaveProperty('merchantPayTo')
  })

  it('a LEGACY-rail account never takes the branch, even when the merchant offers it', async () => {
    const res = await pay(erc7710Header, { ...AGENT_RESPONSE, execution_rail: 'legacy' })
    expect(res.data.settlement_scheme).toBeUndefined()
    const raw = calls.find((c) => new URL(c.url).pathname === '/x402')!.body
    const body = typeof raw === 'string' ? JSON.parse(raw) : (raw as Record<string, unknown>)
    expect(body.settlementScheme).toBe('eip3009')
  })

  it('a 3009-only merchant stays on the bridge, even on a delegation account', async () => {
    const res = await pay(plainHeader, DELEGATION_AGENT)
    expect(res.data.settlement_scheme).toBeUndefined()
    const raw = calls.find((c) => new URL(c.url).pathname === '/x402')!.body
    const body = typeof raw === 'string' ? JSON.parse(raw) : (raw as Record<string, unknown>)
    expect(body.settlementScheme).toBe('eip3009')
  })

  it('keeps #1348 round-trip budget: still exactly ONE agent fetch', async () => {
    await pay(erc7710Header, DELEGATION_AGENT, true)
    expect(
      calls.filter((c) => new URL(c.url).pathname.endsWith('/machine-payments/agent')).length,
    ).toBe(1)
  })

  it('settle exchanges the signature for the header, with NO funding relay and NO preflight', async () => {
    // The sequence inversion this issue turns on: on 3009 the signature funds
    // the delegate; here it IS the settlement child.
    stubFetch({
      'POST /x402/pay_7710/settle': { status: 200, body: { payment_header: 'HEADER_FROM_HAVEN' } },
      'GET /payments/pay_7710': { status: 200, body: { payment_id: 'pay_7710', status: 'settled' } },
    })
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    const spy = vi.spyOn(haven, 'completeX402MerchantCall').mockResolvedValue({
      status: 200,
      ok: true,
      body: { jsonrpc: '2.0', id: 'x', result: { content: [{ type: 'text', text: 'goods' }] } },
      settlementTxHash: undefined,
    })
    vi.spyOn(haven, 'getPostPurchaseAllowanceSummary').mockResolvedValue({
      allowance: null,
      warnings: [],
      payment: { status: 'settled' },
    } as never)

    const res = ok(
      await createToolHandlers(haven).haven_settle_mcp_tool({
        payment_id: 'pay_7710',
        signature: SIG7710,
        merchant_url: 'http://merchant.test/mcp',
        tool_name: 'create_text',
        arguments: { prompt: 'Hello' },
      }),
    ) as { data: Record<string, any> }

    expect(res.data.settlement_scheme).toBe('erc7710')
    expect(res.data.funding_tx_hash).toBeNull()
    expect(spy.mock.calls[0][0].paymentHeader).toBe('HEADER_FROM_HAVEN')
    // The signature went to settle, NOT to the funding relay.
    expect(calls.find((c) => c.url.includes('/settle'))?.body).toEqual({ signature: SIG7710 })
    expect(calls.find((c) => c.url.includes('/payments/pay_7710/sign'))).toBeUndefined()
  })

  /**
   * #1508. The test above stubs `GET /payments/:id` as **200 / 'settled'**, and
   * that fixture is precisely why this shipped green: the real backend answers
   * **409** for a `submitted` intent (`agentPaymentStatusHttpCode`), and a
   * successful erc7710 settle leaves the intent exactly there — the merchant
   * redeems the [child, budget] chain afterwards, so 'submitted' is the
   * EXPECTED end state on this scheme, not a transient one.
   *
   * `deliverMerchantPayment` then called `ensureFundingConfirmed`, which reads
   * that endpoint UNCONDITIONALLY (the fundingTxHash argument only gates the
   * WAIT, not the READ). The 409 became a throw, and a payment whose settlement
   * had already succeeded was reported to the agent as API_ERROR — every time,
   * with the merchant never contacted. Found by probing the live intent status
   * across the handoff: after_quote=pending_signature, after_sign=
   * pending_signature, after_settle_refused=submitted.
   *
   * So this pins the REAL response, not a convenient one.
   */
  it('#1508: settles even though the payment read 409s on the submitted intent', async () => {
    stubFetch({
      'POST /x402/pay_7710/settle': { status: 200, body: { payment_header: 'HEADER_FROM_HAVEN' } },
      // What the backend actually returns once settle has flipped the intent:
      // 409, status 'submitted', and — the part the old fixture also got wrong
      // — NO tx_hash, because erc7710 has no Haven-submitted transaction.
      'GET /payments/pay_7710': {
        status: 200,
        body: {
          payment_id: 'pay_7710',
          status: 'submitted',
          rail: 'x402',
          message: 'The payment was submitted and is waiting for confirmation.',
        },
      },
    })
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    const spy = vi.spyOn(haven, 'completeX402MerchantCall').mockResolvedValue({
      status: 200,
      ok: true,
      body: { jsonrpc: '2.0', id: 'x', result: { content: [{ type: 'text', text: 'goods' }] } },
      settlementTxHash: undefined,
    })
    vi.spyOn(haven, 'getPostPurchaseAllowanceSummary').mockResolvedValue({
      allowance: null,
      warnings: [],
      payment: null,
    } as never)
    // The guard is "never call it", not "call it and tolerate the failure" —
    // there is no funding transaction on this scheme, so the wait is
    // meaningless work whose only possible effect is this bug.
    const fundingSpy = vi.spyOn(haven, 'ensureFundingConfirmed')

    const res = ok(
      await createToolHandlers(haven).haven_settle_mcp_tool({
        payment_id: 'pay_7710',
        signature: SIG7710,
        merchant_url: 'http://merchant.test/mcp',
        tool_name: 'create_text',
        arguments: { prompt: 'Hello' },
      }),
    ) as { data: Record<string, any> }

    expect(res.data.settled).toBe(true)
    expect(res.data.settlement_scheme).toBe('erc7710')
    expect(fundingSpy).not.toHaveBeenCalled()
    // The merchant leg still ran — the whole point of settling.
    expect(spy.mock.calls[0][0].paymentHeader).toBe('HEADER_FROM_HAVEN')
  })
})

/**
 * #1456 review: the code comment claims "a prefetch FAILURE deliberately
 * yields the 3009 path", and nothing pinned it. Mutating the rail test from
 * `=== 'delegation'` to `!== 'legacy'` — which makes an UNKNOWN rail
 * erc7710-eligible — passed all 151 tests. A guarantee stated in a comment and
 * checked by nothing is the failure mode this repo keeps naming.
 */
describe('hosted erc7710 rail fallback (#1456 review)', () => {
  const ERC7710_PR2 = {
    ...PAYMENT_REQUIRED,
    accepts: [
      ...PAYMENT_REQUIRED.accepts,
      { ...PAYMENT_REQUIRED.accepts[0], extra: { assetTransferMethod: 'erc7710' } },
    ],
  }
  const header2 = btoa(JSON.stringify(ERC7710_PR2))

  async function payWithAgent(agentStub: Record<string, unknown>) {
    stubFetch({
      'POST /mcp': { status: 402, responseHeaders: { 'PAYMENT-REQUIRED': header2 } },
      'GET /machine-payments/agent': agentStub,
      'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
    })
    return ok(
      await handlers().haven_pay_mcp_tool({
        merchant_url: 'http://merchant.test/mcp',
        tool_name: 'create_text',
        arguments: { prompt: 'Hello' },
        max_amount: '2000000',
      }),
    ) as { data: Record<string, any> }
  }

  function scheme() {
    const raw = calls.find((c) => new URL(c.url).pathname === '/x402')!.body
    const body = typeof raw === 'string' ? JSON.parse(raw) : (raw as Record<string, unknown>)
    return body.settlementScheme
  }

  it('an agent record with NO rail field falls back to 3009, not erc7710', async () => {
    // The mutation the review used: an unknown rail must never be treated as
    // delegation-eligible just because it is not the string 'legacy'.
    const res = await payWithAgent({ status: 200, body: AGENT_RESPONSE })
    expect(res.data.settlement_scheme).toBeUndefined()
    expect(scheme()).toBe('eip3009')
  })

  it('an unrecognised rail value falls back to 3009', async () => {
    const res = await payWithAgent({ status: 200, body: { ...AGENT_RESPONSE, execution_rail: 'session_key' } })
    expect(res.data.settlement_scheme).toBeUndefined()
    expect(scheme()).toBe('eip3009')
  })

  it('a FAILED agent read never constructs an erc7710 request', async () => {
    // The case the two above cannot reach: getAgent() normalises any unknown
    // rail to 'legacy', so only an outright prefetch REJECTION yields
    // undefined — which is exactly what the review's `!== 'legacy'` mutant
    // treats as delegation-eligible. The call itself fails (createX402Intent
    // re-fetches and hits the same 500), so the assertion is about the SHAPE
    // that was or was not built, not about success.
    stubFetch({
      'POST /mcp': { status: 402, responseHeaders: { 'PAYMENT-REQUIRED': header2 } },
      'GET /machine-payments/agent': { status: 500, body: { error: 'boom' } },
      'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
    })
    await handlers().haven_pay_mcp_tool({
      merchant_url: 'http://merchant.test/mcp',
      tool_name: 'create_text',
      arguments: { prompt: 'Hello' },
      max_amount: '2000000',
    })
    const authorize = calls.find((c) => new URL(c.url).pathname === '/x402')
    if (authorize) {
      const raw = authorize.body
      const body = typeof raw === 'string' ? JSON.parse(raw) : (raw as Record<string, unknown>)
      expect(body.settlementScheme).not.toBe('erc7710')
    }
    // Whatever else happened, no settlement child was requested.
    expect(calls.find((c) => new URL(c.url).pathname.endsWith('/settle'))).toBeUndefined()
  })
})

/**
 * #1469 — a null hole in agent-supplied accepts[] gets the clean refusal,
 * not a 500. The Zod schema only guarantees a string-keyed record; the raw
 * cast this fixes let the hole reach the selectors and throw.
 */
describe('null-holed payment_required (#1469)', () => {
  it('haven_pay_x402_quote survives a null accepts entry and still selects the valid one', async () => {
    stubFetch({
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
    })
    const result = await handlers().haven_pay_x402_quote({
      payment_required: { ...PAYMENT_REQUIRED, accepts: [null, ...PAYMENT_REQUIRED.accepts] },
    })
    // Whatever else this stub run yields, it must NOT be the crash shape.
    expect(JSON.stringify(result)).not.toMatch(/Cannot read properties of null/)
  })

  it('an accepts of ONLY garbage entries refuses cleanly with the wrong-tool guidance', async () => {
    const result = await handlers().haven_pay_x402_quote({
      payment_required: { ...PAYMENT_REQUIRED, accepts: [null, 'garbage', 42] },
    })
    const text = JSON.stringify(result)
    expect(text).not.toMatch(/Cannot read properties/)
    expect(text).toMatch(/No compatible payment option|not a valid x402 PaymentRequired/)
  })
})

describe('runtime-neutral tool naming (#1588)', () => {
  it('every tool description that spells mcp__… also carries the runtime-naming hedge', async () => {
    // Self-enforcing acceptance criterion: no agent-visible description may
    // assert the Claude-family identifier as THE callable name without the
    // runtime-neutral resolution alongside it. Registration-derived, so a new
    // tool description cannot dodge the rule.
    const { toolDescriptions } = await import('./tools.js')
    const offenders = Object.entries(toolDescriptions)
      .filter(([, description]) => description.includes('mcp__'))
      .filter(([, description]) => !description.includes('next_tool_server'))
      .map(([name]) => name)
    expect(offenders).toEqual([])
  })
})

describe('next_tool emission literals (#1588 review)', () => {
  it('every nextTool literal in the source parses into the runtime-neutral pair', async () => {
    // Source-derived like the description scanner: only 4 of the 9 emission
    // sites are behaviourally pinned, and a mis-spelled literal on an
    // unpinned site would silently drop the pair (the derivation omits on
    // parse failure by design). This closes that hole for every literal,
    // present and future.
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const source = readFileSync(fileURLToPath(new URL('./tools.ts', import.meta.url)), 'utf8')
    const literals = [...source.matchAll(/nextTool: '([^']+)'/g)].map((m) => m[1])
    expect(literals.length).toBeGreaterThanOrEqual(9)
    const unparseable = literals.filter((l) => !/^mcp__([a-z0-9-]+)__([a-z0-9_]+)$/.test(l))
    expect(unparseable).toEqual([])
  })

  it('suggested_tool hints use BARE tool names — the sibling convention, never the prefixed form', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const source = readFileSync(fileURLToPath(new URL('./tools.ts', import.meta.url)), 'utf8')
    const prefixed = [...source.matchAll(/suggestedTool: '([^']+)'/g)]
      .map((m) => m[1])
      .filter((v) => v.startsWith('mcp__'))
    expect(prefixed).toEqual([])
  })
})

// ── haven_discover_tools: verified-directory badges + filter (#1716) ────────

describe('haven_discover_tools verified directory (#1716)', () => {
  const directoryFixture = {
    entries: [
      {
        id: 'cat_dir_1',
        name: 'Directory Summarizer',
        description: 'Self-submitted service',
        category: 'api',
        resource_url: 'https://directory.example.com/mcp',
        rail: 'x402',
        protocol: 'mcp',
        tool_name: 'summarize',
        tool_arguments: null,
        price_display: null,
        price_atomic: null,
        asset: null,
        network: null,
        status: 'active',
        verified_at: '2026-08-23T10:00:00.000Z',
        source: 'ingestion',
        domain_verified: true,
        verified_payable: true,
      },
      {
        id: 'cat_cur_1',
        name: 'Curated API',
        description: 'Operator-curated',
        category: 'ai',
        resource_url: 'https://api.example.com/paid',
        rail: 'x402',
        protocol: 'http',
        tool_name: null,
        tool_arguments: null,
        price_display: '$0.01 USDC',
        price_atomic: '10000',
        asset: 'USDC',
        network: 'eip155:8453',
        status: 'active',
        verified_at: '2026-08-01T00:00:00.000Z',
        source: 'operator',
        domain_verified: false,
        verified_payable: false,
      },
    ],
  }

  it('surfaces the badge fields on discovered entries', async () => {
    stubFetch({ 'GET /catalog': { status: 200, body: directoryFixture } })
    const result = ok<Array<Record<string, unknown>>>(await handlers().haven_discover_tools({}))
    expect(result.data).toHaveLength(2)
    expect(result.data[0]).toMatchObject({
      source: 'ingestion',
      domain_verified: true,
      verified_payable: true,
    })
    expect(result.data[1]).toMatchObject({
      source: 'operator',
      domain_verified: false,
      verified_payable: false,
    })
  })

  it('filters client-side on verified=verified and verified=operator', async () => {
    stubFetch({ 'GET /catalog': { status: 200, body: directoryFixture } })

    const verified = ok<Array<Record<string, unknown>>>(
      await handlers().haven_discover_tools({ verified: 'verified' }),
    )
    expect(verified.data.map((e) => e.id)).toEqual(['cat_dir_1'])

    const operator = ok<Array<Record<string, unknown>>>(
      await handlers().haven_discover_tools({ verified: 'operator' }),
    )
    expect(operator.data.map((e) => e.id)).toEqual(['cat_cur_1'])
  })
})

// ── haven_submit_catalog_entry (#1716) ──────────────────────────────────────

describe('haven_submit_catalog_entry (#1716)', () => {
  it('posts the resource_url to the queue-only endpoint and returns token + status', async () => {
    stubFetch({
      'POST /catalog/submit': {
        status: 201,
        body: {
          id: '00000000-0000-4000-8000-000000000001',
          verify_token: 'ab'.repeat(24),
          status: 'submitted',
        },
      },
    })

    const result = ok<{ id: string; verify_token: string; status: string }>(
      await handlers().haven_submit_catalog_entry({
        resource_url: 'https://merchant.example/mcp',
      }),
    )
    expect(result.data).toMatchObject({
      id: '00000000-0000-4000-8000-000000000001',
      verify_token: 'ab'.repeat(24),
      status: 'submitted',
    })
    const call = calls.find((c) => c.method === 'POST' && c.url.includes('/catalog/submit'))
    expect(call?.body).toEqual({ resource_url: 'https://merchant.example/mcp' })
  })
})

/**
 * #2041 — the #1450 preference rule reaches the GENERIC plain-HTTP entry point.
 *
 * #1456 covered `haven_pay_mcp_tool` and `haven_prepare_catalog_purchase` and
 * scoped itself to exactly those two. `haven_quote_x402` → `haven_pay_x402_quote`
 * — the transport most real merchants are actually on — hard-routed to the
 * EIP-3009 bridge, so the merchant TRANSPORT was silently deciding the
 * settlement SCHEME.
 *
 * The NEGATIVES carry this suite, the same way they carry the #1456 one: a
 * selector that always answered "erc7710" would pass a happy-path-only file.
 * Every positive here is paired with a control on the other branch.
 */
describe('generic plain-HTTP x402: settlement-scheme selection (#2041)', () => {
  const FACILITATOR = '0x4444444444444444444444444444444444444444'
  /**
   * The load-bearing fixture: a plain-HTTP merchant that ADVERTISES erc7710.
   *
   * The two entries carry **deliberately different amounts**, and that is the
   * point of the fixture rather than incidental detail. #1453 made the two
   * option selectors mutually exclusive, so the cap is compared against one
   * accepts[] entry while the erc7710 branch authorizes the OTHER — and
   * nothing ties their amounts together. Building the erc7710 entry as a plain
   * spread of the standard one (which is what #1456's fixtures do) gives both
   * entries the same amount, which makes that entire failure mode invisible to
   * a green suite. See #2051.
   */
  const STANDARD_ATOMIC = '1500000' // 1.50 USDC — PAYMENT_REQUIRED's maxAmountRequired
  const ERC7710_ATOMIC = '2500000' // 2.50 USDC — what the erc7710 branch really authorizes
  const ERC7710_PAYMENT_REQUIRED = {
    ...PAYMENT_REQUIRED,
    accepts: [
      ...PAYMENT_REQUIRED.accepts,
      {
        ...PAYMENT_REQUIRED.accepts[0],
        amount: ERC7710_ATOMIC,
        maxAmountRequired: ERC7710_ATOMIC,
        extra: { assetTransferMethod: 'erc7710', facilitatorAddresses: [FACILITATOR] },
      },
    ],
  }
  /** A merchant advertising erc7710 and NOTHING else — no standard entry. */
  const ERC7710_ONLY_PAYMENT_REQUIRED = {
    ...PAYMENT_REQUIRED,
    accepts: [
      {
        ...PAYMENT_REQUIRED.accepts[0],
        amount: ERC7710_ATOMIC,
        maxAmountRequired: ERC7710_ATOMIC,
        extra: { assetTransferMethod: 'erc7710', facilitatorAddresses: [FACILITATOR] },
      },
    ],
  }
  const DELEGATION_AGENT = { ...AGENT_RESPONSE, execution_rail: 'delegation' }
  const LEGACY_AGENT = { ...AGENT_RESPONSE, execution_rail: 'legacy' }
  const CHILD = {
    payment_id: 'pay_generic_7710',
    status: 'pending_signature',
    sign_data: {
      hash: '0x' + '11'.repeat(32),
      signature_scheme: 'eip712_delegation',
      typed_data: { domain: {}, types: {}, primaryType: 'Delegation', message: { caveats: [] } },
    },
  }

  /**
   * The /x402 fixture is chosen by the EXPECTED scheme, not by the challenge —
   * a legacy account meeting a 7710-advertising merchant must still get the
   * 3009 intent back, which is the case a careless helper gets wrong.
   */
  async function rawQuotePay(
    paymentRequired: unknown,
    agent: Record<string, unknown>,
    expectErc7710 = false,
    extraArgs: Record<string, unknown> = {},
  ) {
    stubFetch({
      'GET /machine-payments/agent': { status: 200, body: agent },
      'POST /x402': { status: 201, body: expectErc7710 ? CHILD : X402_INTENT_RESPONSE },
    })
    return handlers().haven_pay_x402_quote({ payment_required: paymentRequired, ...extraArgs })
  }

  async function quotePay(
    paymentRequired: unknown,
    agent: Record<string, unknown>,
    expectErc7710 = false,
    extraArgs: Record<string, unknown> = {},
  ) {
    return ok(await rawQuotePay(paymentRequired, agent, expectErc7710, extraArgs)) as {
      data: Record<string, any>
    }
  }

  function authorizeBody() {
    const raw = calls.find((c) => new URL(c.url).pathname === '/x402')!.body
    return (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>
  }

  it('delegation rail + erc7710 merchant: selects erc7710 and shapes the request for DIRECT settlement', async () => {
    const res = await quotePay(ERC7710_PAYMENT_REQUIRED, DELEGATION_AGENT, true)

    expect(res.data.payment_id).toBe('pay_generic_7710')
    expect(res.data.settlement_scheme).toBe('erc7710')
    expect(res.data.settlement.scheme).toBe('erc7710')
    // The defining property of the preferred scheme is this ABSENCE.
    expect(res.data.settlement.funding_leg).toBe(false)
    expect(res.data.settlement.merchant_pay_to).toBe(PAYMENT_REQUIRED.accepts[0].payTo)
    expect(res.data.settlement.facilitator_addresses).toEqual([FACILITATOR])

    const body = authorizeBody()
    // payTo = the MERCHANT is what selects direct settlement server-side, and
    // the explicit scheme must AGREE with that shape (#1360).
    expect(body.payTo).toBe(PAYMENT_REQUIRED.accepts[0].payTo)
    expect(body.settlementScheme).toBe('erc7710')
    // No funding target, so no separate merchant field and no funding leg.
    expect(body).not.toHaveProperty('merchantPayTo')
    expect(body.facilitatorAddresses).toEqual([FACILITATOR])
    // The authorized amount is the ERC7710 entry's own, not the standard
    // entry's — stated here because everything about the cap depends on it.
    expect(body.amount).toBe(ERC7710_ATOMIC)
    expect(res.data.amount_atomic).toBe(ERC7710_ATOMIC)
  })

  it('POSITIVE CONTROL — a merchant that does NOT advertise erc7710 still takes the 3009 bridge', async () => {
    const res = await quotePay(PAYMENT_REQUIRED, DELEGATION_AGENT)

    expect(res.data.settlement_scheme).toBeUndefined()
    expect(res.data.settlement).toBeUndefined()
    const body = authorizeBody()
    // Byte-identical to the pre-#2041 generic path: fund the delegate EOA,
    // record the real merchant separately, and SAY 'eip3009' out loud (#1360).
    expect(body.settlementScheme).toBe('eip3009')
    expect(body.payTo).toBe('0xDelegate')
    expect(body.merchantPayTo).toBe(PAYMENT_REQUIRED.accepts[0].payTo)
  })

  it('a LEGACY-rail account never takes the branch, even when the merchant offers it', async () => {
    const res = await quotePay(ERC7710_PAYMENT_REQUIRED, LEGACY_AGENT)

    expect(res.data.settlement_scheme).toBeUndefined()
    expect(authorizeBody().settlementScheme).toBe('eip3009')
  })

  it('an agent record with NO execution_rail is not treated as delegation', async () => {
    // AGENT_RESPONSE carries no execution_rail at all. Guessing 'delegation'
    // here would build a request the backend refuses; the pre-#2041 behaviour
    // of this tool was 3009, and an unknown rail keeps it.
    const res = await quotePay(ERC7710_PAYMENT_REQUIRED, AGENT_RESPONSE)

    expect(res.data.settlement_scheme).toBeUndefined()
    expect(authorizeBody().settlementScheme).toBe('eip3009')
  })

  it('keeps the #1348 round-trip budget on BOTH branches: exactly ONE agent fetch', async () => {
    await quotePay(ERC7710_PAYMENT_REQUIRED, DELEGATION_AGENT, true)
    const onErc7710 = calls.filter((c) =>
      new URL(c.url).pathname.endsWith('/machine-payments/agent'),
    ).length
    calls = []
    await quotePay(PAYMENT_REQUIRED, DELEGATION_AGENT)
    const on3009 = calls.filter((c) =>
      new URL(c.url).pathname.endsWith('/machine-payments/agent'),
    ).length
    expect([onErc7710, on3009]).toEqual([1, 1])
  })

  it('points the agent at the erc7710 continuation, not the 3009 header-building one', async () => {
    const res = await quotePay(ERC7710_PAYMENT_REQUIRED, DELEGATION_AGENT, true)

    expect(res.data.next_action).toBe(AgentPaymentNextAction.SignAndSubmitPayment)
    expect(res.data.next_tool).toBe('mcp__haven-signer__haven_sign')
    expect(res.data.next_arguments).toEqual({ payment_id: 'pay_generic_7710' })
    // The agent must be told to say the scheme back on submit — the header is
    // assembled by Haven on this path, never by haven_x402_sign_header.
    expect(res.data.reason).toContain("settlement_scheme: 'erc7710'")
    expect(res.data.reason).toContain('Do NOT call haven_x402_sign_header')
  })

  it('the optional-cap nudge still fires on the erc7710 branch', async () => {
    const res = await quotePay(ERC7710_PAYMENT_REQUIRED, DELEGATION_AGENT, true)
    expect(res.data.cap_warning).toBeTruthy()
  })

  /**
   * #2051 in miniature, fixed for THIS branch only.
   *
   * `payment_required` is merchant-controlled input. Because #1453 made the two
   * option selectors mutually exclusive, a cap compared against the standard
   * entry says nothing about the erc7710 entry the branch actually authorizes —
   * so a merchant could advertise a cheap standard price beside an expensive
   * erc7710 one and walk straight through a user-stated spending limit. That is
   * a bypass an attacker chooses to trigger, not a guard that merely fails to
   * fire, which is why it is proven in both directions here.
   */
  describe('the cap binds the option that is ACTUALLY authorized', () => {
    it('REFUSES when the erc7710 entry exceeds the cap, though the standard entry does not', async () => {
      // 2 USDC cap. Standard entry 1.50 (under), erc7710 entry 2.50 (over).
      // Pre-#2041-review this returned a signable child for 2.50 USDC.
      const payload = await rawQuotePay(
        ERC7710_PAYMENT_REQUIRED,
        DELEGATION_AGENT,
        true,
        { max_amount_human: '2' },
      )

      expect(payload.success).toBe(false)
      if (payload.success) throw new Error('expected failure')
      expect(payload.code).toBe(AgentPaymentFailureCode.PriceExceedsMax)
      // The cap is PRE-network on this branch too: nothing was authorized.
      expect(calls.find((c) => new URL(c.url).pathname === '/x402')).toBeUndefined()
    })

    it('POSITIVE CONTROL — an IN-cap erc7710 payment still succeeds', async () => {
      // Same fixture, same branch, cap raised above the erc7710 entry. Proves
      // the fix refuses the right thing rather than refusing everything.
      const res = await quotePay(ERC7710_PAYMENT_REQUIRED, DELEGATION_AGENT, true, {
        max_amount_human: '3',
      })

      expect(res.data.settlement_scheme).toBe('erc7710')
      expect(authorizeBody().amount).toBe(ERC7710_ATOMIC)
    })

    it('the atomic spelling of the cap binds the erc7710 entry too', async () => {
      const payload = await rawQuotePay(ERC7710_PAYMENT_REQUIRED, DELEGATION_AGENT, true, {
        max_amount: STANDARD_ATOMIC, // exactly the standard entry's price
      })

      expect(payload.success).toBe(false)
      if (payload.success) throw new Error('expected failure')
      expect(payload.code).toBe(AgentPaymentFailureCode.PriceExceedsMax)
    })

    it('POSITIVE CONTROL — the 3009 branch keeps capping against the standard entry', async () => {
      // The same cap that refuses above must still ALLOW the bridge, because
      // there the standard entry IS the authorized one. A fix that simply
      // capped harder everywhere would break this.
      const res = await quotePay(PAYMENT_REQUIRED, LEGACY_AGENT, false, {
        max_amount_human: '2',
      })

      expect(res.data.payment_id).toBe('pay_x402')
      expect(authorizeBody().settlementScheme).toBe('eip3009')
    })
  })

  /**
   * A merchant advertising ONLY erc7710 is payable now, so a CAPPED call must
   * not be refused as "no payment option Haven can settle" while the same call
   * uncapped succeeds — stating a spending limit must never be the thing that
   * breaks a purchase.
   */
  describe('a merchant advertising ONLY erc7710', () => {
    it('is payable with a cap that covers it', async () => {
      const res = await quotePay(ERC7710_ONLY_PAYMENT_REQUIRED, DELEGATION_AGENT, true, {
        max_amount_human: '3',
      })

      expect(res.data.settlement_scheme).toBe('erc7710')
      expect(authorizeBody().amount).toBe(ERC7710_ATOMIC)
    })

    it('still REFUSES a cap it exceeds — the widened guard did not disable the cap', async () => {
      const payload = await rawQuotePay(
        ERC7710_ONLY_PAYMENT_REQUIRED,
        DELEGATION_AGENT,
        true,
        { max_amount_human: '1' },
      )

      expect(payload.success).toBe(false)
      if (payload.success) throw new Error('expected failure')
      expect(payload.code).toBe(AgentPaymentFailureCode.PriceExceedsMax)
      expect(calls.find((c) => new URL(c.url).pathname === '/x402')).toBeUndefined()
    })

    it('is still refused on a LEGACY rail, which genuinely cannot settle it', async () => {
      const payload = await rawQuotePay(ERC7710_ONLY_PAYMENT_REQUIRED, LEGACY_AGENT, false, {
        max_amount_human: '3',
      })

      expect(payload.success).toBe(false)
      if (payload.success) throw new Error('expected failure')
      expect(payload.message).toContain('No compatible payment option')
    })
  })

  /**
   * The backend has supported replay dedup on this branch all along — the
   * lookup runs before the funding-shape branch and the erc7710 insert carries
   * `conflictTarget: 'x402_idempotency_key'`. It was never invoked, because the
   * SDK options bag had no way to say the key. A retried call therefore minted
   * a second INDEPENDENTLY SIGNABLE settlement child for one purchase, and on
   * this scheme the signed artifact is spend authority, not a funding step.
   */
  describe('idempotency on the erc7710 branch', () => {
    it('sends the caller idempotency_key on the authorize, so a retry can replay', async () => {
      await quotePay(ERC7710_PAYMENT_REQUIRED, DELEGATION_AGENT, true, {
        idempotency_key: 'x402:generic-7710:abc',
      })

      expect(authorizeBody().idempotencyKey).toBe('x402:generic-7710:abc')
    })

    it('sends the SAME key on a repeated call, which is what makes the replay one purchase', async () => {
      const seen: unknown[] = []
      for (let i = 0; i < 2; i++) {
        calls = []
        await quotePay(ERC7710_PAYMENT_REQUIRED, DELEGATION_AGENT, true, {
          idempotency_key: 'x402:generic-7710:abc',
        })
        seen.push(authorizeBody().idempotencyKey)
      }
      expect(seen).toEqual(['x402:generic-7710:abc', 'x402:generic-7710:abc'])
    })

    it('omits the field entirely when the caller gave no key, keeping the old request shape', async () => {
      await quotePay(ERC7710_PAYMENT_REQUIRED, DELEGATION_AGENT, true)
      expect(authorizeBody()).not.toHaveProperty('idempotencyKey')
    })
  })

  /**
   * A recipient-PINNED budget cannot fund the delegate EOA, so 3009-mode is
   * structurally impossible for it (owner decision 2026-07-15) and the backend
   * answers 403. Before #2041 that was the ONLY answer a pinned agent could get
   * from this tool — for EVERY merchant, including one advertising erc7710 —
   * because the generic path never asked for anything else.
   */
  describe('recipient-pinned budgets', () => {
    const PINNED_403 = {
      status: 403,
      body: {
        error:
          'Agent has no delegation able to fund EIP-3009 settlement for USDC. ' +
          '3009-mode needs an open (unpinned) budget delegation — merchant-pinned budgets settle via erc7710 only.',
      },
    }

    it('still refuses with the existing 403 at a 3009-only merchant', async () => {
      stubFetch({
        'GET /machine-payments/agent': { status: 200, body: DELEGATION_AGENT },
        'POST /x402': PINNED_403,
      })
      const payload = await handlers().haven_pay_x402_quote({
        payment_required: PAYMENT_REQUIRED,
      })
      expect(payload.success).toBe(false)
      if (payload.success) throw new Error('expected failure')
      expect(payload.message).toContain('erc7710 only')
      expect(authorizeBody().settlementScheme).toBe('eip3009')
    })

    it('reaches the scheme it CAN settle at an erc7710 merchant, instead of that 403', async () => {
      // The severity correction this issue understated: a pinned agent could
      // not pay ANY merchant through this tool, not merely pay them
      // sub-optimally.
      const res = await quotePay(ERC7710_PAYMENT_REQUIRED, DELEGATION_AGENT, true)
      expect(res.data.settlement_scheme).toBe('erc7710')
      expect(authorizeBody().settlementScheme).toBe('erc7710')
    })
  })
})

/**
 * #2041 — haven_submit's erc7710 branch: the generic path's settle leg.
 *
 * On 3009 the signature funds the delegate EOA and a funding transaction has
 * to confirm. Here the signature IS the settlement child: it goes to
 * POST /x402/:id/settle and Haven hands back the assembled merchant header.
 */
describe('haven_submit — erc7710 settle (#2041)', () => {
  const SIG = '0x' + '44'.repeat(65)

  it('exchanges the signed child for the merchant header, with NO funding relay', async () => {
    stubFetch({
      'POST /x402/pay_generic_7710/settle': {
        status: 200,
        body: { payment_header: 'HEADER_FROM_HAVEN' },
      },
    })
    const res = ok(
      await handlers().haven_submit({
        payment_id: 'pay_generic_7710',
        signature: SIG,
        settlement_scheme: 'erc7710',
      }),
    ) as { data: Record<string, any> }

    expect(res.data.settlement_scheme).toBe('erc7710')
    expect(res.data.payment_header).toBe('HEADER_FROM_HAVEN')
    expect(res.data.funding_tx_hash).toBeNull()
    // erc7710 has no Haven-submitted transaction, so there is no hash to fake.
    expect(res.data.tx_hash).toBeNull()
    expect(res.data.next_action).toBe(AgentPaymentNextAction.RetryOriginalX402Request)

    // The signature went to settle, NOT to the funding relay.
    expect(calls.find((c) => c.url.includes('/settle'))?.body).toEqual({ signature: SIG })
    expect(calls.find((c) => c.url.includes('/sign'))).toBeUndefined()
  })

  it('POSITIVE CONTROL — omitting settlement_scheme still relays a FUNDING signature, unchanged', async () => {
    stubFetch({
      'POST /payments/pay_x402/sign': {
        status: 200,
        body: { status: 'confirmed', tx_hash: '0xfunding_tx' },
      },
    })
    const res = ok(
      await handlers().haven_submit({ payment_id: 'pay_x402', signature: SIG }),
    ) as { data: Record<string, any> }

    expect(res.data.status).toBe('confirmed')
    expect(res.data.tx_hash).toBe('0xfunding_tx')
    // The pre-#2041 shape exactly: no scheme marker, no header.
    expect(res.data.settlement_scheme).toBeUndefined()
    expect(res.data.payment_header).toBeUndefined()
    expect(calls.find((c) => c.url.includes('/settle'))).toBeUndefined()
    expect(calls.find((c) => c.url.includes('/sign'))).toBeDefined()
  })

  it('maps an EXPIRED settlement child to the structured window-expired refusal', async () => {
    // The child's window is the shortest in the system, so this is MORE likely
    // on this scheme than on the bridge — leaving it as a raw API error was the
    // wrong asymmetry.
    stubFetch({
      'POST /x402/pay_expired_child/settle': {
        status: 410,
        body: { error: 'Settlement child expired before it could be redeemed' },
      },
      'GET /machine-payments/pay_expired_child/status': {
        status: 200,
        body: {
          payment_id: 'pay_expired_child',
          kind: 'payment_intent',
          rail: 'x402',
          status: 'expired',
          phase: 'expired',
          next_action: 'request_again_if_user_still_wants_it',
          amount: '2.50',
          token: 'USDC',
          resource_url: 'http://merchant.test/paid',
          merchant_address: '0xMerchant',
          tx_hash: null,
          expires_at: '2000-01-01T00:00:00.000Z',
          chain_id: 8453,
          message: 'The payment expired before it was completed.',
          idempotency_key: 'idem-7710',
        },
      },
    })

    const payload = await handlers().haven_submit({
      payment_id: 'pay_expired_child',
      signature: SIG,
      settlement_scheme: 'erc7710',
    })

    if (payload.success) throw new Error('expected a failure payload')
    expect(payload.code).toBe(AgentPaymentFailureCode.PaymentWindowExpired)
    expect(payload.next_action).toBe(AgentPaymentNextAction.PaymentWindowExpired)
    expect(payload.idempotency_key).toBe('idem-7710')
    expect(payload.retry_with_new_quote).toBe(true)
  })

  it("an explicit 'eip3009' behaves identically to omitting it", async () => {
    stubFetch({
      'POST /payments/pay_x402/sign': {
        status: 200,
        body: { status: 'confirmed', tx_hash: '0xfunding_tx' },
      },
    })
    const res = ok(
      await handlers().haven_submit({
        payment_id: 'pay_x402',
        signature: SIG,
        settlement_scheme: 'eip3009',
      }),
    ) as { data: Record<string, any> }

    expect(res.data.status).toBe('confirmed')
    expect(res.data.settlement_scheme).toBeUndefined()
    expect(calls.find((c) => c.url.includes('/settle'))).toBeUndefined()
  })
})
