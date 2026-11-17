/**
 * #4817 — the sub-budget close submit's reading of a submit failure.
 *
 * The route already branches on `SubmittedUserOpFailedError` (#3329 review
 * finding N2): a typed error means the disable MAY have landed, so the route
 * checks the chain before re-preparing. This file pins the branch that the
 * change reaches — a lost send answer now arrives as the typed error, so the
 * route answers `closed` (child disabled on-chain) or `502
 * close_outcome_unconfirmed` instead of today's `409 close_needs_reprepare`.
 *
 * The first case is the characterization: an ordinary error still 409s. The
 * chain-touching collaborators are stubbed; the route's own branching runs
 * real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { AGENT, mockFindForDelegatingAgent, mockMarkClosed, mockSubmitClose, mockDisabled } = vi.hoisted(() => ({
  AGENT: {
    id: '11111111-1111-1111-1111-111111111111',
    user_id: '22222222-2222-2222-2222-222222222222',
    delegate_address: `0x${'11'.repeat(20)}`,
    account_address: `0x${'aa'.repeat(20)}`,
    chain_id: 8453,
    status: 'active',
    account_type: 'delegator_hybrid',
  },
  mockFindForDelegatingAgent: vi.fn(),
  mockMarkClosed: vi.fn(),
  mockSubmitClose: vi.fn(),
  mockDisabled: vi.fn(),
}))

vi.mock('../../middleware/agentAuth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/agentAuth.js')>()
  return {
    ...actual,
    agentAuthMiddleware: async (request: { agent?: unknown }) => {
      request.agent = AGENT
    },
  }
})
vi.mock('../../infra/repositories/sub-budgets.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../infra/repositories/sub-budgets.js')>()
  return {
    ...actual,
    findForDelegatingAgent: (...a: unknown[]) => mockFindForDelegatingAgent(...a),
    markClosed: (...a: unknown[]) => mockMarkClosed(...a),
  }
})
vi.mock('../../modules/sub-budgets/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../modules/sub-budgets/index.js')>()
  return {
    ...actual,
    submitSubBudgetClose: (...a: unknown[]) => mockSubmitClose(...a),
    isSubBudgetChildDisabledOnChain: (...a: unknown[]) => mockDisabled(...a),
  }
})

const subBudgetRoutes = (await import('../sub-budgets.js')).default
const { SubmittedUserOpFailedError } = await import('../../rails/delegation-rail.js')

const SUB_BUDGET_ID = 'sb-1'
const SIGNATURE = `0x${'ab'.repeat(65)}`

function closingRow() {
  return {
    id: SUB_BUDGET_ID,
    agent_id: AGENT.id,
    parent_agent_id: '33333333-3333-3333-3333-333333333333',
    parent_sub_budget_id: null,
    chain_id: AGENT.chain_id,
    token_address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    recipient_address: null,
    parent_delegation_hash: `0x${'ab'.repeat(32)}`,
    delegation_hash: `0x${'cd'.repeat(32)}`,
    delegation_json: '{}',
    label: null,
    period_amount_atomic: '1000',
    status: 'closing' as const,
    expires_at: String(Math.floor(Date.now() / 1000) + 3600),
    prepared_user_op: JSON.stringify({ userOp: true }),
    close_tx_hash: null,
    created_at: '2026-11-12T00:00:00Z',
    updated_at: '2026-11-12T00:00:00Z',
    opened_at: '2026-11-12T00:00:00Z',
    closed_at: null,
  }
}

let app: FastifyInstance

beforeEach(async () => {
  vi.clearAllMocks()
  app = Fastify({ logger: false })
  await app.register(subBudgetRoutes, { prefix: '/sub-budgets' })
  await app.ready()
})

async function submit() {
  return app.inject({
    method: 'POST',
    url: `/sub-budgets/${SUB_BUDGET_ID}/submit`,
    payload: { signature: SIGNATURE },
  })
}

describe('POST /sub-budgets/:id/submit — a close submit failure (#4817)', () => {
  it("characterization: an ordinary submit failure still 409s close_needs_reprepare", async () => {
    mockFindForDelegatingAgent.mockResolvedValue(closingRow())
    mockSubmitClose.mockRejectedValue(new Error('AA25 invalid account nonce'))

    const res = await submit()

    expect(res.statusCode).toBe(409)
    expect(res.json().error_code).toBe('close_needs_reprepare')
    expect(mockDisabled).not.toHaveBeenCalled()
  })

  it('a lost-send typed error with the child disabled on-chain answers closed', async () => {
    const row = closingRow()
    mockFindForDelegatingAgent.mockResolvedValue(row)
    mockSubmitClose.mockRejectedValue(
      new SubmittedUserOpFailedError('send answer lost', `0x${'33'.repeat(32)}`, 'receipt_unconfirmed'),
    )
    mockDisabled.mockResolvedValue(true)
    mockMarkClosed.mockResolvedValue({ ...row, status: 'closed' })

    const res = await submit()

    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('closed')
    expect(mockDisabled).toHaveBeenCalledWith(AGENT.chain_id, row.delegation_hash)
  })

  it('a lost-send typed error with the child still enabled answers 502 close_outcome_unconfirmed', async () => {
    mockFindForDelegatingAgent.mockResolvedValue(closingRow())
    mockSubmitClose.mockRejectedValue(
      new SubmittedUserOpFailedError('send answer lost', `0x${'33'.repeat(32)}`, 'receipt_unconfirmed'),
    )
    mockDisabled.mockResolvedValue(false)

    const res = await submit()

    expect(res.statusCode).toBe(502)
    expect(res.json().error_code).toBe('close_outcome_unconfirmed')
  })
})
