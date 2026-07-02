import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import machinePaymentRoutes from '../machine-payments.js'
import { authorizeMachinePayment } from '../../lib/machine-payments.js'

const { mockQuery, allowanceMocks, fiatMocks } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  allowanceMocks: {
    getTokenAllowance: vi.fn(),
    getLatestBlockTimeSec: vi.fn(),
    computeEffectiveAllowance: vi.fn(),
    generateTransferHash: vi.fn(),
    recoverSigner: vi.fn(),
    executeAllowanceTransfer: vi.fn(),
  },
  fiatMocks: {
    getFiatValuesForTokenAmount: vi.fn(),
    getBookTimeSekValue: vi.fn().mockResolvedValue(null),
  },
}))

vi.mock('../../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockQuery(...args),
  },
}))

vi.mock('../../lib/allowance-module.js', () => allowanceMocks)

vi.mock('../../lib/fiat-values.js', () => fiatMocks)

// Fee recording at settlement must not consume a mocked DB call in these
// sequence-based tests; neutralize it (the module is dark anyway).
vi.mock('../../lib/fee/fee-module.js', () => ({
  quoteFee: () => ({ paymentId: '', rail: '', feeAtomic: 0n, feeToken: '', basisPoints: 0, isZero: true }),
  recordSettledFee: async () => {},
}))

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

function expectNoAuthorizationWork() {
  expect(allowanceMocks.getTokenAllowance).not.toHaveBeenCalled()
  expect(allowanceMocks.getLatestBlockTimeSec).not.toHaveBeenCalled()
  expect(allowanceMocks.computeEffectiveAllowance).not.toHaveBeenCalled()
  expect(allowanceMocks.generateTransferHash).not.toHaveBeenCalled()
  expect(allowanceMocks.recoverSigner).not.toHaveBeenCalled()
  expect(allowanceMocks.executeAllowanceTransfer).not.toHaveBeenCalled()
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
    for (const mock of Object.values(fiatMocks)) mock.mockReset()
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
      kind: 'payment_intent',
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
      funded_but_unsettled: false,
      ...overrides,
    }
  }

  function executedApproval(overrides: Record<string, unknown> = {}) {
    return {
      id: PAYMENT_ID,
      kind: 'approval_request',
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
      status: 'executed',
      payment_rail: 'mpp_demo',
      source: 'mpp_demo',
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
      executed_at: '2026-05-15T12:00:00.000Z',
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
          approval_request_id: null,
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
        payment_intent_id: PAYMENT_ID,
        approval_request_id: null,
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
      .mockResolvedValueOnce({ rows: [] }) // execution-rail state (#745): none → legacy
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

    const insertCall = mockQuery.mock.calls[5]
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

    expect(mockQuery.mock.calls[1][0]).toContain('COALESCE(payment_rail, source) = $4')
    expect(mockQuery.mock.calls[1][1]).toEqual([
      AGENT.id,
      'mpp_demo:test',
      challenge.challengeId,
      'mpp_demo',
    ])
  })

  it('guards stale sign data refreshes for duplicate pending intents', async () => {
    const refreshedHash = `0x${'22'.repeat(32)}`
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 4 })
    allowanceMocks.generateTransferHash.mockResolvedValueOnce(refreshedHash)

    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({
        rows: [pendingIntent({
          allowance_nonce: 3,
          sign_hash: SIGN_HASH,
        })],
      })
      .mockResolvedValueOnce({ rows: [{ id: PAYMENT_ID }] })

    const response = await app.inject({
      method: 'POST',
      url: '/machine-payments/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { challenge, idempotencyKey: 'mpp_demo:test' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().sign_data).toMatchObject({
      hash: refreshedHash,
      components: { nonce: 4 },
    })

    expect(mockQuery.mock.calls[1][0]).toContain('COALESCE(payment_rail, source) = $4')

    const refreshCall = mockQuery.mock.calls[2]
    expect(refreshCall[0]).toContain('UPDATE payment_intents')
    expect(refreshCall[0]).toContain('agent_id = $4')
    expect(refreshCall[0]).toContain('COALESCE(payment_rail, source) = $5')
    expect(refreshCall[0]).toContain("status = 'pending_signature'")
    expect(refreshCall[0]).toContain('tx_hash IS NULL')
    expect(refreshCall[1]).toEqual([
      4,
      refreshedHash,
      PAYMENT_ID,
      AGENT.id,
      'mpp_demo',
    ])
  })

  it('reloads rail-scoped existing intents after insert idempotency conflicts', async () => {
    allowanceMocks.getTokenAllowance
      .mockResolvedValueOnce({ nonce: 3 })
      .mockResolvedValueOnce({ nonce: 3 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 10000n })
    allowanceMocks.generateTransferHash.mockResolvedValueOnce(SIGN_HASH)

    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ allowance_amount: '10000' }] })
      .mockResolvedValueOnce({ rows: [] }) // execution-rail state (#745): none → legacy
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [pendingIntent()] })

    const response = await app.inject({
      method: 'POST',
      url: '/machine-payments/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { challenge, idempotencyKey: 'mpp_demo:test' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      payment_id: PAYMENT_ID,
      status: 'pending_signature',
      rail: 'mpp_demo',
      sign_data: { hash: SIGN_HASH },
    })

    const fallbackLookup = mockQuery.mock.calls[6]
    expect(fallbackLookup[0]).toContain('COALESCE(payment_rail, source) = $4')
    expect(fallbackLookup[1]).toEqual([
      AGENT.id,
      'mpp_demo:test',
      challenge.challengeId,
      'mpp_demo',
    ])
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

  it('returns funded_but_unsettled phase when merchant retry was rejected after funding', async () => {
    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [confirmedPayment({
          funded_but_unsettled: true,
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
      status: 'confirmed',
      phase: 'funded_but_unsettled',
      next_action: 'sweep_stranded_funds',
    })
    // Message must tell the agent to stop and surface the failure.
    expect(response.json().message).toMatch(/stranded|merchant rejected|sweep/i)
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
      .mockResolvedValueOnce({ rows: [] }) // execution-rail state (#745): none → legacy
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

    const insertCall = mockQuery.mock.calls[5]
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

  it('rejects invalid challenge expiry timestamps before authorization work', async () => {
    const invalidExpiresAtValues = [
      'not-a-date',
      '',
      null,
    ]

    for (const expiresAt of invalidExpiresAtValues) {
      mockQuery.mockResolvedValueOnce(authRow())

      const response = await app.inject({
        method: 'POST',
        url: '/machine-payments/authorize',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: {
          challenge: { ...challenge, expiresAt },
          idempotencyKey: 'mpp_demo:test',
        },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json().error).toBe('expiresAt must be a valid ISO timestamp')
    }

    expectNoAuthorizationWork()
    expect(mockQuery).toHaveBeenCalledTimes(invalidExpiresAtValues.length)
  })

  it('rejects malformed MPP payTo before allowance, hash, or execution work', async () => {
    mockQuery.mockResolvedValueOnce(authRow())

    const response = await app.inject({
      method: 'POST',
      url: '/machine-payments/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        challenge: { ...challenge, recipient: 'not-an-address' },
        idempotencyKey: 'mpp_demo:test',
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: 'Valid payTo address is required' })
    expect(mockQuery).toHaveBeenCalledTimes(1)
    expectNoAuthorizationWork()
  })

  it('rejects malformed MPP merchantPayTo before allowance, hash, or execution work', async () => {
    const result = await authorizeMachinePayment({
      agent: AGENT,
      rail: 'mpp_demo',
      resourceUrl: challenge.resource,
      payTo: RECIPIENT,
      merchantPayTo: 'not-an-address',
      amountAtomic: challenge.amount.atomic,
      asset: challenge.asset.address,
      chainId: challenge.network.chainId,
      description: challenge.description,
      challengeId: challenge.challengeId,
      idempotencyKey: 'mpp_demo:test',
      metadata: {
        ...challenge.metadata,
        protocol: 'mpp',
        network: challenge.network.name,
        description: challenge.description,
      },
    })

    expect(result).toEqual({
      statusCode: 400,
      body: { error: 'Valid merchantPayTo address is required' },
    })
    expect(mockQuery).not.toHaveBeenCalled()
    expectNoAuthorizationWork()
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
      .mockResolvedValueOnce({ rows: [] }) // execution-rail state (#745): none → legacy
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

  it('records one-shot signatures without marking the payment submitted before execution', async () => {
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 3 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 10000n })
    allowanceMocks.generateTransferHash.mockResolvedValueOnce(SIGN_HASH)
    allowanceMocks.recoverSigner.mockReturnValueOnce(AGENT.delegate_address)
    allowanceMocks.executeAllowanceTransfer.mockResolvedValueOnce({ txHash: TX_HASH })
    fiatMocks.getFiatValuesForTokenAmount.mockResolvedValueOnce({ usd: 0.01, eur: 0.01 })

    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ allowance_amount: '10000' }] })
      .mockResolvedValueOnce({ rows: [] }) // execution-rail state (#745): none → legacy
      .mockResolvedValueOnce({ rows: [pendingIntent()] })
      .mockResolvedValueOnce({ rows: [{ id: PAYMENT_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: PAYMENT_ID }] })
      .mockResolvedValueOnce({ rows: [] })

    const response = await app.inject({
      method: 'POST',
      url: '/machine-payments/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { challenge, idempotencyKey: 'mpp_demo:test', signature: '0xsig' },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      success: true,
      payment_id: PAYMENT_ID,
      status: 'confirmed',
      tx_hash: TX_HASH,
    })

    const signatureUpdateIndex = mockQuery.mock.calls.findIndex(([sql]) =>
      typeof sql === 'string' && sql.includes('SET signature = $1, signed_at = NOW()')
    )
    expect(signatureUpdateIndex).toBeGreaterThanOrEqual(0)
    const signatureUpdateCall = mockQuery.mock.calls[signatureUpdateIndex]
    expect(signatureUpdateCall[0]).toContain('SET signature = $1, signed_at = NOW()')
    expect(signatureUpdateCall[0]).toContain("status = 'pending_signature'")
    expect(signatureUpdateCall[0]).toContain('agent_id = $3')
    expect(signatureUpdateCall[0]).toContain('payment_rail = $4')
    expect(signatureUpdateCall[0]).toContain('tx_hash IS NULL')
    expect(signatureUpdateCall[0]).not.toContain("status = 'submitted'")
    expect(signatureUpdateCall[0]).not.toContain('submitted_at')
    expect(signatureUpdateCall[1]).toEqual(['0xsig', PAYMENT_ID, AGENT.id, 'mpp_demo'])

    const executionOrder = allowanceMocks.executeAllowanceTransfer.mock.invocationCallOrder[0]
    expect(mockQuery.mock.invocationCallOrder[signatureUpdateIndex]).toBeLessThan(executionOrder)

    const confirmedUpdateIndex = mockQuery.mock.calls.findIndex(([sql]) =>
      typeof sql === 'string' && sql.includes("SET status = 'confirmed'")
    )
    expect(confirmedUpdateIndex).toBeGreaterThanOrEqual(0)
    const confirmedUpdateCall = mockQuery.mock.calls[confirmedUpdateIndex]
    expect(confirmedUpdateCall[0]).toContain("SET status = 'confirmed'")
    expect(confirmedUpdateCall[0]).toContain('tx_hash = $1')
    expect(confirmedUpdateCall[0]).toContain('submitted_at = NOW()')
    expect(confirmedUpdateCall[0]).toContain("status = 'pending_signature'")
    expect(confirmedUpdateCall[0]).toContain('agent_id = $5')
    expect(confirmedUpdateCall[0]).toContain('payment_rail = $6')
    expect(confirmedUpdateCall[0]).toContain('tx_hash IS NULL')
    expect(confirmedUpdateCall[1]).toEqual([TX_HASH, PAYMENT_ID, 0.01, 0.01, AGENT.id, 'mpp_demo'])
  })

  it('does not overwrite one-shot terminal state after execution failures', async () => {
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 3 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 10000n })
    allowanceMocks.generateTransferHash.mockResolvedValueOnce(SIGN_HASH)
    allowanceMocks.recoverSigner.mockReturnValueOnce(AGENT.delegate_address)
    allowanceMocks.executeAllowanceTransfer.mockRejectedValueOnce(new Error('relayer unavailable'))

    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ allowance_amount: '10000' }] })
      .mockResolvedValueOnce({ rows: [] }) // execution-rail state (#745): none → legacy
      .mockResolvedValueOnce({ rows: [pendingIntent()] })
      .mockResolvedValueOnce({ rows: [{ id: PAYMENT_ID }] })
      .mockResolvedValueOnce({ rows: [] })

    const response = await app.inject({
      method: 'POST',
      url: '/machine-payments/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { challenge, idempotencyKey: 'mpp_demo:test', signature: '0xsig' },
    })

    expect(response.statusCode).toBe(502)
    expect(response.json()).toMatchObject({
      payment_id: PAYMENT_ID,
      status: 'failed',
      error: 'On-chain execution failed',
    })

    const failedUpdateCall = mockQuery.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes("SET status = 'failed'")
    )
    expect(failedUpdateCall?.[0]).toContain("status = 'pending_signature'")
    expect(failedUpdateCall?.[0]).toContain('agent_id = $3')
    expect(failedUpdateCall?.[0]).toContain('payment_rail = $4')
    expect(failedUpdateCall?.[0]).toContain('tx_hash IS NULL')
    expect(failedUpdateCall?.[1]).toEqual(['relayer unavailable', PAYMENT_ID, AGENT.id, 'mpp_demo'])
  })

  it('does not record evidence when a one-shot confirmation loses a terminal-state race', async () => {
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 3 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 10000n })
    allowanceMocks.generateTransferHash.mockResolvedValueOnce(SIGN_HASH)
    allowanceMocks.recoverSigner.mockReturnValueOnce(AGENT.delegate_address)
    allowanceMocks.executeAllowanceTransfer.mockResolvedValueOnce({ txHash: TX_HASH })
    fiatMocks.getFiatValuesForTokenAmount.mockResolvedValueOnce({ usd: 0.01, eur: 0.01 })

    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ allowance_amount: '10000' }] })
      .mockResolvedValueOnce({ rows: [] }) // execution-rail state (#745): none → legacy
      .mockResolvedValueOnce({ rows: [pendingIntent()] })
      .mockResolvedValueOnce({ rows: [{ id: PAYMENT_ID }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ status: 'confirmed' }] })

    const response = await app.inject({
      method: 'POST',
      url: '/machine-payments/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { challenge, idempotencyKey: 'mpp_demo:test', signature: '0xsig' },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({
      payment_id: PAYMENT_ID,
      status: 'confirmed',
      error: 'Payment intent changed after on-chain execution',
    })
    expect(allowanceMocks.executeAllowanceTransfer).toHaveBeenCalledOnce()
    expect(
      mockQuery.mock.calls.some(([sql]) =>
        typeof sql === 'string' && sql.includes('machine_payment_evidence')
      ),
    ).toBe(false)
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
    expect(insertCall[0]).toContain("machine_payment_reconciliation_events.status <> 'resolved'")
    expect(insertCall[1]).toContain(PAYMENT_ID)
    expect(insertCall[1]).toContain('mpp_demo')
    expect(insertCall[1]).toContain('merchant_retry_rejected_after_payment')
    expect(insertCall[1]).toContain(TX_HASH)
    expect(insertCall[1]).toContain(challenge.resource)
    expect(insertCall[1]).toContain(RECIPIENT.toLowerCase())
    expect(insertCall[1]).toContain(challenge.challengeId)
    expect(insertCall[1]).toContain('mpp_demo:test')
  })

  it('records a reconciliation event for executed approval requests rejected by the merchant retry', async () => {
    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [executedApproval()] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'event-approval',
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
        reason: 'Merchant returned HTTP 402 after approval-funded payment',
        details: { retryStatus: 402, resourceUrl: challenge.resource },
      },
    })

    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({
      event_id: 'event-approval',
      payment_id: PAYMENT_ID,
      event_type: 'merchant_retry_rejected_after_payment',
    })

    const insertCall = mockQuery.mock.calls[3]
    expect(insertCall[0]).toContain('approval_request_id')
    expect(insertCall[0]).toContain('ON CONFLICT (approval_request_id, event_type)')
    expect(insertCall[0]).toContain("machine_payment_reconciliation_events.status <> 'resolved'")
    expect(insertCall[1]).toContain(PAYMENT_ID)
    expect(insertCall[1]).toContain('merchant_retry_rejected_after_payment')
  })

  it('does not reopen resolved reconciliation events for confirmed payments', async () => {
    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [confirmedPayment()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'event-resolved',
          status: 'resolved',
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
        reason: 'Merchant returned HTTP 402 after a resolved event',
        details: { retryStatus: 402, retryAttempt: 2 },
      },
    })

    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({
      event_id: 'event-resolved',
      status: 'resolved',
      payment_id: PAYMENT_ID,
    })
    expect(mockQuery.mock.calls[2][0]).toContain("machine_payment_reconciliation_events.status <> 'resolved'")
    expect(mockQuery.mock.calls[3][0]).toContain('FROM machine_payment_reconciliation_events')
    expect(mockQuery.mock.calls[3][0]).toContain('WHERE payment_intent_id = $1')
    expect(mockQuery.mock.calls[3][1]).toEqual([
      PAYMENT_ID,
      AGENT.id,
      'merchant_retry_rejected_after_payment',
    ])
  })

  it('does not reopen resolved reconciliation events for executed approval requests', async () => {
    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [executedApproval()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'event-approval-resolved',
          status: 'resolved',
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
        reason: 'Merchant returned HTTP 402 after a resolved approval event',
      },
    })

    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({
      event_id: 'event-approval-resolved',
      status: 'resolved',
      payment_id: PAYMENT_ID,
    })
    expect(mockQuery.mock.calls[3][0]).toContain("machine_payment_reconciliation_events.status <> 'resolved'")
    expect(mockQuery.mock.calls[4][0]).toContain('FROM machine_payment_reconciliation_events')
    expect(mockQuery.mock.calls[4][0]).toContain('WHERE approval_request_id = $1')
    expect(mockQuery.mock.calls[4][1]).toEqual([
      PAYMENT_ID,
      AGENT.id,
      'merchant_retry_rejected_after_payment',
    ])
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
    expect(mockQuery.mock.calls[4][0]).toContain('machine_payment_reconciliation_events')
    expect(mockQuery.mock.calls[4][0]).toContain("status = 'resolved'")
    expect(mockQuery.mock.calls[4][0]).toContain('WHERE payment_intent_id = $1')
  })

  it('attaches SDK-reported merchant evidence for executed approval requests', async () => {
    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [executedApproval()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'evidence-approval',
          payment_intent_id: null,
          approval_request_id: PAYMENT_ID,
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
        payment_intent_id: null,
        approval_request_id: PAYMENT_ID,
        proof_status: 'protocol_receipt_attached',
      },
    })
    expect(mockQuery.mock.calls[3][0]).toContain('approval_request_id')
    expect(mockQuery.mock.calls[4][0]).toContain('WHERE approval_request_id = $1')
    expect(mockQuery.mock.calls[5][0]).toContain('machine_payment_reconciliation_events')
    expect(mockQuery.mock.calls[5][0]).toContain("status = 'resolved'")
    expect(mockQuery.mock.calls[5][0]).toContain('WHERE approval_request_id = $1')
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
    expect(response.json().error).toBe('Evidence requires a confirmed payment')
    expect(mockQuery).toHaveBeenCalledTimes(2)
  })

  it('does not attach evidence to another agent payment', async () => {
    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] })
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
    expect(response.json().error).toBe('Payment not found')
    expect(mockQuery).toHaveBeenCalledTimes(3)
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
      error: 'Reconciliation events require a confirmed payment',
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

  // ── POST /send ─────────────────────────────────────────────────────────────

  describe('POST /machine-payments/send', () => {
    const SEND_PAYMENT_ID = '44444444-4444-4444-4444-444444444444'
    const SEND_HASH = `0x${'22'.repeat(32)}`
    const SEND_RECIPIENT = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'

    function sendIntentRow(overrides: Record<string, unknown> = {}) {
      return {
        id: SEND_PAYMENT_ID,
        status: 'pending_signature',
        expires_at: '2099-01-01T00:10:00.000Z',
        ...overrides,
      }
    }

    function allowanceWithRemaining(remaining: bigint) {
      allowanceMocks.getTokenAllowance.mockResolvedValueOnce({
        amount: 1_000_000n,
        spent: 0n,
        resetTimeMin: 1440,
        lastResetMin: 0,
        nonce: 5,
      })
      allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({
        remaining,
        effectiveSpent: 0n,
        isResetPending: false,
      })
    }

    it('creates a USDC payment intent within allowance and returns sign_data', async () => {
      allowanceWithRemaining(1_000_000_000n)
      allowanceMocks.generateTransferHash.mockResolvedValueOnce(SEND_HASH)

      mockQuery
        .mockResolvedValueOnce(authRow())
        // agent_allowances check
        .mockResolvedValueOnce({ rows: [{ allowance_amount: '100' }] })
        // INSERT payment_intent
        .mockResolvedValueOnce({ rows: [sendIntentRow()] })

      const response = await app.inject({
        method: 'POST',
        url: '/machine-payments/send',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: { asset: 'USDC', recipient: SEND_RECIPIENT, amount: '1.50' },
      })

      expect(response.statusCode).toBe(201)
      const body = response.json()
      expect(body.payment_id).toBe(SEND_PAYMENT_ID)
      expect(body.status).toBe('pending_signature')
      expect(body.asset).toBe('USDC')
      expect(body.amount).toBe('1.50')
      expect(body.recipient).toBe(SEND_RECIPIENT.toLowerCase())
      expect(body.sign_data.hash).toBe(SEND_HASH)
      expect(body.sign_data.instructions).toContain('delegate private key')
      expect(allowanceMocks.generateTransferHash).toHaveBeenCalledTimes(1)
    })

    it('queues over-allowance transfer as pending_approval (202)', async () => {
      allowanceWithRemaining(0n)

      mockQuery
        .mockResolvedValueOnce(authRow())
        .mockResolvedValueOnce({ rows: [{ allowance_amount: '0' }] })
        .mockResolvedValueOnce({
          rows: [{
            id: SEND_PAYMENT_ID,
            status: 'pending',
            expires_at: '2099-01-02T00:00:00.000Z',
          }],
        })

      const response = await app.inject({
        method: 'POST',
        url: '/machine-payments/send',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: { asset: 'USDC', recipient: SEND_RECIPIENT, amount: '999' },
      })

      expect(response.statusCode).toBe(202)
      const body = response.json()
      expect(body.status).toBe('pending_approval')
      expect(body.payment_id).toBe(SEND_PAYMENT_ID)
      expect(body.asset).toBe('USDC')
      expect(allowanceMocks.generateTransferHash).not.toHaveBeenCalled()
    })

    it('rejects unknown asset with 400', async () => {
      mockQuery.mockResolvedValueOnce(authRow())

      const response = await app.inject({
        method: 'POST',
        url: '/machine-payments/send',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: { asset: 'DOGE', recipient: SEND_RECIPIENT, amount: '1' },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json().error).toContain('ETH, USDC')
      expect(allowanceMocks.getTokenAllowance).not.toHaveBeenCalled()
    })

    it('rejects invalid recipient address with 400', async () => {
      mockQuery.mockResolvedValueOnce(authRow())

      const response = await app.inject({
        method: 'POST',
        url: '/machine-payments/send',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: { asset: 'USDC', recipient: 'not-an-address', amount: '1' },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json().error).toContain('recipient')
    })

    it('rejects missing amount with 400', async () => {
      mockQuery.mockResolvedValueOnce(authRow())

      const response = await app.inject({
        method: 'POST',
        url: '/machine-payments/send',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: { asset: 'USDC', recipient: SEND_RECIPIENT },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json().error).toContain('amount')
    })

    it('rejects when agent has no allowance configured for the token', async () => {
      allowanceMocks.getTokenAllowance.mockResolvedValueOnce({
        amount: 0n, spent: 0n, resetTimeMin: 0, lastResetMin: 0, nonce: 0,
      })
      allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({
        remaining: 0n, effectiveSpent: 0n, isResetPending: false,
      })

      mockQuery
        .mockResolvedValueOnce(authRow())
        .mockResolvedValueOnce({ rows: [] }) // no allowance configured

      const response = await app.inject({
        method: 'POST',
        url: '/machine-payments/send',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: { asset: 'USDC', recipient: SEND_RECIPIENT, amount: '1' },
      })

      expect(response.statusCode).toBe(403)
      expect(response.json().error).toContain('not configured')
    })

    // ── Idempotency ──────────────────────────────────────────────────────────

    function existingIntentRow(overrides: Record<string, unknown> = {}) {
      return {
        id: SEND_PAYMENT_ID,
        status: 'pending_signature',
        expires_at: '2099-01-01T00:10:00.000Z',
        token_address: USDC,
        to_address: SEND_RECIPIENT.toLowerCase(),
        amount_raw: '1500000',
        amount_human: '1.50',
        allowance_nonce: 5,
        sign_hash: SEND_HASH,
        ...overrides,
      }
    }

    it('replays an idempotent request and returns the original intent without re-reading chain', async () => {
      mockQuery
        .mockResolvedValueOnce(authRow())
        // findExistingSend: payment_intents lookup hits
        .mockResolvedValueOnce({ rows: [existingIntentRow()] })

      const response = await app.inject({
        method: 'POST',
        url: '/machine-payments/send',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: { asset: 'USDC', recipient: SEND_RECIPIENT, amount: '1.50', idempotency_key: 'send-key-1' },
      })

      expect(response.statusCode).toBe(201)
      const body = response.json()
      expect(body.payment_id).toBe(SEND_PAYMENT_ID)
      expect(body.idempotent_replay).toBe(true)
      expect(body.sign_data.hash).toBe(SEND_HASH)
      expect(body.sign_data.components.nonce).toBe(5)
      // No second intent minted and no on-chain reads on a replay.
      expect(allowanceMocks.getTokenAllowance).not.toHaveBeenCalled()
      expect(allowanceMocks.generateTransferHash).not.toHaveBeenCalled()
      expect(mockQuery).toHaveBeenCalledTimes(2) // auth + single dedup lookup
    })

    it('persists the idempotency_key when creating a new intent', async () => {
      allowanceWithRemaining(1_000_000_000n)
      allowanceMocks.generateTransferHash.mockResolvedValueOnce(SEND_HASH)

      mockQuery
        .mockResolvedValueOnce(authRow())
        .mockResolvedValueOnce({ rows: [] }) // payment_intents dedup miss
        .mockResolvedValueOnce({ rows: [] }) // approval_requests dedup miss
        .mockResolvedValueOnce({ rows: [{ allowance_amount: '100' }] }) // agent_allowances
        .mockResolvedValueOnce({ rows: [sendIntentRow()] }) // INSERT

      const response = await app.inject({
        method: 'POST',
        url: '/machine-payments/send',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: { asset: 'USDC', recipient: SEND_RECIPIENT, amount: '1.50', idempotency_key: 'send-key-2' },
      })

      expect(response.statusCode).toBe(201)
      const insertCall = mockQuery.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO payment_intents'),
      )
      expect(insertCall).toBeDefined()
      expect(insertCall![1]).toContain('send-key-2')
    })

    it('replays the winner when a concurrent insert wins the idempotency race', async () => {
      allowanceWithRemaining(1_000_000_000n)
      allowanceMocks.generateTransferHash.mockResolvedValueOnce(SEND_HASH)

      const uniqueViolation = Object.assign(new Error('duplicate key value'), { code: '23505' })

      mockQuery
        .mockResolvedValueOnce(authRow())
        .mockResolvedValueOnce({ rows: [] }) // payment_intents dedup miss
        .mockResolvedValueOnce({ rows: [] }) // approval_requests dedup miss
        .mockResolvedValueOnce({ rows: [{ allowance_amount: '100' }] }) // agent_allowances
        .mockRejectedValueOnce(uniqueViolation) // INSERT loses the race
        .mockResolvedValueOnce({ rows: [existingIntentRow()] }) // re-lookup finds the winner

      const response = await app.inject({
        method: 'POST',
        url: '/machine-payments/send',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: { asset: 'USDC', recipient: SEND_RECIPIENT, amount: '1.50', idempotency_key: 'send-key-3' },
      })

      expect(response.statusCode).toBe(201)
      expect(response.json().payment_id).toBe(SEND_PAYMENT_ID)
      expect(response.json().idempotent_replay).toBe(true)
    })

    it('rejects an empty idempotency_key with 400', async () => {
      mockQuery.mockResolvedValueOnce(authRow())

      const response = await app.inject({
        method: 'POST',
        url: '/machine-payments/send',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: { asset: 'USDC', recipient: SEND_RECIPIENT, amount: '1', idempotency_key: '' },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json().error).toContain('idempotency_key')
      expect(allowanceMocks.getTokenAllowance).not.toHaveBeenCalled()
    })

    it('reports the real status (not a stale sign request) when replaying an already-confirmed intent', async () => {
      mockQuery
        .mockResolvedValueOnce(authRow())
        // findExistingSend: payment_intents dedup hits, but it already confirmed
        .mockResolvedValueOnce({ rows: [existingIntentRow({ status: 'confirmed' })] })
        // getAgentPaymentStatus: expire-sweep UPDATE, then status SELECT
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [confirmedPayment({ expires_at: '2099-01-02T00:00:00.000Z' })] })

      const response = await app.inject({
        method: 'POST',
        url: '/machine-payments/send',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: { asset: 'USDC', recipient: SEND_RECIPIENT, amount: '1.50', idempotency_key: 'send-key-confirmed' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body.status).toBe('confirmed')
      expect(body.phase).toBe('payment_confirmed')
      expect(body.idempotent_replay).toBe(true)
      // Must NOT re-emit a sign request for a settled payment.
      expect(body.sign_data).toBeUndefined()
      expect(allowanceMocks.generateTransferHash).not.toHaveBeenCalled()
    })

    it('reports the real status (not still-pending) when replaying an approval the owner already executed', async () => {
      mockQuery
        .mockResolvedValueOnce(authRow())
        .mockResolvedValueOnce({ rows: [] }) // payment_intents dedup miss
        // approval_requests dedup hits, but it has already been executed
        .mockResolvedValueOnce({ rows: [{
          id: 'approval-exec',
          status: 'executed',
          expires_at: '2099-01-02T00:00:00.000Z',
          token_symbol: 'USDC',
          amount_human: '999',
        }] })
        // getAgentPaymentStatus: intent expire-sweep + miss, then approval expire-sweep + hit
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{
          id: 'approval-exec',
          chain_id: 8453,
          token_symbol: 'USDC',
          token_address: USDC,
          amount_human: '999',
          amount_raw: '999000000',
          status: 'executed',
          tx_hash: TX_HASH,
          expires_at: '2099-01-02T00:00:00.000Z',
          source: 'agent_transfer',
          payment_rail: null,
          payment_resource_url: null,
          x402_resource_url: null,
          merchant_address: null,
          machine_challenge_id: null,
          machine_idempotency_key: null,
          machine_metadata: null,
        }] })

      const response = await app.inject({
        method: 'POST',
        url: '/machine-payments/send',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: { asset: 'USDC', recipient: SEND_RECIPIENT, amount: '999', idempotency_key: 'send-key-executed' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body.kind).toBe('approval_request')
      expect(body.status).toBe('executed')
      expect(body.idempotent_replay).toBe(true)
      // Must NOT tell the agent to keep waiting for an approval that already completed.
      expect(body.next_action).not.toBe('wait_for_user_approval')
    })
  })
})
