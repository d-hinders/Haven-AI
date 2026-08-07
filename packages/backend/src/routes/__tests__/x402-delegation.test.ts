/**
 * #830 x402 delegation-rail settlement route. Mocks the network seams; the
 * settlement compiler runs REAL so the child delegation and header are genuine.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { mockQuery, mockSelect, mockCompute, mockCreateIntent, mockPrepareFunding } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockSelect: vi.fn(),
  mockCompute: vi.fn(),
  mockCreateIntent: vi.fn(),
  mockPrepareFunding: vi.fn(),
}))
vi.mock('../../db.js', () => ({ default: { query: (...a: unknown[]) => mockQuery(...a) } }))

// #1053 finding 3 gave /settle real signature verification, so the tests sign
// for REAL: a fixed-key delegate account whose address the agent mock carries.
// Dummy hex now (correctly) 400s — see the wrong-signer regression test.
import { privateKeyToAccount } from 'viem/accounts'
import { delegationSigningPayload } from '../../lib/delegation-policy.js'
const DELEGATE_SIGNER = privateKeyToAccount(('0x' + '11'.repeat(32)) as `0x${string}`)
async function signChild(child: unknown): Promise<`0x${string}`> {
  const payload = delegationSigningPayload(child as never, 84532)
  return DELEGATE_SIGNER.signTypedData({
    domain: payload.domain,
    types: payload.types,
    primaryType: payload.primaryType,
    message: payload.message as never,
  })
}
vi.mock('../../middleware/agentAuth.js', () => ({
  agentAuthMiddleware: async (request: { agent?: unknown }) => {
    request.agent = {
      id: 'agent-1', user_id: 'user-1', name: 'A',
      delegate_address: DELEGATE_SIGNER.address,
      safe_address: '0x' + 'aa'.repeat(20),
      chain_id: 84532, status: 'active',
      execution_rail: 'delegation', account_type: 'delegator_hybrid',
    }
  },
}))
vi.mock('../../lib/delegation-authorization.js', () => ({
  selectDelegation: mockSelect,
  prepareDelegationPayment: mockPrepareFunding,
}))
vi.mock('../../lib/hybrid-provisioning.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/hybrid-provisioning.js')>()
  return { ...actual, computeHybridAccountAddress: mockCompute }
})
// The delegation-rail authorize orchestration writes the intent via the
// repository directly now (#997 removed the `lib/machine-payments.js`
// pass-through wrapper) — mock the repository export it actually calls.
vi.mock('../../infra/repositories/payment-intents.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../infra/repositories/payment-intents.js')>()
  return { ...actual, insertMachineIntent: mockCreateIntent }
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
    // 3009-mode responses carry the expected-context binding (#946); the
    // signer needs the dedicated key (test-only value, same as x402.test.ts).
    process.env.X402_BINDING_PRIVATE_KEY =
      '0x59c6995e998f97a5a0044966f094538797afad9453b9c9d87f1977948421179d'
    app = Fastify({ logger: false })
    await app.register(x402Routes, { prefix: '/x402' })
  })
  afterAll(async () => app.close())
  beforeEach(() => {
    mockQuery.mockReset()
    mockSelect.mockReset()
    mockCompute.mockReset()
    mockCreateIntent.mockReset()
    mockPrepareFunding.mockReset()
    mockCompute.mockResolvedValue(DELEGATE_ACCT)
    // #961: every delegation authorize consults the hourly cap; default to
    // an uncapped agent with no existing intents.
    mockQuery.mockImplementation((sql: string) => {
      if (/max_x402_per_hour/.test(String(sql))) return Promise.resolve({ rows: [{ max_x402_per_hour: 100 }] })
      if (/COUNT\(\*\)/.test(String(sql))) return Promise.resolve({ rows: [{ cnt: '0' }] })
      return Promise.resolve({ rows: [] })
    })
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
    // The intent was pinned to the delegation rail, and the METERING budget
    // is recorded uniformly (#1059): delegation_hash carries the signed CHILD,
    // budget_delegation_hash the parent budget — never equal on erc7710.
    expect(mockCreateIntent).toHaveBeenCalledWith(expect.objectContaining({
      executionRail: 'delegation',
      preparedUserOp: expect.any(String),
      budgetDelegationHash: `0x${'12'.repeat(32)}`,
    }))
    const call = mockCreateIntent.mock.calls[0][0] as { delegationHash: string; budgetDelegationHash: string }
    expect(call.delegationHash).not.toBe(call.budgetDelegationHash)
    // No allowance/funding query ran — there is no funding leg on this rail:
    expect(mockQuery.mock.calls.some((c) => /allowance/i.test(String(c[0])))).toBe(false)
  })

  // ── #1058: facilitator redeemers ─────────────────────────────────────────
  it('authorize pins the child to forwarded facilitators and stores them verbatim', async () => {
    mockSelect.mockResolvedValueOnce({
      delegation_hash: `0x${'12'.repeat(32)}`,
      delegation_json: JSON.stringify(signedBudget),
      recipient_address: null,
    })
    mockCreateIntent.mockResolvedValueOnce({ id: INTENT_ID, status: 'pending_signature', expires_at: 'x' })
    const facilitators = ['0x' + 'Fa'.repeat(20)] // mixed case: stored verbatim, caveat normalized

    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ facilitatorAddresses: facilitators }),
    })
    expect(res.statusCode).toBe(201)
    const stored = JSON.parse(
      (mockCreateIntent.mock.calls[0][0] as { preparedUserOp: string }).preparedUserOp,
    )
    // The echo source is the VERBATIM client value…
    expect(stored.facilitatorAddresses).toEqual(facilitators)
    // …and the child grew a redeemer caveat (one more than a bare build).
    const bare = await (async () => {
      mockSelect.mockResolvedValueOnce({
        delegation_hash: `0x${'12'.repeat(32)}`,
        delegation_json: JSON.stringify(signedBudget),
        recipient_address: null,
      })
      mockCreateIntent.mockResolvedValueOnce({ id: 'pi_other', status: 'pending_signature', expires_at: 'x' })
      await app.inject({
        method: 'POST', url: '/x402/authorize',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: authorizeBody(),
      })
      return JSON.parse((mockCreateIntent.mock.calls[1][0] as { preparedUserOp: string }).preparedUserOp)
    })()
    expect(stored.child.caveats.length).toBe(bare.child.caveats.length + 1)
  })

  it('authorize 400s malformed facilitatorAddresses — garbage cannot half-pin a child', async () => {
    for (const bad of [[], ['not-an-address'], 'x', new Array(17).fill('0x' + 'aa'.repeat(20))]) {
      const res = await app.inject({
        method: 'POST', url: '/x402/authorize',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: authorizeBody({ facilitatorAddresses: bad }),
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toMatch(/facilitatorAddresses/)
    }
  })

  it('authorize 400s facilitatorAddresses on the 3009 funding shape — no redeemer there', async () => {
    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({
        payTo: DELEGATE_EOA,
        merchantPayTo: MERCHANT,
        facilitatorAddresses: ['0x' + 'fa'.repeat(20)],
      }),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/erc7710 direct settlement only/)
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

  // ── #946: EIP-3009 fallback (delegation-metered funding leg) ──────────────
  const DELEGATE_EOA = DELEGATE_SIGNER.address // = the mocked agent.delegate_address
  const PREPARED = {
    delegationHash: `0x${'34'.repeat(32)}`,
    prepared: {
      userOperation: { sender: DELEGATE_ACCT, nonce: '1' },
      userOpHash: `0x${'56'.repeat(32)}`,
      // A COMPLETE EIP-712 payload, not a stub: since #1138 the route hashes
      // this to build the v2 expected-context commitment, and the edge signer
      // re-derives the same digest before signing. A payload that cannot be
      // hashed is one no signer could ever accept.
      signingTypedData: {
        domain: {
          chainId: 84532,
          name: 'HybridDeleGator',
          version: '1',
          verifyingContract: DELEGATE_ACCT,
        },
        types: {
          PackedUserOperation: [
            { name: 'sender', type: 'address' },
            { name: 'nonce', type: 'uint256' },
          ],
        },
        primaryType: 'PackedUserOperation',
        message: { sender: DELEGATE_ACCT, nonce: '1' },
      },
      delegateAccountAddress: DELEGATE_ACCT,
    },
  }

  it('payTo = delegate EOA selects 3009-mode: funding redemption + eip712_userop sign_data (#946)', async () => {
    mockPrepareFunding.mockResolvedValueOnce(PREPARED)
    mockCreateIntent.mockResolvedValueOnce({ id: INTENT_ID, status: 'pending_signature', expires_at: 'x' })

    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ payTo: DELEGATE_EOA, merchantPayTo: MERCHANT }),
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    // The funding leg signs the ACCOUNT's UserOp typed data, not a child delegation:
    expect(body.sign_data.signature_scheme).toBe('eip712_userop')
    expect(body.sign_data.hash).toBe(PREPARED.prepared.userOpHash)
    expect(body.sign_data.instructions).toMatch(/\/payments\//)
    // Funding goes to the EOA; the LEDGER records the real merchant + the scheme:
    expect(mockCreateIntent).toHaveBeenCalledWith(expect.objectContaining({
      executionRail: 'delegation',
      merchantAddress: MERCHANT.toLowerCase(),
      metadata: expect.objectContaining({ settlement_scheme: 'eip3009' }),
      delegationHash: PREPARED.delegationHash,
      // #1059: on the funding leg the budget IS the signed instrument.
      budgetDelegationHash: PREPARED.delegationHash,
    }))
    // The funding redemption targeted the EOA with the exact amount:
    expect(mockPrepareFunding).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'agent-1' }), USDC, DELEGATE_EOA.toLowerCase(), 100000n,
    )
    // The erc7710 selector was never consulted:
    expect(mockSelect).not.toHaveBeenCalled()
  })

  it('3009-mode requires merchantPayTo — the ledger must record the real merchant', async () => {
    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ payTo: DELEGATE_EOA }),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/merchantPayTo is required/)
    expect(mockPrepareFunding).not.toHaveBeenCalled()
  })

  it('3009-mode 403s without a fundable (open) budget — pinned budgets stay erc7710-only', async () => {
    mockPrepareFunding.mockResolvedValueOnce(null)
    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ payTo: DELEGATE_EOA, merchantPayTo: MERCHANT }),
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toMatch(/open \(unpinned\) budget/)
    expect(mockCreateIntent).not.toHaveBeenCalled()
  })

  it('3009-mode maps caveat/bundler failure to a clean 502; database untouched', async () => {
    mockPrepareFunding.mockRejectedValueOnce(new Error('estimation reverted: period budget exceeded'))
    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ payTo: DELEGATE_EOA, merchantPayTo: MERCHANT }),
    })
    expect(res.statusCode).toBe(502)
    expect(res.json().error).toMatch(/funding authorization failed/)
    expect(mockCreateIntent).not.toHaveBeenCalled()
  })

  it('an explicit settlementScheme must agree with the payTo shape', async () => {
    const wrong3009 = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ settlementScheme: 'eip3009' }), // payTo = merchant
    })
    expect(wrong3009.statusCode).toBe(400)
    expect(wrong3009.json().error).toMatch(/payTo = the agent delegate EOA/)

    const wrong7710 = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ payTo: DELEGATE_EOA, merchantPayTo: MERCHANT, settlementScheme: 'erc7710' }),
    })
    expect(wrong7710.statusCode).toBe(400)
    expect(wrong7710.json().error).toMatch(/payTo = the merchant/)

    const invalid = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ settlementScheme: 'sudo' }),
    })
    expect(invalid.statusCode).toBe(400)
  })

  it('settle 400s a VALID signature from the WRONG key — and the intent survives (#1053 f3)', async () => {
    // The review's exact scenario: any hex used to pass the shape check, the
    // intent flipped to submitted, and the ledger recorded a payment that can
    // never settle. Now the signer is recovered against the delegate key
    // BEFORE anything becomes unrecoverable.
    const wrongSigner = privateKeyToAccount(('0x' + '22'.repeat(32)) as `0x${string}`)
    const childFixture = JSON.parse(JSON.stringify(buildBudgetDelegation({
      agentId: 'agent-1', chainId: 84532, treasuryAddress: '0x' + 'aa'.repeat(20) as `0x${string}`,
      delegateAccountAddress: DELEGATE_ACCT as `0x${string}`, tokenAddress: USDC as `0x${string}`,
      budgetAtomic: 100_000n, periodSeconds: 86_400, startDate: NOW - 60, expiresAt: NOW + 300, version: 1,
    })))
    const preparedState = JSON.stringify({
      child: childFixture, budget: signedBudget,
      delegateAccountAddress: DELEGATE_ACCT, network: 'eip155:84532',
    })
    const updates: string[] = []
    mockQuery.mockImplementation((sql: string) => {
      if (/SELECT id, status, execution_rail/.test(String(sql))) {
        return Promise.resolve({ rows: [{
          id: INTENT_ID, status: 'pending_signature', execution_rail: 'delegation',
          prepared_user_op: JSON.parse(preparedState), chain_id: 84532,
          x402_resource_url: 'https://merchant.example/resource',
        }] })
      }
      if (/UPDATE payment_intents/.test(String(sql))) updates.push(String(sql))
      return Promise.resolve({ rows: [] })
    })
    const payload = delegationSigningPayload(childFixture as never, 84532)
    const wrongSig = await wrongSigner.signTypedData({
      domain: payload.domain, types: payload.types,
      primaryType: payload.primaryType, message: payload.message as never,
    })

    const res = await app.inject({
      method: 'POST', url: `/x402/${INTENT_ID}/settle`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: wrongSig },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/delegate key/)
    // Nothing flipped: the intent is still signable with the RIGHT key.
    expect(updates).toEqual([])

    // Garbage hex ('0x0'-class) is also a 400, not a burned intent:
    const garbage = await app.inject({
      method: 'POST', url: `/x402/${INTENT_ID}/settle`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: '0x00' },
    })
    expect(garbage.statusCode).toBe(400)
    expect(updates).toEqual([])
  })

  /** Drive a settle to completion with a valid prepared erc7710 state. */
  async function settleOk(passportRows: Record<string, unknown>[] = []) {
    const childFixture = JSON.parse(JSON.stringify(buildBudgetDelegation({
        agentId: 'agent-1', chainId: 84532, treasuryAddress: '0x' + 'aa'.repeat(20) as `0x${string}`,
        delegateAccountAddress: DELEGATE_ACCT as `0x${string}`, tokenAddress: USDC as `0x${string}`,
        budgetAtomic: 100_000n, periodSeconds: 86_400, startDate: NOW - 60, expiresAt: NOW + 300, version: 1,
      })))
    const preparedState = JSON.stringify({
      child: childFixture,
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
          to_address: '0x' + 'cc'.repeat(20), amount_raw: '1000', token_address: USDC,
        }] })
      }
      if (/FROM agent_passports/.test(String(sql))) return Promise.resolve({ rows: passportRows })
      return Promise.resolve({ rows: [] })
    })
    return app.inject({
      method: 'POST', url: `/x402/${INTENT_ID}/settle`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: await signChild(childFixture) },
    })
  }

  // ── CHARACTERIZATION (money.md §2) of the wire format #976 must not widen.
  //
  // Honesty about its provenance: this test and the #976 feature land in the
  // same commit, so nothing in history shows it was authored first, and the
  // comment used to assert exactly that. It cannot be verified, so it is not
  // claimed. What holds regardless of authoring order is the property below,
  // which is the reason the test exists.
  //
  // The X-PAYMENT header is consumed by a MERCHANT FACILITATOR we do not
  // control. An unexpected key inside `payload` is a rejection risk, and a
  // rejection here is a failed payment — so the passport reference must ride
  // Haven's OWN response body, never the header. This pins that boundary: if a
  // later change widens the wire payload, it fails here rather than at a
  // merchant.
  it('CHARACTERIZATION: the X-PAYMENT payload carries exactly the erc7710 keys', async () => {
    const res = await settleOk()
    expect(res.statusCode).toBe(200)
    const decoded = JSON.parse(Buffer.from(res.json().payment_header, 'base64').toString('utf8'))
    // v2 since #1064: the accepted-requirements echo rides alongside the
    // scheme payload — @x402/core v2 merchants match it field-for-field.
    expect(Object.keys(decoded).sort()).toEqual(['accepted', 'network', 'payload', 'scheme', 'x402Version'])
    expect(Object.keys(decoded.payload).sort()).toEqual([
      'delegationManager', 'delegator', 'permissionContext',
    ])
    expect(Object.keys(decoded.accepted).sort()).toEqual([
      'amount', 'asset', 'extra', 'maxTimeoutSeconds', 'network', 'payTo', 'scheme',
    ])
    expect(decoded.accepted.extra).toEqual({ assetTransferMethod: 'erc7710' })
  })

  it('settle assembles the X-PAYMENT header and flips to submitted; Haven submits nothing', async () => {
    const childFixture = JSON.parse(JSON.stringify(buildBudgetDelegation({
      agentId: 'agent-1', chainId: 84532, treasuryAddress: '0x' + 'aa'.repeat(20) as `0x${string}`,
      delegateAccountAddress: DELEGATE_ACCT as `0x${string}`, tokenAddress: USDC as `0x${string}`,
      budgetAtomic: 100_000n, periodSeconds: 86_400, startDate: NOW - 60, expiresAt: NOW + 300, version: 1,
    })))
    const preparedState = JSON.stringify({
      child: childFixture,
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
          to_address: '0x' + 'cc'.repeat(20), amount_raw: '1000', token_address: USDC,
        }] })
      }
      return Promise.resolve({ rows: [] })
    })

    const res = await app.inject({
      method: 'POST', url: `/x402/${INTENT_ID}/settle`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: await signChild(childFixture) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('submitted')
    // The header decodes to an exact-scheme erc7710 payload:
    const decoded = JSON.parse(Buffer.from(body.payment_header, 'base64').toString('utf8'))
    expect(decoded).toMatchObject({ x402Version: 2, scheme: 'exact', network: 'eip155:84532' })
    // Old stored state (no maxTimeoutSeconds) echoes the 300 default the
    // child expiry was built with — replay-resume of pre-#1064 intents.
    expect(decoded.accepted.maxTimeoutSeconds).toBe(300)
    expect(decoded.payload.delegator.toLowerCase()).toBe(DELEGATE_ACCT.toLowerCase())
    // The intent flipped to submitted:
    expect(mockQuery.mock.calls.some((c) => /status = 'submitted'/.test(String(c[0])))).toBe(true)
  })

  // #1058: stored facilitators ride the accepted echo — the v2 matcher
  // requires the merchant's advertised extra as a subset of it.
  it('settle echoes stored facilitatorAddresses in the accepted extra', async () => {
    const childFixture = JSON.parse(JSON.stringify(buildBudgetDelegation({
      agentId: 'agent-1', chainId: 84532, treasuryAddress: '0x' + 'aa'.repeat(20) as `0x${string}`,
      delegateAccountAddress: DELEGATE_ACCT as `0x${string}`, tokenAddress: USDC as `0x${string}`,
      budgetAtomic: 100_000n, periodSeconds: 86_400, startDate: NOW - 60, expiresAt: NOW + 300, version: 1,
    })))
    const facilitators = ['0x' + 'Fa'.repeat(20)]
    const preparedState = {
      child: childFixture,
      budget: signedBudget,
      delegateAccountAddress: DELEGATE_ACCT,
      network: 'eip155:84532',
      maxTimeoutSeconds: 120,
      facilitatorAddresses: facilitators,
    }
    mockQuery.mockImplementation((sql: string) => {
      if (/SELECT id, status, execution_rail/.test(String(sql))) {
        return Promise.resolve({ rows: [{
          id: INTENT_ID, status: 'pending_signature', execution_rail: 'delegation',
          prepared_user_op: preparedState, chain_id: 84532,
          x402_resource_url: 'https://merchant.example/resource',
          to_address: '0x' + 'cc'.repeat(20), amount_raw: '1000', token_address: USDC,
        }] })
      }
      return Promise.resolve({ rows: [] })
    })

    const res = await app.inject({
      method: 'POST', url: `/x402/${INTENT_ID}/settle`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: await signChild(childFixture) },
    })
    expect(res.statusCode).toBe(200)
    const decoded = JSON.parse(Buffer.from(res.json().payment_header, 'base64').toString('utf8'))
    expect(decoded.accepted.maxTimeoutSeconds).toBe(120)
    expect(decoded.accepted.extra).toEqual({
      assetTransferMethod: 'erc7710',
      facilitatorAddresses: facilitators,
    })
  })

  // ── #976: present inline, verify authoritatively ─────────────────────────
  describe('passport reference on settle (#976)', () => {
    const UID = '0x' + 'ab'.repeat(32)

    it('carries the reference when the agent has an ANCHORED passport', async () => {
      const res = await settleOk([
        { agent_id: 'agent-1', chain_id: 84532, status: 'anchored', attestation_uid: UID },
      ])
      expect(res.statusCode).toBe(200)
      // The UID and the chain id are the substance — the pair a merchant can
      // resolve against a verifier it already pins, or against EAS directly.
      // `verify_url` is a convenience that this deployment may or may not be
      // able to emit honestly (it needs a configured base URL AND a live
      // verifier), so its two branches are pinned where the decision is made,
      // in `lib/passport/__tests__/x402-delivery.test.ts`. Asserting it here
      // would only re-test that env.
      expect(res.json().passport).toMatchObject({ attestation_uid: UID, chain_id: 84532 })
    })

    // Each fixture below must fail for exactly ONE reason. The first version
    // paired 'not anchored' with a null UID, so the STATUS check had no
    // independent coverage — mutating it away left all 28 tests green. The
    // isolated cases are `status !== anchored WITH a UID` and
    // `status === anchored WITHOUT one`.
    //
    // Statuses are the real enum from migration 048 — 'pending' | 'anchored' |
    // 'failed'. An earlier draft used 'requested'/'revoked', which cannot exist
    // (revocation is tracked in `revocation_status`, a separate column), so
    // those cases were asserting over states the database forbids.
    //
    // Two honest limits on this block, both found by review:
    //
    //  - `anchored with no UID` is ITSELF a state migration 048 forbids
    //    (`CHECK (status <> 'anchored' OR attestation_uid IS NOT NULL)`) — the
    //    same standard the paragraph above applies to 'requested'. It stays
    //    because TypeScript needs the guard (`attestation_uid: string | null`)
    //    and because a constraint can be dropped by a later migration, but it
    //    is a TYPE guard with a regression test, not a reachable branch.
    //  - `no passport row` does NOT pin the `!row` clause here. Delete it and
    //    `row.status` throws on undefined, the total catch converts that to the
    //    same null, and this test still passes. That clause is pinned in
    //    `lib/passport/__tests__/x402-delivery.test.ts`, where the error path
    //    has an observable (a logged warning) the absence path does not.
    it.each([
      ['no passport row', []],
      ['ISOLATED status: a UID present but still `pending`', [{ agent_id: 'agent-1', chain_id: 84532, status: 'pending', attestation_uid: '0x' + 'cd'.repeat(32) }]],
      ['ISOLATED status: a UID present but `failed`', [{ agent_id: 'agent-1', chain_id: 84532, status: 'failed', attestation_uid: '0x' + 'cd'.repeat(32) }]],
      ['ISOLATED uid: anchored with no UID (DB-impossible; guards the TYPE)', [{ agent_id: 'agent-1', chain_id: 84532, status: 'anchored', attestation_uid: null }]],
    ])('degrades to null for %s, and the payment still succeeds', async (_name, rows) => {
      // "Absence is graceful" is the acceptance criterion, and it is also the
      // failure mode: a non-anchored passport is deliberately indistinguishable
      // from none, because a reference a merchant cannot verify produces a
      // failed lookup that looks like a REVOKED agent.
      const res = await settleOk(rows as Record<string, unknown>[])
      expect(res.statusCode).toBe(200)
      expect(res.json().passport).toBeNull()
      expect(res.json().payment_header).toBeTruthy()
    })

    it('never lets a passport lookup failure break the payment', async () => {
      // The payment is authorised and signed by the time we decorate it.
      // A passport is not worth a 500 on a settled payment.
      const childFixture = JSON.parse(JSON.stringify(buildBudgetDelegation({
        agentId: 'agent-1', chainId: 84532, treasuryAddress: '0x' + 'aa'.repeat(20) as `0x${string}`,
        delegateAccountAddress: DELEGATE_ACCT as `0x${string}`, tokenAddress: USDC as `0x${string}`,
        budgetAtomic: 100_000n, periodSeconds: 86_400, startDate: NOW - 60, expiresAt: NOW + 300, version: 1,
      })))
      const preparedState = JSON.stringify({
        child: childFixture,
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
        if (/FROM agent_passports/.test(String(sql))) return Promise.reject(new Error('db down'))
        return Promise.resolve({ rows: [] })
      })
      const res = await app.inject({
        method: 'POST', url: `/x402/${INTENT_ID}/settle`,
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: { signature: await signChild(childFixture) },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().passport).toBeNull()
      expect(res.json().payment_header).toBeTruthy()
    })

    it('looks the passport up for the AUTHENTICATED agent, not any other', async () => {
      // Review proved this had NO coverage: mutating `findByAgent(agentId)` to a
      // different id left all 29 tests green, because the mock matches on SQL
      // TEXT and discards bind values. That is not an ordinary coverage hole —
      // casp-risk-guardrails.md asserts the reference is "returned to the agent
      // that owns it", and this assertion is that claim's only support.
      await settleOk([
        { agent_id: 'agent-1', chain_id: 84532, status: 'anchored', attestation_uid: UID },
      ])
      const call = mockQuery.mock.calls.find((c) => /FROM agent_passports/.test(String(c[0])))
      expect(call, 'no agent_passports query was issued').toBeTruthy()
      // agentAuthMiddleware pins the authenticated agent to 'agent-1'.
      expect(call?.[1]).toEqual(['agent-1'])
    })

    it('keeps the reference OUT of the merchant-facing header', async () => {
      // The boundary the characterization test above exists to protect: a
      // facilitator we do not control parses that payload.
      const res = await settleOk([
        { agent_id: 'agent-1', chain_id: 84532, status: 'anchored', attestation_uid: UID },
      ])
      const raw = Buffer.from(res.json().payment_header, 'base64').toString('utf8')
      expect(raw).not.toContain(UID)
      expect(raw).not.toContain('passport')
    })
  })

  it('settle REFUSES a 3009-mode funding intent — /payments/:id/sign is its path (#946)', async () => {
    // A 3009 funding intent stores a prepared UserOp, not {child, budget}.
    mockQuery.mockResolvedValue({ rows: [{
      id: INTENT_ID, status: 'pending_signature', execution_rail: 'delegation',
      prepared_user_op: { sender: DELEGATE_ACCT, nonce: '1' }, chain_id: 84532,
      x402_resource_url: 'https://merchant.example/resource',
    }] })
    const res = await app.inject({
      method: 'POST', url: `/x402/${INTENT_ID}/settle`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: '0x' + 'ef'.repeat(65) },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/EIP-3009 \(funding leg\)/)
    // Nothing flipped to submitted:
    expect(mockQuery.mock.calls.some((c) => /status = 'submitted'/.test(String(c[0])))).toBe(false)
  })

  // ── #961 hardening: replay resumes, one-shot refused, hourly cap enforced ──
  const PENDING_3009_ROW = {
    id: INTENT_ID,
    status: 'pending_signature',
    expires_at: new Date(Date.now() + 300_000).toISOString(),
    sign_hash: `0x${'56'.repeat(32)}`,
    prepared_user_op: { sender: DELEGATE_ACCT, nonce: '1', callData: '0x' },
    to_address: DELEGATE_EOA.toLowerCase(),
    x402_merchant_address: MERCHANT.toLowerCase(),
    x402_resource_url: 'https://merchant.example/resource',
    amount_raw: '100000',
    amount_human: '0.1',
    token_address: USDC.toLowerCase(),
    token_symbol: 'USDC',
    chain_id: 84532,
    safe_address: '0x' + 'aa'.repeat(20),
    machine_metadata: { network: 'eip155:84532', settlement_scheme: 'eip3009' },
  }

  function withHourlyCapQueries(rows: Record<string, unknown>[] = []) {
    mockQuery.mockImplementation((sql: string) => {
      if (/max_x402_per_hour/.test(String(sql))) return Promise.resolve({ rows: [{ max_x402_per_hour: 100 }] })
      if (/COUNT\(\*\)/.test(String(sql))) return Promise.resolve({ rows: [{ cnt: '0' }] })
      if (/x402_idempotency_key = \$2/.test(String(sql))) return Promise.resolve({ rows })
      return Promise.resolve({ rows: [] })
    })
  }

  it('a pending idempotent retry RESUMES the intent — sign_data rebuilt, no new estimation (#961)', async () => {
    withHourlyCapQueries([PENDING_3009_ROW])
    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ payTo: DELEGATE_EOA, merchantPayTo: MERCHANT, idempotencyKey: 'k-1' }),
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.idempotent_replay).toBe(true)
    expect(body.payment_id).toBe(INTENT_ID)
    expect(body.sign_data.signature_scheme).toBe('eip712_userop')
    expect(body.sign_data.hash).toBe(`0x${'56'.repeat(32)}`)
    expect(body.sign_data.typed_data.primaryType).toBe('PackedUserOperation')
    // The whole point: NO fresh sponsored estimation ran.
    expect(mockPrepareFunding).not.toHaveBeenCalled()
    expect(mockCreateIntent).not.toHaveBeenCalled()
  })

  it('a confirmed idempotent retry replays the receipt (#961)', async () => {
    withHourlyCapQueries([{ ...PENDING_3009_ROW, status: 'confirmed', tx_hash: `0x${'ab'.repeat(32)}` }])
    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ payTo: DELEGATE_EOA, merchantPayTo: MERCHANT, idempotencyKey: 'k-1' }),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ success: true, payment_id: INTENT_ID, tx_hash: `0x${'ab'.repeat(32)}` })
    expect(mockPrepareFunding).not.toHaveBeenCalled()
  })

  it('an erc7710 pending retry rebuilds the CHILD signing payload (#961)', async () => {
    const child = JSON.parse(JSON.stringify(buildBudgetDelegation({
      agentId: 'agent-1', chainId: 84532, treasuryAddress: '0x' + 'aa'.repeat(20) as `0x${string}`,
      delegateAccountAddress: DELEGATE_ACCT as `0x${string}`, tokenAddress: USDC as `0x${string}`,
      budgetAtomic: 100_000n, periodSeconds: 86_400, startDate: NOW - 60, expiresAt: NOW + 300, version: 1,
    })))
    withHourlyCapQueries([{
      ...PENDING_3009_ROW,
      to_address: MERCHANT.toLowerCase(),
      prepared_user_op: { child, budget: signedBudget, delegateAccountAddress: DELEGATE_ACCT, network: 'eip155:84532' },
      machine_metadata: null, // erc7710 creates store no metadata (parity)
    }])
    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ idempotencyKey: 'k-1' }), // payTo = merchant
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.idempotent_replay).toBe(true)
    expect(body.sign_data.signature_scheme).toBe('eip712_delegation')
    expect(body.sign_data.typed_data.domain.name).toBe('DelegationManager')
    expect(mockSelect).not.toHaveBeenCalled()
    expect(mockCreateIntent).not.toHaveBeenCalled()
  })

  // #1058: replaying a key after the merchant rotated its facilitators would
  // hand back a child pinned to the OLD redeemer — dead at the merchant's
  // matcher. 409 so the client re-keys.
  it('a facilitator rotation on the same key 409s instead of replaying a stale child', async () => {
    const child = JSON.parse(JSON.stringify(buildBudgetDelegation({
      agentId: 'agent-1', chainId: 84532, treasuryAddress: '0x' + 'aa'.repeat(20) as `0x${string}`,
      delegateAccountAddress: DELEGATE_ACCT as `0x${string}`, tokenAddress: USDC as `0x${string}`,
      budgetAtomic: 100_000n, periodSeconds: 86_400, startDate: NOW - 60, expiresAt: NOW + 300, version: 1,
    })))
    withHourlyCapQueries([{
      ...PENDING_3009_ROW,
      to_address: MERCHANT.toLowerCase(),
      prepared_user_op: {
        child, budget: signedBudget, delegateAccountAddress: DELEGATE_ACCT,
        network: 'eip155:84532', facilitatorAddresses: ['0x' + '77'.repeat(20)],
      },
      machine_metadata: null,
    }])
    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({
        idempotencyKey: 'k-1',
        facilitatorAddresses: ['0x' + '88'.repeat(20)], // rotated
      }),
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/facilitator_addresses/)
    // Same facilitators still replay fine:
    withHourlyCapQueries([{
      ...PENDING_3009_ROW,
      to_address: MERCHANT.toLowerCase(),
      prepared_user_op: {
        child, budget: signedBudget, delegateAccountAddress: DELEGATE_ACCT,
        network: 'eip155:84532', facilitatorAddresses: ['0x' + '77'.repeat(20)],
      },
      machine_metadata: null,
    }])
    const same = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ idempotencyKey: 'k-1', facilitatorAddresses: ['0x' + '77'.repeat(20)] }),
    })
    expect(same.statusCode).toBe(201)
    expect(same.json().idempotent_replay).toBe(true)
  })

  it('a concurrent-claim conflict RESUMES the winner instead of a bare 409 (#961)', async () => {
    withHourlyCapQueries([]) // pre-check: nothing yet
    mockPrepareFunding.mockResolvedValueOnce(PREPARED)
    mockCreateIntent.mockImplementationOnce(async () => {
      // The race: by the time our insert conflicts, the winner's row exists.
      withHourlyCapQueries([PENDING_3009_ROW])
      return null
    })
    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ payTo: DELEGATE_EOA, merchantPayTo: MERCHANT, idempotencyKey: 'k-1' }),
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().idempotent_replay).toBe(true)
    expect(res.json().payment_id).toBe(INTENT_ID)
  })

  it('a conflict with NO recoverable winner still 409s (#961 fallback)', async () => {
    withHourlyCapQueries([])
    mockPrepareFunding.mockResolvedValueOnce(PREPARED)
    mockCreateIntent.mockResolvedValueOnce(null)
    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ payTo: DELEGATE_EOA, merchantPayTo: MERCHANT, idempotencyKey: 'k-1' }),
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/Idempotent replay/)
  })

  it('a stale pending row is LAZILY EXPIRED so the key frees for a fresh create (#961 M2)', async () => {
    const updates: string[] = []
    mockQuery.mockImplementation((sql: string) => {
      updates.push(String(sql))
      if (/max_x402_per_hour/.test(String(sql))) return Promise.resolve({ rows: [{ max_x402_per_hour: 100 }] })
      if (/COUNT\(\*\)/.test(String(sql))) return Promise.resolve({ rows: [{ cnt: '0' }] })
      if (/x402_idempotency_key = \$2/.test(String(sql))) {
        return Promise.resolve({ rows: [{ ...PENDING_3009_ROW, expires_at: new Date(Date.now() - 1000).toISOString() }] })
      }
      return Promise.resolve({ rows: [] })
    })
    mockPrepareFunding.mockResolvedValueOnce(PREPARED)
    mockCreateIntent.mockResolvedValueOnce({ id: 'fresh-intent', status: 'pending_signature', expires_at: 'x' })
    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ payTo: DELEGATE_EOA, merchantPayTo: MERCHANT, idempotencyKey: 'k-1' }),
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().payment_id).toBe('fresh-intent')
    // The stale row was flipped so its key no longer occupies the index:
    expect(updates.some((u) => /SET status = 'expired'/.test(u))).toBe(true)
    expect(mockPrepareFunding).toHaveBeenCalledTimes(1)
  })

  it('a scheme flip on the same key 409s via the funding_to mismatch (#961)', async () => {
    // The stored intent is 3009 (funding to the EOA); the retry asks erc7710
    // (payTo = merchant) with the SAME key — must never leak the original
    // sign_data under different parameters.
    withHourlyCapQueries([PENDING_3009_ROW])
    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ idempotencyKey: 'k-1' }), // payTo = MERCHANT ≠ stored funding_to
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/different x402 funding_to/)
    expect(res.json().payment_id).toBe(INTENT_ID)
  })

  it('a mismatched idempotencyKey 409s with the owning payment id (#961)', async () => {
    withHourlyCapQueries([{ ...PENDING_3009_ROW, amount_raw: '999999' }])
    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ payTo: DELEGATE_EOA, merchantPayTo: MERCHANT, idempotencyKey: 'k-1' }),
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().payment_id).toBe(INTENT_ID)
    expect(res.json().error).toMatch(/different x402 amount/)
  })

  it('one-shot signature is refused loudly on the delegation rail (#961)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ payTo: DELEGATE_EOA, merchantPayTo: MERCHANT, signature: '0x' + 'ab'.repeat(65) }),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/One-shot/)
    expect(mockPrepareFunding).not.toHaveBeenCalled()
  })

  it('the per-agent hourly cap 429s BEFORE any sponsored estimation (#961)', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (/max_x402_per_hour/.test(String(sql))) return Promise.resolve({ rows: [{ max_x402_per_hour: 2 }] })
      if (/COUNT\(\*\)/.test(String(sql))) return Promise.resolve({ rows: [{ cnt: '2' }] })
      return Promise.resolve({ rows: [] })
    })
    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ payTo: DELEGATE_EOA, merchantPayTo: MERCHANT }),
    })
    expect(res.statusCode).toBe(429)
    expect(res.json().error).toMatch(/max 2 x402 payments per hour/)
    expect(mockPrepareFunding).not.toHaveBeenCalled()
    // Also enforced on the erc7710 path:
    const res7710 = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody(),
    })
    expect(res7710.statusCode).toBe(429)
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
