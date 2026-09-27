/**
 * #3343 — the re-key revoke SUBMIT is bound to the calldata it executes.
 *
 * This route had NO route test before #3343 (`git grep 'revoke/submit'` over
 * the re-key suites returned nothing): the client-supplied `delegation_hashes`
 * drove `markRevoked` and the meter while the server's own still-enabled set
 * was read only for metering. A signed userop disabling a SUBSET completed the
 * re-key (`agent_has_no_authority: true`) with the other delegations still
 * enabled on-chain.
 *
 * The fixtures here encode `disableDelegation` straight from the ABI
 * (`@metamask/delegation-abis` + viem) — deliberately NOT through
 * `buildRevocation` — so these tests cannot pass by testing the builder
 * against itself. The binding invariant is the one `assertUserOperationDisablesDelegations`
 * enforces: a delegation is recorded `revoked` only if the included userop's
 * calldata targets the pinned DelegationManager and disables that delegation
 * (identity comparison, signature excluded).
 *
 * Harness mirrors `agent-rekey-signing.test.ts` (#1870): repository seams
 * mocked by name, the pool left real-but-unused, stage machine REAL
 * (`assertStageAllows` runs for actual — a refusal must leave `preflight`).
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { encodeFunctionData, encodeAbiParameters } from 'viem'
import { DelegationManager, DeleGatorCore } from '@metamask/delegation-abis'

const {
  mockFindOwnedRekeyAgent,
  mockFindRekey,
  mockListNonRevoked,
  mockLoadOwner,
  mockTreasury,
  mockRevokeByHashes,
  mockMarkRevoked,
  mockMarkMetered,
  mockFindTerms,
  mockReadRemaining,
} = vi.hoisted(() => ({
  mockFindOwnedRekeyAgent: vi.fn(),
  mockFindRekey: vi.fn(),
  mockListNonRevoked: vi.fn(),
  mockLoadOwner: vi.fn(),
  mockTreasury: vi.fn(),
  mockRevokeByHashes: vi.fn(),
  mockMarkRevoked: vi.fn(),
  mockMarkMetered: vi.fn(),
  mockFindTerms: vi.fn(),
  mockReadRemaining: vi.fn(),
}))

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: async (request: { user?: unknown }) => {
    request.user = { sub: 'user-1' }
  },
}))
vi.mock('../../infra/repositories/agent-rekeys.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../infra/repositories/agent-rekeys.js')>()
  return {
    ...actual,
    findOwnedRekeyAgent: (...a: unknown[]) => mockFindOwnedRekeyAgent(...a),
    findRekey: (...a: unknown[]) => mockFindRekey(...a),
    markRevoked: (...a: unknown[]) => mockMarkRevoked(...a),
    markMetered: (...a: unknown[]) => mockMarkMetered(...a),
    findDelegationTerms: (...a: unknown[]) => mockFindTerms(...a),
  }
})
vi.mock('../../infra/repositories/delegation-budgets.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../infra/repositories/delegation-budgets.js')
  >()
  return {
    ...actual,
    listNonRevokedDelegationsForAgent: (...a: unknown[]) => mockListNonRevoked(...a),
    // The route imports the revocation write from delegation-budgets — the
    // module that owns it (mock-factory-exports guard: an anchor must target
    // a symbol the module actually exports).
    revokeDelegationsByHashes: (...a: unknown[]) => mockRevokeByHashes(...a),
  }
})
vi.mock('../../rails/hybrid-account-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rails/hybrid-account-config.js')>()
  return {
    ...actual,
    loadHybridOwnerConfig: (...a: unknown[]) => mockLoadOwner(...a),
  }
})
vi.mock('../../rails/delegation-rail.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rails/delegation-rail.js')>()
  return {
    ...actual,
    createTreasuryOps: (...a: unknown[]) => mockTreasury(...a),
    delegationRailBundlerUrl: () => 'https://bundler.example/x?apikey=SECRET',
  }
})
vi.mock('../../infra/chain/delegation-budget-reader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../infra/chain/delegation-budget-reader.js')>()
  return {
    ...actual,
    readRemainingBudget: (...a: unknown[]) => mockReadRemaining(...a),
  }
})

const agentRekeyRoutes = (await import('../agent-rekey.js')).default

const AGENT_ID = '11111111-1111-1111-1111-111111111111'
const REKEY_ID = '22222222-2222-2222-2222-222222222222'
const CHAIN_ID = 84532
const TREASURY = '0x' + 'aa'.repeat(20)
const OWNER = '0x' + 'ee'.repeat(20)
const DELEGATE_ACCOUNT = '0x' + 'dd'.repeat(20)
const HASH = '0x' + 'ab'.repeat(32)
const HASH2 = '0x' + 'cd'.repeat(32)
const MANAGER = '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3' // pinned 84532 DelegationManager

function agentRow() {
  return {
    agent_id: AGENT_ID,
    delegate_address: '0x' + 'bb'.repeat(20),
    chain_id: CHAIN_ID,
    treasury_address: TREASURY,
    account_type: 'delegator_hybrid',
    execution_rail: 'delegation',
    status: 'active',
  }
}

function rekeyRow() {
  return {
    id: REKEY_ID,
    agent_id: AGENT_ID,
    initiated_by_user_id: 'user-1',
    stage: 'preflight',
    old_delegate_address: '0x' + 'bb'.repeat(20),
    new_delegate_address: '0x' + 'cc'.repeat(20),
    residual_atomic: '0',
    residual_token_address: null,
    residual_disposition: 'none',
    carry_snapshot: null,
    metered_at: null,
    revoke_tx_hash: null,
    revoked_at: null,
    completed_at: null,
  }
}

function storedDelegation(salt: string) {
  return {
    delegate: DELEGATE_ACCOUNT,
    delegator: TREASURY,
    authority: `0x${'0'.repeat(64)}`,
    caveats: [],
    salt,
    signature: `0x${'ab'.repeat(65)}`,
  }
}

function delegationRow(hash: string, salt: string, status = 'active') {
  return { delegation_hash: hash, delegation_json: JSON.stringify(storedDelegation(salt)), status }
}

function ownerConfig() {
  return {
    config: { ownerAddress: OWNER as `0x${string}`, passkeys: [] },
    accountId: 'account-1',
    singleSignerWaiverAt: null,
  }
}

/** disableDelegation calldata encoded straight from the ABI — never buildRevocation. */
function disableCall(json: string): { target: `0x${string}`; callData: `0x${string}` } {
  const delegation = { ...JSON.parse(json) }
  delegation.salt = BigInt(delegation.salt)
  const data = encodeFunctionData({
    abi: DelegationManager,
    functionName: 'disableDelegation',
    args: [delegation],
  })
  return { target: MANAGER as `0x${string}`, callData: data }
}

/** The account envelope the kit builds for a single prepared call. */
function singleEnvelope(call: { target: `0x${string}`; callData: `0x${string}` }): string {
  return encodeFunctionData({
    abi: DeleGatorCore,
    functionName: 'execute',
    args: [{ target: call.target, value: 0n, callData: call.callData }],
  })
}

/** The kit batch envelope (BatchDefault over Execution[]). */
function batchEnvelope(calls: Array<{ target: `0x${string}`; callData: `0x${string}` }>): string {
  const mode = ('0x01' + '00'.repeat(31)) as `0x${string}`
  const executionData = encodeAbiParameters(
    [{
      components: [
        { name: 'target', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'callData', type: 'bytes' },
      ],
      name: 'executions',
      type: 'tuple[]',
    }],
    [calls.map((c) => ({ target: c.target, value: 0n, callData: c.callData }))],
  )
  return encodeFunctionData({
    abi: DeleGatorCore,
    functionName: 'execute',
    args: [mode, executionData],
  })
}

/** The enableDelegation twin — a decoded op that revokes nothing. */
function invertedEnvelope(json: string): string {
  const delegation = { ...JSON.parse(json) }
  delegation.salt = BigInt(delegation.salt)
  const data = encodeFunctionData({
    abi: DelegationManager,
    functionName: 'enableDelegation',
    args: [delegation],
  })
  return singleEnvelope({ target: MANAGER as `0x${string}`, callData: data })
}

describe('#3343 re-key revoke submit — calldata binding', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(agentRekeyRoutes, { prefix: '/agents' })
    await app.ready()
  })
  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mockFindOwnedRekeyAgent.mockResolvedValue(agentRow())
    mockFindRekey.mockResolvedValue(rekeyRow())
    mockListNonRevoked.mockResolvedValue([delegationRow(HASH, '1')])
    mockLoadOwner.mockResolvedValue(ownerConfig())
    const submitCall = vi.fn().mockResolvedValue({
      txHash: `0x${'11'.repeat(32)}`,
      userOpHash: '0x',
      actualGasUsed: 1n,
      actualGasCost: 1n,
    })
    mockTreasury.mockResolvedValue({
      treasuryAddress: TREASURY,
      prepareCalls: vi.fn(),
      submitCall,
    })
    mockRevokeByHashes.mockResolvedValue([HASH])
    mockMarkRevoked.mockResolvedValue({ ...rekeyRow(), stage: 'revoked' })
    mockMarkMetered.mockResolvedValue({ ...rekeyRow(), stage: 'metered' })
    mockFindTerms.mockResolvedValue({
      token_address: '0x' + '03'.repeat(20),
      recipient_address: null,
      budget_atomic: '5000000',
      period_seconds: 86400,
      start_date: '1755600000',
      expires_at: '1763376000',
    })
    mockReadRemaining.mockResolvedValue({ remainingAtomic: '123', fromChain: true })
  })

  function submit(body: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: `/agents/${AGENT_ID}/rekey/${REKEY_ID}/revoke/submit`,
      payload: body,
    })
  }

  const signature = '0x' + 'ab'.repeat(65)

  it('accepts a kit-genuine op that disables exactly the server-derived set, and meters it', async () => {
    const op = singleEnvelope(disableCall(JSON.stringify(storedDelegation('1'))))
    const res = await submit({ signature, user_operation: { callData: op }, delegation_hashes: [HASH] })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.revoked).toBe(true)
    expect(body.delegation_hashes).toEqual([HASH])
    expect(body.stage).toBe('metered')
    expect(body.agent_has_no_authority).toBe(true)
    // The server's set drove the DB write — not the client's list.
    expect(mockRevokeByHashes).toHaveBeenCalledWith(AGENT_ID, [HASH])
    expect(mockMarkRevoked).toHaveBeenCalledWith(REKEY_ID, AGENT_ID, `0x${'11'.repeat(32)}`)
    expect(mockMarkMetered).toHaveBeenCalledTimes(1)
  })

  it('REFUSES a subset op with a 409 re-prepare — no submit, no markRevoked, stage stays preflight', async () => {
    mockListNonRevoked.mockResolvedValue([delegationRow(HASH, '1'), delegationRow(HASH2, '2')])
    // The op disables only ONE of the two still-enabled delegations.
    const op = singleEnvelope(disableCall(JSON.stringify(storedDelegation('1'))))
    const res = await submit({ signature, user_operation: { callData: op }, delegation_hashes: [HASH] })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/changed since prepare|fresh prepare/i)
    // Fail-BEFORE: the point of no return is never reached.
    expect(mockTreasury).not.toHaveBeenCalled()
    expect(mockRevokeByHashes).not.toHaveBeenCalled()
    expect(mockMarkRevoked).not.toHaveBeenCalled()
    expect(mockMarkMetered).not.toHaveBeenCalled()
  })

  it('REFUSES an inverted op (enableDelegation) — the mutation the unbound route accepted', async () => {
    const op = invertedEnvelope(JSON.stringify(storedDelegation('1')))
    const res = await submit({ signature, user_operation: { callData: op }, delegation_hashes: [HASH] })
    expect(res.statusCode).toBe(409)
    expect(mockTreasury).not.toHaveBeenCalled()
    expect(mockMarkRevoked).not.toHaveBeenCalled()
  })

  it('400s an undecodable user_operation (the old { nonce: "1n" } shape)', async () => {
    const res = await submit({ signature, user_operation: { nonce: '1n' }, delegation_hashes: [HASH] })
    expect(res.statusCode).toBe(400)
    expect(mockTreasury).not.toHaveBeenCalled()
    expect(mockMarkRevoked).not.toHaveBeenCalled()
  })

  it('ignores the client hash list: a stale/wrong list cannot widen or narrow what is recorded', async () => {
    mockListNonRevoked.mockResolvedValue([delegationRow(HASH, '1'), delegationRow(HASH2, '2')])
    // Op binds BOTH rows; the client names only one (and a foreign hash).
    const op = batchEnvelope([
      disableCall(JSON.stringify(storedDelegation('1'))),
      disableCall(JSON.stringify(storedDelegation('2'))),
    ])
    const res = await submit({
      signature,
      user_operation: { callData: op },
      delegation_hashes: [HASH, '0x' + 'ff'.repeat(32)],
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().delegation_hashes).toEqual([HASH, HASH2])
    expect(mockRevokeByHashes).toHaveBeenCalledWith(AGENT_ID, [HASH, HASH2])
  })

  it('binds `replaced` rows too — the still-enabled old key cannot survive a re-key', async () => {
    mockListNonRevoked.mockResolvedValue([
      delegationRow(HASH, '1', 'active'),
      delegationRow(HASH2, '2', 'replaced'),
    ])
    const op = batchEnvelope([
      disableCall(JSON.stringify(storedDelegation('1'))),
      disableCall(JSON.stringify(storedDelegation('2'))),
    ])
    const res = await submit({ signature, user_operation: { callData: op } })
    expect(res.statusCode).toBe(200)
    expect(res.json().delegation_hashes).toEqual([HASH, HASH2])
  })

  it('an op disabling MORE than the server holds is a 409, not a silent extra disable', async () => {
    // Server holds one row; the op disables it AND a second delegation.
    const extra = storedDelegation('9')
    extra.delegate = '0x' + 'd1'.repeat(20)
    const op = batchEnvelope([
      disableCall(JSON.stringify(storedDelegation('1'))),
      disableCall(JSON.stringify(extra)),
    ])
    const res = await submit({ signature, user_operation: { callData: op } })
    expect(res.statusCode).toBe(409)
    expect(mockTreasury).not.toHaveBeenCalled()
  })

  it('a failed submit (bundler rejection) still writes NOTHING — the fail-closed path survives', async () => {
    mockTreasury.mockResolvedValue({
      treasuryAddress: TREASURY,
      prepareCalls: vi.fn(),
      submitCall: vi.fn().mockRejectedValue(new Error('bundler https://bundler.example/x?apikey=SECRET exploded')),
    })
    const op = singleEnvelope(disableCall(JSON.stringify(storedDelegation('1'))))
    const res = await submit({ signature, user_operation: { callData: op }, delegation_hashes: [HASH] })
    expect(res.statusCode).toBe(502)
    expect(JSON.stringify(res.json())).not.toContain('SECRET')
    expect(mockRevokeByHashes).not.toHaveBeenCalled()
    expect(mockMarkRevoked).not.toHaveBeenCalled()
  })

  it('a lost stage race (markRevoked false) still 409s rekey_out_of_order after the revoke landed', async () => {
    mockMarkRevoked.mockResolvedValue(null)
    const op = singleEnvelope(disableCall(JSON.stringify(storedDelegation('1'))))
    const res = await submit({ signature, user_operation: { callData: op }, delegation_hashes: [HASH] })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('rekey_out_of_order')
    // The DB revoke DID run — the chain state moved; only the meter is refused.
    expect(mockRevokeByHashes).toHaveBeenCalledWith(AGENT_ID, [HASH])
    expect(mockMarkMetered).not.toHaveBeenCalled()
  })

  it('400s the request-shape failures before anything else', async () => {
    const cases = [
      { signature: '0xzz', user_operation: { callData: '0x00' } },
      { user_operation: { callData: '0x00' } },
      { signature, user_operation: { callData: '0x00' }, delegation_hashes: 'nope' },
    ]
    for (const payload of cases) {
      const res = await submit(payload)
      expect(res.statusCode).toBe(400)
    }
    expect(mockTreasury).not.toHaveBeenCalled()
  })
})
