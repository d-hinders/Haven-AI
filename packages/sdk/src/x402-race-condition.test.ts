/**
 * Tests for #321 — SDK race condition: wait for funding tx confirmation
 * before retrying the merchant so the merchant's balanceOf(delegate) check
 * sees the funded balance.
 *
 * These live in a separate file so vi.mock('./provider.js') is isolated from
 * the main x402.test.ts suite (vitest isolates module registries per-file).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { HavenClient } from './client.js'
import { HavenApiError } from './types.js'

const { mockWaitForTransaction, mockCreateJsonRpcProvider } = vi.hoisted(() => {
  const mockWaitForTransaction = vi.fn()
  const mockCreateJsonRpcProvider = vi.fn(() => ({ waitForTransaction: mockWaitForTransaction }))
  return { mockWaitForTransaction, mockCreateJsonRpcProvider }
})

vi.mock('./provider.js', () => ({
  createJsonRpcProvider: mockCreateJsonRpcProvider,
}))

const delegateKey = `0x${'01'.repeat(32)}`
const delegateAddress = '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1'
const safeAddress = '0x135a9215604711AC70d970e12Caa812c53537EF4'
const txHash = `0x${'ab'.repeat(32)}`
const rpcUrl = 'https://rpc.test.example'

const paymentRequired = {
  x402Version: 2,
  error: 'Payment required',
  resource: {
    url: 'https://api.merchant.example/paid',
    description: 'test resource',
    mimeType: 'application/json',
  },
  accepts: [{
    scheme: 'exact',
    network: 'eip155:8453',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    amount: '20000',
    payTo: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
    maxTimeoutSeconds: 300,
    extra: { name: 'USD Coin', version: '2' },
  }],
}

function makeHaven() {
  return new HavenClient({
    apiKey: 'sk_agent_test',
    delegateKey,
    baseUrl: 'https://haven.example',
    chainRpcs: { 8453: rpcUrl },
  })
}

function authorizeResponse() {
  return new Response(JSON.stringify({
    payment_id: 'pay_321',
    status: 'pending_signature',
    chain_id: 8453,
    safe_address: safeAddress,
    token: 'USDC',
    amount: '0.02',
    to: delegateAddress,
    resource_url: paymentRequired.resource.url,
    sign_data: {
      hash: `0x${'11'.repeat(32)}`,
      components: {
        safe: safeAddress,
        token: paymentRequired.accepts[0].asset,
        to: delegateAddress,
        amount: paymentRequired.accepts[0].amount,
        payment_token: '0x0000000000000000000000000000000000000000',
        payment: '0',
        nonce: 1,
      },
      instructions: 'Sign with delegate key',
    },
  }), { status: 201 })
}

function signResponse() {
  return new Response(JSON.stringify({
    payment_id: 'pay_321',
    status: 'confirmed',
    tx_hash: txHash,
    chain_id: 8453,
    token: 'USDC',
    amount: '0.02',
    to: delegateAddress,
    explorer_url: `https://basescan.org/tx/${txHash}`,
  }), { status: 200 })
}

function merchantSuccessResponse() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'PAYMENT-RESPONSE': btoa(JSON.stringify({
        success: true,
        transaction: txHash,
        network: paymentRequired.accepts[0].network,
      })),
    },
  })
}

function evidenceResponse() {
  return new Response(JSON.stringify({ evidence: { id: 'ev-321' } }), { status: 202 })
}

describe('x402 funding tx confirmation wait (#321)', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('waits for ≥1 on-chain confirmation before retrying the merchant (happy path)', async () => {
    mockWaitForTransaction.mockResolvedValue({ status: 1 })

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(paymentRequired), {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(authorizeResponse())
      .mockResolvedValueOnce(signResponse())
      .mockResolvedValueOnce(merchantSuccessResponse())
      .mockResolvedValueOnce(evidenceResponse())

    const haven = makeHaven()
    const response = await haven.fetch(paymentRequired.resource.url, { method: 'GET' })

    expect(response.status).toBe(200)
    expect(mockCreateJsonRpcProvider).toHaveBeenCalledWith(rpcUrl)
    expect(mockWaitForTransaction).toHaveBeenCalledWith(txHash, 1, 30_000)
    expect(mockWaitForTransaction).toHaveBeenCalledTimes(1)
  })

  it('throws HavenApiError when the funding tx times out (waitForTransaction returns null)', async () => {
    mockWaitForTransaction.mockResolvedValue(null)

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(paymentRequired), {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(authorizeResponse())
      .mockResolvedValueOnce(signResponse())

    const haven = makeHaven()
    await expect(haven.fetch(paymentRequired.resource.url, { method: 'GET' })).rejects.toMatchObject({
      message: 'Funding tx did not confirm on-chain within the timeout window.',
      statusCode: 500,
    })
  })

  it('throws HavenApiError when the funding tx reverts on-chain (receipt.status === 0)', async () => {
    mockWaitForTransaction.mockResolvedValue({ status: 0 })

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(paymentRequired), {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(authorizeResponse())
      .mockResolvedValueOnce(signResponse())

    const haven = makeHaven()
    await expect(haven.fetch(paymentRequired.resource.url, { method: 'GET' })).rejects.toMatchObject({
      message: 'Funding tx did not confirm on-chain within the timeout window.',
      statusCode: 500,
    })
  })

  it('skips the RPC wait when chainRpcs is not configured (backward-compatible)', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(paymentRequired), {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(authorizeResponse())
      .mockResolvedValueOnce(signResponse())
      .mockResolvedValueOnce(merchantSuccessResponse())
      .mockResolvedValueOnce(evidenceResponse())

    const haven = new HavenClient({
      apiKey: 'sk_agent_test',
      delegateKey,
      baseUrl: 'https://haven.example',
      // chainRpcs intentionally omitted
    })

    const response = await haven.fetch(paymentRequired.resource.url, { method: 'GET' })
    expect(response.status).toBe(200)
    expect(mockCreateJsonRpcProvider).not.toHaveBeenCalled()
  })
})
