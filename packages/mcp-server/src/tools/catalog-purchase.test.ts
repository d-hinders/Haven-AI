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
import {
  AgentPaymentFailureCode,
  AgentPaymentNextAction,
  type AgentNextStep,
} from '@haven_ai/sdk'
import {
  AGENT_RESPONSE,
  PAYMENT_REQUIRED,
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
    expect(recordedCalls().find((call) => new URL(call.url).pathname.includes('/machine-payments/allowances'))).toBeUndefined()
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
    expect(recordedCalls().find((call) => new URL(call.url).pathname.includes('/machine-payments/allowances'))).toBeUndefined()
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
      'GET /machine-payments/allowances': { status: 200, body: allowancesFixture('7500') },
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
    expect(recordedCalls().find((c) => c.url.endsWith('/x402'))).toBeUndefined()
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
      'GET /machine-payments/allowances': { status: 200, body: allowancesFixture('5000000') },
    })

    ok(await handlers().haven_prepare_catalog_purchase({ catalog_id: 'cat_1', max_amount: '2000000' }))

    const byPath = (suffix: string) => recordedCalls().filter((c) => new URL(c.url).pathname.endsWith(suffix)).length
    expect(byPath('/catalog/cat_1')).toBe(1)
    // The mutation this guards: dropping the delegateAddress pass-through to
    // createX402Intent silently re-adds its internal agent fetch → 2.
    expect(byPath('/machine-payments/agent')).toBe(1)
    expect(byPath('/machine-payments/allowances')).toBe(1)
    expect(byPath('/x402')).toBe(1)
    // #1360: the funding-leg intent DECLARES its scheme, so a stale delegate
    // address fails the backend's shape cross-check loudly.
    const intentPost = recordedCalls().find((c) => new URL(c.url).pathname.endsWith('/x402'))!
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
    const lastMerchantPost = recordedCalls().map((c, i) => ({ c, i })).filter(({ c }) => c.method === 'POST' && new URL(c.url).pathname === '/mcp').at(-1)!.i
    const agentIdx = recordedCalls().findIndex((c) => new URL(c.url).pathname.endsWith('/machine-payments/agent'))
    const allowancesIdx = recordedCalls().findIndex((c) => new URL(c.url).pathname.endsWith('/machine-payments/allowances'))
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
    expect(recordedCalls().find((c) => c.url.endsWith('/x402'))).toBeDefined()
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

  function allowances(remaining: string, rail: 'legacy' | 'delegation') {
    return {
      agent_id: 'agt_1',
      safe_address: '0xSafe',
      delegate_address: '0xDelegate',
      chain_id: 8453,
      allowances: [
        {
          id: rail === 'delegation' ? 'delegation-1' : 'allowance-1',
          token_address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
          token_symbol: 'USDC',
          allowance_amount: '5.000000',
          reset_period_min: 1440,
          onchain: { amount: '5000000', spent: '0', remaining, is_active: true },
        },
      ],
    }
  }

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
      opts: { erc7710Intent?: boolean; remaining?: string } = {},
    ) {
      const rail =
        (agent as { execution_rail?: string }).execution_rail === 'delegation'
          ? 'delegation'
          : 'legacy'
      stubFetch({
        'GET /catalog/cat_1': { status: 200, body: CATALOG_ENTRY },
        'POST /mcp': {
          status: 402,
          responseHeaders: { 'PAYMENT-REQUIRED': btoa(JSON.stringify(pr)) },
        },
        'POST /x402': { status: 201, body: opts.erc7710Intent ? CHILD : X402_INTENT_RESPONSE },
        'GET /machine-payments/agent': { status: 200, body: agent },
        'GET /machine-payments/allowances': {
          status: 200,
          body: allowances(opts.remaining ?? '5000000000', rail),
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
      // while the 900 USDC erc7710 entry is what gets authorized.
      const res = await prepare(
        merchant('500000', '900000000'),
        DELEGATION_AGENT,
        { max_amount_human: '1000' },
        { remaining: '1000000', erc7710Intent: true },
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

  const CHILD = {
    payment_id: 'pay_7710_only',
    status: 'pending_signature',
    sign_data: {
      hash: '0x' + '22'.repeat(32),
      signature_scheme: 'eip712_delegation',
      typed_data: { domain: {}, types: {}, primaryType: 'Delegation', message: { caveats: [] } },
    },
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
    ) {
      stubFetch({
        'POST /mcp': {
          status: 402,
          responseHeaders: { 'PAYMENT-REQUIRED': btoa(JSON.stringify(pr)) },
        },
        'GET /machine-payments/agent': agentRoute,
        'POST /x402': { status: 201, body: CHILD },
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

    function allowances(remaining: string, rail: 'legacy' | 'delegation') {
      return {
        agent_id: 'agt_1',
        safe_address: '0xSafe',
        delegate_address: '0xDelegate',
        chain_id: 8453,
        allowances: [
          {
            id: rail === 'delegation' ? 'delegation-1' : 'allowance-1',
            token_address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
            token_symbol: 'USDC',
            allowance_amount: '5.000000',
            reset_period_min: 1440,
            onchain: { amount: '5000000', spent: '0', remaining, is_active: true },
          },
        ],
      }
    }

    async function prepare(
      pr: unknown,
      agent: Record<string, unknown>,
      cap: Record<string, string>,
      opts: { remaining?: string } = {},
    ) {
      const rail =
        (agent as { execution_rail?: string }).execution_rail === 'delegation'
          ? 'delegation'
          : 'legacy'
      stubFetch({
        'GET /catalog/cat_1': { status: 200, body: CATALOG_ENTRY },
        'POST /mcp': {
          status: 402,
          responseHeaders: { 'PAYMENT-REQUIRED': btoa(JSON.stringify(pr)) },
        },
        'POST /x402': { status: 201, body: CHILD },
        'GET /machine-payments/agent': { status: 200, body: agent },
        'GET /machine-payments/allowances': {
          status: 200,
          body: allowances(opts.remaining ?? '5000000000', rail as 'legacy' | 'delegation'),
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
        remaining: '1000000', // under the 2.50 the erc7710 entry authorizes
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

