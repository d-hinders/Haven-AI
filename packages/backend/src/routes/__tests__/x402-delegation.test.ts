/**
 * #830 x402 delegation-rail settlement route. Mocks the network seams; the
 * settlement compiler runs REAL so the child delegation and header are genuine.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { mockQuery, mockSelect, mockCompute, mockCreateIntent } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockSelect: vi.fn(),
  mockCompute: vi.fn(),
  mockCreateIntent: vi.fn(),
}))
vi.mock('../../db.js', () => ({ default: { query: (...a: unknown[]) => mockQuery(...a) } }))
vi.mock('../../middleware/agentAuth.js', () => ({
  agentAuthMiddleware: async (request: { agent?: unknown }) => {
    request.agent = {
      id: 'agent-1', user_id: 'user-1', name: 'A',
      delegate_address: '0x' + 'bb'.repeat(20),
      safe_address: '0x' + 'aa'.repeat(20),
      chain_id: 84532, status: 'active',
      execution_rail: 'delegation', account_type: 'delegator_hybrid',
    }
  },
}))
vi.mock('../../lib/delegation-authorization.js', () => ({ selectDelegation: mockSelect }))
vi.mock('../../lib/hybrid-provisioning.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/hybrid-provisioning.js')>()
  return { ...actual, computeHybridAccountAddress: mockCompute }
})
vi.mock('../../lib/machine-payments.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine-payments.js')>()
  return { ...actual, createPaymentIntent: mockCreateIntent }
})

const x402Routes = (await import('../x402.js')).default
const { buildBudgetDelegation } = await import('../../lib/delegation-policy.js')

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const MERCHANT = '0x' + 'cc'.repeat(20)
const DELEGATE_ACCT = '0x' + 'dd'.repeat(20)
const INTENT_ID = '33333333-3333-3333-3333-333333333333'
const NOW = Math.floor(Date.now() / 1000)

const signedBudget = {
  ...buildBudgetDelegation({
    agentId: 'agent-1', chainId: 84532, treasuryAddress: '0x' + 'aa'.repeat(20) as `0x${string}`,
    delegateAccountAddress: DELEGATE_ACCT as `0x${string}`, tokenAddress: USDC as `0x${string}`,
    budgetAtomic: 5_000_000n, periodSeconds: 86_400, startDate: NOW - 60,
    expiresAt: NOW + 86_400, version: 1,
  }),
  signature: '0x' + 'ab'.repeat(65),
}

function authorizeBody(overrides: Record<string, unknown> = {}) {
  return {
    url: 'https://merchant.example/resource',
    payTo: MERCHANT,
    amount: '100000',
    asset: USDC,
    network: 'eip155:84532',
    ...overrides,
  }
}

describe('x402 delegation-rail settlement (#830)', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(x402Routes, { prefix: '/x402' })
  })
  afterAll(async () => app.close())
  beforeEach(() => {
    mockQuery.mockReset()
    mockSelect.mockReset()
    mockCompute.mockReset()
    mockCreateIntent.mockReset()
    mockCompute.mockResolvedValue(DELEGATE_ACCT)
  })

  it('authorize builds a settlement child + returns typed data; no funding leg', async () => {
    mockSelect.mockResolvedValueOnce({
      delegation_hash: `0x${'12'.repeat(32)}`,
      delegation_json: JSON.stringify(signedBudget),
      recipient_address: null,
    })
    mockCreateIntent.mockResolvedValueOnce({ id: INTENT_ID, status: 'pending_signature', expires_at: 'x' })

    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody(),
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.sign_data.signature_scheme).toBe('eip712_delegation')
    expect(body.sign_data.typed_data.domain.name).toBe('DelegationManager')
    expect(body.sign_data.instructions).toMatch(/X-PAYMENT header/)
    // The intent was pinned to the delegation rail:
    expect(mockCreateIntent).toHaveBeenCalledWith(expect.objectContaining({
      executionRail: 'delegation',
      preparedUserOp: expect.any(String),
    }))
    // No allowance/funding query ran — there is no funding leg on this rail:
    expect(mockQuery.mock.calls.some((c) => /allowance/i.test(String(c[0])))).toBe(false)
  })

  it('authorize rejects native-token x402 on the delegation rail (characterization, #946)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ asset: '0x0000000000000000000000000000000000000000' }),
    })
    // Native has no ERC20 transfer to pin/meter — the rail refuses it whole.
    expect([400, 403]).toContain(res.statusCode)
    expect(mockCreateIntent).not.toHaveBeenCalled()
  })

  it('authorize 403s when the agent has no active budget delegation for the merchant', async () => {
    mockSelect.mockResolvedValueOnce(null)
    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody(),
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toMatch(/no active budget delegation/)
    expect(mockCreateIntent).not.toHaveBeenCalled()
  })

  it('settle assembles the X-PAYMENT header and flips to submitted; Haven submits nothing', async () => {
    const preparedState = JSON.stringify({
      child: JSON.parse(JSON.stringify(buildBudgetDelegation({
        agentId: 'agent-1', chainId: 84532, treasuryAddress: '0x' + 'aa'.repeat(20) as `0x${string}`,
        delegateAccountAddress: DELEGATE_ACCT as `0x${string}`, tokenAddress: USDC as `0x${string}`,
        budgetAtomic: 100_000n, periodSeconds: 86_400, startDate: NOW - 60, expiresAt: NOW + 300, version: 1,
      }))),
      budget: signedBudget,
      delegateAccountAddress: DELEGATE_ACCT,
      network: 'eip155:84532',
    })
    mockQuery.mockImplementation((sql: string) => {
      if (/SELECT id, status, execution_rail/.test(String(sql))) {
        return Promise.resolve({ rows: [{
          id: INTENT_ID, status: 'pending_signature', execution_rail: 'delegation',
          prepared_user_op: JSON.parse(preparedState), chain_id: 84532,
          x402_resource_url: 'https://merchant.example/resource',
        }] })
      }
      return Promise.resolve({ rows: [] })
    })

    const res = await app.inject({
      method: 'POST', url: `/x402/${INTENT_ID}/settle`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: '0x' + 'ef'.repeat(65) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('submitted')
    // The header decodes to an exact-scheme erc7710 payload:
    const decoded = JSON.parse(Buffer.from(body.payment_header, 'base64').toString('utf8'))
    expect(decoded).toMatchObject({ x402Version: 1, scheme: 'exact', network: 'eip155:84532' })
    expect(decoded.payload.delegator.toLowerCase()).toBe(DELEGATE_ACCT.toLowerCase())
    // The intent flipped to submitted:
    expect(mockQuery.mock.calls.some((c) => /status = 'submitted'/.test(String(c[0])))).toBe(true)
  })

  it('settle 409s a non-delegation intent and 400s a bad signature', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: INTENT_ID, status: 'pending_signature', execution_rail: 'session_key', prepared_user_op: {}, chain_id: 84532, x402_resource_url: null }] })
    const wrongRail = await app.inject({
      method: 'POST', url: `/x402/${INTENT_ID}/settle`,
      headers: { authorization: 'Bearer sk_agent_test' }, payload: { signature: '0x' + 'ef'.repeat(65) },
    })
    expect(wrongRail.statusCode).toBe(409)
    const badSig = await app.inject({
      method: 'POST', url: `/x402/${INTENT_ID}/settle`,
      headers: { authorization: 'Bearer sk_agent_test' }, payload: { signature: 'nope' },
    })
    expect(badSig.statusCode).toBe(400)
  })
})
