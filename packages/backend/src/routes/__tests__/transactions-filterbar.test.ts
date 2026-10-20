/**
 * `GET /transactions` + `GET /transactions/export.csv` — the #4095 FilterBar
 * dimensions (direction, chainId, search, Period), route-level.
 *
 * The list used to filter direction and network in the BROWSER, over the
 * loaded page only — so the list, its count and the CSV export could disagree
 * about the same "filtered" view. Since #4095 every dimension rides both
 * endpoints, applied server-side before paging, and name resolution happens
 * BEFORE the search filter — so a search for a contact's name (or the name of
 * another of the user's own accounts) finds the row that SHOWS that name.
 *
 * The explorer leg is stubbed at `fetch` and the DB leg by SQL table — the
 * pattern `transactions-export-csv.test.ts` established. Timestamps are
 * derived from the live clock for the rolling-window rows (a fixed date could
 * drift out of `period=7d` as the calendar moves) and pinned for the
 * custom-range rows (the zone-day cut needs exact instants).
 */
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ethers } from 'ethers'
import transactionRoutes from '../transactions.js'
import { installRequestValidation } from '../../openapi/request-validation.js'
import pool from '../../db.js'
import { TRANSACTION_CSV_COLUMNS } from '../../modules/transactions/index.js'

const DAY_MS = 24 * 60 * 60 * 1000

const BASE_SAFE = '0x135a9215604711AC70d970e12Caa812c53537EF4'
const GNOSIS_SAFE = '0x55C9d84427756D6f82480427Bb778F6dc0cC755E'
const SECOND_BASE_SAFE = ethers.getAddress('0xCCCC0000000000000000000000000000000000C3')
const CONTACT = ethers.getAddress('0xAAAA0000000000000000000000000000000000A1')
const MERCHANT = ethers.getAddress('0xBBBB0000000000000000000000000000000000B2')

const BASE_SAFE_ID = '11111111-1111-4111-8111-111111111111'
const GNOSIS_SAFE_ID = '22222222-2222-4222-8222-222222222222'
const SAVINGS_SAFE_ID = '33333333-3333-4333-8333-333333333333'

// Explorer hashes, distinct and stable across every test below.
const R1 = '0x' + '01'.padStart(64, '0').slice(-64) // in,  contact,   now − 2d
const R2 = '0x' + '02'.padStart(64, '0').slice(-64) // in,  contact,   2026-05-08 11:49:59Z
const R3 = '0x' + '03'.padStart(64, '0').slice(-64) // out, merchant,  now − 3d
const R4 = '0x' + '04'.padStart(64, '0').slice(-64) // out, Savings,   now − 1d   (chain 100)
const R5 = '0x' + '05'.padStart(64, '0').slice(-64) // out, merchant,  now − 36h  (x402, agent)
const R6 = '0x' + '06'.padStart(64, '0').slice(-64) // in,  contact,   2026-05-08 02:30:00Z

/** Blockscout's timestamp shape — second precision, no milliseconds. */
function blockscoutTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

const ACCOUNTS = [
  { id: BASE_SAFE_ID, account_address: BASE_SAFE, chain_id: 8453, name: 'Base account' },
  { id: GNOSIS_SAFE_ID, account_address: GNOSIS_SAFE, chain_id: 100, name: 'Gnosis account' },
  { id: SAVINGS_SAFE_ID, account_address: SECOND_BASE_SAFE, chain_id: 100, name: 'Savings' },
]

const CONTACTS = [
  {
    id: 'c1',
    // Stored casing differs from the explorer's — resolution is
    // case-insensitive, as it is in the dashboard table.
    address: CONTACT.toLowerCase(),
    name: 'Café Brasil',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  },
]

function jsonResponse(body: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as Response)
}

/**
 * The whole fixture in one stub: four native rows on Base (Blockscout) with
 * the clock-derived and pinned timestamps, one outbound row on Gnosis
 * (Etherscan) paying the user's OWN Savings account, and the x402 leg seeded
 * through the DB mock below.
 */
function stubExplorers() {
  const now = Date.now()
  const fetchMock = vi.fn((input: string | URL) => {
    const url = String(input)

    if (url.includes('/api/v1/safes/') && url.includes('/transfers/')) {
      return jsonResponse({ count: 0, next: null, previous: null, results: [] })
    }
    if (url.includes('/addresses/') && url.includes('/token-transfers')) {
      return jsonResponse({ items: [], next_page_params: null })
    }
    if (url.includes('/addresses/') && url.includes('/transactions')) {
      return jsonResponse({
        items: [
          {
            hash: R1,
            block_number: 45_000_001,
            timestamp: blockscoutTimestamp(now - 2 * DAY_MS),
            from: { hash: CONTACT },
            to: { hash: BASE_SAFE },
            value: '1000000000000000000',
            gas_limit: '21000',
            gas_used: '21000',
            status: 'ok',
            method: null,
          },
          {
            hash: R2,
            block_number: 45_000_002,
            timestamp: '2026-05-08T11:49:59Z',
            from: { hash: CONTACT },
            to: { hash: BASE_SAFE },
            value: '1000000000000000000',
            gas_limit: '21000',
            gas_used: '21000',
            status: 'ok',
            method: null,
          },
          {
            hash: R3,
            block_number: 45_000_003,
            timestamp: blockscoutTimestamp(now - 3 * DAY_MS),
            from: { hash: BASE_SAFE },
            to: { hash: MERCHANT },
            value: '2000000000000000000',
            gas_limit: '21000',
            gas_used: '21000',
            status: 'ok',
            method: null,
          },
          {
            hash: R6,
            block_number: 45_000_006,
            timestamp: '2026-05-08T02:30:00Z',
            from: { hash: CONTACT },
            to: { hash: BASE_SAFE },
            value: '1000000000000000000',
            gas_limit: '21000',
            gas_used: '21000',
            status: 'ok',
            method: null,
          },
        ],
        next_page_params: null,
      })
    }
    if (url.includes('action=txlistinternal') || url.includes('action=tokentx')) {
      return jsonResponse({ status: '1', message: 'OK', result: [] })
    }
    if (url.includes('action=txlist')) {
      // Only the Gnosis account has the outbound row; Savings sees nothing.
      const rows =
        url.toLowerCase().includes(GNOSIS_SAFE.toLowerCase())
          ? [
              {
                blockNumber: '45725827',
                timeStamp: String(Math.floor((now - DAY_MS) / 1000)),
                hash: R4,
                from: GNOSIS_SAFE,
                to: SECOND_BASE_SAFE,
                value: '2000000000000000000',
                gas: '21000',
                gasUsed: '21000',
                isError: '0',
                functionName: '',
              },
            ]
          : []
      return jsonResponse({ status: '1', message: 'OK', result: rows })
    }

    throw new Error(`Unexpected fetch URL: ${url}`)
  })

  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** The confirmed x402 payment that carries the agent name search matches. */
function x402AgentPayment(now: number) {
  return [
    {
      id: 'pi-1',
      tx_hash: R5,
      agent_id: 'agent-1',
      agent_name: 'Research agent',
      account_id: BASE_SAFE_ID,
      account_address: BASE_SAFE,
      account_name: 'Base account',
      chain_id: 8453,
      token_symbol: 'USDC',
      token_address: '0xusdc',
      to_address: MERCHANT,
      amount_raw: '1000000',
      amount_human: '1',
      x402_merchant_address: null,
      x402_resource_url: null,
      payment_proof_status: 'payment_confirmed',
      payment_reconciliation_event_type: null,
      amount_sek: null,
      fx_rate_sek: null,
      fx_source: null,
      settlement_scheme: 'erc7710',
      confirmed_at: new Date(now - 36 * 60 * 60 * 1000).toISOString(),
      created_at: new Date(now - 36 * 60 * 60 * 1000).toISOString(),
    },
  ]
}

function routeDbQueries() {
  const now = Date.now()
  return vi.spyOn(pool, 'query').mockImplementation(
    (async (sql: unknown) => {
      const text = String(sql)
      if (text.includes('FROM smart_accounts')) return { rows: ACCOUNTS }
      if (text.includes('FROM contacts')) return { rows: CONTACTS }
      if (text.includes('FROM payment_intents')) return { rows: x402AgentPayment(now) }
      // The receipt-merchant name fallback (#956): the newest receipt on file
      // for the merchant addresses the feed just resolved.
      if (text.includes('FROM machine_payment_evidence')) {
        return { rows: [{ merchant_key: MERCHANT.toLowerCase(), receipt_name: 'Kafé Veranda' }] }
      }
      if (text.includes('SELECT currency_preference FROM users')) return { rows: [] }
      return { rows: [] }
    }) as never,
  )
}

/** Parse an RFC 4180 body into header + records, honouring quotes. */
function parseCsv(body: string): { header: string[]; records: string[][] } {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false

  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (inQuotes) {
      if (ch === '"' && body[i + 1] === '"') {
        field += '"'
        i++
      } else if (ch === '"') {
        inQuotes = false
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') inQuotes = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\r' && body[i + 1] === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i++
    } else field += ch
  }
  row.push(field)
  rows.push(row)

  const [header, ...records] = rows
  return { header, records }
}

describe('GET /transactions + export.csv — FilterBar dimensions (#4095)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify({ logger: false })
    // The production wiring (#3030): root-scope install, this module
    // enforced — off-spec requests answer the 400 envelope before the
    // handler, conformant ones reach it unchanged.
    installRequestValidation(app, { mode: 'enforce', enforcedModules: ['routes/transactions.ts'] })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(transactionRoutes, { prefix: '/transactions' })
  })

  afterAll(async () => {
    await app.close()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function token(sub = 'user-1'): string {
    return app.jwt.sign({ sub, email: 'test@example.com' }, { expiresIn: '1h' })
  }

  function headers(): Record<string, string> {
    return { authorization: `Bearer ${token()}` }
  }

  function getList(query: string) {
    return app.inject({ method: 'GET', url: `/transactions${query}`, headers: headers() })
  }

  function getCsv(query: string) {
    return app.inject({
      method: 'GET',
      url: `/transactions/export.csv${query}`,
      headers: headers(),
    })
  }

  function resetFixture() {
    stubExplorers()
    routeDbQueries()
  }

  /**
   * The acceptance criterion that motivated moving every filter server-side:
   * for one filter combination, the list's `total` (and its rows) must equal
   * the CSV the export writes for the SAME filters — count and content.
   */
  async function assertListMatchesCsv(filterQuery: string) {
    resetFixture()
    const list = await getList(`?fresh=1&${filterQuery}&limit=100`)
    expect(list.statusCode).toBe(200)
    const body = list.json()

    resetFixture()
    const csv = await getCsv(`?fresh=1&${filterQuery}`)
    expect(csv.statusCode).toBe(200)
    const { header, records } = parseCsv(csv.body.slice(1))
    const hashIndex = header.indexOf('tx_hash')

    expect(body.total).toBe(records.length)
    expect(body.transactions.length).toBe(records.length)
    expect(body.transactions.map((tx: { hash: string }) => tx.hash).sort()).toEqual(
      records.map((record) => record[hashIndex]).sort(),
    )
    expect(Number(csv.headers['x-export-row-count'])).toBe(body.total)
  }

  it('baseline: absent parameters mean today\'s behaviour — every row, no filter', async () => {
    resetFixture()
    const response = await getList('?fresh=1&limit=100')
    const body = response.json()

    expect(response.statusCode).toBe(200)
    expect(body.total).toBe(6)
    expect(body.transactions.map((tx: { hash: string }) => tx.hash).sort()).toEqual(
      [R1, R2, R3, R4, R5, R6].sort(),
    )
  })

  it('direction filters the LIST server-side, over the whole result set', async () => {
    resetFixture()
    const response = await getList('?fresh=1&direction=out&limit=100')
    const body = response.json()

    expect(response.statusCode).toBe(200)
    expect(body.total).toBe(3)
    expect(body.transactions.map((tx: { hash: string }) => tx.hash).sort()).toEqual(
      [R3, R4, R5].sort(),
    )
  })

  it('chainId filters the LIST server-side — the browser-side page filter is gone', async () => {
    resetFixture()
    const byBase = await getList('?fresh=1&chainId=8453&limit=100')
    expect(byBase.json().total).toBe(5)
    expect(byBase.json().transactions.map((tx: { hash: string }) => tx.hash)).not.toContain(R4)

    resetFixture()
    const byGnosis = await getList('?fresh=1&chainId=100&limit=100')
    expect(byGnosis.json().total).toBe(1)
    expect(byGnosis.json().transactions.map((tx: { hash: string }) => tx.hash)).toEqual([R4])
  })

  it('search finds a row by the CONTACT name it shows — accent-insensitively', async () => {
    resetFixture()
    const response = await getList('?fresh=1&search=cafe&limit=100')
    const body = response.json()

    expect(response.statusCode).toBe(200)
    expect(body.total).toBe(3)
    expect(body.transactions.map((tx: { hash: string }) => tx.hash).sort()).toEqual(
      [R1, R2, R6].sort(),
    )
  })

  it('search finds an internal transfer by the OTHER account\'s name', async () => {
    resetFixture()
    const response = await getList('?fresh=1&search=savings&limit=100')
    const body = response.json()

    expect(body.total).toBe(1)
    expect(body.transactions.map((tx: { hash: string }) => tx.hash)).toEqual([R4])
  })

  it('search finds a row by the AGENT name, and by a receipt-merchant name', async () => {
    resetFixture()
    const byAgent = await getList('?fresh=1&search=research&limit=100')
    expect(byAgent.json().total).toBe(1)
    expect(byAgent.json().transactions.map((tx: { hash: string }) => tx.hash)).toEqual([R5])

    resetFixture()
    const byMerchant = await getList('?fresh=1&search=veranda&limit=100')
    expect(byMerchant.json().total).toBe(2)
    expect(byMerchant.json().transactions.map((tx: { hash: string }) => tx.hash).sort()).toEqual(
      [R3, R5].sort(),
    )
  })

  it('a search matching nothing returns nothing, not everything', async () => {
    resetFixture()
    const response = await getList('?fresh=1&search=zanzibar&limit=100')
    expect(response.json().total).toBe(0)
    expect(response.json().transactions).toEqual([])
  })

  it('period=7d is the rolling window [now − 7×24h, now) — old rows drop out', async () => {
    resetFixture()
    const response = await getList('?fresh=1&period=7d&limit=100')
    const body = response.json()

    expect(response.statusCode).toBe(200)
    expect(body.total).toBe(4)
    expect(body.transactions.map((tx: { hash: string }) => tx.hash).sort()).toEqual(
      [R1, R3, R4, R5].sort(),
    )
  })

  it('a custom range is inclusive of both calendar days, cut in the caller\'s zone', async () => {
    // UTC: both pinned 2026-05-08 rows — 02:30 and 11:49 — are inside.
    resetFixture()
    const utc = await getList('?fresh=1&from=2026-05-08&to=2026-05-08&limit=100')
    expect(utc.statusCode).toBe(200)
    expect(utc.json().total).toBe(2)
    expect(utc.json().transactions.map((tx: { hash: string }) => tx.hash).sort()).toEqual(
      [R2, R6].sort(),
    )

    // America/New_York (UTC−4 in May): the zone day starts 04:00Z, so the
    // 02:30 row falls OUTSIDE while 11:49 stays inside — the range is cut
    // in the caller's zone, not re-centred on UTC.
    resetFixture()
    const newYork = await getList(
      '?fresh=1&from=2026-05-08&to=2026-05-08&tz=America/New_York&limit=100',
    )
    expect(newYork.json().total).toBe(1)
    expect(newYork.json().transactions.map((tx: { hash: string }) => tx.hash)).toEqual([R2])
  })

  it('filters apply BEFORE paging: page 2 continues the filtered set', async () => {
    // Outgoing rows, newest first: R4 (−1d), R5 (−36h), R3 (−3d). Page 2
    // must be [R5, R3] — the RAW feed's first three are R4, R5, R1, so a
    // page-from-raw would hand back R1, an incoming row the direction
    // filter exists to exclude.
    resetFixture()
    const pageOne = await getList('?fresh=1&direction=out&limit=2&offset=0')
    expect(pageOne.json().transactions.map((tx: { hash: string }) => tx.hash)).toEqual([R4, R5])
    expect(pageOne.json().hasMore).toBe(true)

    resetFixture()
    const pageTwo = await getList('?fresh=1&direction=out&limit=2&offset=2')
    expect(pageTwo.json().total).toBe(3)
    expect(pageTwo.json().transactions.map((tx: { hash: string }) => tx.hash)).toEqual([R3])
    expect(pageTwo.json().hasMore).toBe(false)
  })

  // The acceptance criterion: for ANY combination, the list's total count
  // equals the number of rows the CSV export returns — same filters, both
  // endpoints, count AND hashes.
  it.each([
    ['no filters', ''],
    ['direction', 'direction=out'],
    ['chain', 'chainId=8453'],
    ['search', 'search=cafe'],
    ['period preset', 'period=7d'],
    ['custom range', 'from=2026-05-08&to=2026-05-08'],
    ['custom range in a zone', 'from=2026-05-08&to=2026-05-08&tz=America/New_York'],
    ['everything combined', 'direction=out&chainId=8453&period=7d&search=veranda'],
  ])('list total equals the CSV row count for %s', async (_name, filterQuery) => {
    await assertListMatchesCsv(filterQuery)
  })

  describe('structured 400s — the same rules on both endpoints', () => {
    it.each([
      ['an invalid tz', 'from=2026-05-08&to=2026-05-08&tz=Not/AZone', 'unsupported tz'],
      ['a from after to', 'from=2026-05-09&to=2026-05-08', 'from is after to'],
      ['a lone from', 'from=2026-05-08', 'from and to must be sent together'],
      ['a preset and a custom range together', 'period=7d&from=2026-05-08&to=2026-05-09', 'period and from/to are mutually exclusive'],
    ])('%s is refused by the list', async (_name, query, expectedError) => {
      resetFixture()
      const response = await getList(`?fresh=1&${query}`)
      expect(response.statusCode).toBe(400)
      expect(response.json().error).toBe(expectedError)
    })

    it.each([
      ['an invalid tz', 'from=2026-05-08&to=2026-05-08&tz=Not/AZone', 'unsupported tz'],
      ['a from after to', 'from=2026-05-09&to=2026-05-08', 'from is after to'],
      ['a lone from', 'from=2026-05-08', 'from and to must be sent together'],
      ['a preset and a custom range together', 'period=7d&from=2026-05-08&to=2026-05-09', 'period and from/to are mutually exclusive'],
    ])('%s is refused by the export', async (_name, query, expectedError) => {
      resetFixture()
      const response = await getCsv(`?fresh=1&${query}`)
      expect(response.statusCode).toBe(400)
      expect(response.json().error).toBe(expectedError)
    })

    // #3030: the SHAPE refusals are the spec's (the `period` enum, the
    // calendar-date pattern), answered as the 400 envelope by the enforced
    // module before the handler — on BOTH endpoints, since both declare the
    // parameters.
    it.each([
      ['period=14d', 'querystring/period'],
      ['from=08.05.2026&to=2026-05-09', 'querystring/from'],
    ])('the list rejects ?%s with the envelope', async (query, field) => {
      resetFixture()
      const response = await getList(`?fresh=1&${query}`)
      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({
        error: 'Request does not match the API spec',
        error_code: 'invalid_request',
      })
      expect(response.json().details).toContain(field)
    })

    it.each([
      ['period=14d', 'querystring/period'],
      ['from=08.05.2026&to=2026-05-09', 'querystring/from'],
    ])('the export rejects ?%s with the envelope', async (query, field) => {
      resetFixture()
      const response = await getCsv(`?fresh=1&${query}`)
      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({
        error: 'Request does not match the API spec',
        error_code: 'invalid_request',
      })
      expect(response.json().details).toContain(field)
    })
  })

  describe('the export applies the same dimensions over the whole set', () => {
    function csvHashes(body: string): string[] {
      const { header, records } = parseCsv(body.slice(1))
      return records.map((record) => record[header.indexOf('tx_hash')]).sort()
    }

    it('search resolves names BEFORE filtering — the contact-named rows only', async () => {
      resetFixture()
      const response = await getCsv('?fresh=1&search=cafe')
      expect(response.statusCode).toBe(200)
      expect(csvHashes(response.body)).toEqual([R1, R2, R6].sort())
    })

    it('the own-account name search covers the internal transfer', async () => {
      resetFixture()
      const response = await getCsv('?fresh=1&search=savings')
      expect(csvHashes(response.body)).toEqual([R4])
    })

    it('period=7d filters the file to the rolling window', async () => {
      resetFixture()
      const response = await getCsv('?fresh=1&period=7d')
      expect(csvHashes(response.body)).toEqual([R1, R3, R4, R5].sort())
    })

    it('a custom range with tz filters the file in the caller\'s zone', async () => {
      resetFixture()
      const response = await getCsv('?fresh=1&from=2026-05-08&to=2026-05-08&tz=America/New_York')
      expect(csvHashes(response.body)).toEqual([R2])
    })

    it('direction and chainId still filter the file, composed with the new dimensions', async () => {
      resetFixture()
      const response = await getCsv('?fresh=1&direction=out&chainId=8453&search=veranda')
      expect(csvHashes(response.body)).toEqual([R3, R5].sort())
    })
  })
})
