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
    tokenAddress: '0xToken',
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

function allowancesResponse(): Response {
  return new Response(JSON.stringify({
    agent_id: 'agent-1',
    safe_address: '0xSafe',
    delegate_address: '0xDelegate',
    chain_id: 8453,
    allowances: [{
      id: 'allowance-1',
      token_address: '0xToken',
      token_symbol: 'USDC',
      configured_amount: '10000',
      reset_period_min: 60,
      onchain: {
        amount: '10000',
        spent: '2500',
        remaining: '7500',
        effective_spent: '2500',
        reset_time_min: 60,
        last_reset_min: 100,
        nonce: 7,
        is_reset_pending: false,
      },
    }],
  }))
}
