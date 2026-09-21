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
import { ethers } from 'ethers'
import transactionRoutes from '../transactions.js'
import { installRequestValidation } from '../../openapi/request-validation.js'
import pool from '../../db.js'
import { TRANSACTION_CSV_COLUMNS } from '../../modules/transactions/index.js'

const BASE_SAFE = '0x135a9215604711AC70d970e12Caa812c53537EF4'
const GNOSIS_SAFE = '0x55C9d84427756D6f82480427Bb778F6dc0cC755E'
// #3129: declared in EIP-55 checksummed form, because that is now what the
// export emits — every address on a transaction row goes through
// `toCanonicalAddress` at the row boundary. Written through `getAddress`
// rather than hand-cased so the constant cannot drift from the real answer.
// (An all-caps address carries no checksum, so these previously round-tripped
// unchanged; the export now settles them like any other.)
const SENDER = ethers.getAddress('0xAAAA0000000000000000000000000000000000A1')
const RECIPIENT = ethers.getAddress('0xBBBB0000000000000000000000000000000000B2')
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
const SECOND_BASE_SAFE = ethers.getAddress('0xCCCC0000000000000000000000000000000000C3') // #3129, as above
const SECOND_BASE_SAFE_ID = '33333333-3333-4333-8333-333333333333'

const TWO_BASE_SAFES = [
  { id: BASE_SAFE_ID, account_address: BASE_SAFE, chain_id: 8453, name: 'Base account' },
  { id: SECOND_BASE_SAFE_ID, account_address: SECOND_BASE_SAFE, chain_id: 8453, name: 'Savings' },
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
    account_id: BASE_SAFE_ID,
    account_address: BASE_SAFE,
    account_name: 'Base account',
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

function routeDbQueries(rows: DbRows = {}) {
  return vi.spyOn(pool, 'query').mockImplementation(
    (async (sql: unknown) => {
      const text = String(sql)
      if (text.includes('FROM smart_accounts')) return { rows: rows.smart_accounts ?? [] }
      if (text.includes('FROM contacts')) return { rows: rows.contacts ?? [] }
      if (text.includes('FROM payment_intents')) return { rows: rows.payment_intents ?? [] }
      // #3127: the export reads the user's currency_preference to name the
      // reporting_currency column (the amount stays a fixed-SEK branch).
      if (text.includes('SELECT currency_preference FROM users')) {
        return { rows: rows.currency_preference ? [{ currency_preference: rows.currency_preference }] : [] }
      }
      return { rows: [] }
    }) as never,
  )
}

interface DbRows {
  smart_accounts?: unknown[]
  contacts?: unknown[]
  payment_intents?: unknown[]
  currency_preference?: string
}

const BOTH_SAFES = [
  { id: BASE_SAFE_ID, account_address: BASE_SAFE, chain_id: 8453, name: 'Base account' },
  { id: GNOSIS_SAFE_ID, account_address: GNOSIS_SAFE, chain_id: 100, name: 'Gnosis account' },
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
    // The production wiring (#3030, slice 2 of #3028): root-scope install, the
    // module enforced — off-spec requests answer the 400 envelope before the
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

  function get(query: string, auth = true) {
    return app.inject({
      method: 'GET',
      url: `/transactions/export.csv${query}`,
      headers: auth ? { authorization: `Bearer ${token()}` } : {},
    })
  }

  it('refuses an unauthenticated request', async () => {
    stubExplorers()
    routeDbQueries({ smart_accounts: BOTH_SAFES })

    const response = await get('?fresh=1', false)

    expect(response.statusCode).toBe(401)
  })

  it('returns a UTF-8 BOM, the CSV content type and an attachment filename', async () => {
    stubExplorers()
    routeDbQueries({ smart_accounts: BOTH_SAFES })

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
    routeDbQueries({ smart_accounts: BOTH_SAFES })

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

  it('appends the #3127 currency columns: fixed SEK reporting, the feed currency named beside it', async () => {
    stubExplorers()
    routeDbQueries({ smart_accounts: BOTH_SAFES, currency_preference: 'EUR' })

    const response = await get('?fresh=1')
    const { header, records } = parseCsv(response.body.slice(1))

    // The two appended columns carry the DELIBERATE branch: the file reports
    // in fixed SEK (the accounting semantics this export exists for), while
    // the reader can still see which currency the user's dashboard feed
    // converts in — which does NOT move the amounts here. The amounts
    // themselves stay in amount_sek, untouched.
    expect(header.slice(-2)).toEqual(['reporting_currency', 'converted_currency'])
    for (const record of records) {
      expect(record[header.indexOf('reporting_currency')]).toBe('SEK')
      expect(record[header.indexOf('converted_currency')]).toBe('EUR')
    }
    // Indices of every pre-#3127 column are unchanged (append-only contract).
    expect(header.indexOf('amount_sek')).toBe(9)
    expect(header.indexOf('fx_rate')).toBe(10)
  })

  it('answers converted_currency SEK for a user with no preference — the effective feed currency', async () => {
    stubExplorers()
    routeDbQueries({ smart_accounts: BOTH_SAFES })

    const response = await get('?fresh=1')
    const { header, records } = parseCsv(response.body.slice(1))

    expect(records[0][header.indexOf('reporting_currency')]).toBe('SEK')
    // Not empty: with no preference the feed converts in SEK (the
    // documented default), so that IS the effective currency the columns
    // describe — the file and the feed agree by construction.
    expect(records[0][header.indexOf('converted_currency')]).toBe('SEK')
  })

  it('applies the direction filter server-side, over the whole result set', async () => {
    stubExplorers()
    routeDbQueries({ smart_accounts: BOTH_SAFES })

    const response = await get('?fresh=1&direction=out')
    const { header, records } = parseCsv(response.body.slice(1))

    expect(records).toHaveLength(1)
    expect(records[0][header.indexOf('tx_hash')]).toBe(OUT_HASH)
    expect(response.headers['x-export-row-count']).toBe('1')
  })

  it('applies the chain filter server-side', async () => {
    stubExplorers()
    routeDbQueries({ smart_accounts: BOTH_SAFES })

    const response = await get('?fresh=1&chainId=8453')
    const { header, records } = parseCsv(response.body.slice(1))

    expect(records).toHaveLength(1)
    expect(records[0][header.indexOf('tx_hash')]).toBe(IN_HASH)
  })

  // #2907 AC #3: `?accountId=` is the account-vocabulary twin of `?safeId=`;
  // both accept, both must actually filter. The failure mode this guards
  // against is silent: Fastify ignores an unrecognised query key rather than
  // erroring, so reverting the route's `accountFilterId` alias back to
  // reading only `safeId` would make `?accountId=` a no-op that returns every
  // account's rows with no error — this asserts the filtered count is
  // strictly less than the unfiltered one, which a no-op cannot produce.
  it('applies the ?accountId= filter, and its count differs from the unfiltered export', async () => {
    stubExplorers()
    routeDbQueries({ smart_accounts: BOTH_SAFES })
    const unfiltered = await get('?fresh=1')
    expect(unfiltered.statusCode).toBe(200)
    expect(unfiltered.headers['x-export-row-count']).toBe('2')

    stubExplorers()
    routeDbQueries({ smart_accounts: BOTH_SAFES })
    const filtered = await get(`?fresh=1&accountId=${BASE_SAFE_ID}`)
    expect(filtered.statusCode).toBe(200)
    expect(filtered.headers['x-export-row-count']).toBe('1')
    const { header, records } = parseCsv(filtered.body.slice(1))
    expect(records).toHaveLength(1)
    expect(records[0][header.indexOf('tx_hash')]).toBe(IN_HASH)

    expect(Number(filtered.headers['x-export-row-count'])).toBeLessThan(
      Number(unfiltered.headers['x-export-row-count']),
    )
  })

  // #2914 (naming epic #2906 phase 5, the contraction) ends the #2907 parity
  // window: `?safeId=` is now REFUSED with a 400 naming `accountId`, never
  // silently ignored — an ignored filter would return every account's rows,
  // which is the exact failure mode the refusal exists to prevent.
  it('?safeId= is refused with a 400 naming accountId, not silently ignored', async () => {
    stubExplorers()
    routeDbQueries({ smart_accounts: BOTH_SAFES })
    const bySafeId = await get(`?fresh=1&safeId=${BASE_SAFE_ID}`)

    expect(bySafeId.statusCode).toBe(400)
    expect(bySafeId.json().replacement).toBe('accountId')
    // The important guard: NOT a 200 carrying every row the caller owns.
    expect(bySafeId.headers['x-export-row-count']).toBeUndefined()

    stubExplorers()
    routeDbQueries({ smart_accounts: BOTH_SAFES })
    const byAccountId = await get(`?fresh=1&accountId=${BASE_SAFE_ID}`)
    expect(byAccountId.statusCode).toBe(200)
    expect(byAccountId.headers['x-export-row-count']).toBe('1')
  })

  it('400s an invalid ?accountId= — the spec\'s uuid, as the envelope (#3030)', async () => {
    const response = await get('?accountId=not-a-uuid')
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: 'Request does not match the API spec', error_code: 'invalid_request' })
    expect(response.json().details).toContain('querystring/accountId')
  })

  it('resolves the counterparty name from the address book', async () => {
    stubExplorers()
    routeDbQueries({
      smart_accounts: BOTH_SAFES,
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
    routeDbQueries({ smart_accounts: BOTH_SAFES })

    const response = await get('?fresh=1&chainId=100')
    const { header, records } = parseCsv(response.body.slice(1))

    // #2914: `account_address` is the only address column — the deprecated
    // `safe_address` twin is gone from the header entirely, so `indexOf`
    // would return -1 and silently read the LAST cell of the row.
    expect(header).not.toContain('safe_address')
    expect(records[0][header.indexOf('account_address')]).toBe(GNOSIS_SAFE)
  })

  it('exports every row the pipeline yields, well past one page of the list', async () => {
    // The list route pages at 25; the export takes the lot. #2882 capped a
    // source at one window (fifty of these eighty rows reached the CSV);
    // #2884 removed that cap — the explorer leg reads past the first window
    // (up to EXPLORER_MAX_PAGES pages), so all eighty rows the stub offers
    // on its single page are exported. EXPORT_ROW_CAP's refusal is still not
    // reachable through this leg — the page budget keeps an explorer-sourced
    // export far under it — it is reached through the unbounded x402 leg
    // below.
    stubManyBaseTransactions(80)
    routeDbQueries({ smart_accounts: [BOTH_SAFES[0]] })

    const response = await get('?fresh=1')
    const { records } = parseCsv(response.body.slice(1))

    expect(response.statusCode).toBe(200)
    expect(records).toHaveLength(80)
    expect(response.headers['x-export-row-count']).toBe('80')
  })

  it('names the far side of a transfer between two of the user\'s own accounts', async () => {
    // Scoped to one account, paying the user's OWN second account. The
    // dashboard table resolves names from all of the user's accounts, so the
    // export has to as well — resolving from the `accountId`-narrowed list
    // would leave counterparty_name empty while the screen says "Savings".
    stubTransferBetweenOwnAccounts()
    routeDbQueries({ smart_accounts: TWO_BASE_SAFES })

    const response = await get(`?fresh=1&accountId=${BASE_SAFE_ID}`)
    const { header, records } = parseCsv(response.body.slice(1))

    expect(records).toHaveLength(1)
    expect(records[0][header.indexOf('counterparty_address')]).toBe(SECOND_BASE_SAFE)
    expect(records[0][header.indexOf('counterparty_name')]).toBe('Savings')
  })

  it('refuses above the row cap with a structured error naming the count', async () => {
    // One row over EXPORT_ROW_CAP, seeded through the unbounded x402 leg.
    stubExplorers()
    routeDbQueries({ smart_accounts: [BOTH_SAFES[0]], payment_intents: x402Rows(10_001) })

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
    routeDbQueries({ smart_accounts: [BOTH_SAFES[0]], payment_intents: x402Rows(9_999) })

    const response = await get('?fresh=1')

    expect(response.statusCode).toBe(200)
    expect(response.headers['x-export-row-count']).toBe('10000')
  })

  // #3030: the SHAPE refusals are the spec's (uuid, `user`-or-uuid,
  // `<chain>:<address|native>`, the `direction` enum, a positive integer),
  // answered as the 400 envelope by the enforced module before the handler;
  // an unsupported chain is still the handler's own refusal. Mutation: drop
  // the module from enforcedModules → `direction=sideways` exports (200).
  it.each([
    ['?accountId=not-a-uuid', 'querystring/accountId'],
    ['?agentId=not-a-uuid', 'querystring/agentId'],
    ['?tokenKey=nonsense', 'querystring/tokenKey'],
    ['?direction=sideways', 'querystring/direction'],
    ['?chainId=abc', 'querystring/chainId'],
  ])('rejects %s with the envelope', async (query, field) => {
    stubExplorers()
    routeDbQueries({ smart_accounts: BOTH_SAFES })

    const response = await get(`${query}&fresh=1`)

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: 'Request does not match the API spec', error_code: 'invalid_request' })
    expect(response.json().details).toContain(field)
  })

  it('rejects ?chainId=999999 — a well-shaped chain Haven does not serve (semantic, kept in the handler)', async () => {
    stubExplorers()
    routeDbQueries({ smart_accounts: BOTH_SAFES })
    const response = await get('?chainId=999999&fresh=1')
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: 'Unsupported chain: 999999' })
  })

  it('returns a header-only file when the user has no accounts', async () => {
    stubExplorers()
    routeDbQueries({ smart_accounts: [] })

    const response = await get('?fresh=1')

    expect(response.statusCode).toBe(200)
    expect(response.headers['x-export-row-count']).toBe('0')
    expect(response.body.slice(1)).toBe(TRANSACTION_CSV_COLUMNS.join(','))
  })
})
