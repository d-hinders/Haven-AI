import { afterEach, describe, expect, it, vi } from 'vitest'
import { HavenClient } from './client.js'

const baseUrl = 'https://haven.example'

function statusBody(fee: unknown) {
  return {
    payment_id: 'pi1',
    status: 'confirmed',
    token: 'USDC',
    amount: '1',
    to: '0xRecipient',
    tx_hash: '0xabc',
    chain_id: 8453,
    fee,
    error_message: null,
    created_at: '2026-06-20T10:00:00.000Z',
    signed_at: '2026-06-20T10:00:01.000Z',
    submitted_at: '2026-06-20T10:00:02.000Z',
    confirmed_at: '2026-06-20T10:00:03.000Z',
    expires_at: '2099-01-01T00:00:00.000Z',
  }
}

describe('payment result fee transparency (#386)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('maps the platform fee onto the payment result', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(statusBody({ amount: '0', token: 'USDC', basis_points: 0, applied: false }))),
    )
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl })
    const result = await haven.getPayment('pi1')
    expect(result.fee).toEqual({ amount: '0', token: 'USDC', basisPoints: 0, applied: false })
  })

  it('is null when the backend omits a fee (older servers)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(statusBody(undefined))),
    )
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl })
    const result = await haven.getPayment('pi1')
    expect(result.fee).toBeNull()
  })

  it('maps the fee on the x402/MPP payment status too', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        payment_id: 'ar1',
        kind: 'approval_request',
        rail: 'x402',
        status: 'executed',
        phase: 'payment_confirmed',
        next_action: 'none',
        amount: '0.01',
        token: 'USDC',
        resource_url: null,
        merchant_address: null,
        tx_hash: '0xabc',
        expires_at: '2099-01-01T00:00:00.000Z',
        chain_id: 8453,
        message: 'done',
        fee: { amount: '0', token: 'USDC', basis_points: 0, applied: false },
      })),
    )
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl })
    const result = await haven.getPaymentStatus('ar1')
    expect(result.fee).toEqual({ amount: '0', token: 'USDC', basisPoints: 0, applied: false })
  })
})
