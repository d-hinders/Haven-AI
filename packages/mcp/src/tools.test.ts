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
