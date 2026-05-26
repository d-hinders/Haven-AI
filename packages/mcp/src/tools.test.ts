import { afterEach, describe, expect, it, vi } from 'vitest'
import { HavenClient, toolDescriptions as sharedDescriptions } from '@haven_ai/sdk'
import { createToolHandlers, toolDescriptions } from './tools.js'

const delegateKey = '0x59c6995e998f97a5a0044966f09453843a4bba3e18a70e0614612ece7c1e4568'
const delegateAddress = '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1'
const safeAddress = '0x135a9215604711AC70d970e12Caa812c53537EF4'
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

const x402PaymentRequired = {
  x402Version: 2,
  error: 'Payment required',
  resource: {
    url: 'https://merchant.example/data',
    description: 'Premium data',
    mimeType: 'application/json',
  },
  accepts: [
    {
      scheme: 'exact' as const,
      network: 'eip155:8453',
      asset: challenge.asset.address,
      amount: challenge.amount.atomic,
      payTo: challenge.recipient,
      maxTimeoutSeconds: 300,
      extra: { name: 'USD Coin', version: '2' },
    },
  ],
}

interface CapturedRequest {
  url: string
  init?: RequestInit
}

/**
 * Non-custody assertion: the delegate private key must never appear anywhere
 * in an outgoing HTTP call — URL, header value, or body. Headers are
 * serialised both via the `Headers` view and the raw `init.headers` value
 * because callers may pass either form.
 */
function assertNoDelegateKeyLeak(requests: CapturedRequest[], key: string): void {
  for (const request of requests) {
    expect(request.url).not.toContain(key)
    const headersString = JSON.stringify(request.init?.headers ?? {})
    expect(headersString).not.toContain(key)
    if (request.init?.headers instanceof Headers) {
      for (const [, value] of request.init.headers) {
        expect(value).not.toContain(key)
      }
    }
    const body = typeof request.init?.body === 'string'
      ? request.init.body
      : request.init?.body
        ? String(request.init.body)
        : ''
    expect(body).not.toContain(key)
  }
}

describe('Haven MCP tool descriptions', () => {
  // Drift guard: every MCP tool description must start with the shared
  // summary from `@haven_ai/sdk`. If a tool's description is overwritten with
  // ad-hoc prose instead of composing from the shared source, this test
  // fails loudly and points at the shared module as the place to update.
  const cases: Array<{ tool: keyof typeof toolDescriptions; key: keyof typeof sharedDescriptions }> = [
    { tool: 'haven_quote_x402', key: 'quoteX402' },
    { tool: 'haven_pay_x402_quote', key: 'payX402' },
    { tool: 'haven_resume_x402_payment', key: 'resumeX402' },
    { tool: 'haven_quote_mpp', key: 'quoteMpp' },
    { tool: 'haven_pay_mpp_challenge', key: 'payMpp' },
    { tool: 'haven_resume_mpp_payment', key: 'resumeMpp' },
    { tool: 'haven_get_payment_status', key: 'getPaymentStatus' },
    { tool: 'haven_get_resume_state', key: 'getResumeState' },
    { tool: 'haven_get_agent', key: 'getAgent' },
    { tool: 'haven_get_allowances', key: 'getAllowances' },
    { tool: 'haven_list_receipts', key: 'listReceipts' },
  ]

  for (const { tool, key } of cases) {
    it(`${tool} description starts with shared ${key} summary`, () => {
      expect(toolDescriptions[tool]).toContain(sharedDescriptions[key].summary)
    })
  }
})

describe('Haven MCP tool handlers', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('pays MPP challenges without leaking the delegate key over HTTP', async () => {
    const requests: CapturedRequest[] = []
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

    assertNoDelegateKeyLeak(requests, delegateKey)
  })

  it('pays x402 quotes without leaking the delegate key over HTTP', async () => {
    const requests: CapturedRequest[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      requests.push({ url: String(url), init })
      const u = String(url)

      // First call: merchant returns 402 with x402 payload (used by quoteX402).
      // Second call: merchant returns 402 again on the pay path (Haven re-probes).
      if (u === x402PaymentRequired.resource.url) {
        // Has X-PAYMENT header? It's the retry — return the paid response.
        const headers = init?.headers ? new Headers(init.headers) : new Headers()
        if (headers.has('X-PAYMENT')) {
          return new Response(JSON.stringify({ ok: true, data: 'paid-x402' }), {
            status: 200,
            headers: {
              'PAYMENT-RESPONSE': btoa(JSON.stringify({
                success: true,
                transaction: txHash,
                network: x402PaymentRequired.accepts[0].network,
              })),
            },
          })
        }
        return new Response(JSON.stringify(x402PaymentRequired), {
          status: 402,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      if (u.endsWith('/x402')) {
        // Haven funding leg — returns sign_data for the delegate to sign.
        return jsonResponse({
          payment_id: 'x402-pay-1',
          status: 'pending_signature',
          chain_id: 8453,
          safe_address: safeAddress,
          token: 'USDC',
          amount: '0.01',
          to: delegateAddress,
          resource_url: x402PaymentRequired.resource.url,
          sign_data: {
            hash: `0x${'22'.repeat(32)}`,
            components: {
              safe: safeAddress,
              token: x402PaymentRequired.accepts[0].asset,
              to: delegateAddress,
              amount: x402PaymentRequired.accepts[0].amount,
              payment_token: '0x0000000000000000000000000000000000000000',
              payment: '0',
              nonce: 1,
            },
            instructions: 'Sign with delegate key',
          },
        }, 201)
      }

      if (u.endsWith('/payments/x402-pay-1/sign')) {
        return jsonResponse({
          payment_id: 'x402-pay-1',
          status: 'confirmed',
          tx_hash: txHash,
          token: 'USDC',
          amount: '0.01',
          to: delegateAddress,
          explorer_url: `https://basescan.org/tx/${txHash}`,
        })
      }

      if (u.endsWith('/machine-payments/evidence')) {
        return jsonResponse({ evidence: { id: 'evidence-1' } }, 202)
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

    const quote = await handlers.haven_quote_x402({ url: x402PaymentRequired.resource.url })
    expect(quote.success).toBe(true)
    if (!quote.success) throw new Error('quote failed')

    const paid = await handlers.haven_pay_x402_quote({ quote: quote.data })
    expect(paid.success).toBe(true)
    expect(JSON.stringify(paid)).toContain('paid-x402')

    // Haven traffic must have happened (sign data + sign endpoint) and
    // delegate_key must not appear in any request URL, header, or body.
    expect(requests.some((r) => r.url.endsWith('/x402'))).toBe(true)
    expect(requests.some((r) => r.url.endsWith('/payments/x402-pay-1/sign'))).toBe(true)
    assertNoDelegateKeyLeak(requests, delegateKey)
  })

  it('resumes x402 payments by payment_id without leaking the delegate key', async () => {
    const requests: CapturedRequest[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      requests.push({ url: String(url), init })
      const u = String(url)

      if (u.endsWith('/payments/approval-9/resume_state')) {
        // Server-side resume rehydration — returns the captured x402 context.
        return jsonResponse({
          rail: 'x402',
          paymentId: 'approval-9',
          idempotencyKey: 'x402:approval-9',
          paymentRequired: x402PaymentRequired,
          accepted: x402PaymentRequired.accepts[0],
          url: x402PaymentRequired.resource.url,
          resourceUrl: x402PaymentRequired.resource.url,
          description: x402PaymentRequired.resource.description,
          amountAtomic: x402PaymentRequired.accepts[0].amount,
          amount: '0.01',
          token: 'USDC',
          asset: x402PaymentRequired.accepts[0].asset,
          network: x402PaymentRequired.accepts[0].network,
          chainId: 8453,
          merchantAddress: x402PaymentRequired.accepts[0].payTo,
        })
      }

      if (u.endsWith('/machine-payments/approval-9/status')) {
        // resumeX402Payment calls getPaymentStatus and requires status.rail
        // to be x402 with nextAction=retry_original_x402_request and a real
        // txHash on the funding leg.
        return jsonResponse({
          payment_id: 'approval-9',
          kind: 'approval_request',
          rail: 'x402',
          status: 'executed',
          phase: 'funding_sent',
          next_action: 'retry_original_x402_request',
          amount: '0.01',
          token: 'USDC',
          resource_url: x402PaymentRequired.resource.url,
          merchant_address: x402PaymentRequired.accepts[0].payTo,
          tx_hash: txHash,
          expires_at: '2099-01-01T00:00:00.000Z',
          chain_id: 8453,
          message: 'Resume the original x402 request.',
          amount_atomic: x402PaymentRequired.accepts[0].amount,
          asset: x402PaymentRequired.accepts[0].asset,
          network: x402PaymentRequired.accepts[0].network,
        })
      }

      if (u === x402PaymentRequired.resource.url) {
        return new Response(JSON.stringify({ ok: true, data: 'resumed-x402' }), {
          status: 200,
          headers: {
            'PAYMENT-RESPONSE': btoa(JSON.stringify({
              success: true,
              transaction: txHash,
              network: x402PaymentRequired.accepts[0].network,
            })),
          },
        })
      }

      if (u.endsWith('/machine-payments/evidence')) {
        return jsonResponse({ evidence: { id: 'evidence-1' } }, 202)
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

    // Path 1: rehydrate via getResumeState tool and pass the state in.
    const state = await handlers.haven_get_resume_state({ payment_id: 'approval-9' })
    expect(state.success).toBe(true)
    if (!state.success) throw new Error('get_resume_state failed')

    const resumed = await handlers.haven_resume_x402_payment({ resume_state: state.data })
    expect(resumed.success).toBe(true)

    // Path 2: pass only payment_id — the tool fetches resume state internally.
    const resumedById = await handlers.haven_resume_x402_payment({ payment_id: 'approval-9' })
    expect(resumedById.success).toBe(true)

    assertNoDelegateKeyLeak(requests, delegateKey)
  })

  it('negative control: assertNoDelegateKeyLeak fails when the key is present', () => {
    // Without this test the non-custody assertion could be silently weakened
    // (e.g. comparing against a stripped version of the key) and still pass.
    expect(() =>
      assertNoDelegateKeyLeak(
        [{ url: `https://haven.example/leak?k=${delegateKey}` }],
        delegateKey,
      ),
    ).toThrow()
    expect(() =>
      assertNoDelegateKeyLeak(
        [{ url: 'https://haven.example/x', init: { body: `{"key":"${delegateKey}"}` } }],
        delegateKey,
      ),
    ).toThrow()
    expect(() =>
      assertNoDelegateKeyLeak(
        [{ url: 'https://haven.example/x', init: { headers: { 'X-Leak': delegateKey } } }],
        delegateKey,
      ),
    ).toThrow()
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
