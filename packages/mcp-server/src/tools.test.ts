import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import {
  AgentPaymentFailureCode,
  AgentPaymentNextAction,
  HavenClient,
  MerchantTimeoutError,
  type AgentNextStep,
} from '@haven_ai/sdk'
import { createToolHandlers, toolDescriptions, type ToolSuccess, type ToolPayload } from './tools.js'
import {
  AGENT_RESPONSE,
  DELEGATE_KEY,
  PAYMENT_REQUIRED,
  X402_INTENT_RESPONSE,
  clearCalls,
  handlers,
  installSharedFixtureLifecycle,
  mintPaymentHeaders,
  ok,
  recordedCalls,
  stubFetch,
} from './test-support/hosted-mcp.js'

installSharedFixtureLifecycle()


beforeEach(() => {
  clearCalls()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ── x402 fixtures ─────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Headers are minted by the SDK's real signing path so these fixtures
  // cannot drift from what a client actually sends (#1618 note — see the
  // shared fixture's mintPaymentHeaders).
  await mintPaymentHeaders()
})


// ── haven_pay_mcp_tool ────────────────────────────────────────────────────────

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

    expect(recordedCalls().filter((c) => new URL(c.url).pathname.endsWith('/machine-payments/agent')).length).toBe(1)
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
    expect(recordedCalls().find((c) => new URL(c.url).pathname.endsWith('/x402'))).toBeUndefined()
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
      // createX402Intent recordedCalls() POST /x402
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
    const initialize = recordedCalls().find((call) => call.body?.method === 'initialize')
    const initialized = recordedCalls().find((call) => call.body?.method === 'notifications/initialized')
    const quoteProbe = recordedCalls().find((call) => call.body?.method === 'tools/call')
    expect(initialize).toBeDefined()
    expect(new Headers(initialized?.headers).get('mcp-session-id')).toBe('sess-tools-test')
    expect(new Headers(quoteProbe?.headers).get('Accept')).toBe('application/json, text/event-stream')
    expect(new Headers(quoteProbe?.headers).get('mcp-session-id')).toBe('sess-tools-test')
    expect(new Headers(quoteProbe?.headers).get('x402-wallet')).toBe(AGENT_RESPONSE.delegate_address)
    // createX402Intent was called (POST /x402 route was hit)
    expect(recordedCalls().find((c) => c.url.endsWith('/x402'))).toBeDefined()
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

    const intentCall = recordedCalls().find((c) => c.url.endsWith('/x402'))
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
    expect(recordedCalls().find((c) => c.url.endsWith('/x402'))).toBeUndefined()
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
    expect(recordedCalls().find((c) => c.url.endsWith('/x402'))).toBeDefined()
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
    expect(recordedCalls()).toHaveLength(0)
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

    const wire = JSON.stringify(recordedCalls())
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
      reason: string
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
    expect(recordedCalls()).toHaveLength(0)
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
    // #2101: the authoritative field must say STOP, not wait. No live rail
    // mints this status (410 on the legacy rail per #1986; 403/502 at prepare
    // on the delegation rail; `approval_requests` dropped by #2055), so an
    // agent that followed `wait_for_user_approval` here — the field the agent
    // contract says to follow FIRST — would poll a loop that cannot terminate.
    expect(result.data.next_action).toBe('stop_and_tell_user')
    expect(result.data.safe_to_continue).toBe(false)
  })

  it('a retained pending status is UNSAFE to continue and tells the agent to stop', async () => {
    stubFetch({
      ...stubs(),
      'POST /x402': {
        status: 202,
        body: { payment_id: 'pay_pending', status: 'pending_approval' },
      },
    })
    const result = ok<{
      status: string
      agent_summary: Record<string, unknown>
    } & AgentNextStep>(await pay())

    // #2101: the authoritative field must say STOP, not wait. No live rail
    // mints this status (410 on the legacy rail per #1986; 403/502 at prepare
    // on the delegation rail; `approval_requests` dropped by #2055), so an
    // agent that followed `wait_for_user_approval` here — the field the agent
    // contract says to follow FIRST — would poll a loop that cannot terminate.
    expect(result.data.status).toBe('pending_approval')
    expect(result.data.next_action).toBe('stop_and_tell_user')
    expect(result.data.next_tool).toBe('mcp__haven__haven_get_payment_status')
    expect(result.data.next_tool_server).toBe('haven')
    expect(result.data.next_tool_name).toBe('haven_get_payment_status')
    // #2550: both roles are emitted (haven-signer and haven), so the role field
    // has to distinguish them. A field that only ever said "signer" would leave
    // a client unable to tell "the other role" from "the field is missing".
    expect(result.data.next_tool_server_role).toBe('hosted')
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

  const fundingCall = () => recordedCalls().find((c) => new URL(c.url).pathname.endsWith('/x402'))

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
      expect(recordedCalls()).toHaveLength(0)
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
        clearCalls()
        stubFetch(payRoutes)
        const payload = await payMcpTool({ max_amount_human: bad })
        expect(payload.success, `expected "${bad}" to be rejected`).toBe(false)
        if (payload.success) throw new Error('expected failure')
        expect(payload.code).toBe('INVALID_INPUT')
        expect(recordedCalls()).toHaveLength(0)
      }
    })

  it('refuses an uncapped paid MCP call before the merchant probe', async () => {
    stubFetch(payRoutes)

      const payload = await payMcpTool({})

      expect(payload.success).toBe(false)
      if (payload.success) throw new Error('expected failure')
      expect(payload.code).toBe('INVALID_INPUT')
      expect(payload.message).toContain('max_amount_human')
      expect(recordedCalls()).toHaveLength(0)
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
        clearCalls()
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
      expect(recordedCalls()).toHaveLength(0)
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
      expect(recordedCalls()).toHaveLength(0)
    })

    it('still refuses when NEITHER spelling is given — the guided path never runs uncapped', async () => {
      stubFetch(catalogRoutes)

      const payload = await handlers().haven_prepare_catalog_purchase({ catalog_id: 'cat_1' })

      expect(payload.success).toBe(false)
      if (payload.success) throw new Error('expected failure')
      expect(payload.code).toBe('INVALID_INPUT')
      expect(payload.message).toContain('max_amount_human')
      expect(recordedCalls()).toHaveLength(0)
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

    const raw = recordedCalls().find((c) => new URL(c.url).pathname === '/x402')!.body
    const body = typeof raw === 'string' ? JSON.parse(raw) : (raw as Record<string, unknown>)
    // payTo = the MERCHANT is what selects direct settlement server-side.
    expect(body.settlementScheme).toBe('erc7710')
    expect(body.payTo).toBe(PAYMENT_REQUIRED.accepts[0].payTo)
    expect(body).not.toHaveProperty('merchantPayTo')
  })

  it('a LEGACY-rail account never takes the branch, even when the merchant offers it', async () => {
    const res = await pay(erc7710Header, { ...AGENT_RESPONSE, execution_rail: 'legacy' })
    expect(res.data.settlement_scheme).toBeUndefined()
    const raw = recordedCalls().find((c) => new URL(c.url).pathname === '/x402')!.body
    const body = typeof raw === 'string' ? JSON.parse(raw) : (raw as Record<string, unknown>)
    expect(body.settlementScheme).toBe('eip3009')
  })

  it('a 3009-only merchant stays on the bridge, even on a delegation account', async () => {
    const res = await pay(plainHeader, DELEGATION_AGENT)
    expect(res.data.settlement_scheme).toBeUndefined()
    const raw = recordedCalls().find((c) => new URL(c.url).pathname === '/x402')!.body
    const body = typeof raw === 'string' ? JSON.parse(raw) : (raw as Record<string, unknown>)
    expect(body.settlementScheme).toBe('eip3009')
  })

  it('keeps #1348 round-trip budget: still exactly ONE agent fetch', async () => {
    await pay(erc7710Header, DELEGATION_AGENT, true)
    expect(
      recordedCalls().filter((c) => new URL(c.url).pathname.endsWith('/machine-payments/agent')).length,
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
    expect(recordedCalls().find((c) => c.url.includes('/settle'))?.body).toEqual({ signature: SIG7710 })
    expect(recordedCalls().find((c) => c.url.includes('/payments/pay_7710/sign'))).toBeUndefined()
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
  /**
   * Every non-test source file under `src/tools/`, RECURSIVELY, plus the
   * facade (#2810).
   *
   * Both scanners below used to read `tools.ts` alone. That was the whole
   * surface when they were written; it is now the facade plus one module per
   * capability plus the shared `tools/support/`, and epic #2806 moves more out
   * with every slice. A scanner that keeps reading only `tools.ts` does not
   * fail when handlers leave it — it quietly measures less, which for the
   * `suggestedTool` check below (a NEGATIVE assertion) means it stops being
   * able to fail at all.
   *
   * The recursion is the correction that matters, and it was found by a
   * mutation that SURVIVED. A non-recursive read covers 2 of the 9
   * `suggestedTool` emission sites; the other 7 are in `tools/support/`
   * (`errors.ts`, `cap-price.ts`, `catalog-entry.ts`, `mcp-context.ts`) and
   * every one of them is agent-visible — `support/errors.ts` maps
   * `suggestedTool` straight onto the `suggested_tool` response field. A
   * prefixed literal planted at `support/mcp-context.ts` passed the whole
   * suite before this change.
   *
   * Directory-derived rather than a list, so the next slice is covered without
   * editing this file — the same reason `CAPABILITY_MODULES` is derived in
   * `tools/support/shared-helper-ownership.test.ts`.
   */
  async function hostedSurfaceSource(): Promise<string> {
    const { readFileSync, readdirSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const parts = [readFileSync(fileURLToPath(new URL('./tools.ts', import.meta.url)), 'utf8')]
    const walk = (dir: URL) => {
      for (const entry of readdirSync(fileURLToPath(dir), { withFileTypes: true })) {
        if (entry.isDirectory()) {
          walk(new URL(`${entry.name}/`, dir))
          continue
        }
        if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
        if (entry.name.endsWith('.test.ts')) continue
        parts.push(readFileSync(fileURLToPath(new URL(entry.name, dir)), 'utf8'))
      }
    }
    walk(new URL('./tools/', import.meta.url))
    return parts.join('\n')
  }

  it('every nextTool literal in the source parses into the runtime-neutral pair', async () => {
    // Source-derived like the description scanner: only 4 of the 9 emission
    // sites are behaviourally pinned, and a mis-spelled literal on an
    // unpinned site would silently drop the pair (the derivation omits on
    // parse failure by design). This closes that hole for every literal,
    // present and future.
    const source = await hostedSurfaceSource()
    const literals = [...source.matchAll(/nextTool: '([^']+)'/g)].map((m) => m[1])
    expect(literals.length).toBeGreaterThanOrEqual(9)
    const unparseable = literals.filter((l) => !/^mcp__([a-z0-9-]+)__([a-z0-9_]+)$/.test(l))
    expect(unparseable).toEqual([])
  })

  it('suggested_tool hints use BARE tool names — the sibling convention, never the prefixed form', async () => {
    const source = await hostedSurfaceSource()
    const all = [...source.matchAll(/suggestedTool: '([^']+)'/g)].map((m) => m[1])
    // A FLOOR, because everything below it is a negative assertion and an
    // empty input satisfies those for free. Its sibling above has one; this
    // one did not, so a later slice relocating these literals somewhere the
    // walk does not reach would have turned the check green rather than red.
    expect(
      all.length,
      'the suggestedTool scan found (almost) nothing — the probe is broken, not the code clean',
    ).toBeGreaterThanOrEqual(9)
    const prefixed = all.filter((v) => v.startsWith('mcp__'))
    expect(prefixed).toEqual([])
  })
})


/**
 * #2041 — haven_submit's erc7710 branch: the generic path's settle leg.
 *
 * On 3009 the signature funds the delegate EOA and a funding transaction has
 * to confirm. Here the signature IS the settlement child: it goes to
 * POST /x402/:id/settle and Haven hands back the assembled merchant header.
 */
describe('#2145: the hosted resume description gates on the live retry trigger', () => {
  /**
   * `RESUME_X402_DESCRIPTION` in this file is a hand-built string literal, not
   * an entry of the SDK's shared `toolDescriptions` object — so the regression
   * guard in `packages/sdk/src/tool-descriptions.test.ts` never scanned it.
   *
   * #2145 gave `retry_original_x402_request` a real producer
   * (agent-payment-status.ts emits it when the funding leg confirmed but no
   * merchant response was ever recorded). `haven_resume_x402_payment`'s
   * description must name it as the gate, and no hosted description should
   * still claim the trigger is unreachable.
   *
   * Scans the exported record, so a newly registered hosted tool is covered
   * without anyone remembering to extend this list.
   */
  it('haven_resume_x402_payment names retry_original_x402_request as its gate; nothing claims it is unreachable', () => {
    const entries = Object.entries(toolDescriptions)

    // Non-vacuity: an empty record would satisfy every assertion below.
    expect(entries.length).toBeGreaterThan(0)

    expect(toolDescriptions.haven_resume_x402_payment).toContain(
      'nextAction=retry_original_x402_request',
    )

    for (const [name, description] of entries) {
      const lower = description.toLowerCase()
      expect(
        lower,
        `${name} must not claim retry_original_x402_request is unreachable — #2145 gave it a producer`,
      ).not.toContain('not currently reachable')
      expect(
        lower,
        `${name} must not claim nothing emits a resume trigger — #2145 gave it a producer`,
      ).not.toContain('nothing emits')
    }
  })

  /**
   * #2290 wrote this test to pin that the resume description names the binding
   * step and not only the header step. The premise was wrong: it asserted the
   * description mentions haven_sign_x402 AND haven_x402_sign_header AND
   * x402_binding, which the CORRECTED #2291 wording also satisfies — the
   * corrected text names all three in order to say "do NOT chain them". So the
   * test went on passing across a contract reversal, proving only that three
   * substrings appear somewhere (review finding).
   *
   * Rewritten to pin the contract rather than the vocabulary: the resume path
   * ends at the one-shot's inline payment_header, and the description must say
   * so explicitly. Still literal-only — nothing here interprets a sentence.
   */
  it('points the resume path at the inline payment_header, not a second signer call', () => {
    const description = toolDescriptions.haven_resume_x402_payment
    expect(description).toContain('haven_sign_x402')
    expect(description).toContain('payment_header')
    // The load-bearing half: the impossible chain is named as forbidden, not
    // as the next step. A revert to either earlier wording drops this literal.
    expect(description).toContain('Do NOT pass its x402_binding to')
    expect(description).toContain('haven_x402_sign_header')
  })
})
