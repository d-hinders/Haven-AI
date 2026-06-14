import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import x402Routes from '../x402.js'

const { mockQuery, allowanceMocks, fiatMocks, evidenceMocks } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  allowanceMocks: {
    getTokenAllowance: vi.fn(),
    getTokenBalance: vi.fn(),
    getLatestBlockTimeSec: vi.fn(),
    computeEffectiveAllowance: vi.fn(),
    generateTransferHash: vi.fn(),
    recoverSigner: vi.fn(),
    executeAllowanceTransfer: vi.fn(),
  },
  fiatMocks: {
    getFiatValuesForTokenAmount: vi.fn(),
  },
  evidenceMocks: {
    tryRecordMachinePaymentEvidenceBaseById: vi.fn(),
  },
}))

vi.mock('../../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockQuery(...args),
  },
}))

vi.mock('../../lib/allowance-module.js', () => allowanceMocks)

vi.mock('../../lib/fiat-values.js', () => fiatMocks)

vi.mock('../../lib/machine-payment-evidence.js', () => evidenceMocks)

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
const MERCHANT = '0x15179876c595922999C2d5DC7c23Cc7711fE799a'
const SIGN_HASH = `0x${'11'.repeat(32)}`
const TX_HASH = `0x${'ab'.repeat(32)}`
const X402_BINDING_PRIVATE_KEY = '0x59c6995e998f97a5a0044966f094538797afad9453b9c9d87f1977948421179d'

function authRow() {
  return { rows: [AGENT] }
}

function pendingX402Intent(overrides: Record<string, unknown> = {}) {
  return {
    id: '33333333-3333-3333-3333-333333333333',
    status: 'pending_signature',
    expires_at: '2026-05-10T20:00:00.000Z',
    chain_id: 8453,
    safe_address: AGENT.safe_address,
    token_symbol: 'USDC',
    token_address: USDC,
    amount_human: '0.02',
    amount_raw: '20000',
    to_address: AGENT.delegate_address.toLowerCase(),
    x402_merchant_address: MERCHANT.toLowerCase(),
    merchant_address: MERCHANT.toLowerCase(),
    x402_resource_url: 'https://mcp.soundside.ai/mcp',
    payment_resource_url: 'https://mcp.soundside.ai/mcp',
    source: 'x402',
    payment_rail: 'x402',
    x402_idempotency_key: 'x402:test',
    machine_idempotency_key: 'x402:test',
    sign_hash: SIGN_HASH,
    allowance_nonce: 7,
    ...overrides,
  }
}

describe('x402 routes', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(x402Routes, { prefix: '/x402' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    process.env.X402_BINDING_PRIVATE_KEY = X402_BINDING_PRIVATE_KEY
    mockQuery.mockReset()
    for (const mock of Object.values(allowanceMocks)) mock.mockReset()
    for (const mock of Object.values(fiatMocks)) mock.mockReset()
    for (const mock of Object.values(evidenceMocks)) mock.mockReset()
    // Default to zero delegate balance for tests that don't care about it.
    // The pre-flight check (delegateBalance + remainingAllowance >= amount)
    // still passes because existing tests set `remaining` high enough to
    // cover the requested amount on its own. Tests that want to exercise
    // the insufficient-funds branch override this with .mockResolvedValueOnce.
    allowanceMocks.getTokenBalance.mockResolvedValue(0n)
  })

  it('registers /x402/authorize as the explicit authorize endpoint', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/x402/authorize',
      payload: {},
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({ error: 'Missing or invalid API key' })
  })

  it('creates a funding intent to the delegate and records merchant metadata', async () => {
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 7 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 1_000_000n })
    allowanceMocks.generateTransferHash.mockResolvedValueOnce(SIGN_HASH)

    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ allowance_amount: '10' }] })
      .mockResolvedValueOnce({ rows: [{ max_x402_per_hour: 100 }] })
      .mockResolvedValueOnce({ rows: [{ cnt: '0' }] })
      .mockResolvedValueOnce({
        rows: [{
          id: '33333333-3333-3333-3333-333333333333',
          expires_at: '2026-05-10T20:00:00.000Z',
        }],
      })

    const response = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: AGENT.delegate_address,
        merchantPayTo: MERCHANT,
        amount: '20000',
        asset: USDC,
        network: 'base',
        idempotencyKey: 'x402:test',
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      payment_id: '33333333-3333-3333-3333-333333333333',
      status: 'pending_signature',
      chain_id: 8453,
      to: AGENT.delegate_address.toLowerCase(),
      merchant_to: MERCHANT.toLowerCase(),
      x402_expected_auth: {
        version: 1,
        message: expect.stringContaining('Haven x402 expected context v1'),
        signature: expect.stringMatching(/^0x[0-9a-f]{130}$/i),
        signer: expect.stringMatching(/^0x[0-9a-f]{40}$/i),
      },
      sign_data: {
        hash: SIGN_HASH,
        components: {
          safe: AGENT.safe_address,
          token: USDC,
          to: AGENT.delegate_address.toLowerCase(),
          amount: '20000',
          nonce: 7,
        },
      },
    })

    expect(allowanceMocks.generateTransferHash).toHaveBeenCalledWith(
      8453,
      AGENT.safe_address,
      USDC,
      AGENT.delegate_address,
      20000n,
      '0x0000000000000000000000000000000000000000',
      0n,
      7,
    )

    const insertCall = mockQuery.mock.calls[6]
    expect(insertCall[0]).toContain('x402_merchant_address')
    expect(insertCall[0]).toContain('x402_idempotency_key')
    expect(insertCall[0]).toContain('payment_rail')
    expect(insertCall[0]).toContain('merchant_address')
    expect(insertCall[0]).toContain('machine_idempotency_key')
    expect(insertCall[1]).toContain(MERCHANT.toLowerCase())
    expect(insertCall[1]).toContain('x402:test')
  })

  it('records one-shot x402 signatures without marking the payment submitted before execution', async () => {
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 7 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 1_000_000n })
    allowanceMocks.generateTransferHash.mockResolvedValueOnce(SIGN_HASH)
    allowanceMocks.recoverSigner.mockReturnValueOnce(AGENT.delegate_address)
    allowanceMocks.executeAllowanceTransfer.mockResolvedValueOnce({ txHash: TX_HASH })
    fiatMocks.getFiatValuesForTokenAmount.mockResolvedValueOnce({ usd: 0.02, eur: 0.02 })
    evidenceMocks.tryRecordMachinePaymentEvidenceBaseById.mockResolvedValueOnce(undefined)

    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ allowance_amount: '10' }] })
      .mockResolvedValueOnce({ rows: [{ max_x402_per_hour: 100 }] })
      .mockResolvedValueOnce({ rows: [{ cnt: '0' }] })
      .mockResolvedValueOnce({ rows: [pendingX402Intent()] })
      .mockResolvedValueOnce({ rows: [{ id: '33333333-3333-3333-3333-333333333333' }] })
      .mockResolvedValueOnce({ rows: [{ id: '33333333-3333-3333-3333-333333333333' }] })

    const response = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: AGENT.delegate_address,
        merchantPayTo: MERCHANT,
        amount: '20000',
        asset: USDC,
        network: 'base',
        idempotencyKey: 'x402:test',
        signature: '0xsig',
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      success: true,
      payment_id: '33333333-3333-3333-3333-333333333333',
      status: 'confirmed',
      tx_hash: TX_HASH,
    })

    const signatureUpdateIndex = mockQuery.mock.calls.findIndex(([sql]) =>
      typeof sql === 'string' && sql.includes('SET signature = $1, signed_at = NOW()')
    )
    expect(signatureUpdateIndex).toBeGreaterThanOrEqual(0)
    const signatureUpdateCall = mockQuery.mock.calls[signatureUpdateIndex]
    expect(signatureUpdateCall[0]).toContain('SET signature = $1, signed_at = NOW()')
    expect(signatureUpdateCall[0]).toContain('agent_id = $3')
    expect(signatureUpdateCall[0]).toContain("COALESCE(payment_rail, source) = 'x402'")
    expect(signatureUpdateCall[0]).toContain("status = 'pending_signature'")
    expect(signatureUpdateCall[0]).toContain('tx_hash IS NULL')
    expect(signatureUpdateCall[0]).not.toContain("status = 'submitted'")
    expect(signatureUpdateCall[0]).not.toContain('submitted_at')
    expect(signatureUpdateCall[1]).toEqual([
      '0xsig',
      '33333333-3333-3333-3333-333333333333',
      AGENT.id,
    ])

    const executionOrder = allowanceMocks.executeAllowanceTransfer.mock.invocationCallOrder[0]
    expect(mockQuery.mock.invocationCallOrder[signatureUpdateIndex]).toBeLessThan(executionOrder)

    const confirmedUpdateCall = mockQuery.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes("SET status = 'confirmed'")
    )
    expect(confirmedUpdateCall?.[0]).toContain('agent_id = $5')
    expect(confirmedUpdateCall?.[0]).toContain("COALESCE(payment_rail, source) = 'x402'")
    expect(confirmedUpdateCall?.[0]).toContain("status = 'pending_signature'")
    expect(confirmedUpdateCall?.[0]).toContain('tx_hash IS NULL')
    expect(confirmedUpdateCall?.[1]).toEqual([
      TX_HASH,
      '33333333-3333-3333-3333-333333333333',
      0.02,
      0.02,
      AGENT.id,
    ])
    expect(evidenceMocks.tryRecordMachinePaymentEvidenceBaseById).toHaveBeenCalledWith(
      '33333333-3333-3333-3333-333333333333',
      AGENT.id,
      expect.anything(),
    )
  })

  it('does not overwrite one-shot x402 terminal state after execution failures', async () => {
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 7 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 1_000_000n })
    allowanceMocks.generateTransferHash.mockResolvedValueOnce(SIGN_HASH)
    allowanceMocks.recoverSigner.mockReturnValueOnce(AGENT.delegate_address)
    allowanceMocks.executeAllowanceTransfer.mockRejectedValueOnce(new Error('relayer unavailable'))

    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ allowance_amount: '10' }] })
      .mockResolvedValueOnce({ rows: [{ max_x402_per_hour: 100 }] })
      .mockResolvedValueOnce({ rows: [{ cnt: '0' }] })
      .mockResolvedValueOnce({ rows: [pendingX402Intent()] })
      .mockResolvedValueOnce({ rows: [{ id: '33333333-3333-3333-3333-333333333333' }] })
      .mockResolvedValueOnce({ rows: [] })

    const response = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: AGENT.delegate_address,
        merchantPayTo: MERCHANT,
        amount: '20000',
        asset: USDC,
        network: 'base',
        idempotencyKey: 'x402:test',
        signature: '0xsig',
      },
    })

    expect(response.statusCode).toBe(502)
    expect(response.json()).toMatchObject({
      payment_id: '33333333-3333-3333-3333-333333333333',
      status: 'failed',
      error: 'On-chain execution failed',
    })

    const failedUpdateCall = mockQuery.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes("SET status = 'failed'")
    )
    expect(failedUpdateCall?.[0]).toContain('agent_id = $3')
    expect(failedUpdateCall?.[0]).toContain("COALESCE(payment_rail, source) = 'x402'")
    expect(failedUpdateCall?.[0]).toContain("status = 'pending_signature'")
    expect(failedUpdateCall?.[0]).toContain('tx_hash IS NULL')
    expect(failedUpdateCall?.[1]).toEqual([
      'relayer unavailable',
      '33333333-3333-3333-3333-333333333333',
      AGENT.id,
    ])
    expect(evidenceMocks.tryRecordMachinePaymentEvidenceBaseById).not.toHaveBeenCalled()
  })

  it('does not record x402 evidence when a one-shot confirmation loses a terminal-state race', async () => {
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 7 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 1_000_000n })
    allowanceMocks.generateTransferHash.mockResolvedValueOnce(SIGN_HASH)
    allowanceMocks.recoverSigner.mockReturnValueOnce(AGENT.delegate_address)
    allowanceMocks.executeAllowanceTransfer.mockResolvedValueOnce({ txHash: TX_HASH })
    fiatMocks.getFiatValuesForTokenAmount.mockResolvedValueOnce({ usd: 0.02, eur: 0.02 })

    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ allowance_amount: '10' }] })
      .mockResolvedValueOnce({ rows: [{ max_x402_per_hour: 100 }] })
      .mockResolvedValueOnce({ rows: [{ cnt: '0' }] })
      .mockResolvedValueOnce({ rows: [pendingX402Intent()] })
      .mockResolvedValueOnce({ rows: [{ id: '33333333-3333-3333-3333-333333333333' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ status: 'confirmed' }] })

    const response = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: AGENT.delegate_address,
        merchantPayTo: MERCHANT,
        amount: '20000',
        asset: USDC,
        network: 'base',
        idempotencyKey: 'x402:test',
        signature: '0xsig',
      },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({
      payment_id: '33333333-3333-3333-3333-333333333333',
      status: 'confirmed',
      error: 'Payment intent changed after on-chain execution',
    })
    expect(allowanceMocks.executeAllowanceTransfer).toHaveBeenCalledOnce()
    expect(evidenceMocks.tryRecordMachinePaymentEvidenceBaseById).not.toHaveBeenCalled()
  })

  it('rejects payment requirements whose network does not match the agent chain', async () => {
    mockQuery.mockResolvedValueOnce(authRow())

    const response = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: AGENT.delegate_address,
        amount: '20000',
        asset: USDC,
        network: 'eip155:100',
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('x402 network eip155:100 does not match agent chain 8453')
    expect(allowanceMocks.generateTransferHash).not.toHaveBeenCalled()
  })

  it('rejects malformed decimal atomic amounts before allowance checks', async () => {
    const malformedAmounts = [
      '0x4e20',
      '1e6',
      '+20000',
      '-1',
      ' 20000',
      '20000 ',
      '0',
    ]

    for (const amount of malformedAmounts) {
      mockQuery.mockResolvedValueOnce(authRow())

      const response = await app.inject({
        method: 'POST',
        url: '/x402',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: {
          url: 'https://mcp.soundside.ai/mcp',
          payTo: AGENT.delegate_address,
          amount,
          asset: USDC,
          network: 'base',
        },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json().error).toBe(
        'Invalid amount — must be a positive decimal integer in atomic units',
      )
    }

    mockQuery.mockResolvedValueOnce(authRow())
    const blankResponse = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: AGENT.delegate_address,
        amount: '',
        asset: USDC,
        network: 'base',
      },
    })

    expect(blankResponse.statusCode).toBe(400)
    expect(blankResponse.json().error).toBe('Amount (atomic units) is required')
    expect(allowanceMocks.getTokenAllowance).not.toHaveBeenCalled()
    expect(allowanceMocks.generateTransferHash).not.toHaveBeenCalled()
    expect(mockQuery).toHaveBeenCalledTimes(malformedAmounts.length + 1)
  })

  it('returns an existing pending signature intent for duplicate idempotency keys', async () => {
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 7 })

    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({
        rows: [{
          id: '33333333-3333-3333-3333-333333333333',
          status: 'pending_signature',
          expires_at: '2026-05-10T20:00:00.000Z',
          chain_id: 8453,
          safe_address: AGENT.safe_address,
          token_symbol: 'USDC',
          token_address: USDC,
          amount_human: '0.02',
          amount_raw: '20000',
          to_address: AGENT.delegate_address.toLowerCase(),
          x402_merchant_address: MERCHANT.toLowerCase(),
          x402_resource_url: 'https://mcp.soundside.ai/mcp',
          sign_hash: SIGN_HASH,
          allowance_nonce: 7,
        }],
      })

    const response = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: AGENT.delegate_address,
        merchantPayTo: MERCHANT,
        amount: '20000',
        asset: USDC,
        network: 'base',
        idempotencyKey: 'x402:test',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      payment_id: '33333333-3333-3333-3333-333333333333',
      status: 'pending_signature',
      to: AGENT.delegate_address.toLowerCase(),
      merchant_to: MERCHANT.toLowerCase(),
      sign_data: { hash: SIGN_HASH },
    })
    expect(allowanceMocks.generateTransferHash).not.toHaveBeenCalled()
    expect(mockQuery.mock.calls[1][0]).toContain("COALESCE(payment_rail, source) = 'x402'")
  })

  it('refreshes stale sign data when a duplicate pending intent has an old allowance nonce', async () => {
    const refreshedHash = `0x${'22'.repeat(32)}`
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 8 })
    allowanceMocks.generateTransferHash.mockResolvedValueOnce(refreshedHash)

    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({
        rows: [{
          id: '33333333-3333-3333-3333-333333333333',
          status: 'pending_signature',
          expires_at: '2026-05-10T20:00:00.000Z',
          chain_id: 8453,
          safe_address: AGENT.safe_address,
          token_symbol: 'USDC',
          token_address: USDC,
          amount_human: '0.02',
          amount_raw: '20000',
          to_address: AGENT.delegate_address.toLowerCase(),
          x402_merchant_address: MERCHANT.toLowerCase(),
          x402_resource_url: 'https://mcp.soundside.ai/mcp',
          sign_hash: SIGN_HASH,
          allowance_nonce: 7,
        }],
      })
      .mockResolvedValueOnce({ rows: [{ id: '33333333-3333-3333-3333-333333333333' }] })

    const response = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: AGENT.delegate_address,
        merchantPayTo: MERCHANT,
        amount: '20000',
        asset: USDC,
        network: 'base',
        idempotencyKey: 'x402:test',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().sign_data).toMatchObject({
      hash: refreshedHash,
      components: { nonce: 8 },
    })
    expect(allowanceMocks.generateTransferHash).toHaveBeenCalledWith(
      8453,
      AGENT.safe_address,
      USDC,
      AGENT.delegate_address.toLowerCase(),
      20000n,
      '0x0000000000000000000000000000000000000000',
      0n,
      8,
    )
    const refreshCall = mockQuery.mock.calls[2]
    expect(refreshCall[0]).toContain('UPDATE payment_intents')
    expect(refreshCall[0]).toContain('agent_id = $4')
    expect(refreshCall[0]).toContain("COALESCE(payment_rail, source) = 'x402'")
    expect(refreshCall[0]).toContain("status = 'pending_signature'")
    expect(refreshCall[0]).toContain('tx_hash IS NULL')
    expect(refreshCall[1]).toEqual([
      8,
      refreshedHash,
      '33333333-3333-3333-3333-333333333333',
      AGENT.id,
    ])
  })

  it('reloads rail-scoped existing x402 intents after insert idempotency conflicts', async () => {
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 7 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 1_000_000n })
    allowanceMocks.generateTransferHash.mockResolvedValueOnce(SIGN_HASH)

    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ allowance_amount: '10' }] })
      .mockResolvedValueOnce({ rows: [{ max_x402_per_hour: 100 }] })
      .mockResolvedValueOnce({ rows: [{ cnt: '0' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [pendingX402Intent()] })

    const response = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: AGENT.delegate_address,
        merchantPayTo: MERCHANT,
        amount: '20000',
        asset: USDC,
        network: 'base',
        idempotencyKey: 'x402:test',
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      payment_id: '33333333-3333-3333-3333-333333333333',
      status: 'pending_signature',
      sign_data: { hash: SIGN_HASH },
    })

    expect(mockQuery.mock.calls[1][0]).toContain("COALESCE(payment_rail, source) = 'x402'")
    const fallbackLookup = mockQuery.mock.calls[7]
    expect(fallbackLookup[0]).toContain("COALESCE(payment_rail, source) = 'x402'")
  })

  it('queues over-allowance x402 payments once with rail metadata', async () => {
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 7 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 10_000n })
    // Delegate already holds enough to satisfy the shortfall after the
    // top-up, so the pre-flight insufficient-funds check passes and we
    // fall through into the existing over-budget approval-queue path.
    allowanceMocks.getTokenBalance.mockResolvedValueOnce(20_000n)

    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ allowance_amount: '10' }] })
      .mockResolvedValueOnce({ rows: [{ max_x402_per_hour: 100 }] })
      .mockResolvedValueOnce({ rows: [{ cnt: '0' }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'approval-123',
          status: 'pending',
          token_symbol: 'USDC',
          amount_human: '0.02',
          expires_at: '2026-05-10T20:00:00.000Z',
          machine_challenge_id: null,
        }],
      })

    const response = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: AGENT.delegate_address,
        merchantPayTo: MERCHANT,
        amount: '20000',
        asset: USDC,
        network: 'base',
        category: 'data',
        idempotencyKey: 'x402:approval',
      },
    })

    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({
      payment_id: 'approval-123',
      status: 'pending_approval',
      phase: 'user_approval_required',
      next_action: 'wait_for_user_approval',
      remaining: '0.01',
      requested: '0.02',
      token: 'USDC',
      rail: 'x402',
      resource_url: 'https://mcp.soundside.ai/mcp',
      merchant_address: MERCHANT.toLowerCase(),
      chain_id: 8453,
      amount_atomic: '20000',
      asset: USDC,
      network: 'base',
      idempotency_key: 'x402:approval',
      challenge_id: null,
      x402: {
        amount_atomic: '20000',
        asset: USDC,
        network: 'base',
        resource_url: 'https://mcp.soundside.ai/mcp',
        merchant_address: MERCHANT.toLowerCase(),
        idempotency_key: 'x402:approval',
      },
    })

    const insertCall = mockQuery.mock.calls[6]
    expect(insertCall[0]).toContain('payment_rail')
    expect(insertCall[0]).toContain('payment_resource_url')
    expect(insertCall[0]).toContain('merchant_address')
    expect(insertCall[0]).toContain('machine_idempotency_key')
    expect(insertCall[0]).toContain('ON CONFLICT (agent_id, machine_idempotency_key)')
    expect(insertCall[1]).toContain('https://mcp.soundside.ai/mcp')
    expect(insertCall[1]).toContain(MERCHANT.toLowerCase())
    expect(insertCall[1]).toContain('x402:approval')
    expect(insertCall[1]).toContain(JSON.stringify({
      protocol: 'x402',
      network: 'base',
      category: 'data',
      description: null,
    }))
  })

  it('returns 422 insufficient_funds when delegate balance + remaining allowance cannot cover the amount', async () => {
    // Regression test for the agent-feedback-driven pre-flight check. Before
    // the check existed, this case would proceed all the way to sign_data
    // generation and then fail on-chain at executeAllowanceTransfer, leaving
    // the agent in a dead-end "signed but won't settle" state. The new
    // pre-flight fails fast with a structured error the agent can act on
    // (next_action=fund_safe_or_raise_allowance).
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 7 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 5_000n })
    allowanceMocks.getTokenBalance.mockResolvedValueOnce(0n)

    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ allowance_amount: '10' }] })
      .mockResolvedValueOnce({ rows: [{ max_x402_per_hour: 100 }] })
      .mockResolvedValueOnce({ rows: [{ cnt: '0' }] })

    const response = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: AGENT.delegate_address,
        merchantPayTo: MERCHANT,
        amount: '20000',
        asset: USDC,
        network: 'base',
        idempotencyKey: 'x402:insufficient',
      },
    })

    expect(response.statusCode).toBe(422)
    const body = response.json()
    expect(body).toMatchObject({
      error_code: 'insufficient_funds',
      phase: 'insufficient_funds',
      next_action: 'fund_safe_or_raise_allowance',
      rail: 'x402',
      chain_id: 8453,
      token: 'USDC',
      asset: USDC,
      network: 'base',
      amount: '0.02',
      amount_atomic: '20000',
      delegate_balance: '0.0',
      delegate_balance_atomic: '0',
      remaining_allowance: '0.005',
      remaining_allowance_atomic: '5000',
      shortfall: '0.015',
      shortfall_atomic: '15000',
      resource_url: 'https://mcp.soundside.ai/mcp',
      merchant_address: MERCHANT.toLowerCase(),
    })
    // Delegate / Safe addresses must NOT be echoed back. Agents already know
    // both from the credential they hold; surfacing them in a structured
    // pre-flight error widens the surveillance surface for the hot-wallet
    // delegate EOA for no agent-side benefit.
    expect(body).not.toHaveProperty('delegate_address')
    expect(body).not.toHaveProperty('safe_address')
    expect(body.error).toMatch(/Insufficient funds/i)
    expect(body.error).toContain('USDC')

    // Critical: no payment intent or approval row was written. The pre-flight
    // must short-circuit BEFORE any state-creating DB write — the user can
    // retry after funding without an idempotency conflict.
    const inserts = mockQuery.mock.calls.filter((call) =>
      typeof call[0] === 'string' && /INSERT INTO (payment_intents|approval_requests)/.test(call[0] as string),
    )
    expect(inserts).toEqual([])

    // The pre-flight read happened on the (chain, delegate, token) tuple
    // before the over-budget approval-queue path would have run.
    expect(allowanceMocks.getTokenBalance).toHaveBeenCalledWith(
      AGENT.chain_id,
      AGENT.delegate_address,
      USDC,
    )
  })

  it('returns 422 insufficient_funds when delegate balance + remaining is just short of the amount', async () => {
    // Boundary case: cover = amount - 1. The check must reject (strict >),
    // not silently round to "close enough", or merchant settlement would
    // revert downstream.
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 7 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 10_000n })
    allowanceMocks.getTokenBalance.mockResolvedValueOnce(9_999n)

    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ allowance_amount: '10' }] })
      .mockResolvedValueOnce({ rows: [{ max_x402_per_hour: 100 }] })
      .mockResolvedValueOnce({ rows: [{ cnt: '0' }] })

    const response = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: AGENT.delegate_address,
        merchantPayTo: MERCHANT,
        amount: '20000',
        asset: USDC,
        network: 'base',
        idempotencyKey: 'x402:boundary',
      },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({
      error_code: 'insufficient_funds',
      shortfall_atomic: '1',
    })
  })

  it('falls through pre-flight when delegate balance covers the allowance gap', async () => {
    // Regression guard: if the delegate already holds enough of the token to
    // settle the merchant payment, even a zero remaining allowance must NOT
    // fire the insufficient-funds short-circuit on its own. The over-budget
    // approval-queue path (or the happy-path sign step) is what should run.
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 7 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 0n })
    allowanceMocks.getTokenBalance.mockResolvedValueOnce(50_000n)

    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ allowance_amount: '10' }] })
      .mockResolvedValueOnce({ rows: [{ max_x402_per_hour: 100 }] })
      .mockResolvedValueOnce({ rows: [{ cnt: '0' }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'approval-balance-only',
          status: 'pending',
          token_symbol: 'USDC',
          amount_human: '0.02',
          expires_at: '2026-05-10T20:00:00.000Z',
          machine_challenge_id: null,
        }],
      })

    const response = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: AGENT.delegate_address,
        merchantPayTo: MERCHANT,
        amount: '20000',
        asset: USDC,
        network: 'base',
        idempotencyKey: 'x402:balance-only',
      },
    })

    // The existing over-budget logic still treats remaining<amount as
    // approval-required (queues for user approval). The pre-flight check is
    // narrower than that: it only short-circuits the unrecoverable case.
    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({
      payment_id: 'approval-balance-only',
      status: 'pending_approval',
    })
  })

  it('returns 502 when the delegate balance read itself fails (RPC outage)', async () => {
    // Make sure a transient RPC failure on the balance read surfaces as a
    // distinct 502 from the allowance-read failure — agents and dashboards
    // distinguishing the two read paths can pick the right retry strategy.
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 7 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 1_000_000n })
    allowanceMocks.getTokenBalance.mockRejectedValueOnce(new Error('rpc timeout'))

    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ allowance_amount: '10' }] })
      .mockResolvedValueOnce({ rows: [{ max_x402_per_hour: 100 }] })
      .mockResolvedValueOnce({ rows: [{ cnt: '0' }] })

    const response = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: AGENT.delegate_address,
        merchantPayTo: MERCHANT,
        amount: '20000',
        asset: USDC,
        network: 'base',
        idempotencyKey: 'x402:rpc-outage',
      },
    })

    expect(response.statusCode).toBe(502)
    expect(response.json().error).toBe('Failed to read delegate token balance')
  })

  it('returns an existing pending approval for duplicate over-allowance idempotency keys', async () => {
    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'approval-123',
          status: 'pending',
          token_symbol: 'USDC',
          amount_human: '0.02',
          expires_at: '2026-05-10T20:00:00.000Z',
          machine_challenge_id: null,
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'approval-123',
          chain_id: 8453,
          token_symbol: 'USDC',
          token_address: USDC,
          amount_human: '0.02',
          amount_raw: '20000',
          status: 'pending',
          tx_hash: null,
          expires_at: '2026-05-10T20:00:00.000Z',
          source: 'x402',
          payment_rail: 'x402',
          payment_resource_url: 'https://mcp.soundside.ai/mcp',
          x402_resource_url: 'https://mcp.soundside.ai/mcp',
          merchant_address: MERCHANT.toLowerCase(),
          machine_idempotency_key: 'x402:approval',
          machine_metadata: JSON.stringify({
            protocol: 'x402',
            network: 'base',
            category: null,
            description: null,
          }),
        }],
      })

    const response = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: AGENT.delegate_address,
        merchantPayTo: MERCHANT,
        amount: '20000',
        asset: USDC,
        network: 'base',
        idempotencyKey: 'x402:approval',
      },
    })

    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({
      payment_id: 'approval-123',
      kind: 'approval_request',
      status: 'pending',
      phase: 'user_approval_required',
      next_action: 'wait_for_user_approval',
      amount: '0.02',
      token: 'USDC',
      rail: 'x402',
      resource_url: 'https://mcp.soundside.ai/mcp',
      merchant_address: MERCHANT.toLowerCase(),
      amount_atomic: '20000',
      asset: USDC,
      network: 'base',
      idempotency_key: 'x402:approval',
      x402: {
        amount_atomic: '20000',
        asset: USDC,
        network: 'base',
        resource_url: 'https://mcp.soundside.ai/mcp',
        merchant_address: MERCHANT.toLowerCase(),
        idempotency_key: 'x402:approval',
      },
    })
    expect(allowanceMocks.getTokenAllowance).not.toHaveBeenCalled()
  })

  it('returns executed approvals as ready for the original x402 retry', async () => {
    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'approval-123',
          status: 'executed',
          token_symbol: 'USDC',
          amount_human: '0.02',
          expires_at: '2026-05-10T20:00:00.000Z',
          machine_challenge_id: null,
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'approval-123',
          chain_id: 8453,
          token_symbol: 'USDC',
          token_address: USDC,
          amount_human: '0.02',
          amount_raw: '20000',
          status: 'executed',
          tx_hash: `0x${'ab'.repeat(32)}`,
          expires_at: '2026-05-10T20:00:00.000Z',
          source: 'x402',
          payment_rail: 'x402',
          payment_resource_url: 'https://mcp.soundside.ai/mcp',
          x402_resource_url: 'https://mcp.soundside.ai/mcp',
          merchant_address: MERCHANT.toLowerCase(),
          machine_idempotency_key: 'x402:approval',
          machine_metadata: JSON.stringify({
            protocol: 'x402',
            network: 'base',
            category: null,
            description: null,
          }),
        }],
      })

    const response = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: AGENT.delegate_address,
        merchantPayTo: MERCHANT,
        amount: '20000',
        asset: USDC,
        network: 'base',
        idempotencyKey: 'x402:approval',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      payment_id: 'approval-123',
      kind: 'approval_request',
      status: 'executed',
      phase: 'funding_sent',
      next_action: 'retry_original_x402_request',
      rail: 'x402',
      resource_url: 'https://mcp.soundside.ai/mcp',
      merchant_address: MERCHANT.toLowerCase(),
      amount_atomic: '20000',
      asset: USDC,
      network: 'base',
      idempotency_key: 'x402:approval',
    })
    expect(allowanceMocks.getTokenAllowance).not.toHaveBeenCalled()
  })

  it('returns the existing approval when an over-allowance insert hits an idempotency conflict', async () => {
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 7 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 10_000n })
    // Delegate balance covers the shortfall so the pre-flight check passes
    // and we exercise the over-budget idempotency-conflict path.
    allowanceMocks.getTokenBalance.mockResolvedValueOnce(20_000n)

    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ allowance_amount: '10' }] })
      .mockResolvedValueOnce({ rows: [{ max_x402_per_hour: 100 }] })
      .mockResolvedValueOnce({ rows: [{ cnt: '0' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'approval-123',
          status: 'pending',
          token_symbol: 'USDC',
          amount_human: '0.02',
          expires_at: '2026-05-10T20:00:00.000Z',
          machine_challenge_id: null,
        }],
      })

    const response = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: AGENT.delegate_address,
        merchantPayTo: MERCHANT,
        amount: '20000',
        asset: USDC,
        network: 'base',
        idempotencyKey: 'x402:approval',
      },
    })

    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({
      payment_id: 'approval-123',
      status: 'pending_approval',
      remaining: '0.01',
      rail: 'x402',
      resource_url: 'https://mcp.soundside.ai/mcp',
      merchant_address: MERCHANT.toLowerCase(),
      amount_atomic: '20000',
      asset: USDC,
      network: 'base',
      idempotency_key: 'x402:approval',
    })
    expect(mockQuery.mock.calls[7][0]).toContain('FROM approval_requests')
  })
})
