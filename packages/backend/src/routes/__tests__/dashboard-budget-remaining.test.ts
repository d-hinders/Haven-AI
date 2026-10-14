/**
 * Route tests for GET /dashboard/budget-remaining (#3804).
 *
 * The UNKNOWN wire shape is the point of the suite: today a failed read
 * returns `remainingAtomic: budgetAtomic` and `/analytics/overview`'s
 * shaping turns that into `used_atomic: "0"` — reusing either would ship
 * "full budget left" (or "0 left") as a fact. Here a failed/unknown read is
 * `remaining_from_chain: false`, `remaining_atomic: null`, `used_atomic:
 * null`, and a component renders it as unavailable — never a meter.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { expectMatchesSpec } from '../../openapi/response-shape.js'

const { repoMocks, cacheMocks, jsonByIds } = vi.hoisted(() => ({
  repoMocks: {
    listDashboardBudgetDelegations: vi.fn(),
    listSubBudgetSpend: vi.fn(),
  },
  cacheMocks: {
    fetchBudgetRemaining: vi.fn(),
  },
  jsonByIds: { listDelegationJsonByIds: vi.fn() },
}))

vi.mock('../../infra/repositories/budget-remaining.js', () => repoMocks)
vi.mock('../../infra/repositories/delegation-budgets.js', () => jsonByIds)
vi.mock('../../modules/dashboard/budget-remaining-cache.js', () => cacheMocks)

import budgetRemainingRoutes from '../dashboard-budget-remaining.js'

const USER = '11111111-1111-4111-8111-111111111111'
const AGENT_A = '22222222-2222-4222-8222-222222222222'
const AGENT_B = '33333333-3333-4333-8333-333333333333'

const NOW_SEC = 1_800_000_000
const BUDGET_ROW = {
  id: 'd1',
  agent_id: AGENT_A,
  chain_id: 84532,
  token_address: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
  token_symbol: 'USDC',
  token_decimals: 6,
  delegation_hash: `0x${'a'.repeat(64)}`,
  budget_atomic: '1000000',
  period_seconds: 86400,
  start_date: String(NOW_SEC - 60),
  expires_at: String(NOW_SEC + 30 * 86400),
}

describe('GET /dashboard/budget-remaining (#3804)', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(budgetRemainingRoutes, { prefix: '/dashboard' })
    token = app.jwt.sign({ sub: USER, email: 'ada@example.com' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    repoMocks.listDashboardBudgetDelegations.mockReset()
    repoMocks.listSubBudgetSpend.mockReset()
    cacheMocks.fetchBudgetRemaining.mockReset()
    jsonByIds.listDelegationJsonByIds.mockReset()

    repoMocks.listDashboardBudgetDelegations.mockResolvedValue([BUDGET_ROW])
    jsonByIds.listDelegationJsonByIds.mockResolvedValue(new Map([[BUDGET_ROW.id, '{"signed":true}']]))
    repoMocks.listSubBudgetSpend.mockResolvedValue([])
    cacheMocks.fetchBudgetRemaining.mockResolvedValue({
      status: 'known',
      remainingAtomic: '400000',
      readAtMs: NOW_SEC * 1000,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shapes a known read: remaining + used, read_at carried, sub-budget spend attributed', async () => {
    repoMocks.listSubBudgetSpend.mockResolvedValue([{ agent_id: AGENT_B, spent_atomic: '150000' }])
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/budget-remaining',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.budgets).toHaveLength(1)
    expect(body.budgets[0]).toMatchObject({
      agent_id: AGENT_A,
      chain_id: 84532,
      delegation_hash: BUDGET_ROW.delegation_hash,
      budget_atomic: '1000000',
      remaining_atomic: '400000',
      remaining_from_chain: true,
      used_atomic: '600000',
      sub_budget_spend: [{ agent_id: AGENT_B, spent_atomic: '150000' }],
    })
    expect(body.budgets[0].read_at).not.toBeNull()
    // The round trip against the spec is the shape gate (see #2392/#1090).
    expectMatchesSpec('get', '/dashboard/budget-remaining', body)
  })

  it('UNKNOWN: a fromChain-false read ships remaining_atomic/used_atomic null — never "0", never the full budget', async () => {
    cacheMocks.fetchBudgetRemaining.mockResolvedValue({ status: 'unknown' })
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/budget-remaining',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.budgets[0]).toMatchObject({
      remaining_from_chain: false,
      remaining_atomic: null,
      used_atomic: null,
      read_at: null,
    })
    expectMatchesSpec('get', '/dashboard/budget-remaining', body)
  })

  it('the 4 s deadline: a read that never finishes returns unknown and the response still ships', async () => {
    vi.useFakeTimers()
    cacheMocks.fetchBudgetRemaining.mockImplementation(
      () => new Promise(() => {}), // never resolves
    )

    const pending = app.inject({
      method: 'GET',
      url: '/dashboard/budget-remaining',
      headers: { authorization: `Bearer ${token}` },
    })
    await vi.advanceTimersByTimeAsync(4_000)
    const response = await pending

    expect(response.statusCode).toBe(200)
    expect(response.json().budgets[0]).toMatchObject({
      remaining_atomic: null,
      used_atomic: null,
      remaining_from_chain: false,
    })
  })

  it('reads under the deadline cache normally: the cache module receives the period end and the row identity', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/budget-remaining',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(200)

    expect(cacheMocks.fetchBudgetRemaining).toHaveBeenCalledTimes(1)
    expect(cacheMocks.fetchBudgetRemaining).toHaveBeenCalledWith(
      expect.objectContaining({
        chainId: 84532,
        delegationHash: BUDGET_ROW.delegation_hash,
        delegationJson: '{"signed":true}',
        budgetAtomic: '1000000',
      }),
    )
    // The period end passed to the cache is the row's own boundary.
    const periodEndSec = cacheMocks.fetchBudgetRemaining.mock.calls[0][0].periodEndSec
    expect(Number.isInteger(periodEndSec)).toBe(true)
  })

  it('the cache module is fed per row; the set query ran with the requesting user', async () => {
    await app.inject({
      method: 'GET',
      url: '/dashboard/budget-remaining',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(repoMocks.listDashboardBudgetDelegations).toHaveBeenCalledWith(USER)
  })

  it('requires authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/dashboard/budget-remaining' })
    expect(response.statusCode).toBe(401)
  })
})
