import { beforeAll, describe, expect, it, vi } from 'vitest'
import { HavenClient } from '@haven_ai/sdk'
import { createToolHandlers } from '../tools.js'
import {
  AGENT_RESPONSE,
  PAYMENT_REQUIRED,
  VALID_PAYMENT_HEADER_REF,
  X402_INTENT_RESPONSE,
  fail,
  handlers,
  installSharedFixtureLifecycle,
  mintPaymentHeaders,
  ok,
  recordedCalls,
  stubFetch,
  x402PreflightStatus,
} from '../test-support/hosted-mcp.js'
import { resourceAddressMismatch } from './support/resource-address.js'

/**
 * #5084 / #5086: where a paid MCP payment may be delivered, decided before
 * the money moves.
 *
 * The cold run of 2026-11-25: a paid MCP tool answered with a challenge whose
 * `resource.url` was `mcp://tool/haiku` while its endpoint was
 * `https://<host>/mcp`. On EIP-3009 Haven stored the challenge's address,
 * funded the delegate, and only then did completion refuse the mismatch.
 * #5084 refused it before the intent; #5086 (owner decision (a1), "Check
 * against the stored server address") makes it PAYABLE: delivery is checked
 * against the MCP endpoint Haven stored with the payment's call context, and
 * the payment's address keeps the merchant's declared value. These pins hold
 * both halves: the declared address is accepted, and a signed header still
 * goes nowhere but the stored endpoint.
 */
installSharedFixtureLifecycle()

beforeAll(async () => {
  await mintPaymentHeaders()
})

const ENDPOINT = 'http://merchant.test/mcp'
const MCP_TOOL_ADDRESS = 'mcp://tool/x'
const OTHER = 'http://merchant.test/other'

const challengeHeader = (resource: unknown) =>
  btoa(JSON.stringify({ ...PAYMENT_REQUIRED, resource }))

const path = (c: { url: string }) => new URL(c.url).pathname
const intentRequests = () => recordedCalls().filter((c) => c.method === 'POST' && path(c) === '/x402')
const precheckRequests = () => recordedCalls().filter((c) => path(c) === '/machine-payments/budget-precheck')
const fundingRelays = () => recordedCalls().filter((c) => c.method === 'POST' && path(c) === '/payments/pay_x402/sign')
const erc7710Submits = () => recordedCalls().filter((c) => c.method === 'POST' && path(c) === '/x402/pay_x402/settle')
const merchantCalls = () => recordedCalls().filter((c) => new URL(c.url).host === 'merchant.test')

const PAY = { merchant_url: ENDPOINT, tool_name: 'paid_tool', arguments: {}, max_amount: '2000000' }

const DELEGATION_AGENT = { ...AGENT_RESPONSE, execution_rail: 'delegation' }
/** A challenge that also offers erc7710 (the #1456 fixture's shape), naming `url` as its address. */
const erc7710Header = (url: string) =>
  btoa(
    JSON.stringify({
      ...PAYMENT_REQUIRED,
      resource: { url, description: 'paid tool' },
      accepts: [
        ...PAYMENT_REQUIRED.accepts,
        {
          ...PAYMENT_REQUIRED.accepts[0],
          extra: { assetTransferMethod: 'erc7710', facilitatorAddresses: ['0x4444444444444444444444444444444444444444'] },
        },
      ],
    }),
  )
const CHILD = {
  payment_id: 'pay_7710',
  status: 'pending_signature',
  sign_data: {
    hash: '0x' + '11'.repeat(32),
    signature_scheme: 'eip712_delegation',
    typed_data: { domain: {}, types: {}, primaryType: 'Delegation', message: { caveats: [] } },
  },
}

/** The stored MCP call context, as the backend answers it. */
const storedContext = (merchantUrl: string) => ({
  status: 200 as const,
  body: { payment_id: 'pay_x402', merchant_url: merchantUrl, tool_name: 'paid_tool', arguments: {} },
})
const NO_STORED_CONTEXT = {
  status: 409 as const,
  body: { error: 'No stored merchant call context for this intent', error_code: 'merchant_call_context_unavailable' },
}

describe('haven_pay_mcp_tool (EIP-3009): an mcp://tool/<name> address is payable (#5086)', () => {
  it('creates the intent with the merchant\'s declared address and the discovered endpoint as the stored context', async () => {
    stubFetch({
      'POST /mcp': {
        status: 402,
        responseHeaders: { 'PAYMENT-REQUIRED': challengeHeader({ url: MCP_TOOL_ADDRESS, description: 'paid tool' }) },
      },
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
    })
    const res = await handlers().haven_pay_mcp_tool(PAY)
    expect(res.success).toBe(true)
    expect(intentRequests()).toHaveLength(1)
    const body = intentRequests()[0].body as Record<string, any>
    // The payment's identity stays the merchant's declared address (what the
    // signer binds and the funding evidence report carries) …
    expect(body.url).toBe(MCP_TOOL_ADDRESS)
    // … and the endpoint delivery is checked against is the one Haven called.
    expect(body.mcpCallContext?.merchantUrl).toBe(ENDPOINT)
  })

  it('compares string for string, as completion does (no normalisation)', () => {
    expect(resourceAddressMismatch(`${ENDPOINT}/`, ENDPOINT)).toBe(true)
    expect(resourceAddressMismatch(ENDPOINT, ENDPOINT)).toBe(false)
    expect(resourceAddressMismatch(null, ENDPOINT)).toBe(false)
  })
})

describe('haven_pay_mcp_tool (ERC-7710): unchanged — that scheme stores the endpoint itself', () => {
  it('an mcp://tool/x challenge address prepares the settlement child', async () => {
    stubFetch({
      'POST /mcp': { status: 402, responseHeaders: { 'PAYMENT-REQUIRED': erc7710Header(MCP_TOOL_ADDRESS) } },
      'GET /machine-payments/agent': { status: 200, body: DELEGATION_AGENT },
      'POST /x402': { status: 201, body: CHILD },
    })
    const res = await handlers().haven_pay_mcp_tool(PAY)
    expect(res.success).toBe(true)
    expect(intentRequests()).toHaveLength(1)
    expect(intentRequests()[0].body?.settlementScheme).toBe('erc7710')
  })
})

describe('haven_prepare_catalog_purchase (EIP-3009): an mcp://tool/<name> address is payable (#5086)', () => {
  const ENTRY = {
    id: 'cat_mcp',
    name: 'paid_tool',
    description: 'A paid MCP tool',
    category: 'ai',
    resource_url: ENDPOINT,
    rail: 'x402',
    protocol: 'mcp',
    tool_name: 'paid_tool',
    tool_arguments: {},
    price_display: '$1.50 USDC',
    price_atomic: '1500000',
    asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    network: 'eip155:8453',
    status: 'active',
    verified_at: '2026-06-16T08:50:39.772Z',
  }

  it('a catalogued merchant whose challenge names mcp://tool/x reaches the pre-check and the intent', async () => {
    stubFetch({
      'GET /catalog/cat_mcp': { status: 200, body: ENTRY },
      'POST /mcp': {
        status: 402,
        responseHeaders: { 'PAYMENT-REQUIRED': challengeHeader({ url: MCP_TOOL_ADDRESS, description: 'paid tool' }) },
      },
      'GET /machine-payments/agent': { status: 200, body: DELEGATION_AGENT },
      'POST /machine-payments/budget-precheck': { status: 200, body: { sufficient: true, remaining_atomic: '5000000' } },
      'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
    })
    const res = await handlers().haven_prepare_catalog_purchase({ catalog_id: 'cat_mcp', max_amount_human: '2' })
    expect(res.success).toBe(true)
    expect(precheckRequests()).toHaveLength(1)
    expect(intentRequests()).toHaveLength(1)
    const body = intentRequests()[0].body as Record<string, any>
    expect(body.url).toBe(MCP_TOOL_ADDRESS)
    expect(body.mcpCallContext?.merchantUrl).toBe(ENDPOINT)
  })

  it('ERC-7710 is unchanged: an mcp://tool/x challenge address is prepared', async () => {
    stubFetch({
      'GET /catalog/cat_mcp': { status: 200, body: ENTRY },
      'POST /mcp': { status: 402, responseHeaders: { 'PAYMENT-REQUIRED': erc7710Header(MCP_TOOL_ADDRESS) } },
      'GET /machine-payments/agent': { status: 200, body: DELEGATION_AGENT },
      'POST /machine-payments/budget-precheck': { status: 200, body: { sufficient: true, remaining_atomic: '5000000' } },
      'POST /x402': { status: 201, body: CHILD },
    })
    const res = await handlers().haven_prepare_catalog_purchase({ catalog_id: 'cat_mcp', max_amount_human: '2' })
    expect(res.success).toBe(true)
    expect(intentRequests()).toHaveLength(1)
    expect(intentRequests()[0].body?.settlementScheme).toBe('erc7710')
  })
})

describe('haven_settle_mcp_tool: delivery is bound to the stored endpoint before spending (#5086)', () => {
  const settle = (extra: Record<string, unknown> = {}) => ({
    payment_id: 'pay_x402',
    signature: '0x' + '11'.repeat(65),
    merchant_url: OTHER,
    tool_name: 'paid_tool',
    arguments: {},
    ...extra,
  })

  it('EIP-3009: an explicit merchant_url that is not the stored endpoint relays no funding', async () => {
    stubFetch({
      'GET /x402/pay_x402/merchant-call-context': storedContext(ENDPOINT),
      'POST /payments/pay_x402/sign': { status: 200, body: { status: 'confirmed', tx_hash: '0xfund' } },
    })
    const res = await handlers().haven_settle_mcp_tool(settle({ payment_header: VALID_PAYMENT_HEADER_REF.v1 }))
    expect(res.success).toBe(false)
    const out = fail(res)
    expect(out.code).toBe('MERCHANT_RESOURCE_MISMATCH')
    expect(out.message).toContain(`approved for the MCP endpoint ${ENDPOINT}, but this call would deliver it to ${OTHER}`)
    expect(out.next_action).toBe('retry_with_explicit_context')
    // Per call, never "nothing was funded": a repeated settle of a funded
    // payment reaches this refusal too.
    expect(out.next_tool_omitted_reason).toBe(
      're-call the same tool without merchant_url (Haven rehydrates the stored context) or with merchant_url set to the approved endpoint the message names; this call funded and submitted nothing',
    )
    expect(fundingRelays()).toHaveLength(0)
  })

  it('ERC-7710: the same mismatch makes no settle submit', async () => {
    stubFetch({
      'GET /x402/pay_x402/merchant-call-context': storedContext(ENDPOINT),
      'POST /x402/pay_x402/settle': { status: 200, body: { payment_header: 'HEADER_FROM_HAVEN' } },
    })
    const res = await handlers().haven_settle_mcp_tool(settle())
    expect(res.success).toBe(false)
    expect(fail(res).code).toBe('MERCHANT_RESOURCE_MISMATCH')
    expect(erc7710Submits()).toHaveLength(0)
  })

  it('the stored endpoint, not the explicit URL, is what completion is bound to — on a matching explicit settle', async () => {
    stubFetch({
      'GET /x402/pay_x402/merchant-call-context': storedContext(ENDPOINT),
      'POST /payments/pay_x402/sign': { status: 200, body: { status: 'confirmed', tx_hash: '0xfund' } },
    })
    const haven = new HavenClient({ apiKey: 'test-key', baseUrl: 'http://haven.test' })
    vi.spyOn(haven, 'ensureFundingConfirmed').mockResolvedValue(undefined)
    const complete = vi.spyOn(haven, 'completeX402MerchantCall').mockResolvedValue({
      status: 200, ok: true, body: { result: 'ok' }, settlementEvidenceOutcome: { outcome: 'confirmed' },
    } as never)
    await createToolHandlers(haven).haven_settle_mcp_tool(settle({ merchant_url: ENDPOINT, payment_header: VALID_PAYMENT_HEADER_REF.v1 }))
    expect(complete).toHaveBeenCalledTimes(1)
    expect(complete.mock.calls[0][0]).toMatchObject({ url: ENDPOINT, approvedEndpoint: ENDPOINT })
  })

  it('a rehydrated settle binds completion to the stored endpoint (no address-column comparison)', async () => {
    stubFetch({
      'GET /x402/pay_x402/merchant-call-context': storedContext(ENDPOINT),
      'POST /payments/pay_x402/sign': { status: 200, body: { status: 'confirmed', tx_hash: '0xfund' } },
    })
    const haven = new HavenClient({ apiKey: 'test-key', baseUrl: 'http://haven.test' })
    vi.spyOn(haven, 'ensureFundingConfirmed').mockResolvedValue(undefined)
    const complete = vi.spyOn(haven, 'completeX402MerchantCall').mockResolvedValue({
      status: 200, ok: true, body: { result: 'ok' }, settlementEvidenceOutcome: { outcome: 'confirmed' },
    } as never)
    await createToolHandlers(haven).haven_settle_mcp_tool({
      payment_id: 'pay_x402',
      signature: '0x' + '11'.repeat(65),
      payment_header: VALID_PAYMENT_HEADER_REF.v1,
    })
    expect(complete).toHaveBeenCalledTimes(1)
    expect(complete.mock.calls[0][0]).toMatchObject({ url: ENDPOINT, approvedEndpoint: ENDPOINT })
  })

  it('compares with the stored endpoint string for string: a trailing slash is a different endpoint', async () => {
    stubFetch({
      'GET /x402/pay_x402/merchant-call-context': storedContext(ENDPOINT),
      'POST /payments/pay_x402/sign': { status: 200, body: { status: 'confirmed', tx_hash: '0xfund' } },
    })
    const res = await handlers().haven_settle_mcp_tool(settle({ merchant_url: `${ENDPOINT}/`, payment_header: VALID_PAYMENT_HEADER_REF.v1 }))
    expect(res.success).toBe(false)
    expect(fail(res).code).toBe('MERCHANT_RESOURCE_MISMATCH')
    expect(fundingRelays()).toHaveLength(0)
  })

  it('an expired payment (410 on the context read) answers the expired-window refusal', async () => {
    stubFetch({
      'GET /x402/pay_x402/merchant-call-context': { status: 410, body: { payment_id: 'pay_x402', status: 'expired', error_code: 'expired' } },
      'POST /payments/pay_x402/sign': { status: 200, body: { status: 'confirmed', tx_hash: '0xfund' } },
    })
    const res = await handlers().haven_settle_mcp_tool(settle({ payment_header: VALID_PAYMENT_HEADER_REF.v1 }))
    expect(res.success).toBe(false)
    expect(fail(res).code).toBe('PAYMENT_WINDOW_EXPIRED')
    expect(fundingRelays()).toHaveLength(0)
  })

  it('an explicit settle reads the stored context once (the delivery check also feeds checkout details)', async () => {
    stubFetch({
      'GET /x402/pay_x402/merchant-call-context': storedContext(ENDPOINT),
      'POST /payments/pay_x402/sign': { status: 200, body: { status: 'confirmed', tx_hash: '0xfund' } },
    })
    const haven = new HavenClient({ apiKey: 'test-key', baseUrl: 'http://haven.test' })
    vi.spyOn(haven, 'ensureFundingConfirmed').mockResolvedValue(undefined)
    vi.spyOn(haven, 'completeX402MerchantCall').mockResolvedValue({
      status: 200, ok: true, body: { result: 'ok' }, settlementEvidenceOutcome: { outcome: 'confirmed' },
    } as never)
    await createToolHandlers(haven).haven_settle_mcp_tool(settle({ merchant_url: ENDPOINT, payment_header: VALID_PAYMENT_HEADER_REF.v1 }))
    expect(recordedCalls().filter((c) => path(c) === '/x402/pay_x402/merchant-call-context')).toHaveLength(1)
  })

  it('no stored context (409): the context is read once, not again for checkout details', async () => {
    stubFetch({
      'GET /x402/pay_x402/merchant-call-context': NO_STORED_CONTEXT,
      'POST /payments/pay_x402/sign': { status: 200, body: { status: 'confirmed', tx_hash: '0xfund' } },
    })
    const haven = new HavenClient({ apiKey: 'test-key', baseUrl: 'http://haven.test' })
    vi.spyOn(haven, 'ensureFundingConfirmed').mockResolvedValue(undefined)
    vi.spyOn(haven, 'completeX402MerchantCall').mockResolvedValue({
      status: 200, ok: true, body: { result: 'ok' }, settlementEvidenceOutcome: { outcome: 'confirmed' },
    } as never)
    await createToolHandlers(haven).haven_settle_mcp_tool(settle({ merchant_url: ENDPOINT, payment_header: VALID_PAYMENT_HEADER_REF.v1 }))
    expect(recordedCalls().filter((c) => path(c) === '/x402/pay_x402/merchant-call-context')).toHaveLength(1)
  })

  it('no stored context (409): falls back to the payment\'s address, still before funding', async () => {
    stubFetch({
      'GET /x402/pay_x402/merchant-call-context': NO_STORED_CONTEXT,
      'GET /machine-payments/pay_x402/status': { status: 200, body: x402PreflightStatus({ resource_url: ENDPOINT }) },
      'POST /payments/pay_x402/sign': { status: 200, body: { status: 'confirmed', tx_hash: '0xfund' } },
    })
    const res = await handlers().haven_settle_mcp_tool(settle({ payment_header: VALID_PAYMENT_HEADER_REF.v1 }))
    expect(res.success).toBe(false)
    const out = fail(res)
    expect(out.code).toBe('MERCHANT_RESOURCE_MISMATCH')
    expect(out.message).toContain(`approved for ${ENDPOINT}, but this call would deliver it to ${OTHER}`)
    expect(fundingRelays()).toHaveLength(0)
  })

  it('no stored context and a payment past pending_signature: left to the relay\'s own answer', async () => {
    stubFetch({
      'GET /x402/pay_x402/merchant-call-context': NO_STORED_CONTEXT,
      'GET /machine-payments/pay_x402/status': {
        status: 200,
        body: x402PreflightStatus({ resource_url: ENDPOINT, status: 'confirmed', phase: 'payment_confirmed', next_action: 'none', tx_hash: '0xfund' }),
      },
    })
    const result = await handlers().haven_settle_mcp_tool(settle({ payment_header: VALID_PAYMENT_HEADER_REF.v1 }))
    expect(result).not.toMatchObject({ code: 'MERCHANT_RESOURCE_MISMATCH' })
  })

  it('a failed read of the stored context (5xx) refuses before funding (fail closed)', async () => {
    stubFetch({
      'GET /x402/pay_x402/merchant-call-context': { status: 500, body: { error: 'unavailable' } },
      'POST /payments/pay_x402/sign': { status: 200, body: { status: 'confirmed', tx_hash: '0xfund' } },
    })
    const res = await handlers().haven_settle_mcp_tool(settle({ payment_header: VALID_PAYMENT_HEADER_REF.v1 }))
    expect(res.success).toBe(false)
    const out = fail(res)
    expect(out.code).toBe('PAYMENT_STATE_UNAVAILABLE')
    expect(out.message).toMatch(/This call sent nothing/)
    expect(out.next_tool_name).toBe('haven_get_payment_status')
    expect(out.next_arguments).toEqual({ payment_id: 'pay_x402' })
    expect(fundingRelays()).toHaveLength(0)
  })

  it('a deterministic 4xx on that read stops (no status-read loop), still before funding', async () => {
    stubFetch({
      'GET /x402/pay_x402/merchant-call-context': { status: 404, body: { error: 'Payment intent not found' } },
      'POST /payments/pay_x402/sign': { status: 200, body: { status: 'confirmed', tx_hash: '0xfund' } },
    })
    const res = await handlers().haven_settle_mcp_tool(settle({ payment_header: VALID_PAYMENT_HEADER_REF.v1 }))
    expect(res.success).toBe(false)
    const out = fail(res)
    expect(out.code).toBe('PAYMENT_STATE_UNAVAILABLE')
    expect(out.next_action).toBe('stop_and_tell_user')
    expect(out.next_tool_name).toBeUndefined()
    expect(fundingRelays()).toHaveLength(0)
  })

  it('a 429 on that read is not deterministic: it hands the status read, not a stop', async () => {
    stubFetch({
      'GET /x402/pay_x402/merchant-call-context': { status: 429, body: { error: 'rate_limited' } },
      'POST /payments/pay_x402/sign': { status: 200, body: { status: 'confirmed', tx_hash: '0xfund' } },
    })
    const res = await handlers().haven_settle_mcp_tool(settle({ payment_header: VALID_PAYMENT_HEADER_REF.v1 }))
    expect(res.success).toBe(false)
    const out = fail(res)
    expect(out.code).toBe('PAYMENT_STATE_UNAVAILABLE')
    expect(out.next_action).toBe('check_status_later')
    expect(out.next_tool_name).toBe('haven_get_payment_status')
    expect(fundingRelays()).toHaveLength(0)
  })

  it('the no-stored-context fallback: a failed status read (5xx) still refuses before funding', async () => {
    stubFetch({
      'GET /x402/pay_x402/merchant-call-context': NO_STORED_CONTEXT,
      'GET /machine-payments/pay_x402/status': { status: 500, body: { error: 'unavailable' } },
      'POST /payments/pay_x402/sign': { status: 200, body: { status: 'confirmed', tx_hash: '0xfund' } },
    })
    const res = await handlers().haven_settle_mcp_tool(settle({ payment_header: VALID_PAYMENT_HEADER_REF.v1 }))
    expect(res.success).toBe(false)
    expect(fail(res).code).toBe('PAYMENT_STATE_UNAVAILABLE')
    expect(fundingRelays()).toHaveLength(0)
  })
})

describe('haven_complete_mcp_tool: an explicit, different merchant_url is refused before delivery (#5086)', () => {
  it('after haven_submit funded it, a merchant_url that is not the stored endpoint never reaches a merchant', async () => {
    stubFetch({
      'GET /x402/pay_x402/merchant-call-context': storedContext(ENDPOINT),
      'POST /other': { status: 200, body: { jsonrpc: '2.0', id: 1, result: { content: [] } } },
    })
    const haven = new HavenClient({ apiKey: 'test-key', baseUrl: 'http://haven.test' })
    const funding = vi.spyOn(haven, 'ensureFundingConfirmed').mockResolvedValue(undefined)
    const complete = vi.spyOn(haven, 'completeX402MerchantCall')
    const res = await createToolHandlers(haven).haven_complete_mcp_tool({
      payment_id: 'pay_x402',
      merchant_url: OTHER,
      tool_name: 'paid_tool',
      arguments: {},
      payment_header: VALID_PAYMENT_HEADER_REF.v1,
    })
    expect(res.success).toBe(false)
    const out = fail(res)
    expect(out.code).toBe('MERCHANT_RESOURCE_MISMATCH')
    expect(out.message).toMatch(/the payment header was not sent to any merchant/)
    expect(complete).not.toHaveBeenCalled()
    expect(funding).not.toHaveBeenCalled()
    expect(merchantCalls()).toHaveLength(0)
  })

  it('the matching explicit merchant_url is delivered, bound to the stored endpoint', async () => {
    stubFetch({ 'GET /x402/pay_x402/merchant-call-context': storedContext(ENDPOINT) })
    const haven = new HavenClient({ apiKey: 'test-key', baseUrl: 'http://haven.test' })
    vi.spyOn(haven, 'ensureFundingConfirmed').mockResolvedValue(undefined)
    const complete = vi.spyOn(haven, 'completeX402MerchantCall').mockResolvedValue({
      status: 200, ok: true, body: { result: 'ok' }, settlementEvidenceOutcome: { outcome: 'confirmed' },
    } as never)
    ok(
      await createToolHandlers(haven).haven_complete_mcp_tool({
        payment_id: 'pay_x402',
        merchant_url: ENDPOINT,
        tool_name: 'paid_tool',
        arguments: {},
        payment_header: VALID_PAYMENT_HEADER_REF.v1,
      }),
    )
    expect(complete.mock.calls[0][0]).toMatchObject({ url: ENDPOINT, approvedEndpoint: ENDPOINT })
  })

  it('a rehydrated complete (after haven_submit) of an mcp://tool/x payment is bound to the stored endpoint', async () => {
    stubFetch({ 'GET /x402/pay_x402/merchant-call-context': storedContext(ENDPOINT) })
    const haven = new HavenClient({ apiKey: 'test-key', baseUrl: 'http://haven.test' })
    vi.spyOn(haven, 'ensureFundingConfirmed').mockResolvedValue(undefined)
    const complete = vi.spyOn(haven, 'completeX402MerchantCall').mockResolvedValue({
      status: 200, ok: true, body: { result: 'ok' }, settlementEvidenceOutcome: { outcome: 'confirmed' },
    } as never)
    ok(await createToolHandlers(haven).haven_complete_mcp_tool({ payment_id: 'pay_x402', payment_header: VALID_PAYMENT_HEADER_REF.v1 }))
    // Without approvedEndpoint, completion would compare mcp://tool/x with the
    // endpoint and refuse after funding — the stranded payment #5084 fixed.
    expect(complete.mock.calls[0][0]).toMatchObject({ url: ENDPOINT, approvedEndpoint: ENDPOINT })
  })

  it('no stored context (409): completion keeps the address comparison (no approvedEndpoint passed)', async () => {
    stubFetch({ 'GET /x402/pay_x402/merchant-call-context': NO_STORED_CONTEXT })
    const haven = new HavenClient({ apiKey: 'test-key', baseUrl: 'http://haven.test' })
    vi.spyOn(haven, 'ensureFundingConfirmed').mockResolvedValue(undefined)
    const complete = vi.spyOn(haven, 'completeX402MerchantCall').mockResolvedValue({
      status: 200, ok: true, body: { result: 'ok' }, settlementEvidenceOutcome: { outcome: 'confirmed' },
    } as never)
    ok(
      await createToolHandlers(haven).haven_complete_mcp_tool({
        payment_id: 'pay_x402',
        merchant_url: ENDPOINT,
        tool_name: 'paid_tool',
        arguments: {},
        payment_header: VALID_PAYMENT_HEADER_REF.v1,
      }),
    )
    expect(complete.mock.calls[0][0]).not.toHaveProperty('approvedEndpoint')
  })
})
