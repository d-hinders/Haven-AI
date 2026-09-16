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
  mockAggregateRefusalAmountForUser,
  mockListRefusalsByDayForUser,
  mockFirstRefusalDayForUser,
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
  mockAggregateRefusalAmountForUser: vi.fn(),
  mockListRefusalsByDayForUser: vi.fn(),
  mockFirstRefusalDayForUser: vi.fn(),
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
    aggregateRefusalAmountForUser: mockAggregateRefusalAmountForUser,
    listRefusalsByDayForUser: mockListRefusalsByDayForUser,
  }
})

vi.mock('../../infra/repositories/contacts.js', () => ({
  listContactsForUser: mockListContactsForUser,
}))

vi.mock('../../infra/repositories/payment-refusals.js', () => ({
  aggregateRefusalsForUserByAgent: mockAggregateRefusalsForUserByAgent,
  firstRefusalDayForUser: mockFirstRefusalDayForUser,
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
  mockAggregateRefusalAmountForUser.mockResolvedValue({
    refused_count: '0',
    refused_amount_usd: '0',
    refused_amount_eur: '0',
  })
  mockListRefusalsByDayForUser.mockResolvedValue([])
  mockFirstRefusalDayForUser.mockResolvedValue(null)
  void userId
}

/**
 * A payload that exercises every item schema in the OpenAPI response, not
 * just the top-level object: a real merchant (`top_merchant` non-null on the
 * one agent, `merchants[0]` populated), one balance-by-day entry, and one
 * budget entry. `emptyFixtures`'s all-empty-arrays shape let
 * `expectMatchesSpec` pass while `top_merchant`, `merchants[].items`,
 * `balance_by_day[].items` and `agents[].budgets.items` went unvalidated —
 * an item schema with a bug (e.g. a missing `required` field) could not have
 * failed against it.
 */
const MERCHANT_ADDRESS = `0x${'7'.padStart(40, '0')}`

function fullFixtures(userId: string) {
  emptyFixtures(userId)
  mockListPerAgentTopMerchantForUser.mockResolvedValue([
    { agent_id: AGENT_UUID, merchant_key: MERCHANT_ADDRESS },
  ])
  mockListTopMerchantsForUser.mockResolvedValue([
    {
      merchant_key: MERCHANT_ADDRESS,
      spent_usd: '10.00',
      spent_eur: '9.00',
      payments: '1',
      agent_ids: [AGENT_UUID],
      first_seen: '2030-06-01T12:00:00.000Z',
      last_seen: '2030-06-01T12:00:00.000Z',
    },
  ])
  mockListBalanceByDayForUser.mockResolvedValue([
    { snapshot_date: '2030-06-01', total_usd: '100.00', total_eur: '90.00' },
  ])
  mockListActiveDelegationsForUser.mockResolvedValue([
    {
      id: 'd1',
      agent_id: AGENT_UUID,
      chain_id: 84532,
      token_address: `0x${'a'.repeat(40)}`,
      recipient_address: null,
      delegation_json: '{}',
      budget_atomic: '1000000',
      period_seconds: 86400,
      start_date: String(Math.floor(Date.now() / 1000) - 3600),
    },
  ])
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

  it('400s on a UTC offset string — Postgres and JS interpret its sign oppositely, so it must never reach either', async () => {
    const res = await call('/analytics/overview?range=30d&tz=%2B05:00', token)
    expect(res.statusCode).toBe(400)
    // Never echoed: a raw offset/injection string reflected into the body is
    // its own defect, independent of the validation being correct.
    expect(JSON.stringify(res.json())).not.toContain('+05:00')
  })

  it('400s on a fixed-abbreviation zone (EST) even though the constructor would accept it', async () => {
    const res = await call('/analytics/overview?range=30d&tz=EST', token)
    expect(res.statusCode).toBe(400)
  })

  it('400s on a bare country code (GB) — Intl.DateTimeFormat resolves it, IANA tzdata does not name it a zone', async () => {
    const res = await call('/analytics/overview?range=30d&tz=GB', token)
    expect(res.statusCode).toBe(400)
  })

  it('400s on an injection-shaped tz value and does not echo it', async () => {
    const injected = "Europe/Stockholm'; DROP TABLE payment_intents; --"
    const res = await call(`/analytics/overview?range=30d&tz=${encodeURIComponent(injected)}`, token)
    expect(res.statusCode).toBe(400)
    expect(JSON.stringify(res.json())).not.toContain('DROP TABLE')
  })

  it("400s on the literal string 'Zulu' (a fixed abbreviation, not an IANA zone name)", async () => {
    const res = await call('/analytics/overview?range=30d&tz=Zulu', token)
    expect(res.statusCode).toBe(400)
  })

  it('accepts a real IANA zone and defaults currency to usd', async () => {
    const res = await call('/analytics/overview?range=30d&tz=Europe/Stockholm', token)
    expect(res.statusCode).toBe(200)
    expect(res.json().currency).toBe('usd')
    expect(res.json().basis.tz).toBe('Europe/Stockholm')
  })

  it('accepts the literal zone name UTC', async () => {
    const res = await call('/analytics/overview?range=30d&tz=UTC', token)
    expect(res.statusCode).toBe(200)
  })

  it('passes the caller\'s own sub to every repository call, never another user\'s (does NOT prove row-level tenant isolation — that is the repository suite\'s job)', async () => {
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

  it('the full 200 payload matches the OpenAPI spec exactly, with every item schema exercised', async () => {
    fullFixtures(USER)
    const res = await call('/analytics/overview?range=7d&currency=eur&tz=UTC', token)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    // Guard the fixture itself: an all-empty-arrays payload would still pass
    // expectMatchesSpec without ever validating the item schemas below.
    expect(body.agents[0].top_merchant).not.toBeNull()
    expect(body.merchants.length).toBeGreaterThan(0)
    expect(body.balance_by_day.length).toBeGreaterThan(0)
    expect(body.agents[0].budgets.length).toBeGreaterThan(0)
    expectMatchesSpec('GET', '/analytics/overview', body)
  })

  it('refused_amount is a numeric STRING, like every other money field on this response', async () => {
    mockAggregateRefusalAmountForUser.mockResolvedValue({
      refused_count: '2',
      refused_amount_usd: '15.50',
      refused_amount_eur: '14.00',
    })
    const res = await call('/analytics/overview?range=30d&currency=usd', token)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(typeof body.totals.refused_amount).toBe('string')
    expect(body.totals.refused_amount).toBe('15.50')
  })

  it('refused_amount and refused_count come from ONE aggregate read, tenant- and range-scoped like spend', async () => {
    await call('/analytics/overview?range=30d', token)
    expect(mockAggregateRefusalAmountForUser).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ from: expect.any(String), to: expect.any(String) }),
    )
  })

  it('reports the refusal-ledger floor: null on an empty ledger, the earliest recorded day once rows exist (#3013)', async () => {
    // The default fixture seeds an empty refusal ledger: null — an empty
    // ledger must stay distinguishable from any day value.
    const empty = await call('/analytics/overview?range=30d', token)
    expect(empty.statusCode).toBe(200)
    expect(empty.json().basis.refusals_recorded_from).toBeNull()

    mockFirstRefusalDayForUser.mockResolvedValue('2030-05-30')
    const seeded = await call('/analytics/overview?range=7d', token)
    expect(seeded.statusCode).toBe(200)
    expect(seeded.json().basis.refusals_recorded_from).toBe('2030-05-30')
  })

  it('the floor is a LEDGER property, not a range property: the repo read takes only the user, never the window (#3013)', async () => {
    await call('/analytics/overview?range=90d', token)
    // No from/to argument — contrast the range-scoped reads above, which all
    // receive the requested window. A 90d request and a 7d request must read
    // the same floor.
    expect(mockFirstRefusalDayForUser).toHaveBeenCalledWith(USER)
    expect(mockFirstRefusalDayForUser).toHaveBeenCalledTimes(1)
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
