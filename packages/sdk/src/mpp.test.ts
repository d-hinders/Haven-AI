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

  it('builds deterministic idempotency keys per challenge and bucket', () => {
    const now = 1778600000000
    expect(buildMachinePaymentIdempotencyKey(challenge, now)).toBe(
      buildMachinePaymentIdempotencyKey(challenge, now + 60_000),
    )
    expect(buildMachinePaymentIdempotencyKey(challenge, now)).not.toBe(
      buildMachinePaymentIdempotencyKey(
        { ...challenge, challengeId: 'challenge-456' },
        now,
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
      .mockResolvedValueOnce(new Response(JSON.stringify({ paid: true }), { status: 200 }))

    const haven = new HavenClient({
      apiKey: 'sk_agent_test',
      delegateKey: `0x${'01'.repeat(32)}`,
      baseUrl: backendUrl,
    })

    const response = await haven.fetch(resourceUrl)

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(4)

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
  })
})
