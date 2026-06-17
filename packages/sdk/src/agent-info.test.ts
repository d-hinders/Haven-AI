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

function agentResponse(status: string): Response {
  return new Response(JSON.stringify({
    id: 'agent-1',
    name: 'Research agent',
    status,
    safe_address: '0xSafe',
    delegate_address: '0xDelegate',
    chain_id: 8453,
  }))
}

// Real registered token addresses so remainingDisplay exercises the decimals
// lookup (Base USDC = 6 decimals, Gnosis EURe = 18 decimals).
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const EURE_GNOSIS = '0xcb444e90d8198415266c6a2724b7900fb12fc56e'

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
