import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { HavenClient } from '@haven_ai/sdk'
import { createToolHandlers, type ToolSuccess, type ToolPayload } from './tools.js'

const DELEGATE_KEY = '0x' + 'a'.repeat(64)
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
    calls.push({
      url,
      method,
      body: init.body ? JSON.parse(init.body as string) : undefined,
      headers: (init.headers ?? {}) as Record<string, string>,
    })
    const route = routes[`${method} ${path}`]
    const status = route?.status ?? 200
    const responseHeaders = new Headers(route?.responseHeaders ?? {})
    const bodySnapshot = route?.body
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
      payTo: '0xMerchant',
      maxTimeoutSeconds: 60,
    },
  ],
}

const X402_INTENT_RESPONSE = {
  payment_id: 'pay_x402',
  status: 'pending_signature',
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

// ── haven_pay_x402_quote ──────────────────────────────────────────────────────

describe('haven_pay_x402_quote', () => {
  it('returns the unsigned funding hash + x402 data for the edge, signing nothing', async () => {
    stubFetch({
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
    })

    const result = ok<{
      payment_id: string
      payload_hash: string
      x402: Record<string, unknown>
    }>(await handlers().haven_pay_x402_quote({ payment_required: PAYMENT_REQUIRED }))

    expect(result.data.payment_id).toBe('pay_x402')
    expect(result.data.payload_hash).toBe('0xfunding')
    expect(result.data.x402.funding_to).toBe('0xDelegate')
    expect(result.data.x402.merchant_to).toBe('0xMerchant')
    expect(result.data.x402.expected).toEqual({
      payment_id: 'pay_x402',
      payload_hash: '0xfunding',
      resource_url:
        (PAYMENT_REQUIRED.accepts[0] as { resource?: string }).resource ??
        PAYMENT_REQUIRED.resource.url,
      merchant_to: '0xMerchant',
      amount: PAYMENT_REQUIRED.accepts[0].maxAmountRequired,
      asset: PAYMENT_REQUIRED.accepts[0].asset,
      network: PAYMENT_REQUIRED.accepts[0].network,
      auth: X402_EXPECTED_AUTH,
    })

    // Custody: the funding request tops up the delegate EOA but carries no key.
    const x402Call = calls.find((c) => c.url.endsWith('/x402'))
    expect(x402Call?.body).toMatchObject({
      payTo: '0xDelegate',
      merchantPayTo: '0xMerchant',
      amount: PAYMENT_REQUIRED.accepts[0].maxAmountRequired,
    })
    expect(JSON.stringify(calls)).not.toContain(DELEGATE_KEY)
    expect(JSON.stringify(calls)).not.toContain('delegate_key')
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

describe('haven_pay_mcp_tool', () => {
  const paymentRequiredHeader = btoa(JSON.stringify(PAYMENT_REQUIRED))

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
      payload_hash: string
      merchant_url: string
      tool_name: string
      arguments: Record<string, unknown>
      payment_required: { accepts?: unknown[] }
      x402: unknown
    }>(
      await handlers().haven_pay_mcp_tool({
        merchant_url: 'http://merchant.test/mcp',
        tool_name: 'create_text',
        arguments: { prompt: 'Hello' },
      }),
    )

    expect(result.data.payment_id).toBe(X402_INTENT_RESPONSE.payment_id)
    expect(result.data.payload_hash).toBe(X402_INTENT_RESPONSE.sign_data.hash)
    // Merchant context + payment_required threaded through so the agent can
    // complete the flow (haven_x402_sign_header then haven_complete_mcp_tool).
    expect(result.data.merchant_url).toBe('http://merchant.test/mcp')
    expect(result.data.tool_name).toBe('create_text')
    expect(result.data.arguments).toEqual({ prompt: 'Hello' })
    // The raw merchant 402 PaymentRequired must be returned (the signer needs it).
    expect(result.data.payment_required).toBeDefined()
    expect(Array.isArray(result.data.payment_required.accepts)).toBe(true)
    expect(result.data.x402).toBeDefined()
    // createX402Intent was called (POST /x402 route was hit)
    expect(calls.find((c) => c.url.endsWith('/x402'))).toBeDefined()
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
        payment_header: 'eyJwYXltZW50IjoiaGVhZGVyIn0=',
      }),
    )

    expect(spy).toHaveBeenCalledTimes(1)
    const callArg = spy.mock.calls[0][0]
    expect(callArg.paymentId).toBe('pay_x402')
    expect(callArg.url).toBe('http://merchant.test/mcp')
    expect(callArg.paymentHeader).toBe('eyJwYXltZW50IjoiaGVhZGVyIn0=')
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

  it('haven_complete_mcp_tool fails with a sweep hint when the merchant rejects after funding', async () => {
    stubFetch({})
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    vi.spyOn(haven, 'completeX402MerchantCall').mockResolvedValue({
      status: 402,
      ok: false,
      body: { error: 'payment verification failed' },
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
    expect(payload.message).toContain('haven_sweep_delegate')
    expect(payload.message).toContain('402')
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

    const wire = JSON.stringify(calls)
    expect(wire).not.toContain(DELEGATE_KEY)
    expect(wire).not.toContain('delegate_key')
    expect(wire).not.toContain('private_key')
  })
})
