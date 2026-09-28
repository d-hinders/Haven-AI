/**
 * #3386 — a re-key's issue step must carry the old delegation's
 * `merchant_id` onto every replacement piece (carry, steady, reanchor). A
 * label only: no caveat, recipient, amount, period or authority changes.
 *
 * ## Why this file exists at the ROUTE level
 *
 * The label is resolved UNCONDITIONALLY by a by-hash read of the old row
 * (`findDelegationTerms`) — the snapshot never carries `merchant_id` for new
 * re-keys, and even where an old persisted snapshot still has the field this
 * route no longer trusts it, because only the old row's live FK (kept
 * current under `ON DELETE SET NULL`) can say whether the merchant still
 * exists at issue time. `infra/repositories/__tests__/agent-rekeys.test.ts`
 * proves the DATA layer: `findDelegationTerms` reads `merchant_id`,
 * `insertRekeyDelegation` writes it through a merchant-existence subselect,
 * and a merchant deleted between metering and issue still lets issuance
 * succeed with `merchant_id: null`. It cannot prove the ROUTE reads once per
 * entry, only when a piece is built, and never for an entry that produces
 * none — that is route-level wiring, proven here the same way #1849's
 * issue-clock file proves the route reads `metered_at` — by mocking the
 * repository layer and asserting what the route hands to
 * `insertRekeyDelegation`.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const {
  mockFindOwnedRekeyAgent,
  mockFindRekey,
  mockNextVersion,
  mockInsertRekeyDelegation,
  mockFindDelegationTerms,
  mockMarkIssued,
  mockComputeAddress,
} = vi.hoisted(() => ({
  mockFindOwnedRekeyAgent: vi.fn(),
  mockFindRekey: vi.fn(),
  mockNextVersion: vi.fn(),
  mockInsertRekeyDelegation: vi.fn(),
  mockFindDelegationTerms: vi.fn(),
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
    findDelegationTerms: (...a: unknown[]) => mockFindDelegationTerms(...a),
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
const MERCHANT_ID = '33333333-3333-3333-3333-333333333333'

const DAY = 86_400
const START = 1_800_000_000
const BUDGET = 100_000_000n
const REMAINING = 40_000_000n

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

/** One metered snapshot entry, still within the same period as `now`. */
function snapshotEntry(overrides: Record<string, unknown> = {}) {
  return {
    delegation_hash: HASH,
    token_address: USDC,
    recipient_address: '0x' + 'c0'.repeat(20),
    budget_atomic: BUDGET.toString(),
    period_seconds: DAY,
    start_date: START,
    expires_at: START + 365 * DAY,
    remaining_atomic: REMAINING.toString(),
    from_chain: true,
    ...overrides,
  }
}

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
    carry_snapshot: [snapshotEntry()],
    metered_at: new Date(START * 1000).toISOString(),
    revoke_tx_hash: '0x' + '11'.repeat(32),
    revoked_at: new Date(START * 1000).toISOString(),
    completed_at: null,
    ...overrides,
  }
}

describe('#3386 re-key issue — the merchant label carries onto every replacement piece', () => {
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
    mockInsertRekeyDelegation.mockResolvedValue(true)
    mockMarkIssued.mockResolvedValue({ stage: 'issued' })
    mockComputeAddress.mockResolvedValue(DELEGATE_ACCOUNT)
  })

  /** Issues 10 minutes after metering — same period, the ordinary case. */
  async function issue(entry: Record<string, unknown> = {}) {
    mockFindRekey.mockResolvedValue(rekeyRow({ carry_snapshot: [snapshotEntry(entry)] }))
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime((START + 600) * 1000)
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/agents/${AGENT_ID}/rekey/${REKEY_ID}/issue`,
        payload: {},
      })
      return { status: res.statusCode, body: res.json() as { delegations: Array<{ carry_role: string }> } }
    } finally {
      vi.useRealTimers()
    }
  }

  it('carries the by-hash-read merchant_id onto BOTH the carry and steady pieces', async () => {
    mockFindDelegationTerms.mockResolvedValue({
      token_address: USDC,
      recipient_address: '0x' + 'c0'.repeat(20),
      budget_atomic: BUDGET.toString(),
      period_seconds: DAY,
      start_date: String(START),
      expires_at: String(START + 365 * DAY),
      merchant_id: MERCHANT_ID,
    })
    const { status, body } = await issue()
    expect(status).toBe(201)
    expect(body.delegations.map((d) => d.carry_role)).toEqual(['carry', 'steady'])

    // Read once per entry that produced a piece to insert, scoped by agent
    // and the OLD delegation's hash — not the new replacement's.
    expect(mockFindDelegationTerms).toHaveBeenCalledTimes(1)
    expect(mockFindDelegationTerms).toHaveBeenCalledWith(AGENT_ID, HASH)
    expect(mockInsertRekeyDelegation).toHaveBeenCalledTimes(2)
    for (const call of mockInsertRekeyDelegation.mock.calls) {
      expect((call[0] as { merchantId: string | null }).merchantId).toBe(MERCHANT_ID)
    }
  })

  it('MUTATION TARGET — writes merchantId: null when the by-hash read reports no merchant', async () => {
    mockFindDelegationTerms.mockResolvedValue({
      token_address: USDC,
      recipient_address: '0x' + 'c0'.repeat(20),
      budget_atomic: BUDGET.toString(),
      period_seconds: DAY,
      start_date: String(START),
      expires_at: String(START + 365 * DAY),
      merchant_id: null,
    })
    const { status } = await issue()
    expect(status).toBe(201)
    expect(mockInsertRekeyDelegation).toHaveBeenCalled()
    for (const call of mockInsertRekeyDelegation.mock.calls) {
      expect((call[0] as { merchantId: string | null }).merchantId).toBeNull()
    }
  })

  it('MUTATION TARGET — a merchant_id lingering on the persisted snapshot is IGNORED; only the by-hash read is trusted', async () => {
    // Even where an old `carry_snapshot` still carries a `merchant_id` field
    // (persisted before the write was removed, or inherited wholesale
    // through `adoptAbandonedCarry`), the route must not read it — only the
    // live state of the old row, by hash, decides the label now.
    mockFindDelegationTerms.mockResolvedValue({
      token_address: USDC,
      recipient_address: '0x' + 'c0'.repeat(20),
      budget_atomic: BUDGET.toString(),
      period_seconds: DAY,
      start_date: String(START),
      expires_at: String(START + 365 * DAY),
      merchant_id: MERCHANT_ID,
    })
    // The stale snapshot value is a DIFFERENT id — proving it is not the
    // source used.
    const { status } = await issue({ merchant_id: '99999999-9999-9999-9999-999999999999' })
    expect(status).toBe(201)
    for (const call of mockInsertRekeyDelegation.mock.calls) {
      expect((call[0] as { merchantId: string | null }).merchantId).toBe(MERCHANT_ID)
    }
  })

  it('never queries the by-hash read, and inserts nothing, for an entry that produces no piece (expired)', async () => {
    // Metered AFTER expiry — `planCarry` reports `kind: 'expired'`, so no
    // piece is built and the merchant_id resolution (the by-hash read) must
    // never run for this entry.
    const stale = snapshotEntry({ start_date: START - 2 * DAY, expires_at: START - DAY })
    mockFindRekey.mockResolvedValue(
      rekeyRow({ carry_snapshot: [stale], metered_at: new Date((START - DAY / 2) * 1000).toISOString() }),
    )

    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime((START + 600) * 1000)
    let res
    try {
      res = await app.inject({
        method: 'POST',
        url: `/agents/${AGENT_ID}/rekey/${REKEY_ID}/issue`,
        payload: {},
      })
    } finally {
      vi.useRealTimers()
    }
    expect(res.statusCode).toBe(201)
    expect(res.json().delegations).toEqual([])
    expect(mockFindDelegationTerms).not.toHaveBeenCalled()
    expect(mockInsertRekeyDelegation).not.toHaveBeenCalled()
  })
})
