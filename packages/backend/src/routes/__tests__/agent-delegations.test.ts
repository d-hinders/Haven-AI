/**
 * #828 delegation lifecycle. Pattern-matched DB mocks (#775). The network
 * seams (address derivation, treasury ops) are mocked; the caveat compiler
 * runs REAL so payloads and identities are genuine.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { expectMatchesSpec } from '../../openapi/response-shape.js'

const { mockQuery, mockCompute, mockTreasury, mockEnsureDeployed, mockReadDisabled } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockCompute: vi.fn(),
  mockTreasury: vi.fn(),
  mockEnsureDeployed: vi.fn(),
  mockReadDisabled: vi.fn(),
}))
vi.mock('../../db.js', () => ({
  default: {
    query: (...a: unknown[]) => mockQuery(...a),
    // #1053 finding 4: activation is transactional now — the route takes a
    // dedicated client. Same mockQuery underneath so assertions see BEGIN/
    // COMMIT/ROLLBACK inline with the statements they bracket.
    connect: async () => ({ query: (...a: unknown[]) => mockQuery(...a), release: () => {} }),
  },
}))
vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: async (request: { user?: unknown }) => {
    request.user = { sub: 'user-1' }
  },
}))
vi.mock('../../rails/hybrid-provisioning.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rails/hybrid-provisioning.js')>()
  return {
    ...actual,
    computeHybridAccountAddress: (...a: unknown[]) => mockCompute(...a),
    ensureHybridDeployed: (...a: unknown[]) => mockEnsureDeployed(...a),
  }
})
vi.mock('../../rails/delegation-rail.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rails/delegation-rail.js')>()
  return {
    ...actual,
    createTreasuryOps: (...a: unknown[]) => mockTreasury(...a),
    delegationRailBundlerUrl: () => 'https://bundler.example/x?apikey=SECRET',
    readDisabledDelegationHashes: (...a: unknown[]) => mockReadDisabled(...a),
  }
})

const agentDelegationRoutes = (await import('../agent-delegations.js')).default
const { getDelegationContracts } = await import('../../rails/delegation-contracts.js')

const AGENT_ID = '11111111-1111-1111-1111-111111111111'
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const RECIPIENT = '0x' + 'cc'.repeat(20)
const TREASURY = '0x' + 'aa'.repeat(20)
const DELEGATE_KEY = '0x' + 'bb'.repeat(20)
const DELEGATE_ACCOUNT = '0x' + 'dd'.repeat(20)
/**
 * A real `agent_delegations` row as the DRIVER returns it (#1446): a uuid id,
 * lowercase addresses (the table's CHECK), and start_date/expires_at as digit
 * STRINGS — node-postgres decodes int8 that way, and the spec says so.
 */
const DELEGATION_ROW = {
  id: '9f8a1b62-3c47-4d55-9e10-2b7c4a6d8e30',
  chain_id: 84532,
  token_address: USDC.toLowerCase(),
  recipient_address: RECIPIENT.toLowerCase(),
  delegation_hash: '0x' + 'ab'.repeat(32),
  version: 1,
  status: 'active',
  budget_atomic: '5000000',
  period_seconds: 86400,
  start_date: '1755600000',
  expires_at: '1763376000',
  created_at: '2026-08-19T10:00:00.000Z',
}
const OWNER = '0x' + 'ee'.repeat(20)
const HASH = `0x${'ab'.repeat(32)}`

function agentRow(overrides: Record<string, unknown> = {}) {
  return {
    agent_id: AGENT_ID,
    delegate_address: DELEGATE_KEY,
    chain_id: 84532,
    treasury_address: TREASURY,
    account_type: 'delegator_hybrid',
    ...overrides,
  }
}

function mockDb(opts: {
  agent?: Record<string, unknown> | null
  version?: number
  stored?: Record<string, unknown> | null
  owner?: string | null
  passkeys?: Array<{ key_id: string; public_key_x: string; public_key_y: string; created_at?: Date | string | null }>
  waiverAt?: string | null
  list?: Array<Record<string, unknown>>
} = {}) {
  mockQuery.mockImplementation((sql: string) => {
    const s = String(sql)
    if (/FROM agents a/.test(s)) {
      return Promise.resolve({ rows: opts.agent === null ? [] : [opts.agent ?? agentRow()] })
    }
    if (/COALESCE\(MAX\(version\)/.test(s)) {
      return Promise.resolve({ rows: [{ next_version: opts.version ?? 1 }] })
    }
    // loadHybridOwnerConfig (#885): the account row, then its passkey set.
    if (/SELECT id, owner_address, single_signer_waiver_at FROM user_safes/.test(s)) {
      // owner === null AND no passkeys → account row still exists (so the
      // config loader can look up passkeys); a truly-missing row is opts.owner
      // === undefined with no passkeys handled below via the null return.
      const ownerAddr = opts.owner === undefined ? OWNER : opts.owner
      return Promise.resolve({ rows: [{ id: 'safe-1', owner_address: ownerAddr }] })
    }
    if (/FROM hybrid_account_passkeys/.test(s)) {
      return Promise.resolve({ rows: opts.passkeys ?? [] })
    }
    // #908 activation gate: the recorded single-signer waiver lookup.
    if (/single_signer_waiver_at/.test(s)) {
      return Promise.resolve({ rows: [{ single_signer_waiver_at: opts.waiverAt ?? null }] })
    }
    if (/SELECT delegation_json, status/.test(s) || /SELECT id, delegation_json/.test(s)) {
      return Promise.resolve({ rows: opts.stored === null ? [] : [opts.stored ?? {
        id: 'row-1',
        delegation_json: JSON.stringify({ delegate: DELEGATE_ACCOUNT, delegator: TREASURY, authority: `0x${'0'.repeat(64)}`, caveats: [], salt: 1n.toString() }),
        status: 'pending',
        token_address: USDC.toLowerCase(),
        recipient_address: RECIPIENT.toLowerCase(),
      }] })
    }
    if (/FROM agent_delegations/.test(s)) return Promise.resolve({ rows: opts.list ?? [] })
    return Promise.resolve({ rows: [] })
  })
}

describe('delegation lifecycle API (#828)', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(agentDelegationRoutes, { prefix: '/agents' })
  })
  afterAll(async () => app.close())
  beforeEach(() => {
    mockQuery.mockReset()
    mockCompute.mockReset()
    mockTreasury.mockReset()
    mockEnsureDeployed.mockReset()
    mockCompute.mockResolvedValue(DELEGATE_ACCOUNT)
    // Default: the delegator account is (or becomes) deployed at the stored address.
    mockEnsureDeployed.mockResolvedValue({ address: TREASURY, alreadyDeployed: true })
    // #1423 default: nothing already disabled on-chain.
    mockReadDisabled.mockReset()
    mockReadDisabled.mockResolvedValue(new Set())
  })

  describe('POST /:id/delegations/build — grant step 1', () => {
    it('returns EIP-712 typed data for the OWNER to sign; backend signs nothing', async () => {
      mockDb({})
      const res = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/delegations/build`,
        payload: { token_address: USDC, recipient_address: RECIPIENT, budget_atomic: '5000000', period_seconds: 86400 },
      })
      expect(res.statusCode).toBe(201)
      const body = res.json()
      expect(body.signing_payload.primaryType).toBe('Delegation')
      expect(body.signing_payload.domain.verifyingContract.toLowerCase()).toBe(
        getDelegationContracts(84532).delegationManager.toLowerCase(),
      )
      expect(body.delegation_hash).toMatch(/^0x[0-9a-f]{64}$/i)
      // #1446: the documented 201 shape, checked against the real payload.
      expectMatchesSpec('POST', '/agents/{id}/delegations/build', body, '201')
      // No signature anywhere in the response — the owner supplies it:
      expect(JSON.stringify(body)).not.toMatch(/"signature":\s*"0x[0-9a-f]{130}/i)
      // Row stored as pending:
      const insert = mockQuery.mock.calls.find((c) => /INSERT INTO agent_delegations/.test(String(c[0])))!
      expect(String(insert[0])).toContain("'pending'")
    })

    it('the open-budget variant carries no recipient', async () => {
      mockDb({})
      const res = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/delegations/build`,
        payload: { token_address: USDC, budget_atomic: '5000000', period_seconds: 86400 },
      })
      expect(res.statusCode).toBe(201)
      const insert = mockQuery.mock.calls.find((c) => /INSERT INTO agent_delegations/.test(String(c[0])))!
      expect(insert[1][3]).toBeNull() // recipient_address
    })

    it('a replacement gets a FRESH identity (version bump, #813)', async () => {
      mockDb({ version: 1 })
      const first = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/delegations/build`,
        payload: { token_address: USDC, recipient_address: RECIPIENT, budget_atomic: '5000000', period_seconds: 86400 },
      })
      mockDb({ version: 2 })
      const second = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/delegations/build`,
        payload: { token_address: USDC, recipient_address: RECIPIENT, budget_atomic: '9000000', period_seconds: 86400 },
      })
      expect(second.json().version).toBe(2)
      expect(second.json().delegation_hash).not.toBe(first.json().delegation_hash)
    })

    it.each([
      ['legacy account', { agent: agentRow({ account_type: 'safe' }) }, 409],
      ['missing delegate key', { agent: agentRow({ delegate_address: null }) }, 409],
      ['unknown agent', { agent: null }, 404],
    ])('rejects %s', async (_label, opts, code) => {
      mockDb(opts as never)
      const res = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/delegations/build`,
        payload: { token_address: USDC, budget_atomic: '1', period_seconds: 86400 },
      })
      expect(res.statusCode).toBe(code)
    })

    it.each([
      ['bad token', { token_address: 'x', budget_atomic: '1', period_seconds: 86400 }],
      ['zero budget', { token_address: USDC, budget_atomic: '0', period_seconds: 86400 }],
      ['short period', { token_address: USDC, budget_atomic: '1', period_seconds: 10 }],
      ['past expiry', { token_address: USDC, budget_atomic: '1', period_seconds: 86400, expires_at: 1 }],
    ])('validates: %s', async (_label, payload) => {
      mockDb({})
      const res = await app.inject({ method: 'POST', url: `/agents/${AGENT_ID}/delegations/build`, payload })
      expect(res.statusCode).toBe(400)
    })
  })

  describe('signer management (#888)', () => {
    const PK1 = { key_id: '0x' + '11'.repeat(32), public_key_x: '0xaa', public_key_y: '0xbb' }
    const PK2 = { key_id: '0x' + '22'.repeat(32), public_key_x: '0xcc', public_key_y: '0xdd' }
    const NEW_PK = { key_id: '0x' + '33'.repeat(32), x: '0x1', y: '0x2' }

    function mockPrepared() {
      mockTreasury.mockResolvedValueOnce({
        treasuryAddress: TREASURY,
        prepareCall: vi.fn().mockResolvedValue({
          userOperation: { sender: TREASURY, nonce: 1n, callData: '0xffff' },
          userOpHash: '0x' + 'ee'.repeat(32),
          signingTypedData: { domain: { name: 'HybridDeleGator' }, types: {}, primaryType: 'PackedUserOperation', message: {} },
        }),
        submitCall: vi.fn().mockResolvedValue({ txHash: '0x' + 'ff'.repeat(32) }),
      })
    }

    it('matches the documented signer prepare/submit shapes (#1446)', async () => {
      mockDb({ owner: null, passkeys: [PK1, PK2] })
      mockPrepared()
      const prepared = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/account-signers/prepare`,
        payload: { action: 'add_passkey', passkey: NEW_PK },
      })
      expect(prepared.statusCode).toBe(200)
      // Unlike the revocation prepares, this response carries NO
      // treasury_address — the spec documents the difference rather than
      // pretending the two prepares are one shape.
      expect(prepared.json().treasury_address).toBeUndefined()
      expectMatchesSpec('POST', '/agents/{id}/account-signers/prepare', prepared.json())
    })

    it('prepare add_passkey on a passkey account returns the WebAuthn scheme', async () => {
      mockDb({ owner: null, passkeys: [PK1, PK2] })
      mockPrepared()
      const res = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/account-signers/prepare`,
        payload: { action: 'add_passkey', passkey: NEW_PK },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().signature_scheme).toBe('webauthn_userop')
      expect(res.json().user_op_hash).toBeTruthy()
    })

    it('prepares a two-to-one passkey removal (#1199)', async () => {
      mockDb({ owner: null, passkeys: [PK1, PK2] })
      mockPrepared()
      const res = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/account-signers/prepare`,
        payload: { action: 'remove_passkey', passkey: { key_id: PK1.key_id } },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().signature_scheme).toBe('webauthn_userop')
    })

    it('allows removal when two signers remain', async () => {
      mockDb({ owner: OWNER, passkeys: [PK1, PK2] }) // 3 signers → 2 after
      mockPrepared()
      const res = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/account-signers/prepare`,
        payload: { action: 'remove_passkey', passkey: { key_id: PK1.key_id } },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().signature_scheme).toBe('eip712_userop')
      // The OTHER branch of the documented oneOf — an eip712 owner account.
      expect(res.json().signature_scheme).toBe('eip712_userop')
      expectMatchesSpec('POST', '/agents/{id}/account-signers/prepare', res.json())
    })

    it('refuses enrolling a duplicate passkey and a second EOA owner', async () => {
      mockDb({ owner: OWNER, passkeys: [PK1] })
      const dup = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/account-signers/prepare`,
        payload: { action: 'add_passkey', passkey: { key_id: PK1.key_id, x: '0x1', y: '0x2' } },
      })
      expect(dup.statusCode).toBe(409)
      const secondOwner = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/account-signers/prepare`,
        payload: { action: 'add_owner', owner_address: '0x' + '99'.repeat(20) },
      })
      expect(secondOwner.statusCode).toBe(409)
      expect(secondOwner.json().error).toMatch(/already has a wallet owner/)
    })

    it('submit pins the DB sync to the SIGNED calldata — a mismatched user_operation is refused', async () => {
      mockDb({ owner: null, passkeys: [PK1, PK2] })
      const res = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/account-signers/submit`,
        payload: {
          action: 'add_passkey', passkey: NEW_PK,
          signature: '0x' + 'ab'.repeat(80),
          user_operation: { sender: TREASURY, callData: '0xdeadbeef' }, // does NOT contain addKey(NEW_PK)
        },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toMatch(/does not match/)
      expect(mockQuery.mock.calls.some((c) => /INSERT INTO hybrid_account_passkeys/.test(String(c[0])))).toBe(false)
    })

    it('submit add_passkey syncs storage after the on-chain op succeeds', async () => {
      mockDb({ owner: null, passkeys: [PK1, PK2] })
      mockPrepared()
      // Build the REAL expected calldata so the pinning check passes.
      const { encodeFunctionData } = await import('viem')
      const inner = encodeFunctionData({
        abi: [{ name: 'addKey', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: '_keyId', type: 'string' }, { name: '_x', type: 'uint256' }, { name: '_y', type: 'uint256' }], outputs: [] }],
        functionName: 'addKey',
        args: [NEW_PK.key_id, 1n, 2n],
      })
      const res = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/account-signers/submit`,
        payload: {
          action: 'add_passkey', passkey: NEW_PK,
          signature: '0x' + 'ab'.repeat(80),
          user_operation: { sender: TREASURY, callData: '0x1111' + inner.slice(2) },
        },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ updated: true })
      const insert = mockQuery.mock.calls.find((c) => /INSERT INTO hybrid_account_passkeys/.test(String(c[0])))!
      expect(insert[1]).toEqual(['safe-1', NEW_PK.key_id, NEW_PK.x, NEW_PK.y])
      expectMatchesSpec('POST', '/agents/{id}/account-signers/submit', res.json())
    })
  })

  describe('GET /:id/account-signers (#887)', () => {
    it('matches the documented signer-set shape (#1446)', async () => {
      mockDb({ owner: null, passkeys: [{ key_id: 'kid-1', public_key_x: '0x01', public_key_y: '0x02' }] })
      const res = await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/account-signers` })
      expect(res.statusCode).toBe(200)
      expectMatchesSpec('GET', '/agents/{id}/account-signers', res.json())
    })

    it('returns the signer set for a passkey account — public key material only', async () => {
      // The fixture row has no created_at → the response serves null, never a
      // fabricated date and never a 500 (#1679 defensive mapping).
      mockDb({ owner: null, passkeys: [{ key_id: '0x' + '11'.repeat(32), public_key_x: '0xaa', public_key_y: '0xbb' }] })
      const res = await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/account-signers` })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        account_address: TREASURY,
        chain_id: 84532,
        owner_address: null,
        passkeys: [{ key_id: '0x' + '11'.repeat(32), x: '0xaa', y: '0xbb', created_at: null }],
      })
    })

    it('serves per-credential created_at when stored — the UI labels "Passkey · added {date}" from it (#1679)', async () => {
      mockDb({
        owner: null,
        passkeys: [{
          key_id: '0x' + '11'.repeat(32), public_key_x: '0xaa', public_key_y: '0xbb',
          created_at: new Date('2026-03-03T12:00:00.000Z'),
        }],
      })
      const res = await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/account-signers` })
      expect(res.statusCode).toBe(200)
      expect(res.json().passkeys).toEqual([
        { key_id: '0x' + '11'.repeat(32), x: '0xaa', y: '0xbb', created_at: '2026-03-03T12:00:00.000Z' },
      ])
      expectMatchesSpec('GET', '/agents/{id}/account-signers', res.json())
    })

    it('returns the EOA owner with an empty passkey list', async () => {
      mockDb({})
      const res = await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/account-signers` })
      expect(res.statusCode).toBe(200)
      expect(res.json().owner_address).toBe(OWNER)
      expect(res.json().passkeys).toEqual([])
    })

    it('409s when no signer configuration exists', async () => {
      mockDb({ owner: null })
      const res = await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/account-signers` })
      expect(res.statusCode).toBe(409)
    })
  })

  describe('POST /:id/delegations/:hash/activate — grant step 2', () => {
    it('activating the first grant ALSO activates a pending_approval agent — the rail\'s approval (#1069)', async () => {
      // On the delegation rail there is no wallet-approval step; the owner's
      // grant signature IS the approval. Without this flip a modal-created
      // agent stayed pending forever.
      mockDb({})
      const res = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/delegations/${HASH}/activate`,
        payload: { signature: '0x' + 'ab'.repeat(65) },
      })
      expect(res.json()).toMatchObject({ activated: true })
      const flip = mockQuery.mock.calls.find((c) => /UPDATE agents SET status = 'active'/.test(String(c[0])))
      expect(flip).toBeDefined()
      expect(String(flip![0])).toMatch(/status = 'pending_approval'/)
    })

    it('accepts a WebAuthn-length signature (ABI-encoded assertion, >65 bytes) (#887)', async () => {
      mockDb({
        owner: null,
        passkeys: [{ key_id: 'cred-1', public_key_x: '0x11', public_key_y: '0x22' }],
      })
      mockEnsureDeployed.mockResolvedValueOnce({ address: TREASURY, alreadyDeployed: true })
      const res = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/delegations/${HASH}/activate`,
        payload: { signature: '0x' + 'ab'.repeat(300) }, // WebAuthn assertion scale
      })
      expect(res.statusCode).toBe(200)
    })

    it('still rejects a too-short or odd-length signature', async () => {
      mockDb({})
      for (const bad of ['0xdead', '0x' + 'ab'.repeat(64) + 'a']) {
        const res = await app.inject({
          method: 'POST', url: `/agents/${AGENT_ID}/delegations/${HASH}/activate`,
          payload: { signature: bad },
        })
        expect(res.statusCode).toBe(400)
      }
    })


    it('deploys the counterfactual delegator via the relayer before activating (#860)', async () => {
      mockDb({})
      mockEnsureDeployed.mockResolvedValueOnce({ address: TREASURY, alreadyDeployed: false, txHash: '0x' + '11'.repeat(32) })
      const res = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/delegations/${HASH}/activate`,
        payload: { signature: '0x' + 'ab'.repeat(65) },
      })
      expect(res.statusCode).toBe(200)
      expect(mockEnsureDeployed).toHaveBeenCalledWith(84532, expect.objectContaining({ ownerAddress: OWNER }), TREASURY, { agentId: AGENT_ID, userId: 'user-1' })
    })

    it('502s WITHOUT activating when the deploy fails — grant stays pending, retryable (#860)', async () => {
      mockDb({})
      mockEnsureDeployed.mockRejectedValueOnce(new Error('relayer out of gas at https://rpc?apikey=pim_SECRET'))
      const res = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/delegations/${HASH}/activate`,
        payload: { signature: '0x' + 'ab'.repeat(65) },
      })
      expect(res.statusCode).toBe(502)
      expect(res.body).not.toContain('pim_SECRET')
      expect(mockQuery.mock.calls.some((c) => /SET\s+status = 'active'/.test(String(c[0])))).toBe(false)
    })

    it('409s when the account has NO signer config at all (neither owner nor passkey)', async () => {
      mockDb({ owner: null }) // no owner_address, no passkeys
      const res = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/delegations/${HASH}/activate`,
        payload: { signature: '0x' + 'ab'.repeat(65) },
      })
      expect(res.statusCode).toBe(409)
      expect(mockEnsureDeployed).not.toHaveBeenCalled()
    })

    it('activates a PURE-PASSKEY account — deploys with its passkey config, no 409 (#885)', async () => {
      mockDb({
        owner: null,
        passkeys: [{ key_id: 'cred-1', public_key_x: '0x11', public_key_y: '0x22' }],
      })
      mockEnsureDeployed.mockResolvedValueOnce({ address: TREASURY, alreadyDeployed: false, txHash: '0x' + '33'.repeat(32) })
      const res = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/delegations/${HASH}/activate`,
        payload: { signature: '0x' + 'ab'.repeat(65) },
      })
      expect(res.statusCode).toBe(200)
      // The relayer deploys from the stored passkey set — the #885 unblock.
      expect(mockEnsureDeployed).toHaveBeenCalledWith(84532, {
        ownerAddress: undefined,
        passkeys: [{ keyId: 'cred-1', x: 0x11n, y: 0x22n }],
      }, TREASURY, { agentId: AGENT_ID, userId: 'user-1' })
    })

    it('REVERSAL (#1153): a single-signer MAINNET account ACTIVATES, no waiver required', async () => {
      // Asserted 403 until #1153. A budget may now be granted to an account
      // with one signer on a value-bearing chain; the backup recommendation
      // reaches the user after funding instead of refusing the grant here.
      mockDb({ agent: agentRow({ chain_id: 8453 }) }) // owner only = 1 signer
      mockEnsureDeployed.mockResolvedValueOnce({ address: TREASURY, alreadyDeployed: true })
      const res = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/delegations/${HASH}/activate`,
        payload: { signature: '0x' + 'ab'.repeat(65) },
      })
      expect(res.statusCode).toBe(200)
      expect(mockEnsureDeployed).toHaveBeenCalled()
    })

    it('#908: a recorded waiver lets a single-signer mainnet account activate', async () => {
      mockDb({ agent: agentRow({ chain_id: 8453 }), waiverAt: '2026-07-14T00:00:00Z' })
      mockEnsureDeployed.mockResolvedValueOnce({ address: TREASURY, alreadyDeployed: true })
      const res = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/delegations/${HASH}/activate`,
        payload: { signature: '0x' + 'ab'.repeat(65) },
      })
      expect(res.statusCode).toBe(200)
    })

    it('#908: two signers (owner + passkey) activate on mainnet with no waiver', async () => {
      mockDb({
        agent: agentRow({ chain_id: 8453 }),
        passkeys: [{ key_id: 'cred-1', public_key_x: '0x11', public_key_y: '0x22' }],
      })
      mockEnsureDeployed.mockResolvedValueOnce({ address: TREASURY, alreadyDeployed: true })
      const res = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/delegations/${HASH}/activate`,
        payload: { signature: '0x' + 'ab'.repeat(65) },
      })
      expect(res.statusCode).toBe(200)
    })

    it('REVERSAL (#1153): a legacy zero-address-owner row activates too', async () => {
      // 0x0 is the Hybrid "no owner" encoding, so this row has ONE real
      // signer. It used to 403 — the assertion proved the zero address was
      // not miscounted as a phantom second signer and so could not sneak past
      // the floor. With no floor to sneak past, activation proceeds; the
      // "0x0 is not a signer" rule now lives where it still decides something,
      // in the recommendation predicate's unit tests.
      mockDb({
        agent: agentRow({ chain_id: 8453 }),
        owner: '0x' + '0'.repeat(40),
        passkeys: [{ key_id: 'cred-1', public_key_x: '0x11', public_key_y: '0x22' }],
      })
      mockEnsureDeployed.mockResolvedValueOnce({ address: TREASURY, alreadyDeployed: true })
      const res = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/delegations/${HASH}/activate`,
        payload: { signature: '0x' + 'ab'.repeat(65) },
      })
      expect(res.statusCode).toBe(200)
    })

    it('#908 CHARACTERIZATION: testnet activation is untouched by the floor', async () => {
      mockDb({}) // chain 84532, owner only = 1 signer, no waiver
      mockEnsureDeployed.mockResolvedValueOnce({ address: TREASURY, alreadyDeployed: true })
      const res = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/delegations/${HASH}/activate`,
        payload: { signature: '0x' + 'ab'.repeat(65) },
      })
      expect(res.statusCode).toBe(200)
    })

    it('500s on owner→address derivation mismatch rather than activating an unusable grant (#860)', async () => {
      mockDb({})
      mockEnsureDeployed.mockResolvedValueOnce({ address: '0x' + 'ff'.repeat(20), alreadyDeployed: false })
      const res = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/delegations/${HASH}/activate`,
        payload: { signature: '0x' + 'ab'.repeat(65) },
      })
      expect(res.statusCode).toBe(500)
      expect(mockQuery.mock.calls.some((c) => /SET\s+status = 'active'/.test(String(c[0])))).toBe(false)
    })

    it('matches the documented activate shape (#1446)', async () => {
      mockDb({})
      const res = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/delegations/${'0x' + 'ab'.repeat(32)}/activate`,
        payload: { signature: '0x' + 'ab'.repeat(65) },
      })
      expect(res.statusCode).toBe(200)
      expectMatchesSpec('POST', '/agents/{id}/delegations/{hash}/activate', res.json())
    })

    it('stores the owner signature and marks the previous grant replaced', async () => {
      mockDb({})
      const res = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/delegations/${HASH}/activate`,
        payload: { signature: '0x' + 'ab'.repeat(65) },
      })
      expect(res.json()).toMatchObject({ activated: true })
      const replaced = mockQuery.mock.calls.find((c) => /SET status = 'replaced'/.test(String(c[0])))
      expect(replaced).toBeDefined()
      const activated = mockQuery.mock.calls.find((c) => /SET\s+status = 'active'/.test(String(c[0])))!
      expect(String(activated[1][0])).toContain('signature')
    })

    it('rejects a malformed signature and a non-pending row', async () => {
      mockDb({})
      const bad = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/delegations/${HASH}/activate`, payload: { signature: '0xdead' },
      })
      expect(bad.statusCode).toBe(400)
      mockDb({ stored: { id: 'r', delegation_json: '{}', status: 'revoked', token_address: USDC, recipient_address: null } })
      const wrongState = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/delegations/${HASH}/activate`,
        payload: { signature: '0x' + 'ab'.repeat(65) },
      })
      expect(wrongState.statusCode).toBe(409)
    })
  })

  describe('POST /:id/delegations/:hash/revoke — one owner signature', () => {
    it('prepares a treasury userOpHash for the owner to sign; backend never signs', async () => {
      mockDb({ stored: { delegation_json: JSON.stringify({ delegate: DELEGATE_ACCOUNT, delegator: TREASURY, authority: `0x${'0'.repeat(64)}`, caveats: [], salt: '1', signature: '0x' + 'cd'.repeat(65) }), status: 'active' } })
      mockTreasury.mockResolvedValue({
        treasuryAddress: TREASURY,
        prepareCall: vi.fn().mockResolvedValue({
          userOperation: { nonce: 1n, sender: TREASURY },
          userOpHash: `0x${'ef'.repeat(32)}`,
          // The owner signs THIS typed data — not the bare hash (#829 lesson).
          signingTypedData: { domain: { name: 'HybridDeleGator' }, types: {}, primaryType: 'PackedUserOperation', message: {} },
          treasuryAddress: TREASURY,
        }),
        submitCall: vi.fn(),
      })
      const res = await app.inject({ method: 'POST', url: `/agents/${AGENT_ID}/delegations/${HASH}/revoke` })
      expect(res.statusCode).toBe(200)
      expect(res.json().signing_payload.domain.name).toBe('HybridDeleGator')
      expect(res.json().instructions).toMatch(/Sign signing_payload/)
      // Nothing was submitted, nothing marked revoked yet:
      expect(mockQuery.mock.calls.some((c) => /status = 'revoked'/.test(String(c[0])))).toBe(false)
    })

    it('matches the documented prepare shape, both schemes (#1446)', async () => {
      const stored = { stored: { delegation_json: JSON.stringify({ delegate: DELEGATE_ACCOUNT, delegator: TREASURY, authority: `0x${'0'.repeat(64)}`, caveats: [], salt: '1', signature: '0x' + 'cd'.repeat(65) }), status: 'active' } }
      mockTreasury.mockResolvedValue({
        treasuryAddress: TREASURY,
        prepareCall: vi.fn().mockResolvedValue({
          userOperation: { nonce: 1n, sender: TREASURY },
          userOpHash: `0x${'ef'.repeat(32)}`,
          signingTypedData: { domain: { name: 'HybridDeleGator' }, types: {}, primaryType: 'PackedUserOperation', message: {} },
          treasuryAddress: TREASURY,
        }),
        submitCall: vi.fn(),
      })

      mockDb(stored)
      const eoa = await app.inject({ method: 'POST', url: `/agents/${AGENT_ID}/delegations/${HASH}/revoke` })
      expect(eoa.statusCode).toBe(200)
      expectMatchesSpec('POST', '/agents/{id}/delegations/{hash}/revoke', eoa.json())

      // The passkey branch returns user_op_hash instead of signing_payload —
      // the spec's oneOf must accept BOTH, or half the accounts are undocumented.
      mockDb({ ...stored, owner: null, passkeys: [{ key_id: 'kid-1', public_key_x: '0x01', public_key_y: '0x02' }] })
      const passkey = await app.inject({ method: 'POST', url: `/agents/${AGENT_ID}/delegations/${HASH}/revoke` })
      expect(passkey.statusCode).toBe(200)
      expect(passkey.json().signature_scheme).toBe('webauthn_userop')
      expectMatchesSpec('POST', '/agents/{id}/delegations/{hash}/revoke', passkey.json())
    })

    it('prepares a WebAuthn userOpHash for a PURE-PASSKEY account (#885)', async () => {
      mockDb({
        stored: { delegation_json: JSON.stringify({ delegate: DELEGATE_ACCOUNT, delegator: TREASURY, authority: `0x${'0'.repeat(64)}`, caveats: [], salt: '1', signature: '0x' + 'cd'.repeat(65) }), status: 'active' },
        owner: null,
        passkeys: [{ key_id: 'cred-1', public_key_x: '0x11', public_key_y: '0x22' }],
      })
      mockTreasury.mockResolvedValue({
        treasuryAddress: TREASURY,
        prepareCall: vi.fn().mockResolvedValue({
          userOperation: { nonce: 1n, sender: TREASURY },
          userOpHash: `0x${'ef'.repeat(32)}`,
          signingTypedData: null,
          treasuryAddress: TREASURY,
        }),
        submitCall: vi.fn(),
      })
      const res = await app.inject({ method: 'POST', url: `/agents/${AGENT_ID}/delegations/${HASH}/revoke` })
      expect(res.statusCode).toBe(200)
      // Passkey accounts get the userOpHash to WebAuthn-sign — not EIP-712 typed data.
      expect(res.json().signature_scheme).toBe('webauthn_userop')
      expect(res.json().user_op_hash).toBe(`0x${'ef'.repeat(32)}`)
      expect(res.json().instructions).toMatch(/WebAuthn/)
      // createTreasuryOps was built from the passkey set, not an EOA owner:
      expect(mockTreasury.mock.calls[0][0]).toMatchObject({
        ownerAddress: undefined,
        passkeys: [{ keyId: 'cred-1', x: 0x11n, y: 0x22n }],
      })
    })

    it('409s when the account has no signer config at all', async () => {
      mockDb({ stored: { delegation_json: '{}', status: 'active' }, owner: null })
      const res = await app.inject({ method: 'POST', url: `/agents/${AGENT_ID}/delegations/${HASH}/revoke` })
      expect(res.statusCode).toBe(409)
      expect(res.json().error).toMatch(/exit path/)
    })

    it('heals a crash-window orphan instead of 502ing on the AlreadyDisabled revert (#1423)', async () => {
      mockDb({ stored: { delegation_json: '{}', status: 'active' } })
      mockReadDisabled.mockResolvedValue(new Set([HASH]))

      const res = await app.inject({ method: 'POST', url: `/agents/${AGENT_ID}/delegations/${HASH}/revoke` })
      expect(res.statusCode).toBe(409)
      expect(res.json().error).toMatch(/Already revoked.*reconciled/i)
      const heal = mockQuery.mock.calls.find((c) => /SET status = 'revoked'/.test(String(c[0])))
      expect(heal).toBeDefined()
      expect(heal![1]).toEqual([AGENT_ID, [HASH]])
      // Nothing was prepared — no UserOp for a call that would only revert.
      expect(mockTreasury).not.toHaveBeenCalled()
    })

    it('submit marks revoked and never leaks the bundler credential on failure', async () => {
      mockDb({ stored: { delegation_json: '{}', status: 'active' } })
      mockTreasury.mockResolvedValue({
        treasuryAddress: TREASURY,
        prepareCall: vi.fn(),
        submitCall: vi.fn().mockRejectedValue(
          new Error('bundler: https://bundler.example/x?apikey=SUPERSECRET declined'),
        ),
      })
      const res = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/delegations/${HASH}/revoke/submit`,
        payload: { signature: '0xabcd', user_operation: { nonce: '1n' } },
      })
      expect(res.statusCode).toBe(502)
      expect(res.body).not.toContain('SUPERSECRET')
      expect(res.body).toContain('apikey=REDACTED')
    })

    it('successful submit marks the row revoked', async () => {
      mockDb({ stored: { delegation_json: '{}', status: 'active' } })
      mockTreasury.mockResolvedValue({
        treasuryAddress: TREASURY,
        prepareCall: vi.fn(),
        submitCall: vi.fn().mockResolvedValue({ txHash: '0xfeed', userOpHash: '0x', actualGasUsed: 1n, actualGasCost: 1n }),
      })
      const res = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/delegations/${HASH}/revoke/submit`,
        payload: { signature: '0xabcd', user_operation: { nonce: '1n' } },
      })
      expect(res.json()).toMatchObject({ revoked: true, tx_hash: '0xfeed' })
      expectMatchesSpec('POST', '/agents/{id}/delegations/{hash}/revoke/submit', res.json())
      expect(mockQuery.mock.calls.some((c) => /status = 'revoked'/.test(String(c[0])))).toBe(true)
    })
  })

  describe('GET /:id/delegations', () => {
    it('never returns the signed delegation object in the list', async () => {
      mockDb({})
      const res = await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/delegations` })
      expect(res.statusCode).toBe(200)
      const listQuery = mockQuery.mock.calls.find((c) => /FROM agent_delegations/.test(String(c[0])))!
      expect(String(listQuery[0])).not.toContain('delegation_json')
    })

    it('matches the documented shape for a real row (#1446)', async () => {
      mockDb({ list: [DELEGATION_ROW] })
      const res = await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/delegations` })
      expect(res.statusCode).toBe(200)
      expect(res.json().delegations).toHaveLength(1)
      // #1444: the spec's own schema decides — including that the BIGINT
      // columns arrive as strings and that delegation_json is absent.
      expectMatchesSpec('GET', '/agents/{id}/delegations', res.json())
    })

    it('an open budget documents its null recipient', async () => {
      mockDb({ list: [{ ...DELEGATION_ROW, recipient_address: null, status: 'pending' }] })
      const res = await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/delegations` })
      expectMatchesSpec('GET', '/agents/{id}/delegations', res.json())
    })
  })

  describe('multi-signer accounts pick the signature scheme per request (the Daniel regression)', () => {
    // An account with BOTH an EOA owner and passkeys accepts either signer
    // on-chain. The old code read "has an owner" as "must sign as the owner",
    // which stranded every passkey user the moment they enrolled a backup
    // wallet: sign with passkey → add EOA owner → passkey stops working.
    const BOTH = {
      owner: OWNER,
      passkeys: [{ key_id: '0x' + '77'.repeat(32), public_key_x: '0xaa', public_key_y: '0xbb' }],
    }
    const STORED_DELEGATION = {
      delegation_json: JSON.stringify({ delegate: DELEGATE_ACCOUNT, delegator: TREASURY, authority: `0x${'0'.repeat(64)}`, caveats: [], salt: '1', signature: '0x' + 'cd'.repeat(65) }),
      status: 'active',
    }
    const prepared = () =>
      mockTreasury.mockResolvedValue({
        treasuryAddress: TREASURY,
        prepareCall: vi.fn().mockResolvedValue({
          userOperation: { nonce: 1n, sender: TREASURY },
          userOpHash: `0x${'ef'.repeat(32)}`,
          signingTypedData: { domain: { name: 'HybridDeleGator' }, types: {}, primaryType: 'PackedUserOperation', message: {} },
          treasuryAddress: TREASURY,
        }),
        submitCall: vi.fn(),
      })

    it('revoke prepare honours a requested webauthn_userop even when an owner exists', async () => {
      mockDb({ stored: STORED_DELEGATION, ...BOTH })
      prepared()
      const res = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/delegations/${HASH}/revoke`,
        payload: { signature_scheme: 'webauthn_userop' },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().signature_scheme).toBe('webauthn_userop')
      expect(res.json().user_op_hash).toBe(`0x${'ef'.repeat(32)}`)
      // Gas estimation must be shaped by the signer that will actually sign:
      expect(mockTreasury.mock.calls[0][0]).toMatchObject({ signWith: 'passkey' })
    })

    it('revoke prepare without a requested scheme keeps the legacy owner default', async () => {
      mockDb({ stored: STORED_DELEGATION, ...BOTH })
      prepared()
      const res = await app.inject({ method: 'POST', url: `/agents/${AGENT_ID}/delegations/${HASH}/revoke` })
      expect(res.statusCode).toBe(200)
      expect(res.json().signature_scheme).toBe('eip712_userop')
      expect(mockTreasury.mock.calls[0][0]).toMatchObject({ signWith: 'owner' })
    })

    it('refuses a scheme the account cannot satisfy', async () => {
      mockDb({ stored: STORED_DELEGATION, passkeys: [] }) // owner only
      const res = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/delegations/${HASH}/revoke`,
        payload: { signature_scheme: 'webauthn_userop' },
      })
      expect(res.statusCode).toBe(409)
      expect(res.json().error).toMatch(/no passkeys/)
    })

    it('account-signers prepare honours the requested scheme on a mixed account', async () => {
      mockDb(BOTH)
      prepared()
      const res = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/account-signers/prepare`,
        payload: {
          action: 'add_passkey',
          passkey: { key_id: '0x' + '88'.repeat(32), x: '0x1', y: '0x2' },
          signature_scheme: 'webauthn_userop',
        },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().signature_scheme).toBe('webauthn_userop')
      expect(res.json().user_op_hash).toBeTruthy()
      expect(mockTreasury.mock.calls[0][0]).toMatchObject({ signWith: 'passkey' })
    })
  })
})

describe('POST /:id/delegations/revoke-all — #1400: one signature, every budget', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(agentDelegationRoutes, { prefix: '/agents' })
  })
  afterAll(async () => app.close())
  beforeEach(() => {
    mockQuery.mockReset()
    mockTreasury.mockReset()
    mockReadDisabled.mockReset()
    // Default: nothing already disabled on-chain — the pre-#1423 world.
    mockReadDisabled.mockResolvedValue(new Set())
  })

  const HASH2 = `0x${'cd'.repeat(32)}`
  const storedJsonWithSalt = (salt: string) => JSON.stringify({
    delegate: DELEGATE_ACCOUNT, delegator: TREASURY,
    authority: `0x${'0'.repeat(64)}`, caveats: [], salt, signature: '0x' + 'cd'.repeat(65),
  })
  const storedJson = storedJsonWithSalt('1')

  function mockBatchDb(opts: {
    agent?: Record<string, unknown> | null
    targets?: Array<Record<string, unknown>>
    owner?: string | null
    passkeys?: Array<{ key_id: string; public_key_x: string; public_key_y: string; created_at?: Date | string | null }>
  } = {}) {
    mockQuery.mockImplementation((sql: string) => {
      const s = String(sql)
      if (/FROM agents a/.test(s)) {
        return Promise.resolve({ rows: opts.agent === null ? [] : [opts.agent ?? agentRow()] })
      }
      if (/SELECT id, owner_address, single_signer_waiver_at FROM user_safes/.test(s)) {
        const ownerAddr = opts.owner === undefined ? OWNER : opts.owner
        return Promise.resolve({ rows: [{ id: 'safe-1', owner_address: ownerAddr }] })
      }
      if (/FROM hybrid_account_passkeys/.test(s)) {
        return Promise.resolve({ rows: opts.passkeys ?? [] })
      }
      if (/status IN \('pending', 'active'\)/.test(s)) {
        return Promise.resolve({
          rows: opts.targets ?? [
            { delegation_hash: HASH, delegation_json: storedJsonWithSalt('1'), status: 'active' },
            { delegation_hash: HASH2, delegation_json: storedJsonWithSalt('2'), status: 'pending' },
          ],
        })
      }
      if (/SET status = 'revoked'/.test(s)) {
        return Promise.resolve({ rows: [{ delegation_hash: HASH }, { delegation_hash: HASH2 }] })
      }
      return Promise.resolve({ rows: [] })
    })
  }

  function preparedBatch() {
    return {
      userOperation: { nonce: 1n, sender: TREASURY },
      userOpHash: `0x${'ef'.repeat(32)}`,
      signingTypedData: { domain: { name: 'HybridDeleGator' }, types: {}, primaryType: 'PackedUserOperation', message: {} },
      treasuryAddress: TREASURY,
    }
  }

  it('404s a foreign agent and 409s a non-delegation-rail agent', async () => {
    mockBatchDb({ agent: null })
    const foreign = await app.inject({ method: 'POST', url: `/agents/${AGENT_ID}/delegations/revoke-all` })
    expect(foreign.statusCode).toBe(404)

    mockBatchDb({ agent: agentRow({ account_type: null }) })
    const legacy = await app.inject({ method: 'POST', url: `/agents/${AGENT_ID}/delegations/revoke-all` })
    expect(legacy.statusCode).toBe(409)
    expect(legacy.json().error).toContain('AllowanceModule')
  })

  it('409s Nothing to revoke — no empty UserOp ever reaches the bundler', async () => {
    mockBatchDb({ targets: [] })
    const res = await app.inject({ method: 'POST', url: `/agents/${AGENT_ID}/delegations/revoke-all` })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('Nothing to revoke')
    expect(mockTreasury).not.toHaveBeenCalled()
  })

  it('prepares ONE batched UserOp for an EOA owner and lists every hash it will kill', async () => {
    mockBatchDb({})
    const prepareCalls = vi.fn().mockResolvedValue(preparedBatch())
    mockTreasury.mockResolvedValue({ treasuryAddress: TREASURY, prepareCalls, submitCall: vi.fn() })

    const res = await app.inject({ method: 'POST', url: `/agents/${AGENT_ID}/delegations/revoke-all` })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.signature_scheme).toBe('eip712_userop')
    expect(body.delegation_hashes).toEqual([HASH, HASH2])
    expect(body.signing_payload.primaryType).toBe('PackedUserOperation')
    // ONE prepare with BOTH disableDelegation calls in it — and they are the
    // two DISTINCT delegations (different salts → different calldata), not a
    // duplicate of one; both target the pinned DelegationManager.
    expect(prepareCalls).toHaveBeenCalledTimes(1)
    const calls = prepareCalls.mock.calls[0][0]
    expect(calls).toHaveLength(2)
    expect(calls[0].data).not.toBe(calls[1].data)
    expect(calls[0].to).toBe(calls[1].to)
    // Custody rule (#824 §3): the signed delegation JSON never leaves the
    // backend. HASH2 legitimately shows up in delegation_hashes (64 cd:s) —
    // the needle is the stored delegation SIGNATURE (130 cd:s), so probe for
    // a run longer than any hash, and for the json key itself.
    expect(JSON.stringify(body)).not.toContain('cd'.repeat(50))
    expect(JSON.stringify(body)).not.toContain('delegation_json')
    expectMatchesSpec('POST', '/agents/{id}/delegations/revoke-all', body)
    // Nothing marked revoked at prepare time:
    expect(mockQuery.mock.calls.some((c) => /SET status = 'revoked'/.test(String(c[0])))).toBe(false)
  })

  it('prepares via the account passkey for pure-passkey accounts (webauthn_userop)', async () => {
    mockBatchDb({ owner: null, passkeys: [{ key_id: 'abc', public_key_x: '1', public_key_y: '2' }] })
    const prepareCalls = vi.fn().mockResolvedValue(preparedBatch())
    mockTreasury.mockResolvedValue({ treasuryAddress: TREASURY, prepareCalls, submitCall: vi.fn() })

    const res = await app.inject({ method: 'POST', url: `/agents/${AGENT_ID}/delegations/revoke-all` })
    expect(res.statusCode).toBe(200)
    expect(res.json().signature_scheme).toBe('webauthn_userop')
    expect(res.json().user_op_hash).toBe(`0x${'ef'.repeat(32)}`)
    // The webauthn branch of the documented oneOf (#1446).
    expectMatchesSpec('POST', '/agents/{id}/delegations/revoke-all', res.json())
    expect(mockTreasury.mock.calls[0][0]).toMatchObject({ signWith: 'passkey' })
  })

  // #1423: disableDelegation REVERTS on an already-disabled delegation
  // (AlreadyDisabled), and the batch is atomic — so a crash-window orphan
  // (disabled on-chain, row still active) must be healed and dropped at
  // prepare, never bundled into a guaranteed revert.
  it('heals a crash-window orphan: marks it revoked, drops it from the batch (#1423)', async () => {
    mockBatchDb({})
    mockReadDisabled.mockResolvedValue(new Set([HASH]))
    const prepareCalls = vi.fn().mockResolvedValue(preparedBatch())
    mockTreasury.mockResolvedValue({ treasuryAddress: TREASURY, prepareCalls, submitCall: vi.fn() })

    const res = await app.inject({ method: 'POST', url: `/agents/${AGENT_ID}/delegations/revoke-all` })
    expect(res.statusCode).toBe(200)
    // Only the still-live delegation is in the signed batch:
    expect(res.json().delegation_hashes).toEqual([HASH2])
    expect(prepareCalls.mock.calls[0][0]).toHaveLength(1)
    // The orphan's row was reconciled to revoked — with exactly that hash:
    const heal = mockQuery.mock.calls.find((c) => /SET status = 'revoked'/.test(String(c[0])))
    expect(heal).toBeDefined()
    expect(heal![1]).toEqual([AGENT_ID, [HASH]])
  })

  it('409s when EVERYTHING was already disabled on-chain — after healing the rows (#1423)', async () => {
    mockBatchDb({})
    mockReadDisabled.mockResolvedValue(new Set([HASH, HASH2]))

    const res = await app.inject({ method: 'POST', url: `/agents/${AGENT_ID}/delegations/revoke-all` })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('Nothing to revoke')
    // Healed BEFORE refusing, so the retry-flow's "step already done" signal
    // is backed by consistent records:
    expect(mockQuery.mock.calls.some((c) => /SET status = 'revoked'/.test(String(c[0])))).toBe(true)
    expect(mockTreasury).not.toHaveBeenCalled()
  })

  it('a failed disabled-read degrades to the full batch — revocation is never blocked by RPC (#1423)', async () => {
    mockBatchDb({})
    mockReadDisabled.mockRejectedValue(new Error('rpc flap'))
    const prepareCalls = vi.fn().mockResolvedValue(preparedBatch())
    mockTreasury.mockResolvedValue({ treasuryAddress: TREASURY, prepareCalls, submitCall: vi.fn() })

    const res = await app.inject({ method: 'POST', url: `/agents/${AGENT_ID}/delegations/revoke-all` })
    expect(res.statusCode).toBe(200)
    expect(res.json().delegation_hashes).toEqual([HASH, HASH2])
    expect(mockQuery.mock.calls.some((c) => /SET status = 'revoked'/.test(String(c[0])))).toBe(false)
  })

  it('422s past the batch cap with per-hash guidance — never a doomed mega-UserOp (#1423)', async () => {
    const many = Array.from({ length: 26 }, (_, i) => ({
      delegation_hash: `0x${i.toString(16).padStart(2, '0').repeat(32)}`,
      delegation_json: storedJsonWithSalt(String(i)),
      status: 'active',
    }))
    mockBatchDb({ targets: many })

    const res = await app.inject({ method: 'POST', url: `/agents/${AGENT_ID}/delegations/revoke-all` })
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toContain('Revoke individually')
    expect(mockTreasury).not.toHaveBeenCalled()
  })

  it('past the coarse ceiling it refuses BEFORE spending any RPC reads (#1423 review)', async () => {
    const many = Array.from({ length: 101 }, (_, i) => ({
      delegation_hash: `0x${(i % 251).toString(16).padStart(2, '0').repeat(32)}`,
      delegation_json: storedJsonWithSalt(String(i)),
      status: 'active',
    }))
    mockBatchDb({ targets: many })

    const res = await app.inject({ method: 'POST', url: `/agents/${AGENT_ID}/delegations/revoke-all` })
    expect(res.statusCode).toBe(422)
    expect(mockReadDisabled).not.toHaveBeenCalled()
    expect(mockTreasury).not.toHaveBeenCalled()
  })

  it('submit marks exactly the batch revoked ONLY after the UserOp lands', async () => {
    mockBatchDb({})
    const submitCall = vi.fn().mockResolvedValue({ txHash: `0x${'11'.repeat(32)}` })
    mockTreasury.mockResolvedValue({ treasuryAddress: TREASURY, prepareCalls: vi.fn(), submitCall })

    const res = await app.inject({
      method: 'POST', url: `/agents/${AGENT_ID}/delegations/revoke-all/submit`,
      payload: {
        signature: '0x' + 'ab'.repeat(65),
        user_operation: { nonce: '1n', sender: TREASURY },
        delegation_hashes: [HASH, HASH2],
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ revoked: true, tx_hash: `0x${'11'.repeat(32)}`, delegation_hashes: [HASH, HASH2] })
    expectMatchesSpec('POST', '/agents/{id}/delegations/revoke-all/submit', res.json())
    const update = mockQuery.mock.calls.find((c) => /SET status = 'revoked'/.test(String(c[0])))!
    expect(update).toBeDefined()
    // Batch statement, agent-scoped: ANY($2) with this agent's id first.
    expect(String(update[0])).toContain('ANY($2)')
    expect(update[1]).toEqual([AGENT_ID, [HASH, HASH2]])
  })

  it('a failed submit leaves every row untouched and never leaks the bundler credential', async () => {
    mockBatchDb({})
    const submitCall = vi.fn().mockRejectedValue(new Error('bundler https://bundler.example/x?apikey=SECRET exploded'))
    mockTreasury.mockResolvedValue({ treasuryAddress: TREASURY, prepareCalls: vi.fn(), submitCall })

    const res = await app.inject({
      method: 'POST', url: `/agents/${AGENT_ID}/delegations/revoke-all/submit`,
      payload: {
        signature: '0x' + 'ab'.repeat(65),
        user_operation: { nonce: '1n', sender: TREASURY },
        delegation_hashes: [HASH],
      },
    })
    expect(res.statusCode).toBe(502)
    expect(JSON.stringify(res.json())).not.toContain('SECRET')
    expect(mockQuery.mock.calls.some((c) => /SET status = 'revoked'/.test(String(c[0])))).toBe(false)
  })

  it('submit 400s on malformed signature, missing user_operation, and bad hashes', async () => {
    mockBatchDb({})
    const cases = [
      { signature: '0xzz', user_operation: {}, delegation_hashes: [HASH] },
      { signature: '0x' + 'ab'.repeat(65), delegation_hashes: [HASH] },
      { signature: '0x' + 'ab'.repeat(65), user_operation: {}, delegation_hashes: [] },
      { signature: '0x' + 'ab'.repeat(65), user_operation: {}, delegation_hashes: ['nope'] },
    ]
    for (const payload of cases) {
      const res = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/delegations/revoke-all/submit`, payload,
      })
      expect(res.statusCode).toBe(400)
    }
  })
})
