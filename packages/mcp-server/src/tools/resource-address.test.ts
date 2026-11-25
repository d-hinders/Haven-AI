import { beforeAll, describe, expect, it } from 'vitest'
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
import { assertChallengeAddressMatchesEndpoint, resourceAddressMismatch } from './support/resource-address.js'

/**
 * #5084: a resource-address mismatch is refused before any money moves.
 *
 * The cold run of 2026-11-25: a paid MCP tool answered with a challenge whose
 * `resource.url` was `mcp://tool/haiku` while its endpoint was
 * `https://<host>/mcp`. On EIP-3009 Haven stored the challenge's address,
 * funded the delegate, and only then did completion refuse the mismatch
 * (`resolveCompletionContext`'s 409) — the money sat on the delegate until it
 * was swept back. These pins hold the refusal on the near side of every
 * money-moving call.
 */
installSharedFixtureLifecycle()

beforeAll(async () => {
  await mintPaymentHeaders()
})

const ENDPOINT = 'http://merchant.test/mcp'
const MCP_TOOL_ADDRESS = 'mcp://tool/x'

const challengeHeader = (resource: unknown) =>
  btoa(JSON.stringify({ ...PAYMENT_REQUIRED, resource }))

const path = (c: { url: string }) => new URL(c.url).pathname
const intentRequests = () => recordedCalls().filter((c) => c.method === 'POST' && path(c) === '/x402')
const precheckRequests = () => recordedCalls().filter((c) => path(c) === '/machine-payments/budget-precheck')
const fundingRelays = () => recordedCalls().filter((c) => c.method === 'POST' && path(c) === '/payments/pay_x402/sign')
const erc7710Submits = () => recordedCalls().filter((c) => c.method === 'POST' && path(c) === '/x402/pay_x402/settle')

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

describe('haven_pay_mcp_tool (EIP-3009): the challenge address is compared with the endpoint before any intent', () => {
  it('refuses mcp://tool/x at an https endpoint with a typed error, and makes no /x402 request', async () => {
    stubFetch({
      'POST /mcp': {
        status: 402,
        responseHeaders: { 'PAYMENT-REQUIRED': challengeHeader({ url: MCP_TOOL_ADDRESS, description: 'paid tool' }) },
      },
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
    })
    const res = await handlers().haven_pay_mcp_tool(PAY)
    expect(res.success).toBe(false)
    const out = fail(res)
    expect(out.code).toBe('MERCHANT_RESOURCE_MISMATCH')
    expect(out.message).toContain(`names ${MCP_TOOL_ADDRESS} as its address, but the tool lives at ${ENDPOINT}`)
    expect(out.next_action).toBe('stop_and_tell_user')
    expect(out.next_tool_omitted_reason).toMatch(/nothing was created/)
    expect(intentRequests()).toHaveLength(0)
    // This tool makes no budget pre-check; the catalog test below proves the
    // ordering against one.
  })

  it('a challenge whose address IS the endpoint still creates the intent (control)', async () => {
    stubFetch({
      'POST /mcp': { status: 402, responseHeaders: { 'PAYMENT-REQUIRED': challengeHeader({ url: ENDPOINT, description: 'paid tool' }) } },
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
    })
    ok(await handlers().haven_pay_mcp_tool(PAY))
    expect(intentRequests()).toHaveLength(1)
  })

  it('a challenge with no resource address skips the check, as completion skips a null stored address', () => {
    // Through the tool this cannot arise: the SDK's challenge parser fills
    // resource.url (falling back to accepts[0].resource) or refuses the 402.
    // The helper still skips rather than refusing on nothing to compare.
    expect(() => assertChallengeAddressMatchesEndpoint({ ...PAYMENT_REQUIRED, resource: undefined } as never, ENDPOINT)).not.toThrow()
    expect(() => assertChallengeAddressMatchesEndpoint({ ...PAYMENT_REQUIRED, resource: { url: '' } } as never, ENDPOINT)).not.toThrow()
  })

  it('compares string for string, as completion does (no normalisation)', () => {
    expect(resourceAddressMismatch(`${ENDPOINT}/`, ENDPOINT)).toBe(true)
    expect(resourceAddressMismatch(ENDPOINT, ENDPOINT)).toBe(false)
    expect(resourceAddressMismatch(null, ENDPOINT)).toBe(false)
  })
})

describe('haven_pay_mcp_tool (ERC-7710): exempt, since that scheme stores the endpoint itself', () => {
  it('an mcp://tool/x challenge address prepares the settlement child, not a refusal', async () => {
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

describe('haven_prepare_catalog_purchase (EIP-3009): the same check, before the budget pre-check', () => {
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

  it('refuses a catalogued merchant whose challenge names another address: no pre-check, no /x402', async () => {
    stubFetch({
      'GET /catalog/cat_mcp': { status: 200, body: ENTRY },
      'POST /mcp': {
        status: 402,
        responseHeaders: { 'PAYMENT-REQUIRED': challengeHeader({ url: MCP_TOOL_ADDRESS, description: 'paid tool' }) },
      },
      // A delegation-rail agent: only that rail reaches the budget pre-check,
      // so "no pre-check" proves the ORDER (the control below reaches it).
      'GET /machine-payments/agent': { status: 200, body: DELEGATION_AGENT },
      'POST /machine-payments/budget-precheck': { status: 200, body: { sufficient: true, remaining_atomic: '5000000' } },
      'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
    })
    const res = await handlers().haven_prepare_catalog_purchase({ catalog_id: 'cat_mcp', max_amount_human: '2' })
    expect(res.success).toBe(false)
    const out = fail(res)
    expect(out.code).toBe('MERCHANT_RESOURCE_MISMATCH')
    expect(out.message).toContain(MCP_TOOL_ADDRESS)
    expect(precheckRequests()).toHaveLength(0)
    expect(intentRequests()).toHaveLength(0)
  })

  it('the same delegation-rail purchase with a matching address reaches the pre-check and the intent (control)', async () => {
    stubFetch({
      'GET /catalog/cat_mcp': { status: 200, body: ENTRY },
      'POST /mcp': { status: 402, responseHeaders: { 'PAYMENT-REQUIRED': challengeHeader({ url: ENDPOINT, description: 'paid tool' }) } },
      'GET /machine-payments/agent': { status: 200, body: DELEGATION_AGENT },
      'POST /machine-payments/budget-precheck': { status: 200, body: { sufficient: true, remaining_atomic: '5000000' } },
      'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
    })
    const res = await handlers().haven_prepare_catalog_purchase({ catalog_id: 'cat_mcp', max_amount_human: '2' })
    expect(res.success).toBe(true)
    expect(precheckRequests()).toHaveLength(1)
    expect(intentRequests()).toHaveLength(1)
  })

  it('ERC-7710 is exempt: an mcp://tool/x challenge address is prepared, since that scheme stores the endpoint', async () => {
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

describe('haven_settle_mcp_tool: an explicit merchant_url is compared with the approved address before spending', () => {
  const OTHER = 'http://merchant.test/other'
  const settle = (extra: Record<string, unknown> = {}) => ({
    payment_id: 'pay_x402',
    signature: '0x' + '11'.repeat(65),
    merchant_url: OTHER,
    tool_name: 'paid_tool',
    arguments: {},
    ...extra,
  })

  it('EIP-3009: a merchant_url that is not the approved address relays no funding', async () => {
    stubFetch({
      // The approved address (the shared preflight status) is ENDPOINT.
      'GET /machine-payments/pay_x402/status': { status: 200, body: x402PreflightStatus({ resource_url: ENDPOINT }) },
      'POST /payments/pay_x402/sign': { status: 200, body: { status: 'confirmed', tx_hash: '0xfund' } },
    })
    const res = await handlers().haven_settle_mcp_tool(settle({ payment_header: VALID_PAYMENT_HEADER_REF.v1 }))
    expect(res.success).toBe(false)
    const out = fail(res)
    expect(out.code).toBe('MERCHANT_RESOURCE_MISMATCH')
    expect(out.message).toContain(`approved for ${ENDPOINT}, but this call would deliver it to ${OTHER}`)
    expect(out.next_action).toBe('retry_with_explicit_context')
    expect(fundingRelays()).toHaveLength(0)
  })

  it('ERC-7710: the same mismatch makes no settle submit', async () => {
    stubFetch({
      'GET /machine-payments/pay_x402/status': { status: 200, body: x402PreflightStatus({ resource_url: ENDPOINT }) },
      'POST /x402/pay_x402/settle': { status: 200, body: { payment_header: 'HEADER_FROM_HAVEN' } },
    })
    const res = await handlers().haven_settle_mcp_tool(settle())
    expect(res.success).toBe(false)
    const out = fail(res)
    expect(out.code).toBe('MERCHANT_RESOURCE_MISMATCH')
    expect(erc7710Submits()).toHaveLength(0)
  })

  it('a failed read of the approved address refuses before funding (fail closed)', async () => {
    stubFetch({
      'GET /machine-payments/pay_x402/status': { status: 500, body: { error: 'unavailable' } },
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
      'GET /machine-payments/pay_x402/status': { status: 404, body: { error: 'Payment not found' } },
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
      'GET /machine-payments/pay_x402/status': { status: 429, body: { error: 'rate_limited' } },
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

  it('a payment that already moved past pending_signature is left to the relay\'s own answer', async () => {
    stubFetch({
      'GET /machine-payments/pay_x402/status': {
        status: 200,
        body: x402PreflightStatus({ resource_url: ENDPOINT, status: 'confirmed', phase: 'payment_confirmed', next_action: 'none', tx_hash: '0xfund' }),
      },
    })
    const result = await handlers().haven_settle_mcp_tool(settle({ payment_header: VALID_PAYMENT_HEADER_REF.v1 }))
    expect(result).not.toMatchObject({ code: 'MERCHANT_RESOURCE_MISMATCH' })
  })
})
