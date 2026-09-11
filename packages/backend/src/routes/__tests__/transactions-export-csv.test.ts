/**
 * `GET /transactions/export.csv` (#2871).
 *
 * The transaction feed is not a database read — it is aggregated from block
 * explorers and then enriched from `payment_intents`. So the explorer leg is
 * stubbed at `fetch` (the collaborator this route does not own) and the DB leg
 * is routed by SQL table, the pattern `transactions.test.ts` established for
 * the db-mock ratchet (#1227). What is asserted here is the route's own
 * behaviour: filter fidelity over the WHOLE result set, the row cap, the
 * headers, and the CSV projection. The quoting rules have their own unit test
 * in `domain/__tests__/csv.test.ts`.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import transactionRoutes from '../transactions.js'
import pool from '../../db.js'
import { TRANSACTION_CSV_COLUMNS } from '../../modules/transactions/index.js'

const BASE_SAFE = '0x135a9215604711AC70d970e12Caa812c53537EF4'
const GNOSIS_SAFE = '0x55C9d84427756D6f82480427Bb778F6dc0cC755E'
const SENDER = '0xAAAA0000000000000000000000000000000000A1'
const RECIPIENT = '0xBBBB0000000000000000000000000000000000B2'
const IN_HASH = '0x1111111111111111111111111111111111111111111111111111111111111111'
const OUT_HASH = '0x2222222222222222222222222222222222222222222222222222222222222222'

// Real uuids: `safeId` is uuid-validated before it reaches the account list.
const BASE_SAFE_ID = '11111111-1111-4111-8111-111111111111'
const GNOSIS_SAFE_ID = '22222222-2222-4222-8222-222222222222'

function jsonResponse(body: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as Response)
}

/**
 * One inbound row on Base (8453, Blockscout) and one outbound row on Gnosis
 * (100, Etherscan v2) — enough to prove the direction and chain filters run
 * server-side rather than over a loaded page.
 */
function stubExplorers() {
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
            hash: IN_HASH,
            block_number: 45_725_826,
            timestamp: '2026-05-08T11:49:59Z',
            from: { hash: SENDER },
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
      return jsonResponse({
        status: '1',
        message: 'OK',
        result: [
          {
            blockNumber: '45725827',
            timeStamp: '1778240999',
            hash: OUT_HASH,
            from: GNOSIS_SAFE,
            to: RECIPIENT,
            value: '2000000000000000000',
            gas: '21000',
            gasUsed: '21000',
            isError: '0',
            functionName: '',
          },
        ],
      })
    }

    throw new Error(`Unexpected fetch URL: ${url}`)
  })

  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/**
 * `count` distinct inbound rows on the Base account — the row-cap fixture.
 * Hash is derived from the index so every row survives dedupe.
 */
function stubManyBaseTransactions(count: number) {
  const items = Array.from({ length: count }, (_, i) => ({
    hash: `0x${(i + 1).toString(16).padStart(64, '0')}`,
    block_number: 45_000_000 + i,
    timestamp: '2026-05-08T11:49:59Z',
    from: { hash: SENDER },
    to: { hash: BASE_SAFE },
    value: '1000000000000000000',
    gas_limit: '21000',
    gas_used: '21000',
    status: 'ok',
    method: null,
  }))

  const fetchMock = vi.fn((input: string | URL) => {
    const url = String(input)
    if (url.includes('/addresses/') && url.includes('/transactions')) {
      return jsonResponse({ items, next_page_params: null })
    }
    if (url.includes('/api/v1/safes/') && url.includes('/transfers/')) {
      return jsonResponse({ count: 0, next: null, previous: null, results: [] })
    }
    return jsonResponse({ items: [], next_page_params: null })
  })

  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/**
 * Two accounts on ONE chain — name resolution is keyed by address AND chain,
 * so a cross-chain pair resolves to nothing on the dashboard too and would
 * not exercise this. The first account pays the second.
 */
const SECOND_BASE_SAFE = '0xCCCC0000000000000000000000000000000000C3'
const SECOND_BASE_SAFE_ID = '33333333-3333-4333-8333-333333333333'

const TWO_BASE_SAFES = [
  { id: BASE_SAFE_ID, safe_address: BASE_SAFE, chain_id: 8453, name: 'Base account' },
  { id: SECOND_BASE_SAFE_ID, safe_address: SECOND_BASE_SAFE, chain_id: 8453, name: 'Savings' },
]

function stubTransferBetweenOwnAccounts() {
  const fetchMock = vi.fn((input: string | URL) => {
    const url = String(input)
    // Only the first account has the outbound row; the second sees nothing,
    // so the export scoped to the first holds exactly one record.
    if (
      url.includes('/addresses/') &&
      url.includes('/transactions') &&
      url.toLowerCase().includes(BASE_SAFE.toLowerCase())
    ) {
      return jsonResponse({
        items: [
          {
            hash: OUT_HASH,
            block_number: 45_725_827,
            timestamp: '2026-05-08T11:49:59Z',
            from: { hash: BASE_SAFE },
            to: { hash: SECOND_BASE_SAFE },
            value: '2000000000000000000',
            gas_limit: '21000',
            gas_used: '21000',
            status: 'ok',
            method: null,
          },
        ],
        next_page_params: null,
      })
    }
    return jsonResponse({ items: [], next_page_params: null })
  })

  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/**
 * `count` confirmed x402 payment intents for the Base account — the row-cap
 * fixture. This leg, not the explorer one, is what makes EXPORT_ROW_CAP
 * reachable: `FIND_CONFIRMED_X402_PAYMENT_INTENTS_SQL` carries no `LIMIT` and
 * `mergeX402Transactions` appends every row.
 */
function x402Rows(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `pi-${i}`,
    tx_hash: `0x${(i + 1).toString(16).padStart(64, '0')}`,
    agent_id: 'agent-1',
    agent_name: 'Buyer',
    safe_id: BASE_SAFE_ID,
    safe_address: BASE_SAFE,
    safe_name: 'Base account',
    chain_id: 8453,
    token_symbol: 'USDC',
    token_address: '0xusdc',
    to_address: RECIPIENT,
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
    confirmed_at: '2026-05-08T11:49:59.000Z',
    created_at: '2026-05-08T11:49:59.000Z',
  }))
}

interface DbRows {
  user_safes?: unknown[]
  contacts?: unknown[]
  payment_intents?: unknown[]
}

function routeDbQueries(rows: DbRows = {}) {
  return vi.spyOn(pool, 'query').mockImplementation(
    (async (sql: unknown) => {
      const text = String(sql)
      if (text.includes('FROM user_safes')) return { rows: rows.user_safes ?? [] }
      if (text.includes('FROM contacts')) return { rows: rows.contacts ?? [] }
      if (text.includes('FROM payment_intents')) return { rows: rows.payment_intents ?? [] }
      return { rows: [] }
    }) as never,
  )
}

const BOTH_SAFES = [
  { id: BASE_SAFE_ID, safe_address: BASE_SAFE, chain_id: 8453, name: 'Base account' },
  { id: GNOSIS_SAFE_ID, safe_address: GNOSIS_SAFE, chain_id: 100, name: 'Gnosis account' },
]

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

describe('GET /transactions/export.csv', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify({ logger: false })
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

  function get(query: string, auth = true) {
    return app.inject({
      method: 'GET',
      url: `/transactions/export.csv${query}`,
      headers: auth ? { authorization: `Bearer ${token()}` } : {},
    })
  }

  it('refuses an unauthenticated request', async () => {
    stubExplorers()
    routeDbQueries({ user_safes: BOTH_SAFES })

    const response = await get('?fresh=1', false)

    expect(response.statusCode).toBe(401)
  })

  it('returns a UTF-8 BOM, the CSV content type and an attachment filename', async () => {
    stubExplorers()
    routeDbQueries({ user_safes: BOTH_SAFES })

    const response = await get('?fresh=1')

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/csv')
    expect(response.headers['content-disposition']).toMatch(
      /^attachment; filename="haven-transactions-\d{8}\.csv"$/,
    )
    expect(response.headers['x-export-row-count']).toBe('2')
    expect(response.body.startsWith('﻿')).toBe(true)
  })

  it('exports every row of the result set, in the declared column order', async () => {
    stubExplorers()
    routeDbQueries({ user_safes: BOTH_SAFES })

    const response = await get('?fresh=1')
    const { header, records } = parseCsv(response.body.slice(1))

    expect(header).toEqual([...TRANSACTION_CSV_COLUMNS])
    expect(records).toHaveLength(2)

    const hashes = records.map((r) => r[header.indexOf('tx_hash')])
    expect(hashes.sort()).toEqual([IN_HASH, OUT_HASH].sort())

    const inbound = records.find((r) => r[header.indexOf('tx_hash')] === IN_HASH)!
    expect(inbound[header.indexOf('direction')]).toBe('in')
    expect(inbound[header.indexOf('counterparty_address')]).toBe(SENDER)
    expect(inbound[header.indexOf('chain_id')]).toBe('8453')
    expect(inbound[header.indexOf('settled_at')]).toBe('2026-05-08T11:49:59.000Z')
    // No fee ledger exists (#386), so the reserved column is present and empty.
    expect(inbound[header.indexOf('fee_sek')]).toBe('')
  })

  it('applies the direction filter server-side, over the whole result set', async () => {
    stubExplorers()
    routeDbQueries({ user_safes: BOTH_SAFES })

    const response = await get('?fresh=1&direction=out')
    const { header, records } = parseCsv(response.body.slice(1))

    expect(records).toHaveLength(1)
    expect(records[0][header.indexOf('tx_hash')]).toBe(OUT_HASH)
    expect(response.headers['x-export-row-count']).toBe('1')
  })

  it('applies the chain filter server-side', async () => {
    stubExplorers()
    routeDbQueries({ user_safes: BOTH_SAFES })

    const response = await get('?fresh=1&chainId=8453')
    const { header, records } = parseCsv(response.body.slice(1))

    expect(records).toHaveLength(1)
    expect(records[0][header.indexOf('tx_hash')]).toBe(IN_HASH)
  })

  it('resolves the counterparty name from the address book', async () => {
    stubExplorers()
    routeDbQueries({
      user_safes: BOTH_SAFES,
      contacts: [
        {
          id: 'c1',
          // Stored casing differs from the explorer's — resolution is
          // case-insensitive, as it is in the dashboard table.
          address: RECIPIENT.toLowerCase(),
          name: 'Acme, Inc',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    })

    const response = await get('?fresh=1&direction=out')
    const { header, records } = parseCsv(response.body.slice(1))

    expect(records[0][header.indexOf('counterparty_name')]).toBe('Acme, Inc')
    // The comma inside the name must not have split the record.
    expect(records[0]).toHaveLength(TRANSACTION_CSV_COLUMNS.length)
  })

  it('falls back to the name of the user\'s own account', async () => {
    stubExplorers()
    routeDbQueries({ user_safes: BOTH_SAFES })

    const response = await get('?fresh=1&chainId=100')
    const { header, records } = parseCsv(response.body.slice(1))

    expect(records[0][header.indexOf('safe_address')]).toBe(GNOSIS_SAFE)
  })

  it('exports every row the pipeline yields, well past one page of the list', async () => {
    // The list route pages at 25; the export takes the lot. One
    // `EXPLORER_PAGE_SIZE` window is the most a single source yields today —
    // sliced locally on Blockscout, which takes no page-size parameter, and
    // requested as `offset` on the Etherscan-shaped legs. That is why
    // EXPORT_ROW_CAP's refusal is not reachable through this leg; it is
    // reached through the unbounded x402 leg below.
    stubManyBaseTransactions(80)
    routeDbQueries({ user_safes: [BOTH_SAFES[0]] })

    const response = await get('?fresh=1')
    const { records } = parseCsv(response.body.slice(1))

    expect(response.statusCode).toBe(200)
    expect(records).toHaveLength(50)
    expect(response.headers['x-export-row-count']).toBe('50')
  })

  it('names the far side of a transfer between two of the user\'s own accounts', async () => {
    // Scoped to one account, paying the user's OWN second account. The
    // dashboard table resolves names from all of the user's accounts, so the
    // export has to as well — resolving from the `safeId`-narrowed list would
    // leave counterparty_name empty while the screen says "Savings".
    stubTransferBetweenOwnAccounts()
    routeDbQueries({ user_safes: TWO_BASE_SAFES })

    const response = await get(`?fresh=1&safeId=${BASE_SAFE_ID}`)
    const { header, records } = parseCsv(response.body.slice(1))

    expect(records).toHaveLength(1)
    expect(records[0][header.indexOf('counterparty_address')]).toBe(SECOND_BASE_SAFE)
    expect(records[0][header.indexOf('counterparty_name')]).toBe('Savings')
  })

  it('refuses above the row cap with a structured error naming the count', async () => {
    // One row over EXPORT_ROW_CAP, seeded through the unbounded x402 leg.
    stubExplorers()
    routeDbQueries({ user_safes: [BOTH_SAFES[0]], payment_intents: x402Rows(10_001) })

    const response = await get('?fresh=1')

    expect(response.statusCode).toBe(413)
    expect(response.headers['content-type']).toContain('application/json')
    expect(response.json()).toMatchObject({ error: 'Export too large', statusCode: 413 })
    // The actionable half: the count, the limit and the way out.
    // Grouped digits — the copy reads '10,002' / '10,000'.
    expect(response.json().details).toContain('10,002')
    expect(response.json().details).toContain('10,000')
    expect(response.json().details).toContain('Narrow the filters')
    // Nothing is emitted — a refusal, never a truncated file.
    expect(response.body).not.toContain('settled_at')
  })

  it('exports at the row cap rather than refusing', async () => {
    stubExplorers()
    routeDbQueries({ user_safes: [BOTH_SAFES[0]], payment_intents: x402Rows(9_999) })

    const response = await get('?fresh=1')

    expect(response.statusCode).toBe(200)
    expect(response.headers['x-export-row-count']).toBe('10000')
  })

  it.each([
    ['?safeId=not-a-uuid', 'Invalid safeId'],
    ['?agentId=not-a-uuid', 'Invalid agentId'],
    ['?tokenKey=nonsense', 'Invalid tokenKey'],
    ['?direction=sideways', 'Invalid direction'],
    ['?chainId=abc', 'Invalid chainId'],
    ['?chainId=999999', 'Unsupported chain: 999999'],
  ])('rejects %s', async (query, error) => {
    stubExplorers()
    routeDbQueries({ user_safes: BOTH_SAFES })

    const response = await get(`${query}&fresh=1`)

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error })
  })

  it('returns a header-only file when the user has no accounts', async () => {
    stubExplorers()
    routeDbQueries({ user_safes: [] })

    const response = await get('?fresh=1')

    expect(response.statusCode).toBe(200)
    expect(response.headers['x-export-row-count']).toBe('0')
    expect(response.body.slice(1)).toBe(TRANSACTION_CSV_COLUMNS.join(','))
  })
})
