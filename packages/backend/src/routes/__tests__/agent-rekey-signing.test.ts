/**
 * #1870 — the re-key revoke leg must tell the account WHICH signer will sign,
 * and must tell the client which scheme it resolved.
 *
 * ## Why this file exists as characterization-first (money-path rule)
 *
 * The revoke leg is spend authority: it is the owner signature that kills an
 * agent's on-chain budget. `money.md` §2 therefore requires the existing
 * behaviour to be pinned before it moves. The first describe block does that
 * — it asserts what `agent-rekey.ts` did BEFORE #1870, so the change is
 * visible as a diff in these assertions rather than as an unexplained new
 * green test.
 *
 * ## The assertion that actually catches the defect
 *
 * `createTreasuryOps` estimates gas against a DUMMY SIGNATURE sized for the
 * signer it was told about (`rails/delegation-rail.ts:394`). A WebAuthn
 * signature is several hundred bytes; an EOA signature is 65. So the visible
 * consequence of dropping `signWith` is a `verificationGasLimit` estimated
 * for the wrong signature — not a missing field.
 *
 * The `createTreasuryOps` mock below therefore makes `verificationGasLimit`
 * a FUNCTION OF `cfg.signWith`, exactly as the real dependency does. A route
 * that forgets to pass `signWith` gets the owner-path estimate for both
 * schemes and the gas-limit assertion fires. A test that only asserted the
 * echoed `signature_scheme` field would pass on a route that echoed the field
 * and still prepared the wrong op — which is the failure mode #1870 names.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { expectMatchesSpec } from '../../openapi/response-shape.js'

const {
  mockFindOwnedRekeyAgent,
  mockFindRekey,
  mockListNonRevoked,
  mockLoadOwner,
  mockTreasury,
} = vi.hoisted(() => ({
  mockFindOwnedRekeyAgent: vi.fn(),
  mockFindRekey: vi.fn(),
  mockListNonRevoked: vi.fn(),
  mockLoadOwner: vi.fn(),
  mockTreasury: vi.fn(),
}))

// The connection pool is deliberately NOT stubbed here. This file asserts
// nothing about the database — every query the handler makes is behind a
// repository module, and those are mocked by name below. Stubbing the pool as
// well would grow the `lint:db-mocks` ratchet (#1227) while proving nothing;
// data-layer behaviour is proven on the real-Postgres harness instead.
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
  }
})
vi.mock('../../infra/repositories/delegation-budgets.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../infra/repositories/delegation-budgets.js')
  >()
  return {
    ...actual,
    listNonRevokedDelegationsForAgent: (...a: unknown[]) => mockListNonRevoked(...a),
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

const agentRekeyRoutes = (await import('../agent-rekey.js')).default

const AGENT_ID = '11111111-1111-1111-1111-111111111111'
const REKEY_ID = '22222222-2222-2222-2222-222222222222'
const CHAIN_ID = 84532
const TREASURY = '0x' + 'aa'.repeat(20)
const OWNER = '0x' + 'ee'.repeat(20)
const DELEGATE_ACCOUNT = '0x' + 'dd'.repeat(20)
const HASH = '0x' + 'ab'.repeat(32)

/**
 * The gas figures the mocked treasury reports per signer. Distinct on
 * purpose, and in the real direction: a WebAuthn dummy signature is far
 * larger than an EOA's 65 bytes, so it verifies more expensively.
 */
const OWNER_VERIFICATION_GAS = 120_000n
const PASSKEY_VERIFICATION_GAS = 480_000n

const PASSKEY = {
  keyId: '0x' + '11'.repeat(16),
  x: 1n,
  y: 2n,
}

function agentRow(overrides: Record<string, unknown> = {}) {
  return {
    agent_id: AGENT_ID,
    delegate_address: '0x' + 'bb'.repeat(20),
    chain_id: CHAIN_ID,
    treasury_address: TREASURY,
    account_type: 'delegator_hybrid',
    execution_rail: 'delegation',
    status: 'active',
    ...overrides,
  }
}

function rekeyRow(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  }
}

function delegationRow() {
  return {
    delegation_hash: HASH,
    delegation_json: JSON.stringify({
      delegate: DELEGATE_ACCOUNT,
      delegator: TREASURY,
      authority: `0x${'0'.repeat(64)}`,
      caveats: [],
      salt: '1',
      signature: `0x${'ab'.repeat(65)}`,
    }),
  }
}

/**
 * Owner config shapes. `multiSigner` is the shape #1870 is about — an EOA
 * owner AND enrolled passkeys, where neither the account nor the server can
 * infer which one the device will reach for.
 */
function ownerConfig(kind: 'multiSigner' | 'passkeyOnly' | 'ownerOnly') {
  return {
    config: {
      ownerAddress: kind === 'passkeyOnly' ? undefined : (OWNER as `0x${string}`),
      passkeys: kind === 'ownerOnly' ? [] : [PASSKEY],
    },
    userSafeId: 'safe-1',
    singleSignerWaiverAt: null,
  }
}

/**
 * A treasury whose prepared op depends on the signer it was told about.
 *
 * The `isPasskey` line is copied from the real `createTreasuryOps`
 * (`rails/delegation-rail.ts:394`), INCLUDING its fallback inference, so the
 * characterization block below pins the actual default behaviour rather than
 * a convenient stand-in — and so a route that drops `signWith` gets exactly
 * the op the real dependency would have built for it.
 */
function treasuryFor(cfg: {
  signWith?: 'owner' | 'passkey'
  ownerAddress?: string
  passkeys?: unknown[]
}) {
  const passkeys = cfg.passkeys ?? []
  const isPasskey = cfg.signWith
    ? cfg.signWith === 'passkey'
    : !cfg.ownerAddress && passkeys.length > 0
  return {
    treasuryAddress: TREASURY,
    prepareCall: vi.fn(),
    prepareCalls: vi.fn(async () => ({
      userOperation: {
        sender: TREASURY,
        nonce: 1n,
        verificationGasLimit: isPasskey ? PASSKEY_VERIFICATION_GAS : OWNER_VERIFICATION_GAS,
      },
      userOpHash: ('0x' + (isPasskey ? '99' : '88').repeat(32)) as `0x${string}`,
      signingTypedData: { domain: { name: 'HybridDeleGator' }, message: {} },
      treasuryAddress: TREASURY,
    })),
    submitCall: vi.fn(),
  }
}

describe('#1870 re-key revoke prepare — signing scheme', () => {
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
    mockListNonRevoked.mockResolvedValue([delegationRow()])
    mockLoadOwner.mockResolvedValue(ownerConfig('multiSigner'))
    mockTreasury.mockImplementation(async (cfg: { signWith?: 'owner' | 'passkey' }) =>
      treasuryFor(cfg),
    )
  })

  function prepare(body?: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: `/agents/${AGENT_ID}/rekey/${REKEY_ID}/revoke`,
      payload: body ?? {},
    })
  }

  // ── Characterization: what must NOT move ────────────────────────────────

  describe('characterization — behaviour #1870 must preserve', () => {
    it('an omitted signature_scheme still prepares the OWNER op on an account with an EOA owner', async () => {
      const res = await prepare()
      expect(res.statusCode).toBe(200)
      // Asserted as the prepared op, not as the config field: this is the
      // observable default, and it must be identical before and after #1870.
      expect(res.json().user_operation.verificationGasLimit).toBe(`${OWNER_VERIFICATION_GAS}n`)
      expect(res.json().signing_payload).toBeTruthy()
      expect(res.json().delegation_hashes).toEqual([HASH])
    })

    it('an omitted signature_scheme on a pure-passkey account still prepares the PASSKEY op', async () => {
      mockLoadOwner.mockResolvedValue(ownerConfig('passkeyOnly'))
      const res = await prepare()
      expect(res.statusCode).toBe(200)
      expect(res.json().user_operation.verificationGasLimit).toBe(`${PASSKEY_VERIFICATION_GAS}n`)
    })

    it('an unknown owner config is still a 409 before anything is prepared', async () => {
      mockLoadOwner.mockResolvedValue(null)
      const res = await prepare()
      expect(res.statusCode).toBe(409)
      expect(mockTreasury).not.toHaveBeenCalled()
    })

    it('a treasury failure is still a 502 with the bundler key redacted', async () => {
      mockTreasury.mockRejectedValue(new Error('boom https://bundler.example/x?apikey=SECRET'))
      const res = await prepare()
      expect(res.statusCode).toBe(502)
      expect(JSON.stringify(res.json())).not.toContain('SECRET')
    })
  })

  // ── The fix ─────────────────────────────────────────────────────────────

  describe('the multi-signer account can choose', () => {
    /**
     * THE assertion #1870 asks for, and it is deliberately FIRST and ALONE in
     * its test. Under the pre-fix code every other assertion in this file
     * still passes — including the echoed `signature_scheme` and the OpenAPI
     * conformance check — so if this one shared a test with a cheaper
     * assertion, the cheaper one would abort the test first and this one
     * would never be evaluated. It is the only assertion that fails on the
     * defect that matters.
     */
    it('the SAME account and calls produce a DIFFERENT prepared op per scheme (verificationGasLimit)', async () => {
      const passkey = await prepare({ signature_scheme: 'webauthn_userop' })
      const owner = await prepare({ signature_scheme: 'eip712_userop' })
      expect(passkey.statusCode).toBe(200)
      expect(owner.statusCode).toBe(200)

      expect(passkey.json().user_operation.verificationGasLimit).not.toBe(
        owner.json().user_operation.verificationGasLimit,
      )
      expect(passkey.json().user_operation.verificationGasLimit).toBe(
        `${PASSKEY_VERIFICATION_GAS}n`,
      )
      expect(owner.json().user_operation.verificationGasLimit).toBe(`${OWNER_VERIFICATION_GAS}n`)
    })

    it('passes signWith through to createTreasuryOps — the mechanism behind the gas difference', async () => {
      await prepare({ signature_scheme: 'webauthn_userop' })
      expect(mockTreasury.mock.calls[0][0]).toMatchObject({ signWith: 'passkey' })
      await prepare({ signature_scheme: 'eip712_userop' })
      expect(mockTreasury.mock.calls[1][0]).toMatchObject({ signWith: 'owner' })
    })

    it('reports the resolved scheme and the payload that scheme needs', async () => {
      const passkey = await prepare({ signature_scheme: 'webauthn_userop' })
      expect(passkey.json().signature_scheme).toBe('webauthn_userop')
      expect(passkey.json().user_op_hash).toBeTruthy()
      expect(passkey.json().signing_payload).toBeUndefined()

      const owner = await prepare({ signature_scheme: 'eip712_userop' })
      expect(owner.json().signature_scheme).toBe('eip712_userop')
      expect(owner.json().signing_payload).toBeTruthy()
      expect(owner.json().user_op_hash).toBeUndefined()
    })

    it('both branches match the published contract, not just each other', async () => {
      const path = '/agents/{id}/rekey/{rekeyId}/revoke'
      expectMatchesSpec('POST', path, (await prepare({ signature_scheme: 'webauthn_userop' })).json())
      expectMatchesSpec('POST', path, (await prepare({ signature_scheme: 'eip712_userop' })).json())
      // The default path a client that says nothing still gets.
      expectMatchesSpec('POST', path, (await prepare()).json())
    })

    it('carries delegation_hashes on both branches — the submit step requires them', async () => {
      const passkey = await prepare({ signature_scheme: 'webauthn_userop' })
      expect(passkey.json().delegation_hashes).toEqual([HASH])
      const owner = await prepare({ signature_scheme: 'eip712_userop' })
      expect(owner.json().delegation_hashes).toEqual([HASH])
    })
  })

  describe('a scheme the account cannot sign is refused BEFORE the revoke', () => {
    it('webauthn_userop on an account with no passkeys is 409, and nothing is prepared', async () => {
      mockLoadOwner.mockResolvedValue(ownerConfig('ownerOnly'))
      const res = await prepare({ signature_scheme: 'webauthn_userop' })
      expect(res.statusCode).toBe(409)
      expect(res.json().error).toMatch(/no passkeys/i)
      expect(mockTreasury).not.toHaveBeenCalled()
    })

    it('eip712_userop on a pure-passkey account is 409, and nothing is prepared', async () => {
      mockLoadOwner.mockResolvedValue(ownerConfig('passkeyOnly'))
      const res = await prepare({ signature_scheme: 'eip712_userop' })
      expect(res.statusCode).toBe(409)
      expect(res.json().error).toMatch(/no EOA owner/i)
      expect(mockTreasury).not.toHaveBeenCalled()
    })

    it('an unknown scheme is 409, and nothing is prepared', async () => {
      const res = await prepare({ signature_scheme: 'sign_with_vibes' })
      expect(res.statusCode).toBe(409)
      expect(res.json().error).toMatch(/Unknown signature_scheme/)
      expect(mockTreasury).not.toHaveBeenCalled()
    })
  })

  /**
   * #1868 says a re-key abandoned AFTER the revoke wedges the agent's slot
   * permanently. Every refusal this issue adds is therefore only acceptable
   * if it lands strictly before the revoke is submitted. The prepare handler
   * is that "before" — it holds the re-key at `preflight` and writes nothing,
   * so a refused scheme is a retryable dead end rather than a wedge.
   */
  it('#1868 boundary — a refused scheme leaves the re-key retryable at preflight', async () => {
    mockLoadOwner.mockResolvedValue(ownerConfig('ownerOnly'))
    const refused = await prepare({ signature_scheme: 'webauthn_userop' })
    expect(refused.statusCode).toBe(409)

    // Nothing advanced the stage and nothing was revoked: the same request
    // with a scheme the account CAN sign succeeds against the same row.
    const retry = await prepare({ signature_scheme: 'eip712_userop' })
    expect(retry.statusCode).toBe(200)
    expect(retry.json().signature_scheme).toBe('eip712_userop')
  })
})
