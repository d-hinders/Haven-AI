import { afterEach, describe, expect, it, vi } from 'vitest'
import { HavenClient } from './client.js'

const baseUrl = 'https://haven.example'

describe('agent info helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('maps the authenticated agent identity', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        id: 'agent-1',
        name: 'Research agent',
        status: 'active',
        safe_address: '0xSafe',
        delegate_address: '0xDelegate',
        chain_id: 8453,
        execution_rail: 'legacy',
      })),
    )

    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl })

    await expect(haven.getAgent()).resolves.toEqual({
      id: 'agent-1',
      name: 'Research agent',
      status: 'active',
      safeAddress: '0xSafe',
      delegateAddress: '0xDelegate',
      chainId: 8453,
      executionRail: 'legacy',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      `${baseUrl}/machine-payments/agent`,
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer sk_agent_test',
        }),
      }),
    )
  })

  it('maps allowance summaries', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(allowancesResponse())

    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl })

    await expect(haven.getAllowances()).resolves.toEqual(mappedAllowances)
  })

  it('executes the get_allowances tool with the same allowance summary mapping', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(allowancesResponse())

    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl })

    await expect(haven.executeTool('get_allowances', {})).resolves.toEqual(mappedAllowances)
  })

  it('getAgentSummary folds identity + live remaining allowance into a ready bootstrap', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url)
      if (u.endsWith('/machine-payments/agent')) return agentResponse('active')
      if (u.endsWith('/machine-payments/allowances')) return allowancesResponse()
      throw new Error(`unexpected fetch: ${u}`)
    })

    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl })

    await expect(haven.getAgentSummary()).resolves.toEqual({
      id: 'agent-1',
      name: 'Research agent',
      status: 'active',
      safeAddress: '0xSafe',
      delegateAddress: '0xDelegate',
      chainId: 8453,
      executionRail: 'legacy',
      readiness: 'ready',
      allowances: [{
        tokenSymbol: 'USDC',
        remainingAtomic: '7500',
        remainingDisplay: '0.0075 USDC',
        configuredAmount: '10000',
        resetPeriodMin: 60,
        isResetPending: false,
      }],
    })
  })

  it('getAgentSummary reports needs_approval when active with no remaining allowance', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url)
      if (u.endsWith('/machine-payments/agent')) return agentResponse('active')
      if (u.endsWith('/machine-payments/allowances')) return allowancesResponse({ remaining: '0' })
      throw new Error(`unexpected fetch: ${u}`)
    })

    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl })
    const summary = await haven.getAgentSummary()

    expect(summary.readiness).toBe('needs_approval')
    expect(summary.allowances[0]).toMatchObject({ remainingAtomic: '0', remainingDisplay: '0.0 USDC' })
  })

  it('getAgentSummary derives ready from a delegation-rail derived budget (#1135)', async () => {
    // The delegation rail's /allowances view reports the active delegation's
    // period budget as remaining (amount = remaining = budget, spent = 0,
    // no AllowanceModule nonce). Readiness must derive ready from it with no
    // rail-specific SDK logic.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url)
      if (u.endsWith('/machine-payments/agent')) return agentResponse('active', 'delegation')
      if (u.endsWith('/machine-payments/allowances')) {
        return delegationAllowancesResponse([{ tokenAddress: USDC_BASE, tokenSymbol: 'USDC', budgetAtomic: '10000000' }])
      }
      throw new Error(`unexpected fetch: ${u}`)
    })

    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl })
    const summary = await haven.getAgentSummary()

    expect(summary.executionRail).toBe('delegation')
    expect(summary.readiness).toBe('ready')
    expect(summary.allowances[0]).toMatchObject({
      tokenSymbol: 'USDC',
      remainingAtomic: '10000000',
      remainingDisplay: '10.0 USDC',
    })
  })

  it('getAgentSummary reports needs_approval when a delegation agent has NO active budget (#1135)', async () => {
    // No active delegation → the endpoint returns an empty allowances array.
    // Readiness must stay honest: nothing spendable means needs_approval,
    // not an unconditionally optimistic ready.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url)
      if (u.endsWith('/machine-payments/agent')) return agentResponse('active')
      if (u.endsWith('/machine-payments/allowances')) return delegationAllowancesResponse([])
      throw new Error(`unexpected fetch: ${u}`)
    })

    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl })
    const summary = await haven.getAgentSummary()

    expect(summary.readiness).toBe('needs_approval')
    expect(summary.allowances).toEqual([])
  })

  it('getAgentSummary reports revoked when the credential is not active, regardless of allowance', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url)
      if (u.endsWith('/machine-payments/agent')) return agentResponse('revoked')
      if (u.endsWith('/machine-payments/allowances')) return allowancesResponse()
      throw new Error(`unexpected fetch: ${u}`)
    })

    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl })

    await expect(haven.getAgentSummary()).resolves.toMatchObject({ readiness: 'revoked' })
  })

  it('getAgentSummary formats an 18-decimal token (EURe) correctly', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url)
      if (u.endsWith('/machine-payments/agent')) return agentResponse('active')
      if (u.endsWith('/machine-payments/allowances')) {
        // 1.5 EURe = 1.5 * 10^18 atomic.
        return allowancesResponse({ tokenAddress: EURE_GNOSIS, tokenSymbol: 'EURe', remaining: '1500000000000000000' })
      }
      throw new Error(`unexpected fetch: ${u}`)
    })

    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl })
    const summary = await haven.getAgentSummary()

    expect(summary.allowances[0]).toMatchObject({
      tokenSymbol: 'EURe',
      remainingAtomic: '1500000000000000000',
      remainingDisplay: '1.5 EURe',
    })
  })

  it('getAgentSummary surfaces the exact atomic value (flagged) for an unregistered token', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url)
      if (u.endsWith('/machine-payments/agent')) return agentResponse('active')
      if (u.endsWith('/machine-payments/allowances')) {
        return allowancesResponse({ tokenAddress: '0xUnregisteredToken', tokenSymbol: 'FOO', remaining: '12345' })
      }
      throw new Error(`unexpected fetch: ${u}`)
    })

    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl })
    const summary = await haven.getAgentSummary()

    // No decimals guess — show the atomic value flagged, so the agent can't
    // misread a wrong-by-orders-of-magnitude decimal amount.
    expect(summary.allowances[0].remainingDisplay).toBe('12345 FOO (atomic; unknown decimals)')
  })

  it('maps receipt listings and omits proof header values', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        receipts: [{
          id: 'receipt-1',
          payment_id: 'payment-1',
          rail: 'x402',
          proof_status: 'payment_confirmed',
          tx_hash: `0x${'ab'.repeat(32)}`,
          chain_id: 8453,
          resource_url: 'https://paid.example/data',
          merchant_address: '0xMerchant',
          payer_address: '0xSafe',
          settlement_address: '0xMerchant',
          token_symbol: 'USDC',
          token_address: '0xToken',
          amount_raw: '20000',
          amount_human: '0.02',
          challenge_id: null,
          idempotency_key: 'x402:test',
          challenge_payload: { x402Version: 2 },
          selected_payment: { scheme: 'exact' },
          payment_proof_header_name: 'X-PAYMENT',
          protocol_receipt_header_name: 'PAYMENT-RESPONSE',
          protocol_receipt_payload: { success: true },
          merchant_status: 200,
          confirmed_at: '2026-05-15T12:00:00.000Z',
          created_at: '2026-05-15T12:00:01.000Z',
          updated_at: '2026-05-15T12:00:01.000Z',
        }],
      })),
    )

    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl })

    await expect(haven.listReceipts({ limit: 10 })).resolves.toEqual([{
      id: 'receipt-1',
      paymentId: 'payment-1',
      rail: 'x402',
      proofStatus: 'payment_confirmed',
      txHash: `0x${'ab'.repeat(32)}`,
      chainId: 8453,
      resourceUrl: 'https://paid.example/data',
      merchantAddress: '0xMerchant',
      payerAddress: '0xSafe',
      settlementAddress: '0xMerchant',
      tokenSymbol: 'USDC',
      tokenAddress: '0xToken',
      amountRaw: '20000',
      amount: '0.02',
      challengeId: null,
      idempotencyKey: 'x402:test',
      challengePayload: { x402Version: 2 },
      selectedPayment: { scheme: 'exact' },
      paymentProofHeaderName: 'X-PAYMENT',
      protocolReceiptHeaderName: 'PAYMENT-RESPONSE',
      protocolReceiptPayload: { success: true },
      merchantStatus: 200,
      confirmedAt: '2026-05-15T12:00:00.000Z',
      createdAt: '2026-05-15T12:00:01.000Z',
      updatedAt: '2026-05-15T12:00:01.000Z',
    }])
  })
})

describe('getPostPurchaseAllowanceSummary (#1310)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('legacy rail: reports remaining_atomic through the SAME source as getAllowances (parity, not similarity)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url)
      if (u.endsWith('/machine-payments/pay_1/status')) return paymentStatusResponse()
      if (u.endsWith('/machine-payments/agent')) return agentResponse('active')
      if (u.endsWith('/machine-payments/allowances')) return allowancesResponse({ remaining: '3500000' })
      throw new Error(`unexpected fetch: ${u}`)
    })

    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl })
    const [summary, allowances] = await Promise.all([
      haven.getPostPurchaseAllowanceSummary('pay_1'),
      haven.getAllowances(),
    ])

    expect(summary).toEqual({
      allowance: {
        rail: 'legacy',
        remaining_atomic: '3500000',
        remaining_display: '3.5 USDC',
        token_symbol: 'USDC',
        token_address: USDC_BASE,
        reset_period: 60,
        source: 'allowance_module',
      },
      warnings: [],
    })
    // Same source, asserted as equality against haven_get_allowances' own mapping.
    expect(summary.allowance?.remaining_atomic).toBe(allowances.allowances[0].onchain.remaining)
  })

  it('delegation rail: reports source: active_delegations, derived via #1090 (never agent_allowances)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url)
      if (u.endsWith('/machine-payments/pay_1/status')) return paymentStatusResponse()
      if (u.endsWith('/machine-payments/agent')) return agentResponse('active', 'delegation')
      if (u.endsWith('/machine-payments/allowances')) {
        return delegationAllowancesResponse([{ tokenAddress: USDC_BASE, tokenSymbol: 'USDC', budgetAtomic: '4200000' }])
      }
      throw new Error(`unexpected fetch: ${u}`)
    })

    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl })
    const summary = await haven.getPostPurchaseAllowanceSummary('pay_1')

    expect(summary.allowance).toMatchObject({
      rail: 'delegation',
      source: 'active_delegations',
      remaining_atomic: '4200000',
    })
  })

  it('reports remaining_atomic: "0" (never a guess) when no allowance row matches the settled token', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url)
      if (u.endsWith('/machine-payments/pay_1/status')) return paymentStatusResponse({ asset: '0xDifferentToken' })
      if (u.endsWith('/machine-payments/agent')) return agentResponse('active')
      if (u.endsWith('/machine-payments/allowances')) return allowancesResponse()
      throw new Error(`unexpected fetch: ${u}`)
    })

    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl })
    const summary = await haven.getPostPurchaseAllowanceSummary('pay_1')

    expect(summary).toEqual({
      allowance: { rail: 'legacy', remaining_atomic: '0', source: 'allowance_module' },
      warnings: [],
    })
  })

  it('NEVER throws when the payment-status lookup fails — degrades to a null block + ALLOWANCE_CHECK_UNAVAILABLE', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url)
      if (u.endsWith('/machine-payments/pay_1/status')) return new Response('{}', { status: 502 })
      throw new Error(`unexpected fetch: ${u}`)
    })

    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl })
    const summary = await haven.getPostPurchaseAllowanceSummary('pay_1')

    expect(summary.allowance).toBeNull()
    expect(summary.warnings).toHaveLength(1)
    expect(summary.warnings[0].code).toBe('ALLOWANCE_CHECK_UNAVAILABLE')
  })

  it('NEVER throws when the allowance/budget lookup itself fails — the mutation this guards against (a)', async () => {
    // Mutation-proof (a): if the try/catch below getAllowances() is severed,
    // this test fails because the call rejects instead of returning a
    // degraded summary.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url)
      if (u.endsWith('/machine-payments/pay_1/status')) return paymentStatusResponse()
      if (u.endsWith('/machine-payments/agent')) return agentResponse('active')
      if (u.endsWith('/machine-payments/allowances')) return new Response('{}', { status: 502 })
      throw new Error(`unexpected fetch: ${u}`)
    })

    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl })
    await expect(haven.getPostPurchaseAllowanceSummary('pay_1')).resolves.toEqual({
      allowance: null,
      warnings: [expect.objectContaining({ code: 'ALLOWANCE_CHECK_UNAVAILABLE' })],
    })
  })
})

const mappedAllowances = {
  agentId: 'agent-1',
  safeAddress: '0xSafe',
  delegateAddress: '0xDelegate',
  chainId: 8453,
  allowances: [{
    id: 'allowance-1',
    tokenAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    tokenSymbol: 'USDC',
    configuredAmount: '10000',
    resetPeriodMin: 60,
    onchain: {
      amount: '10000',
      spent: '2500',
      remaining: '7500',
      effectiveSpent: '2500',
      resetTimeMin: 60,
      lastResetMin: 100,
      nonce: 7,
      isResetPending: false,
    },
  }],
}

function agentResponse(status: string, executionRail: 'legacy' | 'delegation' = 'legacy'): Response {
  return new Response(JSON.stringify({
    id: 'agent-1',
    name: 'Research agent',
    status,
    safe_address: '0xSafe',
    delegate_address: '0xDelegate',
    chain_id: 8453,
    execution_rail: executionRail,
  }))
}

// Real registered token addresses so remainingDisplay exercises the decimals
// lookup (Base USDC = 6 decimals, Gnosis EURe = 18 decimals).
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const EURE_GNOSIS = '0xcb444e90d8198415266c6a2724b7900fb12fc56e'

/**
 * The delegation rail's /machine-payments/allowances shape (#1135): remaining
 * is the ACTIVE delegation's period budget (amount = remaining, spent = 0);
 * the AllowanceModule-only fields are zeroed placeholders on this rail.
 */
function delegationAllowancesResponse(
  budgets: Array<{ tokenAddress: string; tokenSymbol: string; budgetAtomic: string }>,
): Response {
  return new Response(JSON.stringify({
    agent_id: 'agent-1',
    safe_address: '0xSafe',
    delegate_address: '0xDelegate',
    chain_id: 8453,
    allowances: budgets.map((b, i) => ({
      id: `delegation-${i + 1}`,
      token_address: b.tokenAddress,
      token_symbol: b.tokenSymbol,
      configured_amount: '10.00',
      reset_period_min: 1440,
      onchain: {
        amount: b.budgetAtomic,
        spent: '0',
        remaining: b.budgetAtomic,
        effective_spent: '0',
        reset_time_min: 1440,
        last_reset_min: 0,
        nonce: 0,
        is_reset_pending: false,
      },
    })),
  }))
}

function allowancesResponse(
  overrides: { remaining?: string; tokenAddress?: string; tokenSymbol?: string } = {},
): Response {
  return new Response(JSON.stringify({
    agent_id: 'agent-1',
    safe_address: '0xSafe',
    delegate_address: '0xDelegate',
    chain_id: 8453,
    allowances: [{
      id: 'allowance-1',
      token_address: overrides.tokenAddress ?? USDC_BASE,
      token_symbol: overrides.tokenSymbol ?? 'USDC',
      configured_amount: '10000',
      reset_period_min: 60,
      onchain: {
        amount: '10000',
        spent: '2500',
        remaining: overrides.remaining ?? '7500',
        effective_spent: '2500',
        reset_time_min: 60,
        last_reset_min: 100,
        nonce: 7,
        is_reset_pending: false,
      },
    }],
  }))
}

/** GET /machine-payments/:id/status fixture — a settled x402 payment_intent. */
function paymentStatusResponse(overrides: { asset?: string } = {}): Response {
  return new Response(JSON.stringify({
    payment_id: 'pay_1',
    kind: 'payment_intent',
    rail: 'x402',
    status: 'confirmed',
    phase: 'payment_confirmed',
    next_action: 'none',
    amount: '1.50',
    token: 'USDC',
    resource_url: 'https://merchant.example/paid',
    merchant_address: '0xMerchant',
    tx_hash: '0xfund',
    expires_at: '2099-01-01T00:00:00.000Z',
    chain_id: 8453,
    message: 'The payment is confirmed.',
    asset: overrides.asset ?? USDC_BASE,
  }))
}
