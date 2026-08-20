import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountReads } from './account-reads.js'
import { HavenApiTransport } from './haven-api-transport.js'
import { AgentPaymentWarningCode, type PaymentStatusResult } from './types.js'

const BASE_URL = 'https://haven.test'
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
}

function agent(executionRail = 'legacy') {
  return {
    id: 'agent_1', name: 'Read agent', status: 'active',
    safe_address: '0xsafe', delegate_address: '0xdelegate', chain_id: 8453,
    execution_rail: executionRail,
  }
}

function allowance(remaining = '4960000') {
  return {
    agent_id: 'agent_1', safe_address: '0xsafe', delegate_address: '0xdelegate', chain_id: 8453,
    allowances: [{
      id: 'allowance_1', token_address: USDC, token_symbol: 'USDC', configured_amount: '5000000', reset_period_min: 1440,
      onchain: { amount: '5000000', spent: '40000', remaining, effective_spent: '40000', reset_time_min: 1440, last_reset_min: 0, nonce: 1, is_reset_pending: false },
    }],
  }
}

function reads(getPaymentStatus: (id: string) => Promise<PaymentStatusResult>) {
  return new AccountReads({
    transport: new HavenApiTransport({ apiKey: 'sk_agent_test', baseUrl: BASE_URL }),
    getPaymentStatus,
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('AccountReads', () => {
  it('coalesces concurrent agent reads but leaves sequential reads fresh', async () => {
    let resolveFirst!: (response: Response) => void
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { resolveFirst = resolve }))
    vi.stubGlobal('fetch', fetch)
    const service = reads(async () => ({}) as PaymentStatusResult)

    const first = service.getAgent()
    const second = service.getAgent()
    expect(fetch).toHaveBeenCalledTimes(1)
    resolveFirst(json(agent()))
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(agent())))
    await service.getAgent()
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('maps allowance rows and derives the same ready summary from the live authority read', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      if (path === '/machine-payments/agent') return json(agent())
      if (path === '/machine-payments/allowances') return json(allowance())
      throw new Error(`Unexpected ${path}`)
    }))
    const service = reads(async () => ({}) as PaymentStatusResult)

    await expect(service.getAgentSummary()).resolves.toMatchObject({
      executionRail: 'legacy', readiness: 'ready', spend_authority_readiness: 'ready',
      allowances: [{ remainingAtomic: '4960000', remainingDisplay: '4.96 USDC' }],
    })
  })

  it('keeps a settled status when the best-effort allowance read fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      if (path === '/machine-payments/agent') return json(agent('delegation'))
      if (path === '/machine-payments/allowances') return new Response(JSON.stringify({ error: 'offline' }), { status: 503 })
      throw new Error(`Unexpected ${path}`)
    }))
    const payment = { paymentId: 'pay_1', asset: USDC, x402: undefined } as PaymentStatusResult
    const service = reads(async () => payment)

    await expect(service.getPostPurchaseAllowanceSummary('pay_1')).resolves.toMatchObject({
      payment,
      allowance: null,
      warnings: [{ code: AgentPaymentWarningCode.AllowanceCheckUnavailable }],
    })
  })

  it('does not expose a payment when malformed allowance data prevents the final match', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      if (path === '/machine-payments/agent') return json(agent())
      if (path === '/machine-payments/allowances') return json(allowance())
      throw new Error(`Unexpected ${path}`)
    }))
    const payment = { paymentId: 'pay_1', asset: 12 as unknown as string } as PaymentStatusResult
    const service = reads(async () => payment)

    await expect(service.getPostPurchaseAllowanceSummary('pay_1')).resolves.toMatchObject({
      payment: null,
      allowance: null,
      warnings: [{ code: AgentPaymentWarningCode.AllowanceCheckUnavailable }],
    })
  })

  it('maps receipt history without exposing proof headers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ receipts: [{
      id: 'receipt_1', payment_id: 'pay_1', rail: 'x402', proof_status: 'settled', tx_hash: '0xtx', chain_id: 8453,
      resource_url: 'https://merchant.test', merchant_address: null, payer_address: '0xpayer', settlement_address: '0xsettlement',
      token_symbol: 'USDC', token_address: USDC, amount_raw: '1000000', amount_human: '1', challenge_id: null,
      idempotency_key: null, payment_proof_header_name: 'X-PAYMENT', protocol_receipt_header_name: null, merchant_status: 200,
      confirmed_at: null, created_at: '2026-08-20T00:00:00.000Z', updated_at: '2026-08-20T00:00:00.000Z',
    }] })))
    const service = reads(async () => ({}) as PaymentStatusResult)

    await expect(service.listReceipts({ limit: 5 })).resolves.toMatchObject([{ paymentId: 'pay_1', amount: '1' }])
    expect(String(vi.mocked(globalThis.fetch).mock.calls[0]?.[0])).toContain('/machine-payments/receipts?limit=5')
  })

  it('verifies receipt bundles locally instead of trusting a server verification claim', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ receipt: {
      version: 'haven-receipt-1', paymentId: 'pay_1',
      payment: { token: 'USDC', tokenAddress: USDC, amount: '1', amountSek: null, recipient: '0xmerchant', safe: '0xsafe', chainId: 8453, settledAt: null, resourceUrl: null },
      authorization: { delegate: '0xdelegate', signHash: '0xhash', signature: null },
      onChain: { txHash: null, chainId: 8453 },
    }, verification: { verified: true } })))
    const service = reads(async () => ({}) as PaymentStatusResult)

    await expect(service.getReceipt('pay_1')).resolves.toMatchObject({
      receipt: { paymentId: 'pay_1' },
      verification: { verified: false, reason: 'missing_signature' },
    })
  })
})
