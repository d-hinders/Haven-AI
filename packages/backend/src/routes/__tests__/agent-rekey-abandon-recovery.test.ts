/**
 * #1868 — abandoning a re-key after the revoke must not cost the agent its
 * authority, and the in-flight 409 must name the key it is bound to.
 *
 * ## The wedge, as the route reaches it
 *
 * A re-key that got past the revoke has already retired the agent's
 * delegations ON-CHAIN. Abandoning that re-key frees the one-in-flight slot,
 * but a fresh re-key then finds nothing to revoke
 * (`listNonRevokedDelegationsForAgent` is empty) and — before this fix —
 * walked to `metered` with an EMPTY carry snapshot, so the issue step built
 * nothing. The abandoned row's frozen measurement was sitting right there,
 * taken AFTER the on-chain revoke per the #1694 ordering, and nothing read
 * it. Recovery was a manual owner re-grant, which also cannot restore the
 * period boundary the carry exists to preserve.
 *
 * ## Why this file exists at the ROUTE level
 *
 * The adoption itself — which abandoned row qualifies, the no-later-grants
 * guard, the timestamp inheritance — is Postgres behaviour and is proven on
 * the real-DB harness (`infra/repositories/__tests__/agent-rekeys.test.ts`).
 * What that harness cannot prove is that the route CONSULTS it: the wedge was
 * never a missing query, it was a branch that walked straight past the frozen
 * carry. So the assertions here are on the owner-visible response: after an
 * abandoned post-revoke re-key, the fresh re-key's revoke step hands back the
 * inherited measurement, not an empty one.
 *
 * ## The abandonment signal (stated once, tested here and in the repo suite)
 *
 * Adoption keys on `stage = 'abandoned'` — the owner's explicit abandon call
 * — never on elapsed time. A merely slow re-key is still in flight, still
 * holds the unique in-flight slot, and is therefore structurally invisible to
 * adoption: a fresh re-key cannot even OPEN while it lives. Nothing in this
 * change acts without the owner asking, which is why it cannot fail open on a
 * live re-key.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { expectMatchesSpec } from '../../openapi/response-shape.js'

const {
  mockFindOwnedRekeyAgent,
  mockFindRekey,
  mockFindInFlightRekey,
  mockFindLiveAgentByDelegate,
  mockListNonRevoked,
  mockAdoptAbandonedCarry,
  mockMarkRevoked,
  mockMarkMetered,
  mockOpenRekey,
  mockGetTokenBalance,
} = vi.hoisted(() => ({
  mockFindOwnedRekeyAgent: vi.fn(),
  mockFindRekey: vi.fn(),
  mockFindInFlightRekey: vi.fn(),
  mockFindLiveAgentByDelegate: vi.fn(),
  mockListNonRevoked: vi.fn(),
  mockAdoptAbandonedCarry: vi.fn(),
  mockMarkRevoked: vi.fn(),
  mockMarkMetered: vi.fn(),
  mockOpenRekey: vi.fn(),
  mockGetTokenBalance: vi.fn(),
}))

// The pool is deliberately not stubbed — every query is behind a repository
// module, mocked by name. Data-layer behaviour (which abandoned row
// qualifies, the guard, the timestamp copy) is proven on the real-Postgres
// harness, not here (#1219).
vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: async (request: { user?: unknown }) => {
    request.user = { sub: 'user-1' }
  },
}))
vi.mock('../../infra/repositories/delegation-budgets.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../infra/repositories/delegation-budgets.js')
  >()
  return {
    ...actual,
    listNonRevokedDelegationsForAgent: (...a: unknown[]) => mockListNonRevoked(...a),
  }
})
// `markRevoked`/`markMetered` are mocked because the no-authority
// short-circuit advances stages through them. In the adoption case neither
// may run — the inherited row is already `metered`, and stamping a fresh
// `metered_at` over the inherited one is exactly the #1849 defect coming
// back through a side door.
vi.mock('../../infra/repositories/agent-rekeys.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../infra/repositories/agent-rekeys.js')>()
  return {
    ...actual,
    findOwnedRekeyAgent: (...a: unknown[]) => mockFindOwnedRekeyAgent(...a),
    findRekey: (...a: unknown[]) => mockFindRekey(...a),
    findInFlightRekey: (...a: unknown[]) => mockFindInFlightRekey(...a),
    findLiveAgentByDelegate: (...a: unknown[]) => mockFindLiveAgentByDelegate(...a),
    adoptAbandonedCarry: (...a: unknown[]) => mockAdoptAbandonedCarry(...a),
    markRevoked: (...a: unknown[]) => mockMarkRevoked(...a),
    markMetered: (...a: unknown[]) => mockMarkMetered(...a),
    // Only the concurrent-open race pin below reaches openRekey; it must
    // reject with the REAL one-in-flight constraint error — a shape no other
    // test here exercises (the in-flight 409s above are reached with no
    // constraint-bearing error, which is why they could not catch F1).
    openRekey: (...a: unknown[]) => mockOpenRekey(...a),
  }
})
vi.mock('../../infra/chain/relayer-reads.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../infra/chain/relayer-reads.js')>()
  return {
    ...actual,
    getTokenBalance: (...a: unknown[]) => mockGetTokenBalance(...a),
  }
})

const agentRekeyRoutes = (await import('../agent-rekey.js')).default

const AGENT_ID = '11111111-1111-1111-1111-111111111111'
const REKEY_ID = '22222222-2222-2222-2222-222222222222'
const PRIOR_REKEY_ID = '33333333-3333-3333-3333-333333333333'
const CHAIN_ID = 84532
const TREASURY = '0x' + 'aa'.repeat(20)
const OLD_DELEGATE = '0x' + 'bb'.repeat(20)
const NEW_DELEGATE = '0x' + 'cc'.repeat(20)
const HASH = '0x' + 'ab'.repeat(32)
const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const REVOKE_TX = '0x' + 'fe'.repeat(32)

function agentRow(overrides: Record<string, unknown> = {}) {
  return {
    agent_id: AGENT_ID,
    delegate_address: OLD_DELEGATE,
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
    old_delegate_address: OLD_DELEGATE,
    new_delegate_address: NEW_DELEGATE,
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

/** The frozen measurement the abandoned predecessor took after ITS revoke. */
function inheritedSnapshot() {
  return [
    {
      delegation_hash: HASH,
      token_address: USDC,
      recipient_address: null,
      budget_atomic: '1000000',
      period_seconds: 86_400,
      start_date: 1_760_000_000,
      expires_at: 1_760_000_000 + 90 * 86_400,
      remaining_atomic: '400000',
      from_chain: true,
    },
  ]
}

/** What `adoptAbandonedCarry` returns once the fresh row has inherited. */
function adoptedRow() {
  return rekeyRow({
    stage: 'metered',
    carry_snapshot: inheritedSnapshot(),
    metered_at: '2026-08-20T10:00:05.000Z',
    revoked_at: '2026-08-20T10:00:00.000Z',
    revoke_tx_hash: REVOKE_TX,
    inherited_from_rekey_id: PRIOR_REKEY_ID,
  })
}

describe('re-key abandon recovery (#1868)', () => {
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
    mockFindInFlightRekey.mockResolvedValue(null)
    mockFindLiveAgentByDelegate.mockResolvedValue(null)
    mockListNonRevoked.mockResolvedValue([])
    mockAdoptAbandonedCarry.mockResolvedValue(null)
    mockGetTokenBalance.mockResolvedValue(0n)
    // A plain (non-constraint) rejection: any test that actually reaches
    // openRekey must have chosen its own error — a bare failure here
    // re-throws and surfaces as a 500, which keeps an unintended openRekey
    // call loud instead of silently green.
    mockOpenRekey.mockRejectedValue(new Error('openRekey reached without a test-specific rejection'))
    // The pre-#1868 empty walk, so the wedge is reproducible as dev behaves.
    mockMarkRevoked.mockImplementation(async () => rekeyRow({ stage: 'revoked' }))
    mockMarkMetered.mockImplementation(async () =>
      rekeyRow({
        stage: 'metered',
        carry_snapshot: [],
        metered_at: '2026-08-25T12:00:00.000Z',
        revoked_at: '2026-08-25T12:00:00.000Z',
        revoke_tx_hash: 'none',
      }),
    )
  })

  const revokePath = `/agents/${AGENT_ID}/rekey/${REKEY_ID}/revoke`

  describe('the wedge (red on the pre-#1868 tree)', () => {
    it('a fresh re-key after an abandoned post-revoke one is handed the frozen carry, not an empty one', async () => {
      mockAdoptAbandonedCarry.mockResolvedValue(adoptedRow())

      const res = await app.inject({ method: 'POST', url: revokePath, payload: {} })

      expect(res.statusCode).toBe(200)
      const body = res.json()
      // The owner-visible consequence: the measurement the abandoned re-key
      // froze after its on-chain revoke is what the fresh re-key carries.
      // Under the wedge this array is [] and the issue step builds nothing.
      expect(body.carry).toEqual([
        { delegation_hash: HASH, remaining_atomic: '400000', from_chain: true },
      ])
      expect(body.stage).toBe('metered')
      expect(body.revoked).toBe(true)
      // The revoke that retired the authority was the PREDECESSOR's — its tx
      // hash is reported, not `null`, because "nothing was revoked" is not
      // what happened to this agent.
      expect(body.tx_hash).toBe(REVOKE_TX)
      expect(body.delegation_hashes).toEqual([HASH])
      expect(body.carry_inherited_from_rekey_id).toBe(PRIOR_REKEY_ID)
      expect(body.agent_has_no_authority).toBe(true)
      expect(body.next_step).toContain('/issue')
      expectMatchesSpec('POST', '/agents/{id}/rekey/{rekeyId}/revoke', body)
    })

    it('the inherited walk never re-stamps the stages — the inherited metered_at is the carry clock (#1849)', async () => {
      mockAdoptAbandonedCarry.mockResolvedValue(adoptedRow())

      const res = await app.inject({ method: 'POST', url: revokePath, payload: {} })

      expect(res.statusCode).toBe(200)
      // Walking markRevoked/markMetered here would overwrite the inherited
      // measurement clock with NOW — the #1849 under-grant re-created.
      expect(mockMarkRevoked).not.toHaveBeenCalled()
      expect(mockMarkMetered).not.toHaveBeenCalled()
    })
  })

  describe('characterization — what must NOT change', () => {
    it('with nothing adoptable, the no-authority short-circuit still walks to metered with an empty carry', async () => {
      const res = await app.inject({ method: 'POST', url: revokePath, payload: {} })

      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.revoked).toBe(true)
      expect(body.tx_hash).toBeNull()
      expect(body.carry).toEqual([])
      expect(body.stage).toBe('metered')
      expect(body.agent_has_no_authority).toBe(true)
      expect(mockMarkRevoked).toHaveBeenCalledTimes(1)
      expect(mockMarkMetered).toHaveBeenCalledTimes(1)
      expectMatchesSpec('POST', '/agents/{id}/rekey/{rekeyId}/revoke', body)
    })

    it('with live delegations to revoke, adoption is never consulted', async () => {
      // Live grants mean the ordinary prepare path runs (and here fails fast
      // on the unmocked owner config — which is fine: the assertion is about
      // what was NOT called, not about the prepare succeeding).
      mockListNonRevoked.mockResolvedValue([{ delegation_hash: HASH, delegation_json: '{}' }])

      await app.inject({ method: 'POST', url: revokePath, payload: {} })

      expect(mockAdoptAbandonedCarry).not.toHaveBeenCalled()
    })
  })

  describe('the in-flight 409 names its key (#1868 follow-up from #1701)', () => {
    it('rekey_already_in_flight carries the new_delegate_address the re-key is bound to', async () => {
      mockFindInFlightRekey.mockResolvedValue(
        rekeyRow({ id: PRIOR_REKEY_ID, stage: 'metered', new_delegate_address: NEW_DELEGATE }),
      )

      const res = await app.inject({
        method: 'POST',
        url: `/agents/${AGENT_ID}/rekey`,
        // A DIFFERENT candidate key — the interrupted owner's second attempt.
        payload: { new_delegate_address: '0x' + 'dd'.repeat(20) },
      })

      expect(res.statusCode).toBe(409)
      const body = res.json()
      expect(body.error).toBe('rekey_already_in_flight')
      expect(body.rekey_id).toBe(PRIOR_REKEY_ID)
      expect(body.stage).toBe('metered')
      // The field this test exists for: without it, a client resuming after
      // an interruption completes the re-key against a key the screen never
      // showed (#1868, comment of 2026-08-22).
      expect(body.new_delegate_address).toBe(NEW_DELEGATE)
    })
  })

  describe('the concurrent-open race lands in the 409 branch, never a 500 (#3032 F1)', () => {
    it('openRekey losing idx_agent_rekeys_one_in_flight answers 409, not the raw-constraint 500', async () => {
      // Route the whole open path to the openRekey call: empty table for the
      // collision check, no pre-existing in-flight row, nothing to sweep on
      // the old delegate — the ONLY way out is openRekey, which rejects with
      // the exact error shape Postgres raises when a second concurrent open
      // loses the partial-index race (migration 065). No existing test in
      // this file exercised a constraint-bearing error, which is why the
      // round-1 narrow regression passed the suite while racing to a 500.
      mockGetTokenBalance.mockResolvedValue(0n)
      mockOpenRekey.mockRejectedValue(
        Object.assign(
          new Error('duplicate key value violates unique constraint "idx_agent_rekeys_one_in_flight"'),
          {
            code: '23505',
            constraint: 'idx_agent_rekeys_one_in_flight',
            detail: 'Key (agent_id)=(11111111-1111-1111-1111-111111111111) already exists.',
          },
        ),
      )

      const res = await app.inject({
        method: 'POST',
        url: `/agents/${AGENT_ID}/rekey`,
        // A fresh candidate address — the second opener in the race.
        payload: { new_delegate_address: '0x' + 'ee'.repeat(20) },
      })

      // Explicitly NOT the 500 envelope: under the round-1 narrow this exact
      // probe answered 500 with the raw constraint error in the body.
      expect(res.statusCode).not.toBe(500)
      expect(res.statusCode).toBe(409)
      const body = res.json()
      expect(['rekey_already_in_flight', 'rekey_unavailable']).toContain(body.error)
      expect(JSON.stringify(body)).not.toContain('23505')
      expect(JSON.stringify(body)).not.toContain('idx_agent_rekeys_one_in_flight')
    })
  })
})
