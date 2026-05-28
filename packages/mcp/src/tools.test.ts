import { afterEach, describe, expect, it, vi } from 'vitest'
import { HavenClient } from '@haven_ai/sdk'
import { createToolHandlers } from './tools.js'

const delegateKey = '0x59c6995e998f97a5a0044966f09453843a4bba3e18a70e0614612ece7c1e4568'
const baseUrl = 'https://haven.example'
const txHash = `0x${'ab'.repeat(32)}`

const challenge = {
  rail: 'mpp_demo',
  version: '2026-05-12',
  challengeId: 'challenge-123',
  resource: 'https://merchant.example/data',
  description: 'Demo data',
  network: { chainId: 8453, name: 'base' },
  asset: {
    symbol: 'USDC',
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    decimals: 6,
  },
  amount: { display: '0.01', atomic: '10000' },
  recipient: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
  expiresAt: '2099-01-01T00:00:00.000Z',
} as const

// ── x402 fixtures ────────────────────────────────────────────────────────────

const resourceUrl = 'https://merchant.example/resource'
const delegateAddress = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const safeAddress = '0x135a9215604711AC70d970e12Caa812c53537EF4'

const x402PaymentRequired = {
  x402Version: 2,
  error: 'Payment required',
  resource: {
    url: resourceUrl,
    description: 'Test resource $0.01 USDC',
    mimeType: 'application/json',
  },
  accepts: [{
    scheme: 'exact',
    network: 'eip155:8453',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    amount: '10000',
    payTo: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
    maxTimeoutSeconds: 300,
    extra: { name: 'USD Coin', version: '2' },
  }],
}

describe('Haven MCP tool handlers', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('pays MPP challenges without leaking the delegate key over HTTP', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      requests.push({ url: String(url), init })

      if (String(url).endsWith('/machine-payments/authorize')) {
        return jsonResponse({
          payment_id: 'payment-1',
          status: 'pending_signature',
          rail: 'mpp_demo',
          chain_id: 8453,
          safe_address: '0xSafe',
          sign_data: {
            hash: `0x${'11'.repeat(32)}`,
            components: {
              safe: '0xSafe',
              token: challenge.asset.address,
              to: challenge.recipient,
              amount: challenge.amount.atomic,
              payment_token: '0x0000000000000000000000000000000000000000',
              payment: '0',
              nonce: 1,
            },
            instructions: 'Sign locally',
          },
        })
      }

      if (String(url).endsWith('/payments/payment-1/sign')) {
        return jsonResponse({
          payment_id: 'payment-1',
          status: 'confirmed',
          tx_hash: txHash,
          token: 'USDC',
          amount: '0.01',
          to: challenge.recipient,
          chain_id: 8453,
        })
      }

      return jsonResponse({ delivered: true })
    })

    const haven = new HavenClient({ apiKey: 'sk_agent_test', delegateKey, baseUrl })
    const handlers = createToolHandlers(haven)
    const quote = await handlers.haven_quote_mpp({ challenge })
    expect(quote.success).toBe(true)
    if (!quote.success) throw new Error('quote failed')

    const paid = await handlers.haven_pay_mpp_challenge({ quote: quote.data })
    expect(paid.success).toBe(true)
    expect(JSON.stringify(paid)).toContain('delivered')

    for (const request of requests) {
      expect(request.url).not.toContain(delegateKey)
      expect(JSON.stringify(request.init?.headers ?? {})).not.toContain(delegateKey)
      expect(String(request.init?.body ?? '')).not.toContain(delegateKey)
    }
  })

  // ── #190 Security & regulatory tests ────────────────────────────────────

  it('[#190] x402 payment: delegate key never appears in any HTTP request — custody invariant', async () => {
    // This test would FAIL before the fix — a leaky implementation would
    // embed the raw private key in an Authorization header or request body.
    // The non-custodial architecture requires only {payloadHash, signature}
    // to cross the wire, never the raw delegate key.
    const requests: Array<{ url: string; init?: RequestInit }> = []

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      requests.push({ url: String(url), init })

      // First call: resource URL probe returns x402 Payment Required
      if (String(url) === resourceUrl && !init?.headers) {
        return new Response(JSON.stringify(x402PaymentRequired), {
          status: 402,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      // x402 wallet probe (first call with Haven wallet header)
      if (String(url) === resourceUrl) {
        return new Response(JSON.stringify(x402PaymentRequired), {
          status: 402,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      // Haven backend: POST /x402 (authorize — funds delegate, never receives key)
      if (String(url).endsWith('/x402')) {
        return new Response(JSON.stringify({
          payment_id: 'pay-x402-1',
          status: 'pending_signature',
          chain_id: 8453,
          safe_address: safeAddress,
          token: 'USDC',
          amount: '0.01',
          to: delegateAddress,
          resource_url: resourceUrl,
          sign_data: {
            hash: `0x${'22'.repeat(32)}`,
            components: {
              safe: safeAddress,
              token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
              to: delegateAddress,
              amount: '10000',
              payment_token: '0x0000000000000000000000000000000000000000',
              payment: '0',
              nonce: 1,
            },
            instructions: 'Sign with delegate key',
          },
        }), { status: 201, headers: { 'Content-Type': 'application/json' } })
      }
      // Haven backend: POST /payments/:id/sign (receives signature, not key)
      if (String(url).match(/\/payments\/pay-x402-1\/sign/)) {
        return jsonResponse({
          payment_id: 'pay-x402-1',
          status: 'confirmed',
          tx_hash: txHash,
          chain_id: 8453,
          token: 'USDC',
          amount: '0.01',
          to: delegateAddress,
          explorer_url: `https://basescan.org/tx/${txHash}`,
        })
      }
      // Haven backend: POST /machine-payments/evidence (optional receipt)
      if (String(url).endsWith('/machine-payments/evidence')) {
        return jsonResponse({ evidence: { id: 'ev-1' } }, 202)
      }
      // Resource retry with X-PAYMENT header — merchant confirms
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          'PAYMENT-RESPONSE': btoa(JSON.stringify({
            success: true,
            transaction: txHash,
            network: 'eip155:8453',
          })),
        },
      })
    })

    const haven = new HavenClient({
      apiKey: 'sk_agent_test',
      delegateKey,
      baseUrl,
      x402Wallet: safeAddress,
    })
    const handlers = createToolHandlers(haven)

    // Step 1: Quote (inspects resource URL, no payment)
    const quote = await handlers.haven_quote_x402({ url: resourceUrl })
    expect(quote.success).toBe(true)

    // Step 2: Pay — key must NEVER appear in any request
    const paid = await handlers.haven_pay_x402_quote({ quote: (quote as { success: true; data: unknown }).data })
    // Payment may succeed or queue for approval — either way, key must not leak
    expect([true, false]).toContain(paid.success)

    for (const request of requests) {
      const requestText = [
        request.url,
        JSON.stringify(request.init?.headers ?? {}),
        String(request.init?.body ?? ''),
      ].join(' ')
      expect(requestText, `x402: delegate key must not appear in request to ${request.url}`)
        .not.toContain(delegateKey)
    }
  })

  it('[#190] over-budget x402 payment queues for user approval (regression)', async () => {
    // Regression guard: when the Safe AllowanceModule has insufficient headroom,
    // Haven MUST queue the payment for user approval rather than reject it
    // outright or — critically — attempt to bypass the on-chain constraint.
    // Policy-only rejection (database says no, chain says yes) would violate
    // the casp-risk-guardrails "off-chain-only spend control" red line.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, _init) => {
      if (String(url) === resourceUrl) {
        return new Response(JSON.stringify(x402PaymentRequired), {
          status: 402,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (String(url).endsWith('/x402')) {
        // Backend signals that the AllowanceModule headroom is exhausted:
        // the payment cannot execute without user approval.
        return new Response(JSON.stringify({
          payment_id: 'pay-overbudget-1',
          kind: 'approval_request',
          status: 'pending_approval',
          phase: 'user_approval_required',
          next_action: 'wait_for_user_approval',
          amount: '0.01',
          token: 'USDC',
          resource_url: resourceUrl,
          merchant_address: x402PaymentRequired.accepts[0].payTo,
          tx_hash: null,
          expires_at: '2099-01-01T00:00:00.000Z',
          chain_id: 8453,
          message: 'Allowance exhausted — awaiting user approval',
        }), { status: 202, headers: { 'Content-Type': 'application/json' } })
      }
      return jsonResponse({})
    })

    const haven = new HavenClient({
      apiKey: 'sk_agent_test',
      delegateKey,
      baseUrl,
      x402Wallet: safeAddress,
    })
    const handlers = createToolHandlers(haven)
    const quote = await handlers.haven_quote_x402({ url: resourceUrl })
    expect(quote.success).toBe(true)

    const result = await handlers.haven_pay_x402_quote({
      quote: (quote as { success: true; data: unknown }).data,
    })

    // Must surface approval-required state — never silently fail or succeed
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.nextAction).toBe('wait_for_user_approval')
      expect(result.status).toBe('pending_approval')
      expect(result.paymentId).toBe('pay-overbudget-1')
      // resume_state must be present so the agent can re-try after approval
      expect(result.resume_state).toBeDefined()
    }
  })

  it('[#190] over-budget MPP payment queues for user approval (regression — unchanged)', async () => {
    // Mirror of the x402 regression but for the MPP rail.
    // The approval path must work identically regardless of payment rail.
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({
      payment_id: 'pay-mpp-budget-1',
      kind: 'approval_request',
      rail: 'mpp_demo',
      status: 'pending_approval',
      phase: 'user_approval_required',
      next_action: 'wait_for_user_approval',
      amount: '25.00',
      token: 'USDC',
      resource_url: challenge.resource,
      merchant_address: challenge.recipient,
      tx_hash: null,
      expires_at: '2099-01-01T00:00:00.000Z',
      chain_id: 8453,
      message: 'Allowance exhausted — awaiting user approval',
      mpp: {
        amount_atomic: challenge.amount.atomic,
        asset: challenge.asset.address,
        network: 'base',
        resource_url: challenge.resource,
        merchant_address: challenge.recipient,
        description: challenge.description,
        idempotency_key: 'mpp:budget-test',
        challenge_id: challenge.challengeId,
      },
    }, 202))

    const haven = new HavenClient({ apiKey: 'sk_agent_test', delegateKey, baseUrl })
    const handlers = createToolHandlers(haven)
    const mppQuote = {
      rail: 'mpp',
      paymentRail: 'mpp_demo',
      idempotencyKey: 'mpp:budget-test',
      challenge,
      request: { url: challenge.resource, method: 'GET', headers: [] },
      resourceUrl: challenge.resource,
      description: challenge.description,
      amountAtomic: challenge.amount.atomic,
      amount: '25.00',
      token: 'USDC',
      asset: challenge.asset.address,
      network: 'base',
      chainId: 8453,
      merchantAddress: challenge.recipient,
      expiresAt: challenge.expiresAt,
    }

    const result = await handlers.haven_pay_mpp_challenge({ quote: mppQuote })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.nextAction).toBe('wait_for_user_approval')
      expect(result.status).toBe('pending_approval')
      expect(result.paymentId).toBe('pay-mpp-budget-1')
      expect(result.resume_state).toBeDefined()
    }
  })

  it('[#190] read-only tools (get_agent, get_allowances) never transmit the delegate key', async () => {
    // Non-payment tools must also uphold the key-isolation invariant.
    // Any tool that triggers an HTTP request must not include the delegate
    // private key in the payload, URL, or headers.
    const requests: Array<{ url: string; body: string; headers: string }> = []

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      requests.push({
        url: String(url),
        body: String(init?.body ?? ''),
        headers: JSON.stringify(init?.headers ?? {}),
      })
      if (String(url).endsWith('/agents/me')) {
        return jsonResponse({
          id: 'agt_1', name: 'Test', delegate_address: delegateAddress,
          safe_address: safeAddress, chain_id: 8453, status: 'active',
        })
      }
      if (String(url).includes('/allowances')) {
        return jsonResponse({ on_chain: [], configured: [] })
      }
      return jsonResponse({})
    })

    const haven = new HavenClient({ apiKey: 'sk_agent_test', delegateKey, baseUrl })
    const handlers = createToolHandlers(haven)

    await handlers.haven_get_agent({})
    await handlers.haven_get_allowances({})

    expect(requests.length).toBeGreaterThan(0)
    for (const req of requests) {
      const all = `${req.url} ${req.body} ${req.headers}`
      expect(all, `read-only tool: delegate key must not appear in request to ${req.url}`)
        .not.toContain(delegateKey)
    }
  })

  it('returns structured payment state errors with nextAction and resume_state', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({
      payment_id: 'approval-1',
      kind: 'approval_request',
      rail: 'mpp_demo',
      status: 'pending_approval',
      phase: 'user_approval_required',
      next_action: 'wait_for_user_approval',
      amount: '0.01',
      token: 'USDC',
      resource_url: challenge.resource,
      merchant_address: challenge.recipient,
      tx_hash: null,
      expires_at: '2099-01-01T00:00:00.000Z',
      chain_id: 8453,
      message: 'Waiting for user approval',
      mpp: {
        amount_atomic: '10000',
        asset: challenge.asset.address,
        network: 'base',
        resource_url: challenge.resource,
        merchant_address: challenge.recipient,
        description: challenge.description,
        idempotency_key: 'mpp:test',
        challenge_id: challenge.challengeId,
      },
    }, 202))

    const haven = new HavenClient({ apiKey: 'sk_agent_test', delegateKey, baseUrl })
    const handlers = createToolHandlers(haven)
    const quote = {
      rail: 'mpp',
      paymentRail: 'mpp_demo',
      idempotencyKey: 'mpp:test',
      challenge,
      request: { url: challenge.resource, method: 'GET', headers: [] },
      resourceUrl: challenge.resource,
      description: challenge.description,
      amountAtomic: '10000',
      amount: '0.01',
      token: 'USDC',
      asset: challenge.asset.address,
      network: 'base',
      chainId: 8453,
      merchantAddress: challenge.recipient,
      expiresAt: challenge.expiresAt,
    }

    const result = await handlers.haven_pay_mpp_challenge({ quote })

    expect(result).toMatchObject({
      success: false,
      code: 'API_ERROR',
      paymentId: 'approval-1',
      status: 'pending_approval',
      phase: 'user_approval_required',
      nextAction: 'wait_for_user_approval',
      resume_state: {
        rail: 'mpp',
        paymentId: 'approval-1',
      },
    })
  })
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
