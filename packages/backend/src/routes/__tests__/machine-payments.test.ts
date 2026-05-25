import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import machinePaymentRoutes from '../machine-payments.js'

const { mockQuery, allowanceMocks } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  allowanceMocks: {
    getTokenAllowance: vi.fn(),
    computeEffectiveAllowance: vi.fn(),
    generateTransferHash: vi.fn(),
    recoverSigner: vi.fn(),
    executeAllowanceTransfer: vi.fn(),
  },
}))

vi.mock('../../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockQuery(...args),
  },
}))

vi.mock('../../lib/allowance-module.js', () => allowanceMocks)

const AGENT = {
  id: '11111111-1111-1111-1111-111111111111',
  user_id: '22222222-2222-2222-2222-222222222222',
  name: 'Payment Agent',
  delegate_address: '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1',
  safe_address: '0x135a9215604711AC70d970e12Caa812c53537EF4',
  chain_id: 8453,
  status: 'active',
}

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const RECIPIENT = '0x15179876c595922999C2d5DC7c23Cc7711fE799a'
const SIGN_HASH = `0x${'11'.repeat(32)}`
const PAYMENT_ID = '33333333-3333-3333-3333-333333333333'
const TX_HASH = `0x${'ab'.repeat(32)}`

const challenge = {
  rail: 'mpp_demo',
  version: '2026-05-12',
  challengeId: 'challenge-123',
  resource: 'https://haven.example/demo/mpp/market-summary',
  description: 'Haven market summary demo',
  network: { chainId: 8453, name: 'base' },
  asset: { symbol: 'USDC', address: USDC, decimals: 6 },
  amount: { display: '0.01', atomic: '10000' },
  recipient: RECIPIENT,
  expiresAt: '2099-01-01T00:00:00.000Z',
  metadata: { demoResource: 'market-summary' },
}

function authRow() {
  return { rows: [AGENT] }
}

describe('machine payment routes', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(machinePaymentRoutes, { prefix: '/machine-payments' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    mockQuery.mockReset()
    for (const mock of Object.values(allowanceMocks)) mock.mockReset()
  })

  function pendingIntent(overrides: Record<string, unknown> = {}) {
    return {
      id: PAYMENT_ID,
      status: 'pending_signature',
      expires_at: '2099-01-01T00:10:00.000Z',
      chain_id: 8453,
      safe_address: AGENT.safe_address,
      token_symbol: 'USDC',
      token_address: USDC,
      amount_human: '0.01',
      amount_raw: '10000',
      to_address: RECIPIENT.toLowerCase(),
      merchant_address: RECIPIENT.toLowerCase(),
      payment_resource_url: challenge.resource,
      payment_rail: 'mpp_demo',
      machine_challenge_id: challenge.challengeId,
      machine_idempotency_key: 'mpp_demo:test',
      machine_metadata: JSON.stringify({
        protocol: 'mpp',
        network: challenge.network.name,
        description: challenge.description,
      }),
      sign_hash: SIGN_HASH,
      allowance_nonce: 3,
      ...overrides,
    }
  }

  function confirmedPayment(overrides: Record<string, unknown> = {}) {
    return {
      id: PAYMENT_ID,
      agent_id: AGENT.id,
      user_id: AGENT.user_id,
      safe_address: AGENT.safe_address,
      chain_id: 8453,
      token_symbol: 'USDC',
      token_address: USDC,
      to_address: RECIPIENT.toLowerCase(),
      amount_raw: '10000',
      amount_human: '0.01',
      tx_hash: TX_HASH,
      status: 'confirmed',
      payment_rail: 'mpp_demo',
      source: 'mpp_demo',
      payment_resource_url: challenge.resource,
      x402_resource_url: null,
      merchant_address: RECIPIENT.toLowerCase(),
      x402_merchant_address: null,
      machine_challenge_id: challenge.challengeId,
      machine_idempotency_key: 'mpp_demo:test',
      machine_metadata: JSON.stringify({
        protocol: 'mpp',
        network: challenge.network.name,
        description: challenge.description,
      }),
      x402_idempotency_key: null,
      confirmed_at: '2026-05-15T12:00:00.000Z',
      ...overrides,
    }
  }

  it('returns the authenticated agent identity for MCP clients', async () => {
    mockQuery.mockResolvedValueOnce(authRow())

    const response = await app.inject({
      method: 'GET',
      url: '/machine-payments/agent',
      headers: { authorization: 'Bearer sk_agent_test' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      id: AGENT.id,
      name: AGENT.name,
      status: AGENT.status,
      safe_address: AGENT.safe_address,
      delegate_address: AGENT.delegate_address,
      chain_id: AGENT.chain_id,
    })
  })

  it('returns configured allowances with on-chain remaining spend', async () => {
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({
      amount: 10000n,
      spent: 2500n,
      resetTimeMin: 60,
      lastResetMin: 100,
      nonce: 7,
    })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({
      remaining: 7500n,
      effectiveSpent: 2500n,
      isResetPending: false,
    })

    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({
        rows: [{
          id: 'allowance-1',
          token_address: USDC,
          token_symbol: 'USDC',
          allowance_amount: '10000',
          reset_period_min: 60,
        }],
      })

    const response = await app.inject({
      method: 'GET',
      url: '/machine-payments/allowances',
      headers: { authorization: 'Bearer sk_agent_test' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      agent_id: AGENT.id,
      safe_address: AGENT.safe_address,
      delegate_address: AGENT.delegate_address,
      chain_id: AGENT.chain_id,
      allowances: [{
        id: 'allowance-1',
        token_address: USDC,
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
    })
    expect(allowanceMocks.getTokenAllowance).toHaveBeenCalledWith(
      AGENT.chain_id,
      AGENT.safe_address,
      AGENT.delegate_address,
      USDC,
    )
  })

  it('lists recent receipts without returning payment proof headers', async () => {
    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({
        rows: [{
          id: 'evidence-1',
          payment_intent_id: PAYMENT_ID,
          agent_id: AGENT.id,
          user_id: AGENT.user_id,
          rail: 'mpp_demo',
          proof_status: 'payment_confirmed',
          tx_hash: TX_HASH,
          chain_id: 8453,
          resource_url: challenge.resource,
          merchant_address: RECIPIENT.toLowerCase(),
          payer_address: AGENT.safe_address.toLowerCase(),
          settlement_address: RECIPIENT.toLowerCase(),
          token_symbol: 'USDC',
          token_address: USDC,
          amount_raw: '10000',
          amount_human: '0.01',
          challenge_id: challenge.challengeId,
          idempotency_key: 'mpp_demo:test',
          challenge_payload: { rail: 'mpp_demo' },
          selected_payment: null,
          payment_proof_header_name: 'MACHINE-PAYMENT-PROOF',
          payment_proof_header: 'secret-proof-header',
          protocol_receipt_header_name: 'Payment-Receipt',
          protocol_receipt_header: 'receipt-header',
          protocol_receipt_payload: { ok: true },
          merchant_status: 200,
          confirmed_at: '2026-05-15T12:00:00.000Z',
          created_at: '2026-05-15T12:00:01.000Z',
          updated_at: '2026-05-15T12:00:01.000Z',
        }],
      })

    const response = await app.inject({
      method: 'GET',
      url: '/machine-payments/receipts?limit=10',
      headers: { authorization: 'Bearer sk_agent_test' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      receipts: [{
        id: 'evidence-1',
        payment_id: PAYMENT_ID,
        rail: 'mpp_demo',
        proof_status: 'payment_confirmed',
        tx_hash: TX_HASH,
        chain_id: 8453,
        resource_url: challenge.resource,
        merchant_address: RECIPIENT.toLowerCase(),
        payer_address: AGENT.safe_address.toLowerCase(),
        settlement_address: RECIPIENT.toLowerCase(),
        token_symbol: 'USDC',
        token_address: USDC,
        amount_raw: '10000',
        amount_human: '0.01',
        challenge_id: challenge.challengeId,
        idempotency_key: 'mpp_demo:test',
        challenge_payload: { rail: 'mpp_demo' },
        selected_payment: null,
        payment_proof_header_name: 'MACHINE-PAYMENT-PROOF',
        protocol_receipt_header_name: 'Payment-Receipt',
        protocol_receipt_payload: { ok: true },
        merchant_status: 200,
        confirmed_at: '2026-05-15T12:00:00.000Z',
        created_at: '2026-05-15T12:00:01.000Z',
        updated_at: '2026-05-15T12:00:01.000Z',
      }],
    })
    expect(JSON.stringify(response.json())).not.toContain('secret-proof-header')
  })

  it('creates an MPP demo payment intent with generic rail metadata', async () => {
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 3 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 10000n })
    allowanceMocks.generateTransferHash.mockResolvedValueOnce(SIGN_HASH)

    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ allowance_amount: '10000' }] })
      .mockResolvedValueOnce({
        rows: [pendingIntent()],
      })

    const response = await app.inject({
      method: 'POST',
      url: '/machine-payments/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { challenge, idempotencyKey: 'mpp_demo:test' },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      payment_id: PAYMENT_ID,
      status: 'pending_signature',
      rail: 'mpp_demo',
      challenge_id: challenge.challengeId,
      amount: '0.01',
      amount_atomic: '10000',
      token: 'USDC',
      asset: USDC,
      network: challenge.network.name,
      description: challenge.description,
      idempotency_key: 'mpp_demo:test',
      resource_url: challenge.resource,
      merchant_address: RECIPIENT.toLowerCase(),
      mpp: {
        amount_atomic: '10000',
        asset: USDC,
        network: challenge.network.name,
        resource_url: challenge.resource,
        merchant_address: RECIPIENT.toLowerCase(),
        description: challenge.description,
        idempotency_key: 'mpp_demo:test',
        challenge_id: challenge.challengeId,
      },
      to: RECIPIENT.toLowerCase(),
      sign_data: {
        hash: SIGN_HASH,
        components: {
          safe: AGENT.safe_address,
          token: USDC,
          to: RECIPIENT.toLowerCase(),
          amount: '10000',
          nonce: 3,
        },
      },
    })

    expect(allowanceMocks.generateTransferHash).toHaveBeenCalledWith(
      8453,
      AGENT.safe_address,
      USDC,
      RECIPIENT,
      10000n,
      '0x0000000000000000000000000000000000000000',
      0n,
      3,
    )

    const insertCall = mockQuery.mock.calls[4]
    expect(insertCall[0]).toContain('payment_rail')
    expect(insertCall[0]).toContain('machine_challenge_id')
    expect(insertCall[0]).toContain('machine_idempotency_key')
    expect(insertCall[1]).toContain('mpp_demo')
    expect(insertCall[1]).toContain(challenge.challengeId)
    expect(insertCall[1]).toContain('mpp_demo:test')
  })

  it('returns a confirmed payment for idempotency replay', async () => {
    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({
        rows: [pendingIntent({
          status: 'confirmed',
          tx_hash: `0x${'ab'.repeat(32)}`,
        })],
      })

    const response = await app.inject({
      method: 'POST',
      url: '/machine-payments/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { challenge, idempotencyKey: 'mpp_demo:test' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      success: true,
      payment_id: PAYMENT_ID,
      status: 'confirmed',
      tx_hash: `0x${'ab'.repeat(32)}`,
      rail: 'mpp_demo',
      challenge_id: challenge.challengeId,
      amount_atomic: '10000',
      asset: USDC,
      network: challenge.network.name,
      idempotency_key: 'mpp_demo:test',
      mpp: {
        challenge_id: challenge.challengeId,
        resource_url: challenge.resource,
        merchant_address: RECIPIENT.toLowerCase(),
      },
    })
    expect(allowanceMocks.generateTransferHash).not.toHaveBeenCalled()
  })

  it('returns unified status for confirmed payment intents', async () => {
    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [confirmedPayment({
          expires_at: '2099-01-02T00:00:00.000Z',
        })],
      })

    const response = await app.inject({
      method: 'GET',
      url: `/machine-payments/${PAYMENT_ID}/status`,
      headers: { authorization: 'Bearer sk_agent_test' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      payment_id: PAYMENT_ID,
      kind: 'payment_intent',
      rail: 'mpp_demo',
      status: 'confirmed',
      phase: 'payment_confirmed',
      next_action: 'none',
      amount: '0.01',
      token: 'USDC',
      tx_hash: TX_HASH,
      resource_url: challenge.resource,
      merchant_address: RECIPIENT.toLowerCase(),
      amount_atomic: '10000',
      asset: USDC,
      network: challenge.network.name,
      description: challenge.description,
      idempotency_key: 'mpp_demo:test',
      mpp: {
        amount_atomic: '10000',
        asset: USDC,
        network: challenge.network.name,
        resource_url: challenge.resource,
        merchant_address: RECIPIENT.toLowerCase(),
        description: challenge.description,
        idempotency_key: 'mpp_demo:test',
        challenge_id: challenge.challengeId,
      },
    })
  })

  it('returns unified status for approval request IDs', async () => {
    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'approval-123',
          chain_id: 8453,
          token_symbol: 'USDC',
          token_address: USDC,
          amount_human: '0.01',
          amount_raw: '10000',
          status: 'pending',
          tx_hash: null,
          expires_at: '2099-01-02T00:00:00.000Z',
          source: 'mpp_demo',
          payment_rail: 'mpp_demo',
          payment_resource_url: challenge.resource,
          x402_resource_url: null,
          merchant_address: RECIPIENT.toLowerCase(),
          machine_challenge_id: challenge.challengeId,
          machine_idempotency_key: 'mpp_demo:test',
          machine_metadata: JSON.stringify({
            protocol: 'mpp',
            network: challenge.network.name,
            description: challenge.description,
          }),
        }],
      })

    const response = await app.inject({
      method: 'GET',
      url: '/machine-payments/approval-123/status',
      headers: { authorization: 'Bearer sk_agent_test' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      payment_id: 'approval-123',
      kind: 'approval_request',
      rail: 'mpp_demo',
      status: 'pending',
      phase: 'user_approval_required',
      next_action: 'wait_for_user_approval',
      amount: '0.01',
      token: 'USDC',
      amount_atomic: '10000',
      asset: USDC,
      network: challenge.network.name,
      description: challenge.description,
      idempotency_key: 'mpp_demo:test',
      mpp: {
        challenge_id: challenge.challengeId,
      },
    })
  })

  it('does not return status for another agent payment or approval', async () => {
    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    const response = await app.inject({
      method: 'GET',
      url: `/machine-payments/${PAYMENT_ID}/status`,
      headers: { authorization: 'Bearer sk_agent_test' },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ error: 'Payment or approval request not found' })
  })

  it('queues over-allowance MPP demo payments for approval with rail metadata', async () => {
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 3 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 1n })

    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ allowance_amount: '10000' }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'approval-123',
          status: 'pending',
          token_symbol: 'USDC',
          amount_human: '0.01',
          expires_at: '2099-01-02T00:00:00.000Z',
          tx_hash: null,
          machine_challenge_id: challenge.challengeId,
          payment_rail: 'mpp_demo',
        }],
      })

    const response = await app.inject({
      method: 'POST',
      url: '/machine-payments/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { challenge, idempotencyKey: 'mpp_demo:test' },
    })

    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({
      payment_id: 'approval-123',
      status: 'pending_approval',
      rail: 'mpp_demo',
      challenge_id: challenge.challengeId,
      token: 'USDC',
      requested: '0.01',
      resource_url: challenge.resource,
      merchant_address: RECIPIENT.toLowerCase(),
      amount_atomic: '10000',
      asset: USDC,
      network: challenge.network.name,
      description: challenge.description,
      idempotency_key: 'mpp_demo:test',
      mpp: {
        amount_atomic: '10000',
        asset: USDC,
        network: challenge.network.name,
        resource_url: challenge.resource,
        merchant_address: RECIPIENT.toLowerCase(),
        description: challenge.description,
        idempotency_key: 'mpp_demo:test',
        challenge_id: challenge.challengeId,
      },
    })

    const insertCall = mockQuery.mock.calls[4]
    expect(insertCall[0]).toContain('machine_idempotency_key')
    expect(insertCall[1]).toContain('mpp_demo:test')
  })

  it('returns a specific response for rejected approval retries', async () => {
    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'approval-123',
          status: 'rejected',
          token_symbol: 'USDC',
          amount_human: '0.01',
          expires_at: '2099-01-02T00:00:00.000Z',
          tx_hash: null,
          machine_challenge_id: challenge.challengeId,
          payment_rail: 'mpp_demo',
        }],
      })

    const response = await app.inject({
      method: 'POST',
      url: '/machine-payments/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { challenge, idempotencyKey: 'mpp_demo:test' },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({
      payment_id: 'approval-123',
      status: 'rejected',
      error: 'Payment was rejected by the account owner',
    })
  })

  it('rejects expired challenges', async () => {
    mockQuery.mockResolvedValueOnce(authRow())

    const response = await app.inject({
      method: 'POST',
      url: '/machine-payments/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        challenge: { ...challenge, expiresAt: '2020-01-01T00:00:00.000Z' },
        idempotencyKey: 'mpp_demo:test',
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('MPP demo challenge has expired')
  })

  it('rejects signatures from the wrong delegate', async () => {
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 3 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 10000n })
    allowanceMocks.generateTransferHash.mockResolvedValueOnce(SIGN_HASH)
    allowanceMocks.recoverSigner.mockReturnValueOnce('0x0000000000000000000000000000000000000001')

    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ allowance_amount: '10000' }] })
      .mockResolvedValueOnce({ rows: [pendingIntent()] })

    const response = await app.inject({
      method: 'POST',
      url: '/machine-payments/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { challenge, idempotencyKey: 'mpp_demo:test', signature: '0xsig' },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({
      error: 'Signature does not match delegate address',
      recovered: '0x0000000000000000000000000000000000000001',
    })
    expect(allowanceMocks.executeAllowanceTransfer).not.toHaveBeenCalled()
  })

  it('records a reconciliation event for confirmed payments rejected by the merchant retry', async () => {
    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [confirmedPayment()] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'event-123',
          status: 'open',
          created_at: '2026-05-15T12:00:00.000Z',
        }],
      })

    const response = await app.inject({
      method: 'POST',
      url: '/machine-payments/reconciliation-events',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        paymentId: PAYMENT_ID,
        rail: 'mpp_demo',
        eventType: 'merchant_retry_rejected_after_payment',
        txHash: TX_HASH,
        reason: 'Merchant returned HTTP 402 after payment',
        details: { retryStatus: 402, resourceUrl: challenge.resource },
      },
    })

    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({
      event_id: 'event-123',
      status: 'open',
      payment_id: PAYMENT_ID,
      rail: 'mpp_demo',
      event_type: 'merchant_retry_rejected_after_payment',
    })

    const insertCall = mockQuery.mock.calls[2]
    expect(insertCall[0]).toContain('machine_payment_reconciliation_events')
    expect(insertCall[0]).toContain('ON CONFLICT (payment_intent_id, event_type)')
    expect(insertCall[1]).toContain(PAYMENT_ID)
    expect(insertCall[1]).toContain('mpp_demo')
    expect(insertCall[1]).toContain('merchant_retry_rejected_after_payment')
    expect(insertCall[1]).toContain(TX_HASH)
    expect(insertCall[1]).toContain(challenge.resource)
    expect(insertCall[1]).toContain(RECIPIENT.toLowerCase())
    expect(insertCall[1]).toContain(challenge.challengeId)
    expect(insertCall[1]).toContain('mpp_demo:test')
  })

  it('attaches SDK-reported merchant evidence for confirmed machine payments', async () => {
    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [confirmedPayment()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'evidence-123',
          payment_intent_id: PAYMENT_ID,
          agent_id: AGENT.id,
          user_id: AGENT.user_id,
          rail: 'mpp_demo',
          proof_status: 'protocol_receipt_attached',
          tx_hash: TX_HASH,
          chain_id: 8453,
          resource_url: challenge.resource,
          merchant_address: RECIPIENT.toLowerCase(),
          payer_address: AGENT.safe_address.toLowerCase(),
          settlement_address: RECIPIENT.toLowerCase(),
          token_symbol: 'USDC',
          token_address: USDC.toLowerCase(),
          amount_raw: '10000',
          amount_human: '0.01',
          challenge_id: challenge.challengeId,
          idempotency_key: 'mpp_demo:test',
          challenge_payload: challenge,
          selected_payment: null,
          payment_proof_header_name: 'MACHINE-PAYMENT-PROOF',
          payment_proof_header: 'proof-header',
          protocol_receipt_header_name: 'Payment-Receipt',
          protocol_receipt_header: 'receipt-header',
          protocol_receipt_payload: { status: 'settled' },
          merchant_status: 200,
          confirmed_at: '2026-05-15T12:00:00.000Z',
          created_at: '2026-05-15T12:00:00.000Z',
          updated_at: '2026-05-15T12:00:01.000Z',
        }],
      })

    const response = await app.inject({
      method: 'POST',
      url: '/machine-payments/evidence',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        paymentId: PAYMENT_ID,
        rail: 'mpp_demo',
        txHash: TX_HASH,
        resourceUrl: challenge.resource,
        merchantStatus: 200,
        challengePayload: challenge,
        paymentProofHeaderName: 'MACHINE-PAYMENT-PROOF',
        paymentProofHeader: 'proof-header',
        protocolReceiptHeaderName: 'Payment-Receipt',
        protocolReceiptHeader: 'receipt-header',
        protocolReceiptPayload: { status: 'settled' },
      },
    })

    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({
      evidence: {
        payment_id: PAYMENT_ID,
        rail: 'mpp_demo',
        proof_status: 'protocol_receipt_attached',
        tx_hash: TX_HASH,
        payment_proof_header_name: 'MACHINE-PAYMENT-PROOF',
        protocol_receipt_header_name: 'Payment-Receipt',
        protocol_receipt_payload: { status: 'settled' },
      },
    })

    expect(mockQuery.mock.calls[2][0]).toContain('machine_payment_evidence')
    expect(mockQuery.mock.calls[3][0]).toContain('UPDATE machine_payment_evidence')
  })

  it('rejects evidence reports whose tx hash does not match the payment', async () => {
    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [confirmedPayment()] })

    const response = await app.inject({
      method: 'POST',
      url: '/machine-payments/evidence',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        paymentId: PAYMENT_ID,
        rail: 'mpp_demo',
        txHash: `0x${'cd'.repeat(32)}`,
      },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toBe('txHash does not match payment intent')
    expect(mockQuery).toHaveBeenCalledTimes(2)
  })

  it('rejects evidence reports for unconfirmed payments', async () => {
    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({
        rows: [confirmedPayment({ status: 'pending_signature', tx_hash: null })],
      })

    const response = await app.inject({
      method: 'POST',
      url: '/machine-payments/evidence',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        paymentId: PAYMENT_ID,
        rail: 'mpp_demo',
        txHash: TX_HASH,
      },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toBe('Evidence requires a confirmed payment intent')
    expect(mockQuery).toHaveBeenCalledTimes(2)
  })

  it('does not attach evidence to another agent payment', async () => {
    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] })

    const response = await app.inject({
      method: 'POST',
      url: '/machine-payments/evidence',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        paymentId: PAYMENT_ID,
        rail: 'mpp_demo',
        txHash: TX_HASH,
      },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json().error).toBe('Payment intent not found')
    expect(mockQuery).toHaveBeenCalledTimes(2)
  })

  it('does not record reconciliation events for unconfirmed payments', async () => {
    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({
        rows: [confirmedPayment({ status: 'pending_signature', tx_hash: null })],
      })

    const response = await app.inject({
      method: 'POST',
      url: '/machine-payments/reconciliation-events',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        paymentId: PAYMENT_ID,
        rail: 'mpp_demo',
        eventType: 'merchant_retry_rejected_after_payment',
      },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({
      error: 'Reconciliation events require a confirmed payment intent',
      status: 'pending_signature',
    })
    expect(mockQuery).toHaveBeenCalledTimes(2)
  })

  it('rejects reconciliation events whose tx hash does not match the payment', async () => {
    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [confirmedPayment()] })

    const response = await app.inject({
      method: 'POST',
      url: '/machine-payments/reconciliation-events',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        paymentId: PAYMENT_ID,
        rail: 'mpp_demo',
        eventType: 'merchant_retry_rejected_after_payment',
        txHash: `0x${'cd'.repeat(32)}`,
      },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toBe('txHash does not match payment intent')
    expect(mockQuery).toHaveBeenCalledTimes(2)
  })
})
