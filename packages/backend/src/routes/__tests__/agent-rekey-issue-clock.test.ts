/**
 * #1849 — the carry must be planned against the clock the remainder was
 * MEASURED on, not the clock the owner happened to finish signing on.
 *
 * ## Why this file exists at the ROUTE level
 *
 * `modules/agents/__tests__/rekey-carry.test.ts` proves `planCarry` does the
 * right arithmetic when it is TOLD both clocks. It cannot prove the route
 * tells it both, and the route is exactly where #1849 lived: `planCarry` was
 * called with the issue-time clock for a remainder frozen at revoke time.
 * A unit test of the planner passes cleanly against that defect — the
 * planner was never wrong, the caller was. So the caller gets its own test.
 *
 * ## Why this is money-path characterization (money.md §2)
 *
 * The delegations this route builds ARE the agent's replacement spend
 * authority. The first describe block therefore pins the behaviour that must
 * NOT move — the same-period path, where #1849 changes nothing — so the fix
 * shows up as a diff in the SECOND block rather than as an unexplained new
 * green test.
 *
 * ## The assertion that actually catches the defect
 *
 * Not "the route passes meteredAtSec" — that is a spy on an implementation
 * detail, and `tsc` already catches a missing argument. What it asserts is
 * the OWNER-VISIBLE consequence: after a re-key that crosses a period
 * boundary, the agent holds a grant for the FULL budget, live now. Under the
 * defect it holds a grant for the frozen remainder — at worst zero — for a
 * period it is owed the whole budget in. Those two outcomes differ in
 * `budget_atomic` and in the count of built delegations, which is what the
 * assertions below read.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const {
  mockFindOwnedRekeyAgent,
  mockFindRekey,
  mockNextVersion,
  mockInsertRekeyDelegation,
  mockMarkIssued,
  mockComputeAddress,
} = vi.hoisted(() => ({
  mockFindOwnedRekeyAgent: vi.fn(),
  mockFindRekey: vi.fn(),
  mockNextVersion: vi.fn(),
  mockInsertRekeyDelegation: vi.fn(),
  mockMarkIssued: vi.fn(),
  mockComputeAddress: vi.fn(),
}))

// The pool is deliberately not stubbed — every query is behind a repository
// module, mocked by name. Data-layer behaviour is proven on the real-Postgres
// harness (`infra/repositories/__tests__/agent-rekeys.test.ts`), not here.
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
    nextDelegationVersion: (...a: unknown[]) => mockNextVersion(...a),
    insertRekeyDelegation: (...a: unknown[]) => mockInsertRekeyDelegation(...a),
    markIssued: (...a: unknown[]) => mockMarkIssued(...a),
  }
})
vi.mock('../../rails/hybrid-provisioning.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rails/hybrid-provisioning.js')>()
  return {
    ...actual,
    computeHybridAccountAddress: (...a: unknown[]) => mockComputeAddress(...a),
  }
})

const agentRekeyRoutes = (await import('../agent-rekey.js')).default

const AGENT_ID = '11111111-1111-1111-1111-111111111111'
const REKEY_ID = '22222222-2222-2222-2222-222222222222'
const CHAIN_ID = 84532
const TREASURY = '0x' + 'aa'.repeat(20)
const DELEGATE_ACCOUNT = ('0x' + 'dd'.repeat(20)) as `0x${string}`
const HASH = '0x' + 'ab'.repeat(32)
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'

const DAY = 86_400
/** Period 0 opens here. Fixed so every expectation below is arithmetic, not a clock read. */
const START = 1_800_000_000
const BUDGET = 100_000_000n // 100 USDC
const REMAINING = 1_000_000n // 1 USDC left when the meter was read

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

/** A re-key parked at `metered`, carrying one snapshot entry. */
function rekeyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REKEY_ID,
    agent_id: AGENT_ID,
    initiated_by_user_id: 'user-1',
    stage: 'metered',
    old_delegate_address: '0x' + 'bb'.repeat(20),
    new_delegate_address: '0x' + 'cc'.repeat(20),
    residual_atomic: '0',
    residual_token_address: null,
    residual_disposition: 'none',
    carry_snapshot: [
      {
        delegation_hash: HASH,
        token_address: USDC,
        recipient_address: null,
        budget_atomic: BUDGET.toString(),
        period_seconds: DAY,
        start_date: START,
        expires_at: START + 365 * DAY,
        remaining_atomic: REMAINING.toString(),
        from_chain: true,
      },
    ],
    metered_at: null,
    revoke_tx_hash: '0x' + '11'.repeat(32),
    revoked_at: new Date(START * 1000).toISOString(),
    completed_at: null,
    ...overrides,
  }
}

type Built = {
  carry_role: string
  budget_atomic: string
  start_date: number
  expires_at: number
}
type IssueBody = {
  delegations: Built[]
  skipped: Array<{ delegation_hash: string; reason: string }>
}

describe('#1849 re-key issue — the carry is planned on the metering clock', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(agentRekeyRoutes, { prefix: '/agents' })
    await app.ready()
  })
  afterAll(async () => {
    await app.close()
    vi.useRealTimers()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mockFindOwnedRekeyAgent.mockResolvedValue(agentRow())
    mockNextVersion.mockResolvedValue(2)
    mockInsertRekeyDelegation.mockResolvedValue(undefined)
    mockMarkIssued.mockResolvedValue({ stage: 'issued' })
    mockComputeAddress.mockResolvedValue(DELEGATE_ACCOUNT)
  })

  /**
   * Runs the issue leg with the meter read at `meteredAt` and the owner
   * finishing at `now`. Both are absolute seconds so the gap is explicit at
   * every call site rather than hidden in a helper.
   */
  async function issueAt(meteredAt: number, now: number) {
    mockFindRekey.mockResolvedValue(rekeyRow({ metered_at: new Date(meteredAt * 1000).toISOString() }))
    // ONLY `Date` is faked. Faking the whole timer set stops Fastify's
    // `inject` from ever completing — the request sits on a `setImmediate`
    // that nothing advances, and every test in the file times out.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(now * 1000)
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/agents/${AGENT_ID}/rekey/${REKEY_ID}/issue`,
        payload: {},
      })
      return { status: res.statusCode, body: res.json() as IssueBody }
    } finally {
      vi.useRealTimers()
    }
  }

  // ── Characterization: the same-period path #1849 must not move ──────────

  describe('characterization — no boundary crossed', () => {
    it('still issues the paired carry+steady against the period both clocks share', async () => {
      // Metered 1h into period 0, issued 10 minutes later — still period 0.
      const { status, body } = await issueAt(START + 3600, START + 4200)
      expect(status).toBe(201)

      const roles = body.delegations.map((d) => d.carry_role)
      expect(roles).toEqual(['carry', 'steady'])

      const carry = body.delegations[0]
      expect(BigInt(carry.budget_atomic)).toBe(REMAINING)
      expect(carry.expires_at).toBe(START + DAY) // the period-0 boundary

      const steady = body.delegations[1]
      expect(BigInt(steady.budget_atomic)).toBe(BUDGET)
      expect(steady.start_date).toBe(START + DAY) // resumes exactly where the carry dies
      expect(body.skipped).toEqual([])
    })
  })

  // ── The defect ──────────────────────────────────────────────────────────

  describe('the owner finished signing in the NEXT period', () => {
    it('leaves the agent on the FULL budget, live now — not on the stale remainder', async () => {
      // Metered near the end of period 0; the owner finished 2h into period 1.
      const { status, body } = await issueAt(START + DAY - 600, START + DAY + 7200)
      expect(status).toBe(201)

      // The carry was for period 0, which has ended. It is not offered for
      // signature: an expired delegation is a signing prompt for nothing.
      expect(body.delegations.map((d) => d.carry_role)).toEqual(['steady'])

      const steady = body.delegations[0]
      expect(BigInt(steady.budget_atomic)).toBe(BUDGET)
      expect(steady.start_date).toBe(START + DAY)
      // Live NOW is the whole point — a grant that starts in the future would
      // leave the agent unable to spend during the period it is owed.
      expect(steady.start_date).toBeLessThanOrEqual(START + DAY + 7200)

      // Under the defect the boundary came from the issue clock, so the carry
      // would have been the 1 USDC remainder running to the END of period 1 —
      // a 1 USDC allowance for a period worth 100. Assert the absence of any
      // such grant directly rather than trusting the role list alone.
      expect(body.delegations.some((d) => BigInt(d.budget_atomic) < BUDGET)).toBe(false)
    })

    it('tells the owner the carry was dropped, and why', async () => {
      const { body } = await issueAt(START + DAY - 600, START + DAY + 7200)
      // Silence here is the failure mode that matters: an owner who sees one
      // grant where the docs promise two, with no explanation, concludes the
      // re-key broke their agent.
      expect(body.skipped).toHaveLength(1)
      expect(body.skipped[0].delegation_hash).toBe(HASH)
      // Naming the instant is the part that helps: "a grant was dropped"
      // is not actionable, "the period-0 window closed at <t>" is.
      expect(body.skipped[0].reason).toContain(new Date((START + DAY) * 1000).toISOString())
      expect(body.skipped[0].reason).toMatch(/not issued/i)
    })

    it('persists only what it hands back — no dropped grant reaches the database', async () => {
      // A row written for a grant that is never signed is a pending
      // delegation that can never activate: `complete` would wait on a
      // signature the client was never asked for.
      await issueAt(START + DAY - 600, START + DAY + 7200)
      expect(mockInsertRekeyDelegation).toHaveBeenCalledTimes(1)
      expect(mockInsertRekeyDelegation.mock.calls[0][0]).toMatchObject({
        carryRole: 'steady',
        budgetAtomic: BUDGET.toString(),
      })
    })
  })

  // ── The guard on the clock itself ───────────────────────────────────────

  it('refuses to issue against a re-key with no metering timestamp', async () => {
    // Defaulting to `now` here would silently restore #1849 for exactly the
    // rows that lost the measurement, so the route refuses instead.
    mockFindRekey.mockResolvedValue(rekeyRow({ metered_at: null }))
    const res = await app.inject({
      method: 'POST',
      url: `/agents/${AGENT_ID}/rekey/${REKEY_ID}/issue`,
      payload: {},
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('rekey_out_of_order')
    expect(mockInsertRekeyDelegation).not.toHaveBeenCalled()
    expect(mockMarkIssued).not.toHaveBeenCalled()
  })
})
