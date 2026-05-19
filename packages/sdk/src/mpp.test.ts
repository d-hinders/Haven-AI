import { afterEach, describe, expect, it, vi } from 'vitest'
import { HavenClient } from './client.js'
import {
  buildMachinePaymentIdempotencyKey,
  parseMachinePaymentChallenge,
} from './mpp.js'
import type { MachinePaymentChallenge } from './types.js'

const challenge: MachinePaymentChallenge = {
  rail: 'mpp_demo',
  version: '2026-05-12',
  challengeId: 'challenge-123',
  resource: 'https://haven.example/demo/mpp/market-summary',
  description: 'Haven market summary demo',
  network: { chainId: 8453, name: 'base' },
  asset: {
    symbol: 'USDC',
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    decimals: 6,
  },
  amount: { display: '0.01', atomic: '10000' },
  recipient: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
  expiresAt: '2026-05-12T20:00:00.000Z',
  metadata: { demoResource: 'market-summary' },
}

function decodeHeader(header: string): Record<string, unknown> {
  return JSON.parse(atob(header)) as Record<string, unknown>
}

describe('MPP demo helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('parses MACHINE-PAYMENT-CHALLENGE headers', () => {
    const response = new Response(null, {
      status: 402,
      headers: {
        'MACHINE-PAYMENT-CHALLENGE': btoa(JSON.stringify(challenge)),
      },
    })

    expect(parseMachinePaymentChallenge(response)).toEqual(challenge)
  })

  it('builds deterministic idempotency keys per challenge', () => {
    expect(buildMachinePaymentIdempotencyKey(challenge)).toBe(
      buildMachinePaymentIdempotencyKey(challenge),
    )
    expect(buildMachinePaymentIdempotencyKey(challenge)).not.toBe(
      buildMachinePaymentIdempotencyKey(
        { ...challenge, challengeId: 'challenge-456' },
      ),
    )
  })

  it('pays an MPP demo challenge and retries with a machine payment proof', async () => {
    const backendUrl = 'https://haven-api.example'
    const resourceUrl = challenge.resource
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Machine payment required', challenge }), {
        status: 402,
        headers: {
          'Content-Type': 'application/json',
          'MACHINE-PAYMENT-CHALLENGE': btoa(JSON.stringify(challenge)),
        },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        payment_id: 'pay_123',
        status: 'pending_signature',
        chain_id: 8453,
        safe_address: '0x135a9215604711AC70d970e12Caa812c53537EF4',
        token: 'USDC',
        amount: '0.01',
        to: challenge.recipient,
        resource_url: resourceUrl,
        rail: 'mpp_demo',
        challenge_id: challenge.challengeId,
        sign_data: {
          hash: `0x${'11'.repeat(32)}`,
          components: {
            safe: '0x135a9215604711AC70d970e12Caa812c53537EF4',
            token: challenge.asset.address,
            to: challenge.recipient,
            amount: challenge.amount.atomic,
            payment_token: '0x0000000000000000000000000000000000000000',
            payment: '0',
            nonce: 1,
          },
          instructions: 'Sign with delegate key',
        },
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        payment_id: 'pay_123',
        status: 'confirmed',
        tx_hash: '0xabc',
        chain_id: 8453,
        token: 'USDC',
        amount: '0.01',
        to: challenge.recipient,
        explorer_url: 'https://basescan.org/tx/0xabc',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ paid: true }), {
        status: 200,
        headers: {
          'Payment-Receipt': JSON.stringify({
            status: 'settled',
            method: 'evm',
            reference: 'pay_123',
          }),
        },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ evidence: { id: 'evidence-123' } }), { status: 202 }))

    const haven = new HavenClient({
      apiKey: 'sk_agent_test',
      delegateKey: `0x${'01'.repeat(32)}`,
      baseUrl: backendUrl,
    })

    const response = await haven.fetch(resourceUrl)

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(5)

    const authorizeInit = fetchMock.mock.calls[1][1] as RequestInit
    expect(fetchMock.mock.calls[1][0]).toBe(`${backendUrl}/machine-payments/authorize`)
    expect(JSON.parse(authorizeInit.body as string)).toMatchObject({
      challenge: { challengeId: challenge.challengeId, rail: 'mpp_demo' },
      idempotencyKey: expect.stringMatching(/^mpp_demo:[0-9a-f]{16}$/),
    })

    const retryInit = fetchMock.mock.calls[3][1] as RequestInit
    const retryHeaders = new Headers(retryInit.headers)
    const proof = decodeHeader(retryHeaders.get('MACHINE-PAYMENT-PROOF') ?? '')
    expect(proof).toMatchObject({
      rail: 'mpp_demo',
      challengeId: challenge.challengeId,
      paymentId: 'pay_123',
      txHash: '0xabc',
      settledVia: 'haven',
      chainId: 8453,
    })

    expect(fetchMock.mock.calls[4][0]).toBe(`${backendUrl}/machine-payments/evidence`)
    const evidenceInit = fetchMock.mock.calls[4][1] as RequestInit
    expect(JSON.parse(evidenceInit.body as string)).toMatchObject({
      paymentId: 'pay_123',
      rail: 'mpp_demo',
      txHash: '0xabc',
      resourceUrl,
      merchantStatus: 200,
      challengePayload: { challengeId: challenge.challengeId, rail: 'mpp_demo' },
      paymentProofHeaderName: 'MACHINE-PAYMENT-PROOF',
      protocolReceiptHeaderName: 'Payment-Receipt',
      protocolReceiptPayload: {
        status: 'settled',
        method: 'evm',
        reference: 'pay_123',
      },
    })
  })

  it('records a reconciliation event when an MPP retry is rejected after payment', async () => {
    const backendUrl = 'https://haven-api.example'
    const resourceUrl = challenge.resource
    const txHash = `0x${'ab'.repeat(32)}`
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Machine payment required', challenge }), {
        status: 402,
        headers: {
          'Content-Type': 'application/json',
          'MACHINE-PAYMENT-CHALLENGE': btoa(JSON.stringify(challenge)),
        },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        payment_id: 'pay_123',
        status: 'pending_signature',
        chain_id: 8453,
        safe_address: '0x135a9215604711AC70d970e12Caa812c53537EF4',
        token: 'USDC',
        amount: '0.01',
        to: challenge.recipient,
        resource_url: resourceUrl,
        rail: 'mpp_demo',
        challenge_id: challenge.challengeId,
        sign_data: {
          hash: `0x${'11'.repeat(32)}`,
          components: {
            safe: '0x135a9215604711AC70d970e12Caa812c53537EF4',
            token: challenge.asset.address,
            to: challenge.recipient,
            amount: challenge.amount.atomic,
            payment_token: '0x0000000000000000000000000000000000000000',
            payment: '0',
            nonce: 1,
          },
          instructions: 'Sign with delegate key',
        },
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        payment_id: 'pay_123',
        status: 'confirmed',
        tx_hash: txHash,
        chain_id: 8453,
        token: 'USDC',
        amount: '0.01',
        to: challenge.recipient,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Proof rejected' }), { status: 402 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ event_id: 'event-123' }), { status: 202 }))

    const haven = new HavenClient({
      apiKey: 'sk_agent_test',
      delegateKey: `0x${'01'.repeat(32)}`,
      baseUrl: backendUrl,
    })

    await expect(haven.fetch(resourceUrl)).rejects.toMatchObject({
      statusCode: 402,
      body: expect.objectContaining({
        marker: 'machine_payment_retry_rejected_after_payment',
        payment_id: 'pay_123',
      }),
    })

    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(fetchMock.mock.calls[4][0]).toBe(`${backendUrl}/machine-payments/reconciliation-events`)
    const reportInit = fetchMock.mock.calls[4][1] as RequestInit
    expect(JSON.parse(reportInit.body as string)).toMatchObject({
      paymentId: 'pay_123',
      rail: 'mpp_demo',
      eventType: 'merchant_retry_rejected_after_payment',
      txHash,
      details: {
        resource_url: resourceUrl,
        retry_status: 402,
        retry_body: JSON.stringify({ error: 'Proof rejected' }),
        challenge_id: challenge.challengeId,
      },
    })
  })

  it('surfaces MPP approval queues as a 202 API error', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        payment_id: 'approval-123',
        status: 'pending_approval',
        message: 'Queued for owner approval',
        rail: 'mpp_demo',
        challenge_id: challenge.challengeId,
        token: 'USDC',
        amount: '0.01',
        expires_at: '2026-05-12T20:00:00.000Z',
      }), { status: 202 }))

    const haven = new HavenClient({
      apiKey: 'sk_agent_test',
      delegateKey: `0x${'01'.repeat(32)}`,
      baseUrl: 'https://haven-api.example',
    })

    await expect(haven.authorizeMachinePayment(challenge)).rejects.toMatchObject({
      statusCode: 202,
      body: expect.objectContaining({
        payment_id: 'approval-123',
        status: 'pending_approval',
      }),
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('surfaces expired MPP signing attempts as a 410 API error', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        payment_id: 'pay_123',
        status: 'pending_signature',
        chain_id: 8453,
        safe_address: '0x135a9215604711AC70d970e12Caa812c53537EF4',
        token: 'USDC',
        amount: '0.01',
        to: challenge.recipient,
        resource_url: challenge.resource,
        rail: 'mpp_demo',
        challenge_id: challenge.challengeId,
        sign_data: {
          hash: `0x${'11'.repeat(32)}`,
          components: {
            safe: '0x135a9215604711AC70d970e12Caa812c53537EF4',
            token: challenge.asset.address,
            to: challenge.recipient,
            amount: challenge.amount.atomic,
            payment_token: '0x0000000000000000000000000000000000000000',
            payment: '0',
            nonce: 1,
          },
          instructions: 'Sign with delegate key',
        },
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        payment_id: 'pay_123',
        status: 'expired',
        error: 'Payment intent has expired',
      }), { status: 200 }))

    const haven = new HavenClient({
      apiKey: 'sk_agent_test',
      delegateKey: `0x${'01'.repeat(32)}`,
      baseUrl: 'https://haven-api.example',
    })

    await expect(haven.authorizeMachinePayment(challenge)).rejects.toMatchObject({
      statusCode: 410,
      body: expect.objectContaining({
        payment_id: 'pay_123',
        status: 'expired',
      }),
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
