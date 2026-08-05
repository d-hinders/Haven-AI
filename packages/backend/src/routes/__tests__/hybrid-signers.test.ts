import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { mockQuery, mockLoadOwner, mockTreasury } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockLoadOwner: vi.fn(),
  mockTreasury: vi.fn(),
}))
vi.mock('../../db.js', () => ({ default: { query: (...a: unknown[]) => mockQuery(...a) } }))
vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: async (request: { user?: unknown }) => {
    request.user = { sub: 'user-1' }
  },
}))
vi.mock('../../lib/hybrid-account-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/hybrid-account-config.js')>()
  return { ...actual, loadHybridOwnerConfig: mockLoadOwner }
})
vi.mock('../../lib/delegation-rail.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/delegation-rail.js')>()
  return {
    ...actual,
    delegationRailBundlerUrl: () => 'https://bundler.test/rpc',
    createTreasuryOps: (...a: unknown[]) => mockTreasury(...a),
  }
})

const routes = (await import('../hybrid-accounts.js')).default
const ACCOUNT = '0x' + 'ab'.repeat(20)

describe('GET /accounts/hybrid/:address/signers (#1079)', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(routes, { prefix: '/accounts' })
  })
  afterAll(async () => app.close())
  beforeEach(() => {
    mockQuery.mockReset()
    mockLoadOwner.mockReset()
  })

  it('returns the AccountSigners shape for an owned delegation account', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
    mockLoadOwner.mockResolvedValueOnce({
      config: {
        ownerAddress: null,
        passkeys: [{ keyId: '0xdeadbeef', x: 7n, y: 9n }],
      },
    })
    const res = await app.inject({ method: 'GET', url: `/accounts/hybrid/${ACCOUNT}/signers?chain_id=84532` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      account_address: ACCOUNT,
      chain_id: 84532,
      owner_address: null,
      passkeys: [{ key_id: '0xdeadbeef', x: '0x7', y: '0x9' }],
    })
    // Ownership is in the SQL: user_id + address + chain + delegation rail.
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toMatch(/account_type = 'delegator_hybrid'/)
    expect(params).toEqual(['user-1', ACCOUNT, 84532])
  })

  it("404s another user's account and 400s bad input", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })
    const notMine = await app.inject({ method: 'GET', url: `/accounts/hybrid/${ACCOUNT}/signers?chain_id=84532` })
    expect(notMine.statusCode).toBe(404)

    const badAddr = await app.inject({ method: 'GET', url: '/accounts/hybrid/nonsense/signers?chain_id=84532' })
    expect(badAddr.statusCode).toBe(400)

    const noChain = await app.inject({ method: 'GET', url: `/accounts/hybrid/${ACCOUNT}/signers` })
    expect(noChain.statusCode).toBe(400)
  })
})

describe('account-scoped signer management (#1081)', () => {
  let app: FastifyInstance
  const PK1 = { keyId: '0x' + '11'.repeat(32), x: 1n, y: 2n }
  const PK2 = { keyId: '0x' + '22'.repeat(32), x: 3n, y: 4n }
  const NEW_PK = { key_id: '0x' + '33'.repeat(32), x: '0x1', y: '0x2' }
  const OWNER_EOA = '0x' + 'ee'.repeat(20)

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(routes, { prefix: '/accounts' })
  })
  afterAll(async () => app.close())
  beforeEach(() => {
    mockQuery.mockReset()
    mockLoadOwner.mockReset()
    mockTreasury.mockReset()
    mockQuery.mockResolvedValue({ rows: [] })
  })

  /** Owned account with the given signer set. */
  function ownedAccount(
    config: { ownerAddress?: string; passkeys?: typeof PK1[] },
    opts: { waiverAt?: string | null } = {},
  ) {
    mockQuery.mockImplementation((sql: string) =>
      /FROM user_safes/.test(String(sql))
        ? Promise.resolve({ rows: [{ '?column?': 1 }] })
        : Promise.resolve({ rows: [] }),
    )
    mockLoadOwner.mockResolvedValue({
      userSafeId: 'safe-1',
      config,
      singleSignerWaiverAt: opts.waiverAt ?? null,
    })
  }

  function mockPrepared() {
    mockTreasury.mockResolvedValueOnce({
      treasuryAddress: ACCOUNT,
      prepareCall: vi.fn().mockResolvedValue({
        userOperation: { sender: ACCOUNT, nonce: 1n, callData: '0xffff' },
        userOpHash: '0x' + 'ee'.repeat(32),
        signingTypedData: { domain: { name: 'HybridDeleGator' }, types: {}, primaryType: 'PackedUserOperation', message: {} },
      }),
      submitCall: vi.fn().mockResolvedValue({ txHash: '0x' + 'ff'.repeat(32) }),
    })
  }

  const prepareUrl = `/accounts/hybrid/${ACCOUNT}/signers/prepare?chain_id=84532`

  it('enrols a backup passkey with NO agent in the picture — the whole point of #1081', async () => {
    ownedAccount({ passkeys: [PK1] })
    mockPrepared()
    const res = await app.inject({ method: 'POST', url: prepareUrl, payload: { action: 'add_passkey', passkey: NEW_PK } })

    expect(res.statusCode).toBe(200)
    expect(res.json().signature_scheme).toBe('webauthn_userop')
    expect(res.json().user_op_hash).toBeTruthy()
    // Prepared against the ACCOUNT address, resolved from the URL — no agent.
    expect(mockTreasury.mock.calls[0][0]).toMatchObject({ accountAddress: ACCOUNT, chainId: 84532 })
  })

  it('honours the requested signer on a multi-signer account (the #1086 rule, shared not re-implemented)', async () => {
    ownedAccount({ ownerAddress: OWNER_EOA, passkeys: [PK1] })
    mockPrepared()
    const res = await app.inject({
      method: 'POST', url: prepareUrl,
      payload: { action: 'add_passkey', passkey: NEW_PK, signature_scheme: 'webauthn_userop' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().signature_scheme).toBe('webauthn_userop')
    // Gas is estimated for the signer that will actually sign.
    expect(mockTreasury.mock.calls[0][0]).toMatchObject({ signWith: 'passkey' })
  })

  it('refuses a scheme the account cannot satisfy', async () => {
    ownedAccount({ passkeys: [PK1] })
    const res = await app.inject({
      method: 'POST', url: prepareUrl,
      payload: { action: 'add_passkey', passkey: NEW_PK, signature_scheme: 'eip712_userop' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/no EOA owner to sign with/)
    expect(mockTreasury).not.toHaveBeenCalled()
  })

  it('applies the SAME >=2-signer floor as the agent-scoped route', async () => {
    ownedAccount({ passkeys: [PK1, PK2] })
    const res = await app.inject({
      method: 'POST', url: prepareUrl,
      payload: { action: 'remove_passkey', passkey: { key_id: PK1.keyId } },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/fewer than two ways to approve/)
    expect(mockTreasury).not.toHaveBeenCalled()
  })

  it("404s an account the caller does not own, before any signer work", async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const res = await app.inject({ method: 'POST', url: prepareUrl, payload: { action: 'add_passkey', passkey: NEW_PK } })
    expect(res.statusCode).toBe(404)
    expect(mockLoadOwner).not.toHaveBeenCalled()
    expect(mockTreasury).not.toHaveBeenCalled()
  })

  it('submit pins the DB sync to the SIGNED calldata', async () => {
    ownedAccount({ passkeys: [PK1] })
    const res = await app.inject({
      method: 'POST', url: `/accounts/hybrid/${ACCOUNT}/signers/submit?chain_id=84532`,
      payload: {
        action: 'add_passkey', passkey: NEW_PK,
        signature: '0x' + 'ab'.repeat(80),
        user_operation: { sender: ACCOUNT, callData: '0xdeadbeef' },
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/does not match the requested signer change/)
    // Nothing was written and nothing was submitted on-chain.
    expect(mockTreasury).not.toHaveBeenCalled()
    expect(mockQuery.mock.calls.some(([sql]) => /INSERT INTO hybrid_account_passkeys/.test(String(sql)))).toBe(false)
  })

  it('submit enrols the passkey and syncs storage to the signed op', async () => {
    ownedAccount({ passkeys: [PK1] })
    mockPrepared()
    // callData must contain the addKey calldata the route re-derives.
    const { encodeFunctionData } = await import('viem')
    const { HYBRID_SIGNER_ABI } = await import('../../lib/hybrid-signer-actions.js')
    const callData = encodeFunctionData({
      abi: HYBRID_SIGNER_ABI,
      functionName: 'addKey',
      args: [NEW_PK.key_id, BigInt(NEW_PK.x), BigInt(NEW_PK.y)],
    })

    const res = await app.inject({
      method: 'POST', url: `/accounts/hybrid/${ACCOUNT}/signers/submit?chain_id=84532`,
      payload: {
        action: 'add_passkey', passkey: NEW_PK,
        signature: '0x' + 'ab'.repeat(80),
        user_operation: { sender: ACCOUNT, callData },
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ updated: true, tx_hash: '0x' + 'ff'.repeat(32) })
    // Storage tracks the chain: the new key is recorded against this account.
    const insert = mockQuery.mock.calls.find(([sql]) =>
      /INSERT INTO hybrid_account_passkeys/.test(String(sql)),
    )
    expect(insert?.[1]).toEqual(['safe-1', NEW_PK.key_id, NEW_PK.x, NEW_PK.y])
  })

  it('a malformed envelope is a 400 before the account is even resolved', async () => {
    // Precedence regression (#1081 review): extracting the checks must not
    // turn a malformed-body 400 into a config 409.
    mockQuery.mockResolvedValue({ rows: [] }) // account would 404
    const res = await app.inject({
      method: 'POST', url: `/accounts/hybrid/${ACCOUNT}/signers/submit?chain_id=84532`,
      payload: { action: 'add_passkey', passkey: NEW_PK, user_operation: { callData: '0x' } },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/signature is required/)
    expect(mockLoadOwner).not.toHaveBeenCalled()
  })
})

describe('remove_owner — enrolling a wallet is not a one-way door (#1087)', () => {
  let app: FastifyInstance
  const PK1 = { keyId: '0x' + '11'.repeat(32), x: 1n, y: 2n }
  const OWNER_EOA = '0x' + 'ee'.repeat(20)

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(routes, { prefix: '/accounts' })
  })
  afterAll(async () => app.close())
  beforeEach(() => {
    mockQuery.mockReset()
    mockLoadOwner.mockReset()
    mockTreasury.mockReset()
    mockQuery.mockResolvedValue({ rows: [] })
  })

  function ownedAccount(
    config: { ownerAddress?: string; passkeys?: typeof PK1[] },
    opts: { waiverAt?: string | null } = {},
  ) {
    mockQuery.mockImplementation((sql: string) =>
      /FROM user_safes/.test(String(sql))
        ? Promise.resolve({ rows: [{ '?column?': 1 }] })
        : Promise.resolve({ rows: [] }),
    )
    mockLoadOwner.mockResolvedValue({
      userSafeId: 'safe-1',
      config,
      singleSignerWaiverAt: opts.waiverAt ?? null,
    })
  }

  function mockPrepared() {
    mockTreasury.mockResolvedValueOnce({
      treasuryAddress: ACCOUNT,
      prepareCall: vi.fn().mockResolvedValue({
        userOperation: { sender: ACCOUNT, nonce: 1n, callData: '0xffff' },
        userOpHash: '0x' + 'ee'.repeat(32),
        signingTypedData: { domain: { name: 'HybridDeleGator' }, types: {}, primaryType: 'PackedUserOperation', message: {} },
      }),
      submitCall: vi.fn().mockResolvedValue({ txHash: '0x' + 'ff'.repeat(32) }),
    })
  }

  it('prepares transferOwnership(address(0)) on a testnet account with a passkey remaining', async () => {
    ownedAccount({ ownerAddress: OWNER_EOA, passkeys: [PK1] })
    mockPrepared()
    const res = await app.inject({
      method: 'POST', url: `/accounts/hybrid/${ACCOUNT}/signers/prepare?chain_id=84532`,
      payload: { action: 'remove_owner' },
    })
    expect(res.statusCode).toBe(200)
    // Owner still exists → legacy default scheme is the owner's EIP-712.
    expect(res.json().signature_scheme).toBe('eip712_userop')
    expect(mockTreasury).toHaveBeenCalled()
  })

  it('refuses when the wallet is the only signer — before any op is prepared', async () => {
    ownedAccount({ ownerAddress: OWNER_EOA })
    const res = await app.inject({
      method: 'POST', url: `/accounts/hybrid/${ACCOUNT}/signers/prepare?chain_id=84532`,
      payload: { action: 'remove_owner' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/only signer/)
    expect(mockTreasury).not.toHaveBeenCalled()
  })

  it('refuses on a value-bearing chain when removal would drop below the #908 floor without a waiver', async () => {
    ownedAccount({ ownerAddress: OWNER_EOA, passkeys: [PK1] }) // 1 signer after removal
    const res = await app.inject({
      method: 'POST', url: `/accounts/hybrid/${ACCOUNT}/signers/prepare?chain_id=8453`,
      payload: { action: 'remove_owner' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/single signer/)
    expect(mockTreasury).not.toHaveBeenCalled()
  })

  it('permits the mainnet drop when the account carries the recorded single-signer waiver', async () => {
    ownedAccount({ ownerAddress: OWNER_EOA, passkeys: [PK1] }, { waiverAt: '2026-08-01T00:00:00Z' })
    mockPrepared()
    const res = await app.inject({
      method: 'POST', url: `/accounts/hybrid/${ACCOUNT}/signers/prepare?chain_id=8453`,
      payload: { action: 'remove_owner' },
    })
    expect(res.statusCode).toBe(200)
  })

  it('refuses when there is no wallet owner to remove', async () => {
    ownedAccount({ passkeys: [PK1] })
    const res = await app.inject({
      method: 'POST', url: `/accounts/hybrid/${ACCOUNT}/signers/prepare?chain_id=84532`,
      payload: { action: 'remove_owner' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/no wallet owner/)
  })

  it('submit clears user_safes.owner_address only when the signed calldata IS the removal', async () => {
    ownedAccount({ ownerAddress: OWNER_EOA, passkeys: [PK1] })
    mockPrepared()
    const { encodeFunctionData, zeroAddress } = await import('viem')
    const { HYBRID_SIGNER_ABI } = await import('../../lib/hybrid-signer-actions.js')
    const callData = encodeFunctionData({
      abi: HYBRID_SIGNER_ABI,
      functionName: 'transferOwnership',
      args: [zeroAddress],
    })
    const res = await app.inject({
      method: 'POST', url: `/accounts/hybrid/${ACCOUNT}/signers/submit?chain_id=84532`,
      payload: {
        action: 'remove_owner',
        signature: '0x' + 'ab'.repeat(80),
        user_operation: { sender: ACCOUNT, callData },
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ updated: true, tx_hash: '0x' + 'ff'.repeat(32) })
    const clear = mockQuery.mock.calls.find(([sql]) => /owner_address = NULL/.test(String(sql)))
    expect(clear?.[1]).toEqual(['safe-1'])
  })

  it('submit with mismatched calldata neither submits nor clears the owner', async () => {
    ownedAccount({ ownerAddress: OWNER_EOA, passkeys: [PK1] })
    const res = await app.inject({
      method: 'POST', url: `/accounts/hybrid/${ACCOUNT}/signers/submit?chain_id=84532`,
      payload: {
        action: 'remove_owner',
        signature: '0x' + 'ab'.repeat(80),
        user_operation: { sender: ACCOUNT, callData: '0xdeadbeef' },
      },
    })
    expect(res.statusCode).toBe(400)
    expect(mockTreasury).not.toHaveBeenCalled()
    expect(mockQuery.mock.calls.some(([sql]) => /owner_address = NULL/.test(String(sql)))).toBe(false)
  })
})

describe('owner-initiated send (#1083)', () => {
  let app: FastifyInstance
  const PK1 = { keyId: '0x' + '11'.repeat(32), x: 1n, y: 2n }
  const OWNER_EOA = '0x' + 'ee'.repeat(20)
  const TOKEN = '0x' + '05'.repeat(20)
  const TO = '0x' + '06'.repeat(20)

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(routes, { prefix: '/accounts' })
  })
  afterAll(async () => app.close())
  beforeEach(() => {
    mockQuery.mockReset()
    mockLoadOwner.mockReset()
    mockTreasury.mockReset()
    mockQuery.mockResolvedValue({ rows: [] })
  })

  function ownedAccount(config: { ownerAddress?: string; passkeys?: typeof PK1[] }) {
    mockQuery.mockImplementation((sql: string) =>
      /FROM user_safes/.test(String(sql))
        ? Promise.resolve({ rows: [{ '?column?': 1 }] })
        : Promise.resolve({ rows: [] }),
    )
    mockLoadOwner.mockResolvedValue({ userSafeId: 'safe-1', config, singleSignerWaiverAt: null })
  }

  function mockPrepared() {
    mockTreasury.mockResolvedValueOnce({
      treasuryAddress: ACCOUNT,
      prepareCall: vi.fn().mockResolvedValue({
        userOperation: { sender: ACCOUNT, nonce: 1n, callData: '0xffff' },
        userOpHash: '0x' + 'ee'.repeat(32),
        signingTypedData: { domain: { name: 'HybridDeleGator' }, types: {}, primaryType: 'PackedUserOperation', message: {} },
      }),
      submitCall: vi.fn().mockResolvedValue({ txHash: '0x' + 'ff'.repeat(32) }),
    })
  }

  const prepareUrl = `/accounts/hybrid/${ACCOUNT}/transfers/prepare?chain_id=84532`
  const submitUrl = `/accounts/hybrid/${ACCOUNT}/transfers/submit?chain_id=84532`
  const BODY = { token_address: TOKEN, to: TO, amount_atomic: '250000' }

  it('prepares a passkey-signable transfer — device decides the scheme (#1086)', async () => {
    ownedAccount({ ownerAddress: OWNER_EOA, passkeys: [PK1] })
    mockPrepared()
    const res = await app.inject({
      method: 'POST', url: prepareUrl,
      payload: { ...BODY, signature_scheme: 'webauthn_userop' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().signature_scheme).toBe('webauthn_userop')
    expect(res.json().user_op_hash).toBeTruthy()
    expect(mockTreasury.mock.calls[0][0]).toMatchObject({ signWith: 'passkey' })
  })

  it('rejects garbage transfer input before any op is prepared', async () => {
    ownedAccount({ passkeys: [PK1] })
    for (const bad of [
      { ...BODY, to: 'not-an-address' },
      { ...BODY, to: '0x' + '00'.repeat(20) },
      { ...BODY, amount_atomic: '0' },
      { ...BODY, amount_atomic: '-5' },
      { ...BODY, token_address: 'nope' },
    ]) {
      const res = await app.inject({ method: 'POST', url: prepareUrl, payload: bad })
      expect(res.statusCode).toBe(400)
    }
    expect(mockTreasury).not.toHaveBeenCalled()
  })

  it('submit pins the tx to the SIGNED calldata — a mismatched user_operation is refused', async () => {
    ownedAccount({ passkeys: [PK1] })
    const res = await app.inject({
      method: 'POST', url: submitUrl,
      payload: {
        ...BODY,
        signature: '0x' + 'ab'.repeat(80),
        user_operation: { sender: ACCOUNT, callData: '0xdeadbeef' },
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/does not match the requested transfer/)
    expect(mockTreasury).not.toHaveBeenCalled()
  })

  it('submit relays the signed op and returns the tx hash', async () => {
    ownedAccount({ passkeys: [PK1] })
    mockPrepared()
    const { encodeFunctionData } = await import('viem')
    const callData = encodeFunctionData({
      abi: [{ name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [{ type: 'bool' }] }],
      functionName: 'transfer',
      args: [TO, 250000n],
    })
    const res = await app.inject({
      method: 'POST', url: submitUrl,
      payload: { ...BODY, signature: '0x' + 'ab'.repeat(80), user_operation: { sender: ACCOUNT, callData } },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ submitted: true, tx_hash: '0x' + 'ff'.repeat(32) })
  })

  it("404s an account the caller does not own", async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const res = await app.inject({ method: 'POST', url: prepareUrl, payload: BODY })
    expect(res.statusCode).toBe(404)
    expect(mockTreasury).not.toHaveBeenCalled()
  })
})
