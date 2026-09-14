import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'

/**
 * Route-level invariants for `GET /analytics/overview` (#2946, epic #2944
 * slice B). The repository layer is mocked here (real-DB proof lives in
 * `infra/repositories/__tests__/analytics.test.ts`) — this suite pins auth,
 * tenant isolation, validation, owner-CLI acceptance, and the full-payload
 * shape against the OpenAPI spec.
 */

const USER = '11111111-1111-4111-8111-111111111111'
const OTHER_USER = '22222222-2222-4222-8222-222222222222'
const AGENT_UUID = '4f9a1c2e-7b3d-4a10-9c55-2f8e6d0b1a34'

const {
  mockSumTotalsSpendForUser,
  mockCountUnsettledSubmittedForUser,
  mockListByDaySpendForUser,
  mockListPerAgentSpendForUser,
  mockListPerAgentTopMerchantForUser,
  mockListTopMerchantsForUser,
  mockListBalanceByDayForUser,
  mockSumFeesTotalsForUser,
  mockListGasEventsByChainForUser,
  mockListActiveDelegationsForUser,
  mockListReceiptMerchantNamesForUser,
  mockListContactsForUser,
  mockAggregateRefusalsForUserByAgent,
  mockListRefusalsForUser,
} = vi.hoisted(() => ({
  mockSumTotalsSpendForUser: vi.fn(),
  mockCountUnsettledSubmittedForUser: vi.fn(),
  mockListByDaySpendForUser: vi.fn(),
  mockListPerAgentSpendForUser: vi.fn(),
  mockListPerAgentTopMerchantForUser: vi.fn(),
  mockListTopMerchantsForUser: vi.fn(),
  mockListBalanceByDayForUser: vi.fn(),
  mockSumFeesTotalsForUser: vi.fn(),
  mockListGasEventsByChainForUser: vi.fn(),
  mockListActiveDelegationsForUser: vi.fn(),
  mockListReceiptMerchantNamesForUser: vi.fn(),
  mockListContactsForUser: vi.fn(),
  mockAggregateRefusalsForUserByAgent: vi.fn(),
  mockListRefusalsForUser: vi.fn(),
}))

vi.mock('../../infra/repositories/analytics.js', async () => {
  const actual = await vi.importActual<typeof import('../../infra/repositories/analytics.js')>(
    '../../infra/repositories/analytics.js',
  )
  return {
    ...actual, // keep the pure helpers real: computeBudgetBands, sumValueBearingGasOps, shapeBudgets
    sumTotalsSpendForUser: mockSumTotalsSpendForUser,
    countUnsettledSubmittedForUser: mockCountUnsettledSubmittedForUser,
    listByDaySpendForUser: mockListByDaySpendForUser,
    listPerAgentSpendForUser: mockListPerAgentSpendForUser,
    listPerAgentTopMerchantForUser: mockListPerAgentTopMerchantForUser,
    listTopMerchantsForUser: mockListTopMerchantsForUser,
    listBalanceByDayForUser: mockListBalanceByDayForUser,
    sumFeesTotalsForUser: mockSumFeesTotalsForUser,
    listGasEventsByChainForUser: mockListGasEventsByChainForUser,
    listActiveDelegationsForUser: mockListActiveDelegationsForUser,
    listReceiptMerchantNamesForUser: mockListReceiptMerchantNamesForUser,
  }
})

vi.mock('../../infra/repositories/contacts.js', () => ({
  listContactsForUser: mockListContactsForUser,
}))

vi.mock('../../infra/repositories/payment-refusals.js', () => ({
  aggregateRefusalsForUserByAgent: mockAggregateRefusalsForUserByAgent,
  listRefusalsForUser: mockListRefusalsForUser,
}))

import analyticsOverviewRoutes from '../analytics-overview.js'
import { expectMatchesSpec } from '../../openapi/response-shape.js'

function emptyFixtures(userId: string) {
  mockSumTotalsSpendForUser.mockResolvedValue({
    spent_usd: '10.00',
    spent_eur: '9.00',
    spent_previous_usd: '5.00',
    spent_previous_eur: '4.50',
    payments_counted: '1',
  })
  mockCountUnsettledSubmittedForUser.mockResolvedValue(0)
  mockListByDaySpendForUser.mockResolvedValue([{ day: '2030-06-01', agent_id: AGENT_UUID, usd: '10.00', eur: '9.00' }])
  mockListPerAgentSpendForUser.mockResolvedValue([
    {
      agent_id: AGENT_UUID,
      name: 'agent-1',
      status: 'active',
      spent_usd: '10.00',
      spent_eur: '9.00',
      payments: '1',
      last_payment_at: '2030-06-01T12:00:00.000Z',
    },
  ])
  mockListPerAgentTopMerchantForUser.mockResolvedValue([])
  mockListTopMerchantsForUser.mockResolvedValue([])
  mockListBalanceByDayForUser.mockResolvedValue([])
  mockSumFeesTotalsForUser.mockResolvedValue({
    fee_usd: '0',
    fee_eur: '0',
    fee_usd_previous: '0',
    fee_eur_previous: '0',
    fee_rows: '0',
  })
  mockListGasEventsByChainForUser.mockResolvedValue([])
  mockListActiveDelegationsForUser.mockResolvedValue([])
  mockListReceiptMerchantNamesForUser.mockResolvedValue(new Map())
  mockListContactsForUser.mockResolvedValue([])
  mockAggregateRefusalsForUserByAgent.mockResolvedValue([])
  mockListRefusalsForUser.mockResolvedValue([])
  void userId
}

describe('GET /analytics/overview', () => {
  let app: FastifyInstance
  let token: string
  let otherToken: string
  let ownerCliToken: string

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(analyticsOverviewRoutes, { prefix: '/analytics' })
    token = app.jwt.sign({ sub: USER, email: 'user@example.com' })
    otherToken = app.jwt.sign({ sub: OTHER_USER, email: 'other@example.com' })
    ownerCliToken = app.jwt.sign(
      { sub: USER, email: 'user@example.com', purpose: 'owner_cli' } as unknown as {
        sub: string
        email: string
      },
    )
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    emptyFixtures(USER)
  })

  function call(url: string, bearer?: string) {
    return app.inject({
      method: 'GET',
      url,
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    })
  }

  it('rejects unauthenticated requests', async () => {
    const res = await call('/analytics/overview?range=30d')
    expect(res.statusCode).toBe(401)
    expect(mockSumTotalsSpendForUser).not.toHaveBeenCalled()
  })

  it('400s on a range outside the enum', async () => {
    const res = await call('/analytics/overview?range=14d', token)
    expect(res.statusCode).toBe(400)
  })

  it('400s on an unrecognized currency', async () => {
    const res = await call('/analytics/overview?range=30d&currency=sek', token)
    expect(res.statusCode).toBe(400)
  })

  it('400s on an unrecognized IANA time zone', async () => {
    const res = await call('/analytics/overview?range=30d&tz=Nowhere/Fake', token)
    expect(res.statusCode).toBe(400)
  })

  it('accepts a real IANA zone and defaults currency to usd', async () => {
    const res = await call('/analytics/overview?range=30d&tz=Europe/Stockholm', token)
    expect(res.statusCode).toBe(200)
    expect(res.json().currency).toBe('usd')
    expect(res.json().basis.tz).toBe('Europe/Stockholm')
  })

  it('scopes every repository read to the caller\'s user id — a second user\'s token reads only its own scope', async () => {
    await call('/analytics/overview?range=30d', token)
    expect(mockSumTotalsSpendForUser).toHaveBeenCalledWith(USER, expect.anything(), expect.anything())

    vi.clearAllMocks()
    emptyFixtures(OTHER_USER)
    await call('/analytics/overview?range=30d', otherToken)
    expect(mockSumTotalsSpendForUser).toHaveBeenCalledWith(OTHER_USER, expect.anything(), expect.anything())
    expect(mockSumTotalsSpendForUser).not.toHaveBeenCalledWith(USER, expect.anything(), expect.anything())
  })

  it('accepts an owner-CLI token (the allow-list entry)', async () => {
    const res = await call('/analytics/overview?range=30d', ownerCliToken)
    expect(res.statusCode).toBe(200)
  })

  it('the full 200 payload matches the OpenAPI spec exactly', async () => {
    const res = await call('/analytics/overview?range=7d&currency=eur&tz=UTC', token)
    expect(res.statusCode).toBe(200)
    expectMatchesSpec('GET', '/analytics/overview', res.json())
  })

  it('returns the documented shape end to end (range, basis, totals, sections)', async () => {
    const res = await call('/analytics/overview?range=30d', token)
    const body = res.json()
    expect(body.range).toMatchObject({ days: 30 })
    expect(body.currency).toBe('usd')
    expect(body.basis.payments_counted).toBe(1)
    expect(body.totals.spent).toBe('10.00')
    expect(body.totals.fees).toEqual({ amount: '0', previous: '0', flag_on: false })
    expect(body.agents).toHaveLength(1)
    expect(body.agents[0].id).toBe(AGENT_UUID)
    expect(body.by_day).toHaveLength(1)
    expect(body.merchants).toEqual([])
    expect(body.balance_by_day).toEqual([])
  })
})
