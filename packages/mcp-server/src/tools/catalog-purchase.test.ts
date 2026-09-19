/**
 * #2810 — colocated tests for the CATALOG / QUOTE / PREPARE capability.
 *
 * Moved VERBATIM out of `tools.test.ts`, which had grown to cover the whole
 * hosted surface from one file. Every block here invokes ONLY the six tools
 * this capability owns; blocks that also drive a sibling capability's handler
 * (`haven_pay_x402_quote`, `haven_settle_mcp_tool`, `haven_complete_mcp_tool`,
 * and in the custody-invariant block `haven_pay`, `haven_send`, `haven_submit`)
 * deliberately stayed behind rather than being split, because splitting a test
 * that spans two capabilities is a behaviour change dressed as a move.
 *
 * The classification is by the INVOCATION SET OF A TOP-LEVEL `describe`, not by
 * title: a block moved only if the set of `.haven_*(` calls anywhere in it is a
 * subset of this capability's tuple. At `it` granularity several tests left
 * behind are pure single-capability tests — the rule is deliberately coarser
 * than that, because a describe's `beforeEach` and fixtures are shared by its
 * children and splitting them is a behaviour change dressed as a move. A
 * prose mention or a `nextTool` literal naming another tool does not make a
 * test that tool's — reading titles would have moved the wrong blocks in both
 * directions.
 *
 * Fixtures come from the #2808 shared module, never re-declared here.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { parseStrict } from './parsing.js'
import type { StrictInputToolName } from './contracts.js'
import {
  AgentPaymentFailureCode,
  AgentPaymentNextAction,
  type AgentNextStep,
} from '@haven_ai/sdk'
import {
  AGENT_RESPONSE,
  PAYMENT_REQUIRED,
  X402_EXPECTED_AUTH,
  X402_INTENT_RESPONSE,
  clearCalls,
  handlers,
  installSharedFixtureLifecycle,
  mintPaymentHeaders,
  ok,
  recordedCalls,
  stubFetch,
  type RouteDefinition,
} from '../test-support/hosted-mcp.js'

installSharedFixtureLifecycle()

beforeEach(() => {
  clearCalls()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

beforeAll(async () => {
  // Headers are minted by the SDK's real signing path so these fixtures
  // cannot drift from what a client actually sends (#1618 note — see the
  // shared fixture's mintPaymentHeaders).
  await mintPaymentHeaders()
})

describe('haven_discover_tools', () => {
  it('hands out suggested_arguments each suggested tool accepts VERBATIM — the discovery hop parity (#3100)', async () => {
    const base = {
      description: 'd', category: 'api', rail: 'x402', price_display: '$0.01 USDC', price_atomic: '10000',
      asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', network: 'base', status: 'active',
      verified_at: '2026-06-16T08:50:39.772Z',
    }
    stubFetch({
      'GET /catalog': {
        status: 200,
        body: {
          entries: [
            { ...base, id: 'cat_mcp', name: 'create_text', resource_url: 'https://mcp.merchant.test/mcp', protocol: 'mcp', tool_name: 'create_text', tool_arguments: { prompt: 'hello' } },
            { ...base, id: 'cat_http', name: 'Fact', resource_url: 'https://services.sandbox.ampersend.ai/api/fact', protocol: 'http', tool_name: null, tool_arguments: null },
            // Round-2 (#3113): the two row shapes haven_quote_catalog_purchase refuses get a reason, not a hint.
            { ...base, id: 'cat_mcp_nameless', name: 'Unnamed', resource_url: 'https://mcp.merchant.test/mcp', protocol: 'mcp', tool_name: null, tool_arguments: null },
            { ...base, id: 'cat_mcp_degraded', name: 'Stale', resource_url: 'https://mcp.merchant.test/mcp', protocol: 'mcp', tool_name: 'x', tool_arguments: {}, status: 'degraded' },
          ],
        },
      },
    })
    const result = ok<Array<{ id: string; resource_url: string; suggested_tool?: StrictInputToolName; suggested_arguments?: Record<string, unknown>; suggested_tool_omitted_reason?: string }>>(
      await handlers().haven_discover_tools({}),
    )
    expect(result.data.map((e) => [e.suggested_tool, e.suggested_arguments])).toEqual([
      ['haven_quote_catalog_purchase', { catalog_id: 'cat_mcp' }],
      ['haven_quote_x402', { url: 'https://services.sandbox.ampersend.ai/api/fact' }],
      [undefined, undefined],
      [undefined, undefined],
    ])
    for (const id of ['cat_mcp_nameless', 'cat_mcp_degraded']) {
      const row = result.data.find((e) => e.id === id)!
      expect(row).not.toHaveProperty('suggested_tool')
      expect(row.suggested_tool_omitted_reason).toContain('haven_quote_catalog_purchase refuses it')
    }
    // The property, not the literals: every hint parses under the strict
    // schema of the tool it names. (The live bug: discovery said
    // `resource_url`, the tool took `url`.)
    for (const entry of result.data) {
      if (!entry.suggested_tool) continue
      expect(() => parseStrict(entry.suggested_tool!, entry.suggested_arguments), entry.suggested_tool).not.toThrow()
      expect(() => parseStrict(entry.suggested_tool!, { resource_url: entry.resource_url })).toThrow(/Send "resource_url" as|does not accept/)
    }
  })

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
      suggested_arguments: Record<string, unknown>
      tool_arguments: Record<string, unknown>
    }>>(
      await handlers().haven_discover_tools({}),
    )

    expect(result.data[0].price_is_indicative).toBe(true)
    expect(result.data[0].price_atomic).toBe('10000')
    // #1547 pointed MCP entries at the GUIDED preflight rather than the manual
    // tool; #3100 points them one step earlier, at the cap-free catalog quote
    // (prepare REQUIRES a cap the server must never invent, so a verbatim
    // hint for it cannot exist) — still the guided path, never the manual tool.
    expect(result.data[0].suggested_tool).toBe('haven_quote_catalog_purchase')
    expect(result.data[0].suggested_arguments).toEqual({ catalog_id: 'cat_1' })
    expect(result.data[0].tool_arguments).toEqual({ prompt: 'hello' })
  })

  it('carries the merchant wire-shaped when the backend sends one, and omits it when it does not (#3078)', async () => {
    const base = {
      id: 'cat_1', name: 'fact', description: 'One fact', category: 'api',
      resource_url: 'https://services.sandbox.ampersend.ai/api/fact', rail: 'x402', protocol: 'http',
      tool_name: null, tool_arguments: null, price_display: '0.001 USDC', price_atomic: '1000',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', network: 'eip155:84532', status: 'active',
      verified_at: null, source: 'operator', domain_verified: false, verified_payable: false,
    }
    stubFetch({
      'GET /catalog': {
        status: 200,
        body: {
          entries: [
            { ...base, merchant: { id: 'm_1', slug: 'ampersend-demo-api', name: 'Ampersend Demo API', listing_status: 'live', is_test_merchant: false } },
            { ...base, id: 'cat_2', merchant: { id: 'm_2', slug: 'haven-demo-store', name: 'Haven demo store', listing_status: 'live', is_test_merchant: true } },
            { ...base, id: 'cat_3' },
          ],
        },
      },
    })
    const result = ok<Array<Record<string, unknown>>>(await handlers().haven_discover_tools({}))
    expect(result.data[0].merchant).toEqual({
      id: 'm_1', slug: 'ampersend-demo-api', name: 'Ampersend Demo API', listing_status: 'live', is_test_merchant: false,
    })
    // The structural signal for skipping Haven's own test content rides along.
    expect((result.data[1].merchant as { is_test_merchant: boolean }).is_test_merchant).toBe(true)
    // An older backend sends none: the key is absent, never null.
    expect('merchant' in result.data[2]).toBe(false)
  })

  it('forwards case-insensitive category/search filters as one read-only GET', async () => {
    stubFetch({
      'GET /catalog': { status: 200, body: { entries: [] } },
    })

    await handlers().haven_discover_tools({ category: 'VPN', search: 'NordShield' })
    expect(recordedCalls()[0]?.url).toBe('http://haven.test/catalog?category=VPN&search=NordShield')
    expect(recordedCalls()).toHaveLength(1)
  })

  it('preserves blank search terms so hosted MCP matches the backend contract', async () => {
    stubFetch({
      'GET /catalog': { status: 200, body: { entries: [] } },
    })

    await handlers().haven_discover_tools({ search: '' })
    expect(recordedCalls()[0]?.url).toBe('http://haven.test/catalog?search=')
    expect(recordedCalls()).toHaveLength(1)
  })

  it('returns no prospect even with HAVEN_MARKETPLACE_PROSPECTS on: it reads GET /catalog only, never GET /merchants (#3080)', async () => {
    // Prospects have zero offers by construction, so they never appear in
    // `GET /catalog` regardless of the flag — the merchants route is the only
    // listing surface for them, and this tool has no reason to call it. The
    // fixture below is what `GET /catalog` returns on a dev deployment with
    // the flag on: real offers only, `berget-ai` and `redpine` absent.
    stubFetch({
      'GET /catalog': {
        status: 200,
        body: {
          entries: [
            {
              id: 'cat_1', name: 'Ampersend — fact', description: 'One fact', category: 'api',
              resource_url: 'https://services.sandbox.ampersend.ai/api/fact', rail: 'x402', protocol: 'http',
              tool_name: null, tool_arguments: null, price_display: '0.001 USDC', price_atomic: '1000',
              asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', network: 'eip155:84532', status: 'active',
              verified_at: null,
              merchant: { id: 'm_amp', slug: 'ampersend-demo-api', name: 'Ampersend Demo API', listing_status: 'live', is_test_merchant: false },
            },
          ],
        },
      },
    })

    const result = ok<Array<{ merchant?: { slug: string } }>>(await handlers().haven_discover_tools({}))

    expect(result.data.map((e) => e.merchant?.slug)).toEqual(['ampersend-demo-api'])
    expect(result.data.some((e) => e.merchant?.slug === 'berget-ai' || e.merchant?.slug === 'redpine')).toBe(false)
    // The one call this tool ever makes is GET /catalog; it never touches
    // /merchants, so a prospect could not reach it even if the fixture leaked one.
    expect(recordedCalls()).toHaveLength(1)
    expect(recordedCalls()[0]?.url).toMatch(/^http:\/\/haven\.test\/catalog(\?|$)/)
    expect(recordedCalls().some((call) => call.url.includes('/merchants'))).toBe(false)
  })
})

// ── haven_quote_mcp_tool ─────────────────────────────────────────────────────


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
      // #2349: this call used to carry `max_amount: '2000000'`, which the
      // quote tool has never declared — the #2312 `tools.test.ts:2399` shape
      // again (a cap certified by a test while being discarded). The tool now
      // refuses it, and the assertions below never depended on it.
      await handlers().haven_quote_mcp_tool({
        merchant_url: 'http://merchant.test/mcp',
        tool_name: 'create_text',
        arguments: { prompt: 'Hello' },
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
    expect(recordedCalls().find((call) => new URL(call.url).pathname.endsWith('/x402'))).toBeUndefined()
    // The MCP lifecycle needs the existing public delegate address for
    // x402-wallet. It must not read allowances, create an intent, or write.
    expect(recordedCalls().filter((call) => new URL(call.url).pathname.endsWith('/machine-payments/agent'))).toHaveLength(1)
    expect(recordedCalls().find((call) => new URL(call.url).pathname.includes('/machine-payments/budget-precheck'))).toBeUndefined()
  })
})


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
    expect(recordedCalls().find((call) => new URL(call.url).pathname.endsWith('/x402'))).toBeUndefined()
    expect(recordedCalls().filter((call) => new URL(call.url).pathname.endsWith('/machine-payments/agent'))).toHaveLength(1)
    expect(recordedCalls().find((call) => new URL(call.url).pathname.includes('/machine-payments/budget-precheck'))).toBeUndefined()
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
    expect(recordedCalls()).toHaveLength(1)
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

  // (allowancesFixture removed — #3054 replaced the GET allowances stub with a
  // POST /machine-payments/budget-precheck stub, which takes the bare wire
  // response body inline at each site: { sufficient, remaining_atomic,
  // remaining_is_from_chain? } on 200, or the taxonomy refusal body on 403.)

  const baseRoutes = {
    'GET /catalog/cat_1': { status: 200, body: CATALOG_ENTRY_RESPONSE },
    'POST /mcp': { status: 402, responseHeaders: { 'PAYMENT-REQUIRED': paymentRequiredHeader } },
    'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
  }

  it('success (legacy rail, sufficient allowance): loads catalog, quotes live, creates the intent, returns the compact ready-to-sign shape + catalog fields + allowance block', async () => {
    stubFetch({
      ...baseRoutes,
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /machine-payments/budget-precheck': { status: 200, body: { sufficient: true, remaining_atomic: '5000000' } },
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
      next_arguments: Record<string, unknown>
      warnings: Array<{ code: string }>
      // #2557: the next-step fields come from the PUBLISHED contract rather
      // than being restated here, so a field the SDK type forgets breaks this
      // test instead of quietly needing a cast — which is how #1588's and
      // #2550's fields both went missing.
    } & AgentNextStep>(await handlers().haven_prepare_catalog_purchase({ catalog_id: 'cat_1', max_amount: '2000000' }))

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
    expect(result.data.next_tool_server).toBe('haven-signer')
    expect(result.data.next_tool_name).toBe('haven_sign_x402')
    expect(result.data.next_arguments).toEqual({ payment_id: X402_INTENT_RESPONSE.payment_id })
    // Catalog price matched the live quote — no CATALOG_PRICE_DIFFERS warning.
    expect(result.data.warnings.some((w) => w.code === 'CATALOG_PRICE_DIFFERS')).toBe(false)

    // The catalog entry's OWN tool_arguments were what got quoted and funded.
    const intentCall = recordedCalls().find((c) => c.url.endsWith('/x402'))
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
      'POST /machine-payments/budget-precheck': { status: 200, body: { sufficient: true, remaining_atomic: '5000000', remaining_is_from_chain: true } },
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
    expect(recordedCalls().find((c) => c.url.endsWith('/x402'))).toBeDefined()
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
    expect(recordedCalls()).toHaveLength(1)
  })

  it('rejects with PRICE_EXCEEDS_MAX before any funding intent when the live price exceeds max_amount', async () => {
    stubFetch({
      ...baseRoutes,
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /machine-payments/budget-precheck': { status: 200, body: { sufficient: true, remaining_atomic: '5000000' } },
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
    // #2975: the refusal is machine-readable, not prose-only — the agent must
    // stop and confirm the higher amount, then re-quote before retrying.
    expect(payload.next_action).toBe(AgentPaymentNextAction.StopAndTellUser)
    expect(payload.retry_with_new_quote).toBe(true)
    // The MCP lifecycle reads the public delegate address before quoting, but
    // the cap guard still fires before any funding intent is constructed.
    expect(recordedCalls().find((c) => c.url.endsWith('/x402'))).toBeUndefined()
  })

  it('refuses without max_amount — no cap_warning softness on the guided path', async () => {
    stubFetch({})
    const payload = await handlers().haven_prepare_catalog_purchase({ catalog_id: 'cat_1' })
    expect(payload.success).toBe(false)
    if (payload.success) throw new Error('expected failure')
    expect(payload.code).toBe('INVALID_INPUT')
    // Schema validation runs before any network call.
    expect(recordedCalls()).toHaveLength(0)
  })

  // #2259 re-based this test rather than deleting it. Its OLD framing —
  // "legacy rail: insufficient allowance still proceeds … queues for approval"
  // — asserts something unreachable: the legacy rail answers 410 at every
  // payment entry point since #1986, so `POST /x402` cannot return 202
  // `pending_approval` for a fresh intent on any rail.
  //
  // What IS reachable, and what the branch under test exists for, is a STORED
  // row from before the retirement echoed back by the backend. `isPendingApproval`
  // (tools.ts) documents that retention decision under #2101 and it still
  // holds: the branch is fail-CLOSED — it stops with the payment_id and NO
  // signable payload rather than falling through to a merchant header for
  // funding that never confirmed. Deleting it would trade a defined stop for
  // an undefined fall-through on exactly those rows, which epic #1440
  // deliberately does not delete (see its deferred row-deletion decision).
  //
  // So this test keeps the guided-catalog pass-through coverage — the only
  // exercise it has — and drops the false claim about how the status arises.
  it('passes a stored pending_approval intent through as a defined stop, with no signable payload', async () => {
    stubFetch({
      ...baseRoutes,
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /machine-payments/budget-precheck': { status: 200, body: { sufficient: true, remaining_atomic: '7500' } },
      // A pre-retirement row, echoed back — not a queue this rail could create.
      'POST /x402': { status: 202, body: { payment_id: 'over_1', status: 'pending_approval' } },
    })

    const result = ok<{ status: string; payload_hash: unknown }>(
      await handlers().haven_prepare_catalog_purchase({ catalog_id: 'cat_1', max_amount: '2000000' }),
    )

    expect(result.data.status).toBe('pending_approval')
    // The fail-closed half: a status the agent can act on, and nothing to sign.
    expect(result.data.payload_hash).toBeNull()
    expect(recordedCalls().find((c) => c.url.endsWith('/x402'))).toBeDefined()
  })

  it('delegation rail: over-budget REFUSES at prepare — the decision is Haven\'s (precheck 403), no approval queue exists on this rail', async () => {
    stubFetch({
      ...baseRoutes,
      'GET /machine-payments/agent': { status: 200, body: DELEGATION_AGENT_RESPONSE },
      'POST /machine-payments/budget-precheck': {
        status: 403,
        body: {
          error: 'This payment of 1.5 USDC exceeds the agent\'s remaining budget for this period (0.0001 USDC, short by 1.4999 USDC). There is no approval queue on the delegation rail — an over-budget redemption reverts on-chain. Ask the wallet owner to grant or raise the budget in Haven, then retry.',
          error_code: 'delegation_budget_exceeded',
          phase: 'insufficient_funds',
          next_action: 'fund_safe_or_raise_allowance',
          remaining_atomic: '100',
          amount_atomic: '1500000',
        },
      },
    })

    const payload = await handlers().haven_prepare_catalog_purchase({
      catalog_id: 'cat_1',
      max_amount: '2000000',
    })

    expect(payload.success).toBe(false)
    if (payload.success) throw new Error('expected failure')
    expect(payload.code).toBe('DELEGATION_BUDGET_EXCEEDED')
    expect(payload.next_action).toBe(AgentPaymentNextAction.FundAccountOrRaiseAllowance)
    // Mutation-tested ordering: no funding intent was created — the refusal
    // fires before createX402Intent, unlike the legacy queue-and-proceed path.
    expect(recordedCalls().find((c) => c.url.endsWith('/x402'))).toBeUndefined()
    // #3054 characterization: the relay is byte-identical to the refusal the
    // local compare used to throw — same code, same message shape (the
    // selected option's amount against the remaining the SERVER reported),
    // same next_action, same suggested tool.
    expect(payload.message).toBe(
      'The amount this purchase would authorize (1500000 USDC atomic) ' +
        "exceeds the agent's remaining active delegation budget " +
        '(100 USDC atomic). ' +
        'There is no approval queue — an over-budget redemption would revert ' +
        'on-chain. Ask the wallet owner to grant or raise the budget in Haven before retrying.',
    )
    expect(payload.suggested_tool).toBe('haven_get_allowances')
  })

  it('sends the server the quote facts it needs: the SELECTED option asset/amount, the merchant payTo, and the bought resource URL (#3054)', async () => {
    stubFetch({
      ...baseRoutes,
      'GET /machine-payments/agent': { status: 200, body: DELEGATION_AGENT_RESPONSE },
      'POST /machine-payments/budget-precheck': { status: 200, body: { sufficient: true, remaining_atomic: '5000000' } },
    })

    ok(await handlers().haven_prepare_catalog_purchase({ catalog_id: 'cat_1', max_amount: '2000000' }))

    const precheck = recordedCalls().find((c) => new URL(c.url).pathname.endsWith('/machine-payments/budget-precheck'))
    expect(precheck).toBeDefined()
    expect(precheck?.method).toBe('POST')
    // `resourceUrl` is the merchant resource being bought — the dedupe
    // window's discriminating column — never the allowances read's URL or
    // this endpoint's own. `token`/`amountAtomic` are the SELECTED option's
    // (#2051); `merchantTo` is advisory metadata for the ledger row.
    expect(precheck?.body).toMatchObject({
      token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      amountAtomic: '1500000',
      merchantTo: PAYMENT_REQUIRED.accepts[0].payTo,
      resourceUrl: 'http://merchant.test/mcp',
    })
    // The allowances GET is GONE — one budget read, now this POST (#1348).
    expect(recordedCalls().find((c) => c.method === 'GET' && new URL(c.url).pathname.endsWith('/machine-payments/allowances'))).toBeUndefined()
  })

  it('a non-budget 403 from the pre-check is NOT a refusal — it degrades to sufficient: null with a warning (#3054)', async () => {
    stubFetch({
      ...baseRoutes,
      'GET /machine-payments/agent': { status: 200, body: DELEGATION_AGENT_RESPONSE },
      'POST /machine-payments/budget-precheck': {
        status: 403,
        body: { error: 'agent_paused', error_code: 'agent_paused' },
      },
    })

    const result = ok<{
      allowance: { rail: string; sufficient: boolean | null; source: string }
      warnings: Array<{ code: string }>
    }>(await handlers().haven_prepare_catalog_purchase({ catalog_id: 'cat_1', max_amount: '2000000' }))

    // Only the DECIDED delegation_budget_exceeded refusal stops the purchase;
    // any other status/body degrades — the precheck can never become a
    // refusal the server did not decide.
    expect(result.data.allowance).toEqual({ rail: 'delegation', sufficient: null, source: 'active_delegations' })
    expect(result.data.warnings.some((w) => w.code === 'ALLOWANCE_CHECK_UNAVAILABLE')).toBe(true)
    expect(recordedCalls().find((c) => c.url.endsWith('/x402'))).toBeDefined()
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
    expect(recordedCalls()).toHaveLength(1)
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
      'POST /machine-payments/budget-precheck': { status: 200, body: { sufficient: true, remaining_atomic: '5000000' } },
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
      'POST /machine-payments/budget-precheck': { status: 502, body: { error: 'Failed to read on-chain allowance' } },
    })

    const result = ok<{
      allowance: { rail: string; sufficient: boolean | null; source: string }
      warnings: Array<{ code: string }>
    }>(await handlers().haven_prepare_catalog_purchase({ catalog_id: 'cat_1', max_amount: '2000000' }))

    expect(result.data.allowance).toEqual({ rail: 'legacy', sufficient: null, source: 'allowance_module' })
    expect(result.data.warnings.some((w) => w.code === 'ALLOWANCE_CHECK_UNAVAILABLE')).toBe(true)
    // A failed read never fails the preflight — the intent was still created.
    expect(recordedCalls().find((c) => c.url.endsWith('/x402'))).toBeDefined()
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
      'POST /machine-payments/budget-precheck': { status: 502, body: { error: 'Failed to read on-chain allowance' } },
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
    expect(recordedCalls().find((c) => c.url.endsWith('/x402'))).toBeDefined()
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
    expect(recordedCalls().find((c) => c.url.endsWith('/x402'))).toBeUndefined()
  })

  // ── #1348: round-trip budget — the characterization the issue asked for ────
  // These counts ARE the regression gate: wall-clock is machine-dependent, but
  // the number of sequential Haven round trips is deterministic. Before #1348
  // a successful preflight made FIVE Haven recordedCalls() (catalog, agent, allowances,
  // agent AGAIN inside createX402Intent, POST /x402); now it makes four, and
  // the agent/allowance reads overlap the merchant probe instead of following
  // it.
  it('ROUND-TRIP BUDGET: a successful preflight makes exactly one call per Haven surface — no duplicate agent fetch (#1348)', async () => {
    stubFetch({
      ...baseRoutes,
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /machine-payments/budget-precheck': { status: 200, body: { sufficient: true, remaining_atomic: '5000000' } },
    })

    ok(await handlers().haven_prepare_catalog_purchase({ catalog_id: 'cat_1', max_amount: '2000000' }))

    const byPath = (suffix: string) => recordedCalls().filter((c) => new URL(c.url).pathname.endsWith(suffix)).length
    expect(byPath('/catalog/cat_1')).toBe(1)
    // The mutation this guards: dropping the delegateAddress pass-through to
    // createX402Intent silently re-adds its internal agent fetch → 2.
    expect(byPath('/machine-payments/agent')).toBe(1)
    expect(byPath('/machine-payments/budget-precheck')).toBe(1)
    expect(byPath('/x402')).toBe(1)
    // #1360: the funding-leg intent DECLARES its scheme, so a stale delegate
    // address fails the backend's shape cross-check loudly.
    const intentPost = recordedCalls().find((c) => new URL(c.url).pathname.endsWith('/x402'))!
    expect(intentPost.body).toMatchObject({ settlementScheme: 'eip3009' })
  })

  it('ROUND-TRIP BUDGET: the agent read is dispatched before the merchant probe resolves; the budget pre-check rides the SAME round-trip count the allowances read used (#1348, #3054)', async () => {
    stubFetch({
      ...baseRoutes,
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /machine-payments/budget-precheck': { status: 200, body: { sufficient: true, remaining_atomic: '5000000' } },
    })

    ok(await handlers().haven_prepare_catalog_purchase({ catalog_id: 'cat_1', max_amount: '2000000' }))

    // The AGENT read is dispatched before the merchant's tools/call 402 probe
    // response could have been consumed — dispatched during the probe, not
    // after it. The merchant POSTs (initialize/notify/tools-call) and the
    // Haven agent GET interleave; asserting the GET precedes the LAST
    // merchant POST proves the overlap without depending on scheduler timing.
    // #3054: the budget pre-check deliberately does NOT overlap — it is a
    // single POST that can only be issued once the SELECTED option's
    // asset/amount are known (#2051), so it runs after the quote. The
    // round-trip COUNT is the guarantee that survives: one Haven budget read
    // (now POST budget-precheck, formerly GET allowances) exactly as before,
    // so the refusal path gains none.
    const lastMerchantPost = recordedCalls().map((c, i) => ({ c, i })).filter(({ c }) => c.method === 'POST' && new URL(c.url).pathname === '/mcp').at(-1)!.i
    const agentIdx = recordedCalls().findIndex((c) => new URL(c.url).pathname.endsWith('/machine-payments/agent'))
    expect(agentIdx).toBeGreaterThan(-1)
    expect(agentIdx).toBeLessThan(lastMerchantPost)
    expect(recordedCalls().filter((c) => new URL(c.url).pathname.endsWith('/machine-payments/budget-precheck'))).toHaveLength(1)
    expect(recordedCalls().find((c) => c.method === 'GET' && new URL(c.url).pathname.endsWith('/machine-payments/allowances'))).toBeUndefined()
  })

  it('FAILURE PRECEDENCE: when the merchant probe AND the agent read both fail, the quote error wins deterministically (#1348)', async () => {
    stubFetch({
      'GET /catalog/cat_1': { status: 200, body: CATALOG_ENTRY_RESPONSE },
      'POST /mcp': { status: 500, body: {} },
      'GET /machine-payments/agent': { status: 500, body: { error: 'agent boom' } },
      'POST /machine-payments/budget-precheck': { status: 500, body: { error: 'allowance boom' } },
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
    expect(recordedCalls().find((c) => new URL(c.url).pathname.endsWith('/x402'))).toBeUndefined()
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
      'POST /machine-payments/budget-precheck': {
        status: 200,
        body: { sufficient: true, remaining_atomic: '5000000', remaining_is_from_chain: false },
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
    expect(recordedCalls().find((c) => c.url.endsWith('/x402'))).toBeDefined()
  })

  it('delegation rail: does NOT warn ALLOWANCE_READ_OPTIMISTIC when the reported remaining came from a live chain read', async () => {
    stubFetch({
      ...baseRoutes,
      'GET /machine-payments/agent': { status: 200, body: DELEGATION_AGENT_RESPONSE },
      'POST /machine-payments/budget-precheck': {
        status: 200,
        body: { sufficient: true, remaining_atomic: '5000000', remaining_is_from_chain: true },
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
      'POST /machine-payments/budget-precheck': { status: 200, body: { sufficient: true, remaining_atomic: '5000000' } },
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
      'POST /machine-payments/budget-precheck': { status: 200, body: { sufficient: true, remaining_atomic: '5000000' } },
    })

    ok(
      await handlers().haven_prepare_catalog_purchase({
        catalog_id: 'cat_1',
        max_amount: '2000000',
        idempotency_key: 'catalog-purchase-key-1',
      }),
    )

    const intentCall = recordedCalls().find((c) => c.url.endsWith('/x402'))
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
      const raw = recordedCalls().find((c) => new URL(c.url).pathname === '/x402')!.body
      return (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, any>
    }

    async function prepare(header: string, agent: Record<string, unknown>, expectErc7710 = false) {
      stubFetch({
        'GET /catalog/cat_1': { status: 200, body: CATALOG_ENTRY_RESPONSE },
        'POST /mcp': { status: 402, responseHeaders: { 'PAYMENT-REQUIRED': header } },
        'POST /x402': { status: 201, body: expectErc7710 ? CHILD : X402_INTENT_RESPONSE },
        'GET /machine-payments/agent': { status: 200, body: agent },
        'POST /machine-payments/budget-precheck': {
          status: 200,
          body: { sufficient: true, remaining_atomic: '5000000' },
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
      expect(res.data.next_tool_server).toBe('haven-signer')
      expect(res.data.next_tool_name).toBe('haven_sign')
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

    // #3042 (scan B2): the catalog branch dropped the key too — live on dev,
    // `haven_prepare_catalog_purchase` twice with the same explicit key gave
    // `6866bc97…` and `9835d550…`, both pending_signature. See the
    // haven_pay_mcp_tool twin of this test for the mechanism.
    it('sends the caller idempotency_key on the erc7710 authorize (#3042)', async () => {
      stubFetch({
        'GET /catalog/cat_1': { status: 200, body: CATALOG_ENTRY_RESPONSE },
        'POST /mcp': { status: 402, responseHeaders: { 'PAYMENT-REQUIRED': erc7710Header } },
        'POST /x402': { status: 201, body: CHILD },
        'GET /machine-payments/agent': { status: 200, body: DELEGATION_AGENT_RESPONSE },
        'POST /machine-payments/budget-precheck': { status: 200, body: { sufficient: true, remaining_atomic: '5000000', remaining_is_from_chain: true } },
      })
      const res = ok<Record<string, any>>(
        await handlers().haven_prepare_catalog_purchase({
          catalog_id: 'cat_1',
          max_amount: '2000000',
          idempotency_key: 'catalog-7710-key-1',
        }),
      )
      expect(res.data.settlement_scheme).toBe('erc7710')
      expect(xBody().idempotencyKey).toBe('catalog-7710-key-1')
    })

    it('sends NO idempotencyKey on the erc7710 authorize when the caller gave none (#3042 review)', async () => {
      const res = await prepare(erc7710Header, DELEGATION_AGENT_RESPONSE, true)
      expect(res.data.settlement_scheme).toBe('erc7710')
      expect(xBody()).not.toHaveProperty('idempotencyKey')
    })

    it('a LEGACY-rail account never takes the branch, even when the merchant offers it', async () => {
      const res = await prepare(erc7710Header, AGENT_RESPONSE)
      expect(res.data.settlement_scheme).toBeUndefined()
      expect(res.data.next_tool).toBe('mcp__haven-signer__haven_sign_x402')
      expect(res.data.next_tool_server).toBe('haven-signer')
      expect(res.data.next_tool_name).toBe('haven_sign_x402')
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
        'POST /machine-payments/budget-precheck': {
          status: 200,
          body: { sufficient: true, remaining_atomic: '5000000' },
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

// ── merchant MCP endpoint discovery (#1271) ──────────────────────────────────


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
    expect(recordedCalls().find((call) => new URL(call.url).pathname.endsWith('/x402'))).toBeUndefined()
    expect(recordedCalls().find((call) => new URL(call.url).pathname.includes('/allowances'))).toBeUndefined()
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
    const lifecycle = recordedCalls().filter((call) => call.url === 'http://merchant.test/v1')
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
    expect(recordedCalls().filter((call) => call.url === 'http://merchant.test/v1').map((call) => call.body?.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
    ])
    expect(recordedCalls().some((call) => call.url.includes('.well-known'))).toBe(false)
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
    expect(recordedCalls().some((c) => String(c.url).includes('.well-known'))).toBe(false)
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
    expect(recordedCalls().some((c) => String(c.url).includes('evil.example'))).toBe(false)
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
    const fetched = recordedCalls().map((c) => String(c.url))
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
    expect(recordedCalls().filter((c) => c.method === 'POST').length).toBe(1)
  })
})

// ── hosted erc7710 rail fallback (#1456 review) ───────────────────────────────


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
    const raw = recordedCalls().find((c) => new URL(c.url).pathname === '/x402')!.body
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
    const authorize = recordedCalls().find((c) => new URL(c.url).pathname === '/x402')
    if (authorize) {
      const raw = authorize.body
      const body = typeof raw === 'string' ? JSON.parse(raw) : (raw as Record<string, unknown>)
      expect(body.settlementScheme).not.toBe('erc7710')
    }
    // Whatever else happened, no settlement child was requested.
    expect(recordedCalls().find((c) => new URL(c.url).pathname.endsWith('/settle'))).toBeUndefined()
  })
})

/**
 * #1469 — a null hole in agent-supplied accepts[] gets the clean refusal,
 * not a 500. The Zod schema only guarantees a string-keyed record; the raw
 * cast this fixes let the hole reach the selectors and throw.
 */

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
        // #2978: an active operator row with verified_at set now carries the
        // badge, so this fixture models the shape that stays UNbadged — a
        // degraded operator row — rather than one the backend can no longer emit.
        status: 'degraded',
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

  it('verified=verified returns a probe-verified operator entry at the hosted boundary (#2978)', async () => {
    const probedOperator = {
      ...(directoryFixture.entries[1] as Record<string, unknown>),
      id: 'cat_cur_probed',
      status: 'active',
      verified_payable: true,
    }
    stubFetch({
      'GET /catalog': { status: 200, body: { entries: [...directoryFixture.entries, probedOperator] } },
    })

    const verified = ok<Array<Record<string, unknown>>>(
      await handlers().haven_discover_tools({ verified: 'verified' }),
    )
    // The badge decides, not provenance: the probed operator row is in, the
    // degraded one is out.
    expect(verified.data.map((e) => e.id).sort()).toEqual(['cat_cur_probed', 'cat_dir_1'])
    expect(verified.data.find((e) => e.id === 'cat_cur_probed')).toMatchObject({
      source: 'operator',
      domain_verified: false,
      verified_payable: true,
    })
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
    const call = recordedCalls().find((c) => c.method === 'POST' && c.url.includes('/catalog/submit'))
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

describe('#2051 — cap binds the authorized option', () => {
  const FACILITATORS = ['0x4444444444444444444444444444444444444444']
  const DELEGATION_AGENT = { ...AGENT_RESPONSE, execution_rail: 'delegation' }
  const LEGACY_AGENT = { ...AGENT_RESPONSE, execution_rail: 'legacy' }
  const CHILD = {
    payment_id: 'pay_7710',
    status: 'pending_signature',
    sign_data: {
      hash: '0x' + '11'.repeat(32),
      signature_scheme: 'eip712_delegation',
      typed_data: { domain: {}, types: {}, primaryType: 'Delegation', message: { caveats: [] } },
    },
  }

  /** Two payable Base-USDC entries that differ in amount and in the erc7710 tag. */
  function merchant(standardAtomic: string, erc7710Atomic: string | null) {
    const base = PAYMENT_REQUIRED.accepts[0]
    return {
      ...PAYMENT_REQUIRED,
      accepts: [
        { ...base, amount: standardAtomic, maxAmountRequired: standardAtomic },
        ...(erc7710Atomic === null
          ? []
          : [
              {
                ...base,
                amount: erc7710Atomic,
                maxAmountRequired: erc7710Atomic,
                extra: { assetTransferMethod: 'erc7710', facilitatorAddresses: FACILITATORS },
              },
            ]),
      ],
    }
  }

  /** The authorize request body — assert on what was SENT, never on call counts. */
  function x402Body() {
    const call = recordedCalls().find((c) => new URL(c.url).pathname === '/x402')
    if (!call) return undefined
    const raw = call.body
    return (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, any>
  }

  const CATALOG_ENTRY = {
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

  // (allowances fixture removed — #3054 replaced the GET allowances stub with
  // a POST /machine-payments/budget-precheck stub, which takes the bare wire
  // response body inline at each site.)

  describe('haven_pay_mcp_tool', () => {
    async function pay(
      pr: unknown,
      agent: Record<string, unknown>,
      cap: Record<string, string>,
      erc7710Intent = false,
    ) {
      stubFetch({
        'POST /mcp': {
          status: 402,
          responseHeaders: { 'PAYMENT-REQUIRED': btoa(JSON.stringify(pr)) },
        },
        'GET /machine-payments/agent': { status: 200, body: agent },
        'POST /x402': { status: 201, body: erc7710Intent ? CHILD : X402_INTENT_RESPONSE },
      })
      return handlers().haven_pay_mcp_tool({
        merchant_url: 'http://merchant.test/mcp',
        tool_name: 'create_text',
        arguments: { prompt: 'Hello' },
        ...cap,
      })
    }

    it('THE EXPLOIT: refuses an over-cap erc7710 entry advertised beside an under-cap standard entry', async () => {
      // 1 USDC standard (passes the cap) + 900 USDC erc7710 (the one actually sent).
      // erc7710Intent: true — the merchant/backend stubs are the SUCCESSFUL
      // ones, so an unfixed build does not merely error here, it SUCCEEDS at
      // 900000000 with the response reporting 1000000. The refusal below is
      // therefore the fix's doing and nothing else's.
      const res = await pay(
        merchant('1000000', '900000000'),
        DELEGATION_AGENT,
        { max_amount_human: '1' },
        true,
      )
      expect(res.success).toBe(false)
      expect((res as { code?: string }).code).toBe('PRICE_EXCEEDS_MAX')
      // Refused BEFORE the authorize: no settlement child was ever minted.
      expect(x402Body()).toBeUndefined()
    })

    it('THE MIRROR: allows a cheap erc7710 entry advertised beside an over-cap standard entry', async () => {
      // 3 USDC standard (over the 1 USDC cap) + 0.50 USDC erc7710 (what is sent).
      // Refusing here would cite an amount that was never going to be authorized.
      const res = ok<Record<string, any>>(
        await pay(merchant('3000000', '500000'), DELEGATION_AGENT, { max_amount_human: '1' }, true),
      )
      expect(res.data.settlement_scheme).toBe('erc7710')
      expect(x402Body()?.amount).toBe('500000')
      expect(x402Body()?.settlementScheme).toBe('erc7710')
    })

    /**
     * #3042 (scan B2, measured live on dev 2026-09-16): four prepares, two
     * of them with the SAME explicit key, minted four erc7710 settlement
     * children — this branch never passed `idempotency_key` to the authorize,
     * while its 3009 sibling always did and the backend has deduped on the
     * key all along (`findX402IntentByIdempotencyKey` before the shape
     * branch). On this scheme the signed child IS spend authority, so a
     * retried prepare + sign is a second payment. Pinned per branch: dropping
     * the key from this branch reddens THIS test and leaves the catalog one
     * (below) green, so the failure names the branch.
     */
    it('sends the caller idempotency_key on the erc7710 authorize, so a retry replays instead of minting a second child (#3042)', async () => {
      stubFetch({
        'POST /mcp': {
          status: 402,
          responseHeaders: { 'PAYMENT-REQUIRED': btoa(JSON.stringify(merchant('3000000', '500000'))) },
        },
        'GET /machine-payments/agent': { status: 200, body: DELEGATION_AGENT },
        'POST /x402': { status: 201, body: CHILD },
      })
      const res = ok<Record<string, any>>(
        await handlers().haven_pay_mcp_tool({
          merchant_url: 'http://merchant.test/mcp',
          tool_name: 'create_text',
          arguments: { prompt: 'Hello' },
          max_amount_human: '1',
          idempotency_key: 'x402:pay-mcp-7710:k1',
        }),
      )
      expect(res.data.settlement_scheme).toBe('erc7710')
      expect(x402Body()?.idempotencyKey).toBe('x402:pay-mcp-7710:k1')
    })

    // Review of #3043: `quote.idempotencyKey` is NEVER null on the MCP quote
    // path (the SDK derives a 5-minute-bucket key), so the 3009 branches'
    // `?? quote.idempotencyKey` would have switched bucket-dedupe on for
    // every unkeyed erc7710 call. Pinned: no key in → no key on the wire.
    it('sends NO idempotencyKey on the erc7710 authorize when the caller gave none (#3042 review)', async () => {
      const res = ok<Record<string, any>>(
        await pay(merchant('3000000', '500000'), DELEGATION_AGENT, { max_amount_human: '1' }, true),
      )
      expect(res.data.settlement_scheme).toBe('erc7710')
      expect(x402Body()).not.toHaveProperty('idempotencyKey')
    })

    it('reports amount_atomic as the amount ACTUALLY authorized on the erc7710 branch', async () => {
      const res = ok<Record<string, any>>(
        await pay(merchant('1000000', '2500000'), DELEGATION_AGENT, { max_amount_human: '5' }, true),
      )
      expect(x402Body()?.amount).toBe('2500000')
      expect(res.data.amount_atomic).toBe('2500000')
      expect(res.data.amount).toBe('2.5')
      // agent_summary is what an agent surfaces to the user and logs as its
      // receipt. The first mutation sweep found it UNPINNED — reverting it
      // alone to `quote.amountAtomic` survived a green suite, which is the
      // same "invisible to the tests" property the whole defect had.
      expect(res.data.agent_summary).toMatchObject({
        amount_atomic: '2500000',
        amount: '2.5',
        token: 'USDC',
      })
    })

    it('reports amount_atomic as the amount ACTUALLY authorized on the 3009 branch', async () => {
      const res = ok<Record<string, any>>(
        await pay(merchant('1000000', '2500000'), LEGACY_AGENT, { max_amount_human: '5' }),
      )
      expect(res.data.settlement_scheme).toBeUndefined()
      expect(x402Body()?.settlementScheme).toBe('eip3009')
      expect(x402Body()?.amount).toBe('1000000')
    })

    it('the same fixture still REFUSES on a legacy account, where the expensive entry IS the authorized one', async () => {
      // The mirror test must not be read as "3 USDC is always fine now". On a
      // legacy-rail account the erc7710 entry is unreachable, the 3 USDC
      // standard entry is what would be authorized, and the cap must bite.
      const res = await pay(merchant('3000000', '500000'), LEGACY_AGENT, { max_amount_human: '1' })
      expect(res.success).toBe(false)
      expect((res as { code?: string }).code).toBe('PRICE_EXCEEDS_MAX')
      expect(x402Body()).toBeUndefined()
    })

    it('positive control: an in-cap erc7710 payment still succeeds', async () => {
      const res = ok<Record<string, any>>(
        await pay(merchant('1000000', '900000'), DELEGATION_AGENT, { max_amount_human: '1' }, true),
      )
      expect(res.data.settlement_scheme).toBe('erc7710')
      expect(x402Body()?.amount).toBe('900000')
    })

    it('positive control: a 3009-only merchant still bridges on a delegation account', async () => {
      const res = ok<Record<string, any>>(
        await pay(merchant('1000000', null), DELEGATION_AGENT, { max_amount_human: '2' }),
      )
      expect(res.data.settlement_scheme).toBeUndefined()
      expect(x402Body()?.settlementScheme).toBe('eip3009')
      expect(x402Body()?.amount).toBe('1000000')
    })

    it('positive control: an UNCAPPED call is still refused before any network call', async () => {
      const res = await pay(merchant('1000000', '900000000'), DELEGATION_AGENT, {})
      expect(res.success).toBe(false)
      expect((res as { code?: string }).code).toBe('INVALID_INPUT')
      expect(recordedCalls()).toHaveLength(0)
    })
  })

  describe('haven_prepare_catalog_purchase', () => {
    async function prepare(
      pr: unknown,
      agent: Record<string, unknown>,
      cap: Record<string, string>,
      opts: { erc7710Intent?: boolean; remaining?: string; precheckStatus?: number; precheckBody?: Record<string, unknown> } = {},
    ) {
      stubFetch({
        'GET /catalog/cat_1': { status: 200, body: CATALOG_ENTRY },
        'POST /mcp': {
          status: 402,
          responseHeaders: { 'PAYMENT-REQUIRED': btoa(JSON.stringify(pr)) },
        },
        'POST /x402': { status: 201, body: opts.erc7710Intent ? CHILD : X402_INTENT_RESPONSE },
        'GET /machine-payments/agent': { status: 200, body: agent },
        'POST /machine-payments/budget-precheck': {
          status: opts.precheckStatus ?? 200,
          body:
            opts.precheckBody ??
            (opts.remaining !== undefined
              ? { sufficient: true, remaining_atomic: opts.remaining }
              : { sufficient: true, remaining_atomic: '5000000000' }),
        },
      })
      return handlers().haven_prepare_catalog_purchase({ catalog_id: 'cat_1', ...cap })
    }

    it('THE EXPLOIT: refuses an over-cap erc7710 entry advertised beside an under-cap standard entry', async () => {
      // erc7710Intent: true — see the sibling case: an unfixed build SUCCEEDS
      // here at 900000000 rather than erroring for an unrelated reason.
      const res = await prepare(
        merchant('1000000', '900000000'),
        DELEGATION_AGENT,
        { max_amount_human: '1' },
        { erc7710Intent: true },
      )
      expect(res.success).toBe(false)
      expect((res as { code?: string }).code).toBe('PRICE_EXCEEDS_MAX')
      expect(x402Body()).toBeUndefined()
    })

    it('THE MIRROR: allows a cheap erc7710 entry advertised beside an over-cap standard entry', async () => {
      const res = ok<Record<string, any>>(
        await prepare(merchant('3000000', '500000'), DELEGATION_AGENT, { max_amount_human: '1' }, {
          erc7710Intent: true,
        }),
      )
      expect(res.data.settlement_scheme).toBe('erc7710')
      expect(x402Body()?.amount).toBe('500000')
    })

    it('reports amount_atomic as the amount ACTUALLY authorized on the erc7710 branch', async () => {
      const res = ok<Record<string, any>>(
        await prepare(merchant('1000000', '2500000'), DELEGATION_AGENT, { max_amount_human: '5' }, {
          erc7710Intent: true,
        }),
      )
      expect(x402Body()?.amount).toBe('2500000')
      expect(res.data.amount_atomic).toBe('2500000')
      expect(res.data.amount).toBe('2.5')
      // agent_summary is what an agent surfaces to the user and logs as its
      // receipt. The first mutation sweep found it UNPINNED — reverting it
      // alone to `quote.amountAtomic` survived a green suite, which is the
      // same "invisible to the tests" property the whole defect had.
      expect(res.data.agent_summary).toMatchObject({
        amount_atomic: '2500000',
        amount: '2.5',
        token: 'USDC',
      })
    })

    it('the delegation BUDGET pre-check also reads the authorized option, not the cheap standard one', async () => {
      // Same steer, aimed at the other client-side guard on this path: a
      // 0.50 USDC standard entry would sail past a 1 USDC remaining budget
      // while the 900 USDC erc7710 entry is what gets authorized. #3054: the
      // server-side decision arrives as the pre-check's 403 — asked about the
      // 900 USDC erc7710 amount, not the cheap standard entry.
      const res = await prepare(
        merchant('500000', '900000000'),
        DELEGATION_AGENT,
        { max_amount_human: '1000' },
        {
          erc7710Intent: true,
          precheckStatus: 403,
          precheckBody: {
            error: 'over budget',
            error_code: 'delegation_budget_exceeded',
            phase: 'insufficient_funds',
            next_action: 'fund_safe_or_raise_allowance',
            remaining_atomic: '1000000',
            amount_atomic: '900000000',
          },
        },
      )
      expect(res.success).toBe(false)
      expect((res as { code?: string }).code).toBe('DELEGATION_BUDGET_EXCEEDED')
      expect(x402Body()).toBeUndefined()
    })

    it('positive control: an in-cap erc7710 purchase still succeeds, with the catalog fields kept', async () => {
      const res = ok<Record<string, any>>(
        await prepare(merchant('1000000', '900000'), DELEGATION_AGENT, { max_amount_human: '1' }, {
          erc7710Intent: true,
        }),
      )
      expect(res.data.settlement_scheme).toBe('erc7710')
      expect(res.data.catalog_id).toBe('cat_1')
      expect(res.data.allowance).toMatchObject({ rail: 'delegation', sufficient: true })
      expect(x402Body()?.amount).toBe('900000')
    })

    it('positive control: a 3009-only merchant still bridges on a delegation account', async () => {
      const res = ok<Record<string, any>>(
        await prepare(merchant('1000000', null), DELEGATION_AGENT, { max_amount_human: '2' }),
      )
      expect(res.data.settlement_scheme).toBeUndefined()
      expect(x402Body()?.settlementScheme).toBe('eip3009')
    })

    it('positive control: an UNCAPPED call is still refused before any network call', async () => {
      const res = await prepare(merchant('1000000', '900000000'), DELEGATION_AGENT, {})
      expect(res.success).toBe(false)
      expect((res as { code?: string }).code).toBe('INVALID_INPUT')
      expect(recordedCalls()).toHaveLength(0)
    })
  })
})

/**
 * #2054 — an erc7710-ONLY merchant is reachable through the two MCP purchase
 * tools, and unreachability is refused for the REAL reason.
 *
 * `buildX402Quote` was standard-anchored: it threw "no compatible payment
 * option" whenever `selectStandardPaymentOption` found nothing, so a merchant
 * advertising ONLY an erc7710-tagged entry — the PREFERRED scheme on the
 * delegation rail (#1450) — was refused before scheme selection ever saw it.
 * The quote now falls back to describing the erc7710 entry, and the tools
 * refuse a null scheme selection with the real reason (the ACCOUNT's rail)
 * instead of falling through to a message that blames the merchant.
 *
 * Fixture discipline (#2051's lesson): the erc7710-only entry carries
 * 2 500 000 — an amount NOTHING else in this file's default fixtures carries
 * (PAYMENT_REQUIRED's standard entry is 1 000 000 / 1 500 000, the catalog's
 * indicative price is 1 500 000) — so an assertion on it cannot be satisfied
 * by an inherited number.
 */
describe('#2054 — erc7710-only merchants', () => {
  const FACILITATOR = '0x4444444444444444444444444444444444444444'
  const ERC7710_ONLY_ATOMIC = '2500000' // 2.50 USDC — unique to this suite by design
  const DELEGATION_AGENT = { ...AGENT_RESPONSE, execution_rail: 'delegation' }
  const LEGACY_AGENT = { ...AGENT_RESPONSE, execution_rail: 'legacy' }

  /** A merchant advertising erc7710 and NOTHING else — no standard entry at all. */
  const ERC7710_ONLY_PR = {
    ...PAYMENT_REQUIRED,
    accepts: [
      {
        ...PAYMENT_REQUIRED.accepts[0],
        amount: ERC7710_ONLY_ATOMIC,
        maxAmountRequired: ERC7710_ONLY_ATOMIC,
        extra: { assetTransferMethod: 'erc7710', facilitatorAddresses: [FACILITATOR] },
      },
    ],
  }

  /** Negative control: one entry, payable by NEITHER selector (unknown asset). */
  const NOTHING_SETTLEABLE_PR = {
    ...PAYMENT_REQUIRED,
    accepts: [
      {
        ...PAYMENT_REQUIRED.accepts[0],
        asset: '0x0000000000000000000000000000000000000001',
      },
    ],
  }

  /**
   * #3116 — unique-amount fixtures for unsupported transfer methods and
   * payment flows (3100000 / 3200000 atomic: 3.10 / 3.20 USDC, numbers
   * nothing else in this file carries, so an assertion on them cannot be
   * satisfied by an inherited fixture value — #2051's lesson).
   */
  const PERMIT2_ONLY_ATOMIC = '3100000'
  const FLOW_ONLY_ATOMIC = '3200000'

  /** A merchant advertising ONLY a permit2 entry — not EIP-3009-constructible. */
  const PERMIT2_ONLY_PR = {
    ...PAYMENT_REQUIRED,
    accepts: [
      {
        ...PAYMENT_REQUIRED.accepts[0],
        amount: PERMIT2_ONLY_ATOMIC,
        maxAmountRequired: PERMIT2_ONLY_ATOMIC,
        extra: { name: 'USD Coin', version: '2', assetTransferMethod: 'permit2' },
      },
    ],
  }

  /** A merchant whose only entry names an unrecognized paymentFlow. */
  const FLOW_ONLY_PR = {
    ...PAYMENT_REQUIRED,
    accepts: [
      {
        ...PAYMENT_REQUIRED.accepts[0],
        amount: FLOW_ONLY_ATOMIC,
        maxAmountRequired: FLOW_ONLY_ATOMIC,
        extra: { name: 'USD Coin', version: '2', paymentFlow: 'unrecognized-future-flow' },
      },
    ],
  }

  /** Unsupported-first/supported-second: the plain entry behind must win. */
  const MIXED_PR = {
    ...PAYMENT_REQUIRED,
    accepts: [
      {
        ...PAYMENT_REQUIRED.accepts[0],
        amount: PERMIT2_ONLY_ATOMIC,
        maxAmountRequired: PERMIT2_ONLY_ATOMIC,
        extra: { name: 'USD Coin', version: '2', assetTransferMethod: 'permit2' },
      },
      { ...PAYMENT_REQUIRED.accepts[0] },
    ],
  }

  const CHILD = {
    payment_id: 'pay_7710_only',
    status: 'pending_signature',
    sign_data: {
      hash: '0x' + '22'.repeat(32),
      signature_scheme: 'eip712_delegation',
      typed_data: { domain: {}, types: {}, primaryType: 'Delegation', message: { caveats: [] } },
    },
  }

  /**
   * #3116 — a 3009-shaped intent response for the hosted prepare/pay tests
   * that drive the STANDARD (EIP-3009) path: the SDK's `createX402Intent`
   * refuses any intent without `x402_expected_auth` (client.ts), which the
   * erc7710 CHILD fixture above never carries.
   */
  const CHILD_3009 = {
    payment_id: 'pay_3116_3009',
    status: 'pending_signature',
    expires_at: '2099-01-01T00:00:00.000Z',
    merchant_to: PAYMENT_REQUIRED.accepts[0].payTo,
    x402_expected_auth: X402_EXPECTED_AUTH,
    sign_data: { hash: '0x' + '33'.repeat(32) },
  }

  function x402Body() {
    const call = recordedCalls().find((c) => new URL(c.url).pathname === '/x402')
    if (!call) return undefined
    const raw = call.body
    return (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, any>
  }

  describe('haven_pay_mcp_tool', () => {
    async function pay(
      pr: unknown,
      agentRoute: RouteDefinition,
      cap: Record<string, string>,
      intentBody: unknown = CHILD,
    ) {
      stubFetch({
        'POST /mcp': {
          status: 402,
          responseHeaders: { 'PAYMENT-REQUIRED': btoa(JSON.stringify(pr)) },
        },
        'GET /machine-payments/agent': agentRoute,
        'POST /x402': { status: 201, body: intentBody },
      })
      return handlers().haven_pay_mcp_tool({
        merchant_url: 'http://merchant.test/mcp',
        tool_name: 'create_text',
        arguments: { prompt: 'Hello' },
        ...cap,
      })
    }

    it('delegation rail: prepares DIRECT settlement and reports the erc7710 amount end-to-end', async () => {
      const res = ok<Record<string, any>>(
        await pay(ERC7710_ONLY_PR, { status: 200, body: DELEGATION_AGENT }, { max_amount_human: '3' }),
      )
      expect(res.data.settlement_scheme).toBe('erc7710')
      expect(res.data.settlement).toMatchObject({ scheme: 'erc7710', funding_leg: false })
      // The authorize carries the erc7710 entry's OWN amount and scheme.
      expect(x402Body()?.amount).toBe(ERC7710_ONLY_ATOMIC)
      expect(x402Body()?.settlementScheme).toBe('erc7710')
      expect(x402Body()?.facilitatorAddresses).toEqual([FACILITATOR])
      // The response reports what was actually authorized — top level AND the
      // summary an agent surfaces to the user (#2051's misreport pins).
      expect(res.data.amount_atomic).toBe(ERC7710_ONLY_ATOMIC)
      expect(res.data.amount).toBe('2.5')
      expect(res.data.agent_summary).toMatchObject({
        amount_atomic: ERC7710_ONLY_ATOMIC,
        amount: '2.5',
        token: 'USDC',
      })
    })

    it('a stated cap UNDER the erc7710 price refuses PRICE_EXCEEDS_MAX before any authorize', async () => {
      const res = await pay(
        ERC7710_ONLY_PR,
        { status: 200, body: DELEGATION_AGENT },
        { max_amount_human: '1' },
      )
      expect(res.success).toBe(false)
      expect((res as { code?: string }).code).toBe('PRICE_EXCEEDS_MAX')
      expect((res as { message?: string }).message).toContain('max_amount_human 1 USDC')
      expect(x402Body()).toBeUndefined()
    })

    it('a stated cap OVER the erc7710 price still succeeds — the cap binds, it does not block', async () => {
      const res = ok<Record<string, any>>(
        await pay(ERC7710_ONLY_PR, { status: 200, body: DELEGATION_AGENT }, { max_amount: ERC7710_ONLY_ATOMIC }),
      )
      expect(res.data.settlement_scheme).toBe('erc7710')
      expect(x402Body()?.amount).toBe(ERC7710_ONLY_ATOMIC)
    })

    it('LEGACY rail: refuses with the rail as the reason, not "no compatible payment option"', async () => {
      const res = await pay(
        ERC7710_ONLY_PR,
        { status: 200, body: LEGACY_AGENT },
        { max_amount_human: '3' },
      )
      expect(res.success).toBe(false)
      expect((res as { code?: string }).code).toBe('ERC7710_RAIL_REQUIRED')
      const message = (res as { message?: string }).message ?? ''
      expect(message).toContain('delegation-rail')
      expect(message).toContain("'legacy' rail")
      expect(message).not.toContain('No compatible payment option')
      expect(x402Body()).toBeUndefined()
    })

    it('a FAILED agent read refuses rather than guessing a rail it could not see', async () => {
      const res = await pay(ERC7710_ONLY_PR, { status: 500, body: {} }, { max_amount_human: '3' })
      expect(res.success).toBe(false)
      expect((res as { code?: string }).code).toBe('ERC7710_RAIL_REQUIRED')
      expect((res as { message?: string }).message).toContain('could not be read')
      // #2347: this refusal used to say Haven "refuses rather than AUTHORIZE on a
      // guess" — Haven as the grammatical actor of an authority verb, on a string
      // an agent reads mid-payment. Haven authorizes nothing; the owner-signed
      // delegation and its on-chain caveat do. Two literal pins, no sentence
      // interpretation: the corrected phrase is present, and the inversion cannot
      // come back into THIS message. The copy lint cannot cover it —
      // `packages/mcp-server/` is in neither its SCAN_DIRS nor its SCAN_FILES, and
      // the phrase is non-adjacent, which its own ceiling note says it misses.
      expect((res as { message?: string }).message).toContain('refuses rather than proceed on a guess')
      expect((res as { message?: string }).message).not.toContain('than authorize')
      expect(x402Body()).toBeUndefined()
    })

    it('negative control: a merchant with NOTHING settleable still refuses as before', async () => {
      const res = await pay(
        NOTHING_SETTLEABLE_PR,
        { status: 200, body: DELEGATION_AGENT },
        { max_amount_human: '3' },
      )
      expect(res.success).toBe(false)
      expect((res as { message?: string }).message).toContain('No compatible payment option')
      expect(x402Body()).toBeUndefined()
    })

    // ── #3116: unsupported transfer methods and payment flows ──────────────
    // The hosted pay tool selects through `selectX402SettlementScheme`; a
    // merchant whose only entries ask for permit2 or an unrecognized
    // paymentFlow must be refused with the capability as the named reason,
    // before any /x402 intent is POSTed. A mixed challenge falls back to the
    // supported entry behind the unsupported one.
    it('#3116: a permit2-ONLY merchant refuses with the capability as the reason', async () => {
      const res = await pay(PERMIT2_ONLY_PR, { status: 200, body: DELEGATION_AGENT }, { max_amount_human: '9' })
      expect(res.success).toBe(false)
      expect((res as { message?: string }).message).toContain('No compatible payment option')
      expect((res as { message?: string }).message).toContain('transfer method or payment')
      expect((res as { message?: string }).message).toContain("extra.assetTransferMethod: 'permit2'")
      expect((res as { message?: string }).message).toContain('No payment intent was created and no funds moved')
      expect(x402Body()).toBeUndefined()
    })

    it('#3116: an unrecognized paymentFlow on the only entry refuses the same way', async () => {
      const res = await pay(FLOW_ONLY_PR, { status: 200, body: DELEGATION_AGENT }, { max_amount_human: '9' })
      expect(res.success).toBe(false)
      expect((res as { message?: string }).message).toContain('No compatible payment option')
      expect((res as { message?: string }).message).toContain('unrecognized extra.paymentFlow')
      expect(x402Body()).toBeUndefined()
    })

    it('#3116: a mixed challenge skips the permit2 entry and pays the supported one', async () => {
      const res = ok<Record<string, any>>(
        await pay(MIXED_PR, { status: 200, body: DELEGATION_AGENT }, { max_amount_human: '9' }, CHILD_3009),
      )
      expect(res.data.settlement_scheme).toBeUndefined()
      // The authorize carries the SUPPORTED entry — its maxAmountRequired
      // (the authorization amount), not the unique permit2-tagged amount.
      expect(x402Body()?.amount).toBe(PAYMENT_REQUIRED.accepts[0].maxAmountRequired)
      expect(x402Body()?.amount).not.toBe(PERMIT2_ONLY_ATOMIC)
    })
  })

  describe('haven_prepare_catalog_purchase', () => {
    const CATALOG_ENTRY = {
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

    // (allowances fixture removed — #3054: budget-precheck stubs carry the
    // bare wire response body inline.)

    async function prepare(
      pr: unknown,
      agent: Record<string, unknown>,
      cap: Record<string, string>,
      opts: { remaining?: string; precheckStatus?: number; precheckBody?: Record<string, unknown>; intentBody?: unknown } = {},
    ) {
      stubFetch({
        'GET /catalog/cat_1': { status: 200, body: CATALOG_ENTRY },
        'POST /mcp': {
          status: 402,
          responseHeaders: { 'PAYMENT-REQUIRED': btoa(JSON.stringify(pr)) },
        },
        'POST /x402': { status: 201, body: opts.intentBody ?? CHILD },
        'GET /machine-payments/agent': { status: 200, body: agent },
        'POST /machine-payments/budget-precheck': {
          status: opts.precheckStatus ?? 200,
          body:
            opts.precheckBody ??
            { sufficient: true, remaining_atomic: opts.remaining ?? '5000000000' },
        },
      })
      return handlers().haven_prepare_catalog_purchase({ catalog_id: 'cat_1', ...cap })
    }

    it('delegation rail: prepares DIRECT settlement with the catalog fields and allowance block kept', async () => {
      const res = ok<Record<string, any>>(
        await prepare(ERC7710_ONLY_PR, DELEGATION_AGENT, { max_amount_human: '3' }),
      )
      expect(res.data.settlement_scheme).toBe('erc7710')
      expect(res.data.catalog_id).toBe('cat_1')
      expect(res.data.allowance).toMatchObject({ rail: 'delegation', sufficient: true })
      expect(x402Body()?.amount).toBe(ERC7710_ONLY_ATOMIC)
      expect(x402Body()?.settlementScheme).toBe('erc7710')
      expect(res.data.amount_atomic).toBe(ERC7710_ONLY_ATOMIC)
      expect(res.data.amount).toBe('2.5')
      expect(res.data.agent_summary).toMatchObject({
        amount_atomic: ERC7710_ONLY_ATOMIC,
        amount: '2.5',
        token: 'USDC',
      })
    })

    it('a stated cap UNDER the erc7710 price refuses PRICE_EXCEEDS_MAX before any authorize', async () => {
      const res = await prepare(ERC7710_ONLY_PR, DELEGATION_AGENT, { max_amount_human: '1' })
      expect(res.success).toBe(false)
      expect((res as { code?: string }).code).toBe('PRICE_EXCEEDS_MAX')
      expect(x402Body()).toBeUndefined()
    })

    it('the delegation BUDGET pre-check reads the erc7710 amount on this newly reachable path', async () => {
      const res = await prepare(ERC7710_ONLY_PR, DELEGATION_AGENT, { max_amount_human: '3' }, {
        // Haven decides server-side now: the erc7710 amount (2.50) exceeds
        // the budget and the pre-check refuses.
        precheckStatus: 403,
        precheckBody: {
          error: 'over budget',
          error_code: 'delegation_budget_exceeded',
          phase: 'insufficient_funds',
          next_action: 'fund_safe_or_raise_allowance',
          remaining_atomic: '1000000',
          amount_atomic: ERC7710_ONLY_ATOMIC,
        },
      })
      expect(res.success).toBe(false)
      expect((res as { code?: string }).code).toBe('DELEGATION_BUDGET_EXCEEDED')
      expect((res as { message?: string }).message).toContain(ERC7710_ONLY_ATOMIC)
      expect(x402Body()).toBeUndefined()
    })

    it('LEGACY rail: refuses with the rail as the reason, not "no compatible payment option"', async () => {
      const res = await prepare(ERC7710_ONLY_PR, LEGACY_AGENT, { max_amount_human: '3' })
      expect(res.success).toBe(false)
      expect((res as { code?: string }).code).toBe('ERC7710_RAIL_REQUIRED')
      expect((res as { message?: string }).message).not.toContain('No compatible payment option')
      expect(x402Body()).toBeUndefined()
    })

    it('negative control: a merchant with NOTHING settleable still refuses as before', async () => {
      const res = await prepare(NOTHING_SETTLEABLE_PR, DELEGATION_AGENT, { max_amount_human: '3' })
      expect(res.success).toBe(false)
      expect((res as { message?: string }).message).toContain('No compatible payment option')
      expect(x402Body()).toBeUndefined()
    })

    // ── #3116: unsupported transfer methods and payment flows ──────────────
    // The prepare tool refuses an unsupported-only merchant before the /x402
    // intent is POSTed; a mixed challenge falls back to the supported entry.
    it('#3116: a permit2-ONLY merchant refuses before the /x402 intent', async () => {
      const res = await prepare(PERMIT2_ONLY_PR, DELEGATION_AGENT, { max_amount_human: '9' })
      expect(res.success).toBe(false)
      expect((res as { message?: string }).message).toContain('No compatible payment option')
      expect((res as { message?: string }).message).toContain("extra.assetTransferMethod: 'permit2'")
      expect(x402Body()).toBeUndefined()
    })

    it('#3116: an unrecognized paymentFlow on the only entry refuses the same way', async () => {
      const res = await prepare(FLOW_ONLY_PR, DELEGATION_AGENT, { max_amount_human: '9' })
      expect(res.success).toBe(false)
      expect((res as { message?: string }).message).toContain('No compatible payment option')
      expect(x402Body()).toBeUndefined()
    })

    it('#3116 positive control: a plain supported entry still pays — behavior unchanged', async () => {
      const res = ok<Record<string, any>>(
        await prepare(PAYMENT_REQUIRED, DELEGATION_AGENT, { max_amount_human: '9' }, { intentBody: CHILD_3009 }),
      )
      expect(res.data.settlement_scheme).toBeUndefined()
      expect(x402Body()?.settlementScheme).toBe('eip3009')
      // maxAmountRequired is the authorization amount on this entry (#3116 note: unchanged behavior).
      expect(x402Body()?.amount).toBe(PAYMENT_REQUIRED.accepts[0].maxAmountRequired)
    })

    it('#3116: a mixed challenge skips the permit2 entry and prepares the supported one', async () => {
      const res = ok<Record<string, any>>(
        await prepare(MIXED_PR, DELEGATION_AGENT, { max_amount_human: '9' }, { intentBody: CHILD_3009 }),
      )
      expect(res.data.settlement_scheme).toBeUndefined()
      expect(x402Body()?.amount).toBe(PAYMENT_REQUIRED.accepts[0].maxAmountRequired)
      expect(x402Body()?.amount).not.toBe(PERMIT2_ONLY_ATOMIC)
    })
  })

  describe('haven_quote_mcp_tool', () => {
    async function quoteTool(pr: unknown) {
      stubFetch({
        'POST /mcp': {
          status: 402,
          responseHeaders: { 'PAYMENT-REQUIRED': btoa(JSON.stringify(pr)) },
        },
        'GET /machine-payments/agent': { status: 200, body: DELEGATION_AGENT },
      })
      return handlers().haven_quote_mcp_tool({
        merchant_url: 'http://merchant.test/mcp',
        tool_name: 'create_text',
        arguments: { prompt: 'Hello' },
      })
    }

    it('quotes an erc7710-only merchant and says so, instead of refusing it as incompatible', async () => {
      const res = ok<Record<string, any>>(await quoteTool(ERC7710_ONLY_PR))
      expect(res.data.amount_atomic).toBe(ERC7710_ONLY_ATOMIC)
      expect(res.data.accepted_scheme).toBe('erc7710')
      expect(res.data.erc7710_only).toBe(true)
    })

    it('a standard quote is labeled standard and carries no erc7710_only flag', async () => {
      const res = ok<Record<string, any>>(await quoteTool(PAYMENT_REQUIRED))
      expect(res.data.accepted_scheme).toBe('standard')
      expect(res.data.erc7710_only).toBeUndefined()
      // Unchanged: the standard entry's own amount, not this suite's.
      expect(res.data.amount_atomic).toBe('1500000')
    })

    it('#3116: an unsupported-only merchant is refused, never described as payable', async () => {
      const res = await quoteTool(PERMIT2_ONLY_PR)
      expect(res.success).toBe(false)
      expect((res as { message?: string }).message).toContain('No compatible payment option')
      expect((res as { message?: string }).message).toContain('transfer method or payment')
    })

    it('negative control: a merchant with NOTHING settleable is still refused at the quote', async () => {
      // This is the pin that keeps `buildX402Quote`'s fallback honest: a
      // mutation that falls back to ANY accepts[] entry (rather than the
      // erc7710 selector's) would happily quote this unpayable merchant.
      const res = await quoteTool(NOTHING_SETTLEABLE_PR)
      expect(res.success).toBe(false)
      expect((res as { message?: string }).message).toContain('No compatible payment option')
    })
  })
})

// #2979: what the hosted tools return when a merchant answers its `/mcp`
// `tools/call` probe with its OWN machine-readable "cannot settle right now"
// refusal (demo-merchant-mcp's settlement-readiness gate: `503
// { error: 'merchant_not_ready', reason_code, settlements_remaining,
// fail_floor, retry_after_s }`) instead of a 402 challenge.
//
// BEFORE this slice, both `haven_quote_mcp_tool` and
// `haven_prepare_catalog_purchase` treated ANY non-402 status — including
// this one — as a "wrong endpoint" and ran the #1271 same-origin discovery
// fallback, which (rightly, since the URL WAS correct) also found nothing,
// and surfaced `code: 'API_ERROR'` with no `next_action` and a message
// blaming a failed discovery probe — discarding the merchant's own, honest
// reason entirely. That misleading shape is what these tests replace.
describe('a merchant_not_ready 503 is reported as itself, not a wrong-endpoint miss (#2979)', () => {
  const MERCHANT_NOT_READY_BODY = {
    error: 'merchant_not_ready',
    reason_code: 'settlement_wallet_out_of_gas',
    settlements_remaining: 0,
    fail_floor: 12,
    retry_after_s: 60,
  }

  describe('haven_quote_mcp_tool', () => {
    async function quoteAgainstNotReadyMerchant() {
      stubFetch({
        'POST /mcp': {
          status: 503,
          body: MERCHANT_NOT_READY_BODY,
          responseHeaders: { 'Retry-After': '60' },
        },
      })
      return handlers().haven_quote_mcp_tool({
        merchant_url: 'http://merchant.test/mcp',
        tool_name: 'buy_vpn',
        arguments: { plan: 'basic' },
      })
    }

    it('refuses with MERCHANT_NOT_READY, a StopAndTellUser next_action, and the merchant reason surfaced', async () => {
      const res = await quoteAgainstNotReadyMerchant()

      expect(res.success).toBe(false)
      expect((res as { code?: string }).code).toBe(AgentPaymentFailureCode.MerchantNotReady)
      expect((res as { code?: string }).code).not.toBe('UNKNOWN_ERROR')
      expect((res as { code?: string }).code).not.toBe('API_ERROR')
      expect((res as { next_action?: string }).next_action).toBe(AgentPaymentNextAction.StopAndTellUser)
      const message = (res as { message?: string }).message ?? ''
      expect(message).toContain('settlement_wallet_out_of_gas')
      expect(message).toContain('60')
      // The old, misleading text this replaces must be gone.
      expect(message).not.toContain('discovery document')
      expect((res as { retry_with_new_quote?: boolean }).retry_with_new_quote).toBe(true)
    })

    it('a bare 503 without the merchant_not_ready body is NOT reported as MERCHANT_NOT_READY (review of #2982)', async () => {
      // A load balancer / outage page: the merchant said nothing about its
      // capacity, so the mapping must not invent a capacity refusal — the
      // request keeps going through the #1271 discovery path as before.
      stubFetch({
        'POST /mcp': { status: 503, body: { error: 'upstream unavailable' } },
      })
      const res = await handlers().haven_quote_mcp_tool({
        merchant_url: 'http://merchant.test/mcp',
        tool_name: 'buy_vpn',
        arguments: { plan: 'basic' },
      })
      expect(res.success).toBe(false)
      expect((res as { code?: string }).code).not.toBe(AgentPaymentFailureCode.MerchantNotReady)
      expect((res as { message?: string }).message ?? '').not.toContain('cannot settle a payment right now')
    })

    it('never spends the bounded #1271 discovery retry on an honest 503', async () => {
      await quoteAgainstNotReadyMerchant()
      // The MCP session lifecycle (initialize, notifications/initialized,
      // tools/call) all land on the same `/mcp` path for the ONE probe
      // attempt; what matters is that no #1271 discovery document fetch ran
      // and no SECOND round of the lifecycle was started against a
      // discovered endpoint.
      expect(recordedCalls().some((call) => new URL(call.url).pathname.includes('well-known'))).toBe(false)
      expect(recordedCalls().filter((call) => call.body?.method === 'tools/call')).toHaveLength(1)
    })
  })

  describe('haven_prepare_catalog_purchase', () => {
    const CATALOG_ENTRY = {
      id: 'cat_not_ready',
      name: 'NordShield VPN Basic',
      description: 'VPN subscription',
      category: 'vpn',
      resource_url: 'http://merchant.test/mcp',
      rail: 'x402',
      protocol: 'mcp',
      tool_name: 'buy_vpn',
      tool_arguments: { plan: 'basic' },
      price_display: '$0.001 USDC',
      price_atomic: '1000',
      asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      network: 'eip155:8453',
      status: 'active',
      verified_at: '2026-06-16T08:50:39.772Z',
    }

    it('surfaces the same MERCHANT_NOT_READY refusal, not a wrong-endpoint miss', async () => {
      stubFetch({
        'GET /catalog/cat_not_ready': { status: 200, body: CATALOG_ENTRY },
        'POST /mcp': {
          status: 503,
          body: MERCHANT_NOT_READY_BODY,
          responseHeaders: { 'Retry-After': '60' },
        },
        'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
        'POST /machine-payments/budget-precheck': {
          status: 200,
          body: { sufficient: true, remaining_atomic: '5000000' },
        },
      })

      const res = await handlers().haven_prepare_catalog_purchase({
        catalog_id: 'cat_not_ready',
        max_amount_human: '1',
      })

      expect(res.success).toBe(false)
      expect((res as { code?: string }).code).toBe(AgentPaymentFailureCode.MerchantNotReady)
      expect((res as { next_action?: string }).next_action).toBe(AgentPaymentNextAction.StopAndTellUser)
      expect((res as { message?: string }).message ?? '').toContain('settlement_wallet_out_of_gas')
    })
  })
})

// ── #2991 — the quote's expected_settlement_scheme/expected_funding_leg
// predict the SAME scheme haven_prepare_catalog_purchase / haven_pay_mcp_tool
// will actually select, computed by the IDENTICAL selectX402SettlementScheme
// call those tools run — so a delegation-rail agent quoted
// accepted_scheme: 'standard' at a merchant advertising both entries (the
// demo merchant's shape) is told up front that prepare/pay will still PREFER
// erc7710, rather than being left to infer a settlement shape from a field
// that only ever describes the merchant's offer.
describe('#2991 — expected_settlement_scheme / expected_funding_leg', () => {
  const DELEGATION_AGENT = { ...AGENT_RESPONSE, execution_rail: 'delegation' }
  const LEGACY_AGENT = { ...AGENT_RESPONSE, execution_rail: 'legacy' }
  const FACILITATORS = ['0x4444444444444444444444444444444444444444']

  /** Both a standard AND an erc7710-tagged entry — the demo-merchant shape. */
  function bothEntriesMerchant() {
    const base = PAYMENT_REQUIRED.accepts[0]
    return {
      ...PAYMENT_REQUIRED,
      accepts: [
        { ...base },
        { ...base, extra: { assetTransferMethod: 'erc7710', facilitatorAddresses: FACILITATORS } },
      ],
    }
  }

  const ERC7710_ONLY_PR = {
    ...PAYMENT_REQUIRED,
    accepts: [
      {
        ...PAYMENT_REQUIRED.accepts[0],
        extra: { assetTransferMethod: 'erc7710', facilitatorAddresses: FACILITATORS },
      },
    ],
  }

  const CATALOG_ENTRY = {
    id: 'cat_2991',
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

  // (allowances fixture removed — #3054: budget-precheck stubs carry the
  // bare wire response body inline.)

  it('both entries + delegation rail: predicts erc7710 with no funding leg, even though accepted_scheme is "standard"', async () => {
    stubFetch({
      'POST /mcp': {
        status: 402,
        responseHeaders: { 'PAYMENT-REQUIRED': btoa(JSON.stringify(bothEntriesMerchant())) },
      },
      'GET /machine-payments/agent': { status: 200, body: DELEGATION_AGENT },
    })
    const res = ok<{
      accepted_scheme: string
      expected_settlement_scheme: string | null
      expected_funding_leg: boolean | null
    }>(
      await handlers().haven_quote_mcp_tool({
        merchant_url: 'http://merchant.test/mcp',
        tool_name: 'create_text',
        arguments: { prompt: 'Hello' },
      }),
    )
    expect(res.data.accepted_scheme).toBe('standard')
    expect(res.data.expected_settlement_scheme).toBe('erc7710')
    expect(res.data.expected_funding_leg).toBe(false)
  })

  it('same merchant + agent on the legacy/3009 rail: predicts eip3009 WITH a funding leg — and NOT settleable (Haven refuses retired rails with 410)', async () => {
    stubFetch({
      'POST /mcp': {
        status: 402,
        responseHeaders: { 'PAYMENT-REQUIRED': btoa(JSON.stringify(bothEntriesMerchant())) },
      },
      'GET /machine-payments/agent': { status: 200, body: LEGACY_AGENT },
    })
    const res = ok<{ expected_settlement_scheme: string | null; expected_funding_leg: boolean | null; expected_settleable?: boolean }>(
      await handlers().haven_quote_mcp_tool({
        merchant_url: 'http://merchant.test/mcp',
        tool_name: 'create_text',
        arguments: { prompt: 'Hello' },
      }),
    )
    expect(res.data.expected_settlement_scheme).toBe('eip3009')
    expect(res.data.expected_funding_leg).toBe(true)
    // The selector's answer — but Haven's x402 entry points 410 every retired
    // rail, so the purchase is not settleable for this account.
    expect(res.data.expected_settleable).toBe(false)
  })

  // #2993 review: the catalog quote — the tool B12 was filed against — carries
  // the same prediction; severing `agent` on that site must go red here.
  it('haven_quote_catalog_purchase carries the same prediction as the generic quote', async () => {
    stubFetch({
      'GET /catalog/cat_1': {
        status: 200,
        body: {
          id: 'cat_1', name: 'Demo VPN', description: 'd', category: 'vpn',
          resource_url: 'http://merchant.test/mcp', rail: 'x402', protocol: 'mcp',
          tool_name: 'create_text', tool_arguments: { prompt: 'Hello' },
          price_display: '$1.50 USDC', price_atomic: '1500000',
          asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', network: 'eip155:8453',
          status: 'active', verified_at: '2026-06-16T08:50:39.772Z',
        },
      },
      'POST /mcp': {
        status: 402,
        responseHeaders: { 'PAYMENT-REQUIRED': btoa(JSON.stringify(bothEntriesMerchant())) },
      },
      'GET /machine-payments/agent': { status: 200, body: DELEGATION_AGENT },
    })
    const res = ok<{
      accepted_scheme: string
      expected_settlement_scheme: string | null
      expected_funding_leg: boolean | null
      expected_settleable?: boolean
      warnings?: unknown[]
    }>(await handlers().haven_quote_catalog_purchase({ catalog_id: 'cat_1' }))
    expect(res.data.accepted_scheme).toBe('standard')
    expect(res.data.expected_settlement_scheme).toBe('erc7710')
    expect(res.data.expected_funding_leg).toBe(false)
    expect(res.data.expected_settleable).toBe(true)
    expect(res.data.warnings).toBeUndefined()
  })

  it('an erc7710-only merchant predicts erc7710 regardless of the account rail — and says whether THIS agent can settle it', async () => {
    // Legacy rail at an erc7710-only merchant: prepare will refuse with
    // ERC7710_RAIL_REQUIRED, so the prediction names the scheme the merchant
    // demands and `expected_settleable: false` (review of #2991) — a bare
    // 'erc7710' would read as "prepare will settle it".
    stubFetch({
      'POST /mcp': {
        status: 402,
        responseHeaders: { 'PAYMENT-REQUIRED': btoa(JSON.stringify(ERC7710_ONLY_PR)) },
      },
      'GET /machine-payments/agent': { status: 200, body: LEGACY_AGENT },
    })
    const legacy = ok<{ expected_settlement_scheme: string | null; expected_funding_leg: boolean | null; expected_settleable?: boolean }>(
      await handlers().haven_quote_mcp_tool({
        merchant_url: 'http://merchant.test/mcp',
        tool_name: 'create_text',
        arguments: { prompt: 'Hello' },
      }),
    )
    expect(legacy.data.expected_settlement_scheme).toBe('erc7710')
    expect(legacy.data.expected_funding_leg).toBe(false)
    expect(legacy.data.expected_settleable).toBe(false)

    stubFetch({
      'POST /mcp': {
        status: 402,
        responseHeaders: { 'PAYMENT-REQUIRED': btoa(JSON.stringify(ERC7710_ONLY_PR)) },
      },
      'GET /machine-payments/agent': { status: 200, body: DELEGATION_AGENT },
    })
    const delegation = ok<{ expected_settlement_scheme: string | null; expected_settleable?: boolean }>(
      await handlers().haven_quote_mcp_tool({
        merchant_url: 'http://merchant.test/mcp',
        tool_name: 'create_text',
        arguments: { prompt: 'Hello' },
      }),
    )
    expect(delegation.data.expected_settlement_scheme).toBe('erc7710')
    expect(delegation.data.expected_settleable).toBe(true)
  })

  it('a FAILED agent read yields expected_settlement_scheme: null with a warning, never a guess', async () => {
    stubFetch({
      'POST /mcp': {
        status: 402,
        responseHeaders: { 'PAYMENT-REQUIRED': btoa(JSON.stringify(bothEntriesMerchant())) },
      },
      'GET /machine-payments/agent': { status: 500, body: {} },
    })
    const res = ok<{
      expected_settlement_scheme: string | null
      warnings?: Array<{ code: string }>
    }>(
      await handlers().haven_quote_mcp_tool({
        merchant_url: 'http://merchant.test/mcp',
        tool_name: 'create_text',
        arguments: { prompt: 'Hello' },
      }),
    )
    expect(res.data.expected_settlement_scheme).toBeNull()
    expect(res.data.warnings?.some((w) => w.code === 'X402_SCHEME_UNKNOWN')).toBe(true)
  })

  it('a prepare run right after the quote selects the SAME scheme the quote predicted (agreement pin)', async () => {
    stubFetch({
      'GET /catalog/cat_2991': { status: 200, body: CATALOG_ENTRY },
      'POST /mcp': {
        status: 402,
        responseHeaders: { 'PAYMENT-REQUIRED': btoa(JSON.stringify(bothEntriesMerchant())) },
      },
      'GET /machine-payments/agent': { status: 200, body: DELEGATION_AGENT },
      'POST /machine-payments/budget-precheck': {
        status: 200,
        body: { sufficient: true, remaining_atomic: '5000000000' },
      },
      'POST /x402': {
        status: 201,
        body: {
          payment_id: 'pay_2991',
          status: 'pending_signature',
          sign_data: {
            hash: '0x' + '33'.repeat(32),
            signature_scheme: 'eip712_delegation',
            typed_data: { domain: {}, types: {}, primaryType: 'Delegation', message: { caveats: [] } },
          },
        },
      },
    })

    const quote = ok<{ expected_settlement_scheme: string | null }>(
      await handlers().haven_quote_mcp_tool({
        merchant_url: 'http://merchant.test/mcp',
        tool_name: 'create_text',
        arguments: { prompt: 'Hello' },
      }),
    )
    expect(quote.data.expected_settlement_scheme).toBe('erc7710')

    const prepared = ok<{ settlement_scheme: string }>(
      await handlers().haven_prepare_catalog_purchase({
        catalog_id: 'cat_2991',
        max_amount_human: '3',
      }),
    )
    // The point of this suite: quote and prepare must never disagree.
    expect(prepared.data.settlement_scheme).toBe(quote.data.expected_settlement_scheme)
  })
})

