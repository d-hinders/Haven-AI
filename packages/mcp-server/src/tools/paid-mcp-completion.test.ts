/**
 * #2812 — the paid-MCP completion capability's own suite.
 *
 * These five `describe` blocks moved VERBATIM out of the monolithic
 * `tools.test.ts`, against the SHARED fixture from `test-support/hosted-mcp.ts`
 * (#2808) rather than a clone of it. The selection rule was mechanical, not a
 * judgement call: a block moves iff every hosted handler it invokes belongs to
 * this capability's two tools (haven_complete_mcp_tool, haven_settle_mcp_tool).
 * That is why the hosted erc7710 block (#1456) stays in the residual suite —
 * it drives haven_pay_mcp_tool (#2810) alongside this capability's
 * haven_settle_mcp_tool, so it is an assertion about the COMPOSED surface —
 * and why the #2282 fail-closed-ordering block that exercises the
 * haven_pay_x402_quote intent path only THROUGH this capability's handlers
 * moved here with its full repro commentary.
 *
 * Parity is measured on fully-qualified identities (`describe path > name`)
 * collected by vitest, not on bare names or a source grep: bare names collide
 * and a grep over `it(` cannot see `it.each` expansions. The before/after
 * figures and both SHAs are in the pull request.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import {
  AgentPaymentFailureCode,
  AgentPaymentNextAction,
  AgentPaymentPhase,
  HavenApiError,
  HavenClient,
} from '@haven_ai/sdk'
import { createToolHandlers } from '../tools.js'
import {
  AGENT_RESPONSE,
  DELEGATE_KEY,
  PAYMENT_REQUIRED,
  clearCalls,
  handlers,
  headerSignerClient,
  installSharedFixtureLifecycle,
  mintPaymentHeaders,
  mutateHeader,
  ok,
  recordedCalls,
  stubFetch,
  VALID_PAYMENT_HEADER_REF,
  type RouteDefinition,
} from '../test-support/hosted-mcp.js'

installSharedFixtureLifecycle()


beforeEach(() => {
  clearCalls()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// Headers are minted by the SDK's real signing path so these fixtures
// cannot drift from what a client actually sends (#1618 note — see the
// shared fixture's mintPaymentHeaders).
beforeAll(async () => {
  await mintPaymentHeaders()
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
        // #2312 found `max_amount: '2000000'` here. haven_settle_mcp_tool has
        // never declared it — the cap belongs on the prepare/pay leg, which is
        // where it is checked against the live quote BEFORE any funding. So
        // this test spent its life asserting a successful settle while the cap
        // it thought it had set was being silently stripped. Removed rather
        // than declared: the settle leg genuinely takes no cap.
        payment_header: VALID_PAYMENT_HEADER_REF.v1,
      }),
    )

    // Funding signature was relayed (no key in the wire), then the merchant call ran.
    const signCall = recordedCalls().find((c) => c.url.includes('/sign'))
    expect(signCall?.body).toEqual({ signature: SIG })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0].paymentId).toBe('pay_x402')
    expect(spy.mock.calls[0][0].paymentHeader).toBe(VALID_PAYMENT_HEADER_REF.v1)
    // payment_id is echoed so the agent can reconcile without retaining it.
    expect(result.data.payment_id).toBe('pay_x402')
    expect(result.data.funding_tx_hash).toBe('0xfund')
    expect(result.data.settled).toBe(true)
    expect(result.data.settlement_tx_hash).toBe('0xsettle')
    expect(JSON.stringify(recordedCalls())).not.toContain(DELEGATE_KEY)
  })

  it('accepts the current v2 payment-header envelope before funding', async () => {
    stubFetch({
      'POST /payments/pay_x402/sign': { status: 200, body: { status: 'confirmed', tx_hash: '0xfund' } },
    })
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    vi.spyOn(haven, 'completeX402MerchantCall').mockResolvedValue({ status: 200, ok: true, body: {} })

    const result = await createToolHandlers(haven).haven_settle_mcp_tool({
      payment_id: 'pay_x402', signature: SIG, merchant_url: 'http://merchant.test/mcp', tool_name: 'create_text',
      payment_header: VALID_PAYMENT_HEADER_REF.v2,
    })

    expect(result.success).toBe(true)
    expect(recordedCalls().some((call) => call.url.endsWith('/payments/pay_x402/sign'))).toBe(true)
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
    const paymentHeader = typeof mutation === 'string' ? mutation : mutation(VALID_PAYMENT_HEADER_REF.v2)
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
    expect(recordedCalls().some((call) => call.url.endsWith('/payments/pay_x402/sign'))).toBe(false)
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
        payment_header: VALID_PAYMENT_HEADER_REF.v1,
      }),
    )

    expect(result.data.settled).toBe(false)
    expect(result.data.funding_status).toBe('pending_approval')
    // payment_id is echoed on the not-settled path too, for status follow-up.
    expect(result.data.payment_id).toBe('pay_pending')
    expect(spy).not.toHaveBeenCalled()

    // #2101: this branch used to emit next_action=wait_for_user_approval beside
    // a reason telling the agent not to wait — a payload contradicting itself,
    // with the FIELD winning under the agent contract. No live rail can ever
    // resolve that wait (410 on the legacy rail per #1986; 403/502 at prepare
    // on the delegation rail; `approval_requests` dropped by #2055), so the
    // verdict is stop. This assertion was mutation-proven: it is the one that
    // was missing when the field was first corrected.
    const guidance = result.data as unknown as {
      next_action: string
      safe_to_continue: boolean
      reason: string
    }
    expect(guidance.next_action).toBe('stop_and_tell_user')
    expect(guidance.safe_to_continue).toBe(false)
    expect(guidance.reason).toContain('do not wait for an approval')
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
        payment_header: VALID_PAYMENT_HEADER_REF.v1,
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
      payment_header: VALID_PAYMENT_HEADER_REF.v1,
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
      payment_header: VALID_PAYMENT_HEADER_REF.v1,
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
      payer_address: headerSignerClient().delegateAddress,
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
      payment_header: VALID_PAYMENT_HEADER_REF.v1,
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
    expect(recordedCalls().filter((call) => call.method === 'GET' && call.url.endsWith('/machine-payments/pay_x402/status'))).toHaveLength(2)
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
        payerAddress: headerSignerClient().delegateAddress, txHash: null, expiresAt: '2099-01-01T00:00:00.000Z',
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
        payerAddress: headerSignerClient().delegateAddress, txHash: null, expiresAt: '2099-01-01T00:00:00.000Z',
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
      payment_header: VALID_PAYMENT_HEADER_REF.v1,
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
        payment_header: VALID_PAYMENT_HEADER_REF.v1,
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

// ── #2282: quote-first settle must not relay funding before the context check ─

describe('haven_settle_mcp_tool: merchant-call context is checked BEFORE funding (#2282)', () => {
  const SIG = '0x' + '11'.repeat(65)

  /** The exact wire assertion that matters: did any funding relay leave? */
  const fundingRelayed = () =>
    recordedCalls().some((call) => call.method === 'POST' && call.url.endsWith('/payments/pay_x402/sign'))

  it('does NOT relay funding when a quote-first intent has no stored merchant context', async () => {
    // The #2282 repro: an intent created by haven_pay_x402_quote, which
    // receives only the raw 402 and therefore stores no MCP call context.
    // Route the funding relay as a SUCCESS so the assertion below cannot pass
    // for the wrong reason — if the ordering regresses, the money moves.
    stubFetch({
      'POST /payments/pay_x402/sign': { status: 200, body: { status: 'confirmed', tx_hash: '0xfund' } },
    })
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    vi.spyOn(haven, 'getX402MerchantCallContext').mockRejectedValue(
      new HavenApiError(
        'No stored merchant call context for this intent — pass merchant_url, tool_name, ' +
          'arguments, and mcp_transport explicitly (version-skew fallback).',
        409,
      ),
    )
    const merchant = vi.spyOn(haven, 'completeX402MerchantCall')

    const payload = await createToolHandlers(haven).haven_settle_mcp_tool({
      payment_id: 'pay_x402',
      signature: SIG,
      payment_header: VALID_PAYMENT_HEADER_REF.v1,
    })

    // THE assertion: no funding userop was relayed. An error code alone is not
    // enough — the pre-#2282 behaviour produced this same code with the money
    // already gone, leaving a funded_but_unsettled intent.
    expect(fundingRelayed()).toBe(false)
    expect(merchant).not.toHaveBeenCalled()
    if (payload.success) throw new Error('expected a context-unavailable failure')
    expect(payload.code).toBe(AgentPaymentFailureCode.MerchantCallContextUnavailable)
    expect(payload.next_action).toBe(AgentPaymentNextAction.RetryWithExplicitContext)
  })

  it('leaves the intent retryable in place: the same tool succeeds on an explicit-context retry', async () => {
    // The point of refusing pre-funding rather than post-funding. The intent is
    // still pending_signature, so the caller re-recordedCalls() THIS tool with explicit
    // context and it settles — no tool switch to haven_complete_mcp_tool, no
    // funded_but_unsettled state to recover from.
    stubFetch({
      'POST /payments/pay_x402/sign': { status: 200, body: { status: 'confirmed', tx_hash: '0xfund' } },
    })
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    vi.spyOn(haven, 'getX402MerchantCallContext').mockRejectedValue(
      new HavenApiError('No stored merchant call context for this intent', 409),
    )
    const merchant = vi.spyOn(haven, 'completeX402MerchantCall').mockResolvedValue({
      status: 200, ok: true, body: { result: 'ok' }, settlementTxHash: '0xsettle',
    })
    const handlers = createToolHandlers(haven)

    const refused = await handlers.haven_settle_mcp_tool({
      payment_id: 'pay_x402', signature: SIG, payment_header: VALID_PAYMENT_HEADER_REF.v1,
    })
    expect(refused.success).toBe(false)
    expect(fundingRelayed()).toBe(false)

    const retry = ok<{ settled: boolean; funding_tx_hash: string | null }>(
      await handlers.haven_settle_mcp_tool({
        payment_id: 'pay_x402',
        signature: SIG,
        merchant_url: 'http://merchant.test/mcp',
        tool_name: 'buy_vpn',
        arguments: { plan: 'legacy' },
        mcp_transport: { handshake_required: true, source: 'path' },
        payment_header: VALID_PAYMENT_HEADER_REF.v1,
      }),
    )

    expect(fundingRelayed()).toBe(true)
    expect(retry.data.settled).toBe(true)
    expect(retry.data.funding_tx_hash).toBe('0xfund')
    expect(merchant.mock.calls[0][0].mcpTransport).toEqual({ handshakeRequired: true, source: 'path' })
  })

  it('does NOT submit the erc7710 settlement child when the context is unavailable', async () => {
    // The no-funding-leg scheme has the same shape: POST /x402/:id/settle
    // consumes the signed settlement child, which cannot be re-signed.
    stubFetch({})
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    vi.spyOn(haven, 'getX402MerchantCallContext').mockRejectedValue(
      new HavenApiError('No stored merchant call context for this intent', 409),
    )
    const settle = vi.spyOn(haven, 'submitX402Erc7710')
    const merchant = vi.spyOn(haven, 'completeX402MerchantCall')

    const payload = await createToolHandlers(haven).haven_settle_mcp_tool({
      payment_id: 'pay_x402',
      signature: SIG,
      // no payment_header => erc7710 branch
    })

    expect(settle).not.toHaveBeenCalled()
    expect(merchant).not.toHaveBeenCalled()
    if (payload.success) throw new Error('expected a context-unavailable failure')
    expect(payload.code).toBe(AgentPaymentFailureCode.MerchantCallContextUnavailable)
  })

  it('guided path is unchanged: a rehydrated stored context still funds and settles, resolved exactly once', async () => {
    stubFetch({
      'POST /payments/pay_x402/sign': { status: 200, body: { status: 'confirmed', tx_hash: '0xfund' } },
    })
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    const rehydrate = vi.spyOn(haven, 'getX402MerchantCallContext').mockResolvedValue({
      paymentId: 'pay_x402',
      merchantUrl: 'http://merchant.test/mcp',
      toolName: 'buy_cloud_storage',
      arguments: { tier: '50gb' },
      mcpTransport: { handshakeRequired: true, source: 'bazaar' },
    })
    const merchant = vi.spyOn(haven, 'completeX402MerchantCall').mockResolvedValue({
      status: 200, ok: true, body: { result: 'ok' }, settlementTxHash: '0xsettle',
    })

    const result = ok<{ settled: boolean }>(
      await createToolHandlers(haven).haven_settle_mcp_tool({
        payment_id: 'pay_x402', signature: SIG, payment_header: VALID_PAYMENT_HEADER_REF.v1,
      }),
    )

    expect(result.data.settled).toBe(true)
    expect(fundingRelayed()).toBe(true)
    // Moving the resolve earlier must not double it: two GETs are two chances
    // for the stored context to disagree with itself across one settle.
    expect(rehydrate).toHaveBeenCalledTimes(1)
    expect(merchant.mock.calls[0][0].mcpTransport).toEqual({ handshakeRequired: true, source: 'bazaar' })
  })
})

// ── #2282: a wrong-shaped mcp_transport is refused, never silently dropped ────

describe('mcp_transport shape is refused loudly (#2282)', () => {
  const SIG = '0x' + '11'.repeat(65)

  it.each(['haven_settle_mcp_tool', 'haven_complete_mcp_tool'] as const)(
    '%s: the SDK camelCase shape is refused with a message naming the mismatch',
    async (tool) => {
      stubFetch({
        'POST /payments/pay_x402/sign': { status: 200, body: { status: 'confirmed', tx_hash: '0xfund' } },
      })
      const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
      const merchant = vi.spyOn(haven, 'completeX402MerchantCall')

      const payload = await createToolHandlers(haven)[tool]({
        payment_id: 'pay_x402',
        // #2312: `signature` is haven_settle_mcp_tool's alone — the settle leg
        // relays the funding signature, the complete leg does not. This shared
        // fixture used to send it to BOTH, and the permissive parse dropped it
        // on the complete side without a word, so the test read as if the two
        // tools took the same arguments. Sent only where it is declared.
        ...(tool === 'haven_settle_mcp_tool' ? { signature: SIG } : {}),
        merchant_url: 'http://merchant.test/mcp',
        tool_name: 'buy_vpn',
        arguments: { plan: 'legacy' },
        // The shape @haven_ai/sdk's X402McpTransport uses.
        mcp_transport: { handshakeRequired: true, source: 'path' },
        payment_header: VALID_PAYMENT_HEADER_REF.v1,
      })

      if (payload.success) throw new Error('expected a refusal, not a permissive parse')
      expect(payload.code).toBe('INVALID_INPUT')
      // Names the problem: the key, both spellings, and which boundary wins.
      expect(payload.message).toContain('mcp_transport')
      expect(payload.message).toContain('handshake_required')
      expect(payload.message).toContain('handshakeRequired')
      expect(payload.message).toMatch(/snake_case/)
      // And it is a refusal BEFORE anything moved.
      expect(recordedCalls().some((c) => c.url.endsWith('/payments/pay_x402/sign'))).toBe(false)
      expect(merchant).not.toHaveBeenCalled()
    },
  )

  it('refuses an unknown extra key rather than stripping it (the advertised additionalProperties: false)', async () => {
    stubFetch({})
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    const merchant = vi.spyOn(haven, 'completeX402MerchantCall')

    const payload = await createToolHandlers(haven).haven_complete_mcp_tool({
      payment_id: 'pay_x402',
      merchant_url: 'http://merchant.test/mcp',
      tool_name: 'buy_vpn',
      mcp_transport: { handshake_required: true, source: 'path', handshakeRequired: true },
      payment_header: VALID_PAYMENT_HEADER_REF.v1,
    })

    if (payload.success) throw new Error('expected the extra key to be refused, not stripped')
    expect(payload.code).toBe('INVALID_INPUT')
    expect(merchant).not.toHaveBeenCalled()
  })

  it('refuses a STORED context whose transport Haven cannot parse, instead of delivering without it', async () => {
    // Defence in depth behind the tool schema: parseMcpTransport used to answer
    // `undefined` — the same value "no transport was supplied" produces — for
    // any shape it did not recognise, so a present-but-wrong transport was
    // indistinguishable from an absent one at the last point anyone could tell.
    stubFetch({
      'POST /payments/pay_x402/sign': { status: 200, body: { status: 'confirmed', tx_hash: '0xfund' } },
    })
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    vi.spyOn(haven, 'getX402MerchantCallContext').mockResolvedValue({
      paymentId: 'pay_x402',
      merchantUrl: 'http://merchant.test/mcp',
      toolName: 'buy_vpn',
      arguments: {},
      // A stored transport missing handshakeRequired (older/skewed producer).
      mcpTransport: { source: 'path' } as never,
    })
    const merchant = vi.spyOn(haven, 'completeX402MerchantCall')

    const payload = await createToolHandlers(haven).haven_settle_mcp_tool({
      payment_id: 'pay_x402',
      signature: SIG,
      payment_header: VALID_PAYMENT_HEADER_REF.v1,
    })

    if (payload.success) throw new Error('expected the unparseable stored transport to be refused')
    expect(payload.code).toBe('INVALID_INPUT')
    expect(payload.message).toContain('mcp_transport')
    // Refused pre-funding, like every other context problem on this tool.
    expect(recordedCalls().some((c) => c.url.endsWith('/payments/pay_x402/sign'))).toBe(false)
    expect(merchant).not.toHaveBeenCalled()
  })

  it('refuses a STORED context whose transport `source` is not a value Haven knows', async () => {
    // haven-reviewer (#2282, should-fix): the shape guard above proves the
    // missing-key branch; this one proves the bad-`source` branch, which the
    // tool schema's enum cannot reach because only a REHYDRATED context gets
    // here unvalidated. Same class as the rest of hazard 2 — an unrecognised
    // value must not collapse into the "no transport supplied" answer.
    stubFetch({
      'POST /payments/pay_x402/sign': { status: 200, body: { status: 'confirmed', tx_hash: '0xfund' } },
    })
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    vi.spyOn(haven, 'getX402MerchantCallContext').mockResolvedValue({
      paymentId: 'pay_x402',
      merchantUrl: 'http://merchant.test/mcp',
      toolName: 'buy_vpn',
      arguments: {},
      mcpTransport: { handshakeRequired: true, source: 'bogus' } as never,
    })
    const merchant = vi.spyOn(haven, 'completeX402MerchantCall')

    const payload = await createToolHandlers(haven).haven_settle_mcp_tool({
      payment_id: 'pay_x402',
      signature: SIG,
      payment_header: VALID_PAYMENT_HEADER_REF.v1,
    })

    if (payload.success) throw new Error('expected the unknown transport source to be refused')
    expect(payload.code).toBe('INVALID_INPUT')
    expect(payload.message).toContain('mcp_transport')
    expect(recordedCalls().some((c) => c.url.endsWith('/payments/pay_x402/sign'))).toBe(false)
    expect(merchant).not.toHaveBeenCalled()
  })

  it('a legitimate snake_case transport still settles (positive control)', async () => {
    stubFetch({
      'POST /payments/pay_x402/sign': { status: 200, body: { status: 'confirmed', tx_hash: '0xfund' } },
    })
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    const merchant = vi.spyOn(haven, 'completeX402MerchantCall').mockResolvedValue({
      status: 200, ok: true, body: { result: 'ok' }, settlementTxHash: '0xsettle',
    })

    const result = ok<{ settled: boolean }>(
      await createToolHandlers(haven).haven_settle_mcp_tool({
        payment_id: 'pay_x402',
        signature: SIG,
        merchant_url: 'http://merchant.test/mcp',
        tool_name: 'buy_vpn',
        arguments: { plan: 'legacy' },
        mcp_transport: { handshake_required: true, source: 'path' },
        payment_header: VALID_PAYMENT_HEADER_REF.v1,
      }),
    )

    expect(result.data.settled).toBe(true)
    expect(recordedCalls().some((c) => c.url.endsWith('/payments/pay_x402/sign'))).toBe(true)
    expect(merchant.mock.calls[0][0].mcpTransport).toEqual({ handshakeRequired: true, source: 'path' })
  })
})