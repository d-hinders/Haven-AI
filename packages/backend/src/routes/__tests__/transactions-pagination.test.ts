/**
 * The route-level half of #2884: pagination past the first explorer window
 * has to reach the three consumers downstream of the legs — `total`, the
 * page's hasMore, and the CSV export — with `truncated` (#2882) reporting
 * the cap honestly.
 *
 * The loop mechanics have their own unit test (`explorer-pagination.test.ts`);
 * here a multi-page stub runs the whole `GET /transactions` pipeline so the
 * assertions are about what a caller actually receives. All fixtures use one
 * Blockscout account (the default chain) or one Etherscan-shaped one, distinct
 * hashes per page so dedupe cannot mask a page the loop failed to take, and a
 * fresh address per test because the per-account cache outlives a case.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import transactionRoutes from '../transactions.js'
import pool from '../../db.js'
import { EXPLORER_PAGE_SIZE } from '../../infra/explorer-api.js'

const SENDER = '0xAAAA0000000000000000000000000000000000A1'

function jsonResponse(body: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as Response)
}

function nativeItems(count: number, firstBlock: number, safe: string) {
  return Array.from({ length: count }, (_, i) => ({
    hash: `0x${(firstBlock + i).toString(16).padStart(64, '0')}`,
    block_number: firstBlock + i,
    timestamp: '2026-05-08T11:49:59Z',
    from: { hash: SENDER },
    to: { hash: safe },
    value: '1000000000000000000',
    gas_limit: '21000',
    gas_used: '21000',
    status: 'ok',
    method: null,
  }))
}

function etherscanRows(count: number, firstBlock: number, safe: string) {
  return Array.from({ length: count }, (_, i) => ({
    blockNumber: String(firstBlock + i),
    timeStamp: '1778240999',
    hash: `0x${(firstBlock + i).toString(16).padStart(64, '0')}`,
    from: SENDER,
    to: safe,
    value: '1000000000000000000',
    gas: '21000',
    gasUsed: '21000',
    isError: '0',
    functionName: '',
  }))
}

/**
 * Blockscout pagination fixture. `pages` maps the page's cursor marker (its
 * `next_page_params.block_number`, echoed back on the following request URL)
 * to the rows it holds and the next cursor; the key `null` is page 1. A page
 * whose cursor is `null` ENDS the feed — the provider has no more.
 */
function stubBlockscoutPages(
  safe: string,
  pages: Record<string, { rows: number; firstBlock: number; next: number | null }>,
) {
  const fetchMock = vi.fn((input: string | URL) => {
    const url = String(input)
    if (url.includes('/token-transfers')) {
      return jsonResponse({ items: [], next_page_params: null })
    }
    // Page 1 carries no cursor params; later pages carry the block_number the
    // previous page's cursor asked for.
    let key: string | null = null
    for (const candidate of Object.keys(pages)) {
      if (candidate !== 'null' && url.includes(`block_number=${candidate}`)) {
        key = candidate
        break
      }
    }
    if (key === null) key = 'null'
    const page = pages[key]
    return jsonResponse({
      items: nativeItems(page.rows, page.firstBlock, safe),
      next_page_params: page.next === null ? null : { block_number: page.next, index: 0, items_count: 50 },
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** Etherscan-shaped fixture: `page` is honoured, one row-count per page, then exhausted. */
function stubEtherscanPages(safe: string, pageRows: number[]) {
  const fetchMock = vi.fn((input: string | URL) => {
    const url = new URL(String(input))
    const action = url.searchParams.get('action')
    if (action !== 'txlist') {
      return jsonResponse({ status: '1', message: 'OK', result: [] })
    }
    const page = Number(url.searchParams.get('page') ?? '1')
    const rows = pageRows[page - 1] ?? 0
    return jsonResponse({
      status: '1',
      message: 'OK',
      result: rows > 0 ? etherscanRows(rows, 45_000_000 - page * 1000, safe) : [],
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function routeDbQueries(safes: unknown[]) {
  return vi.spyOn(pool, 'query').mockImplementation(
    (async (sql: unknown) => {
      if (String(sql).includes('FROM user_safes')) return { rows: safes }
      return { rows: [] }
    }) as never,
  )
}

describe('GET /transactions — pagination past the first window (#2884)', () => {
  let app: FastifyInstance
  let counter = 0

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

  function uniqueSafe(chainId = 8453) {
    counter += 1
    const address = `0x${counter.toString(16).padStart(40, '0')}`
    return {
      address,
      rows: [
        {
          id: `11111111-1111-4111-8111-${counter.toString().padStart(12, '0')}`,
          safe_address: address,
          chain_id: chainId,
          name: 'Account',
        },
      ],
    }
  }

  function get(query = '') {
    const token = app.jwt.sign({ sub: 'user-1', email: 'test@example.com' }, { expiresIn: '1h' })
    return app.inject({
      method: 'GET',
      url: `/transactions${query}`,
      headers: { authorization: `Bearer ${token}` },
    })
  }

  it('feeds the list route past one window: total, rows and hasMore all reflect four pages', async () => {
    // Four FULL pages with the provider still offering a fifth: the loop
    // stops at the budget and says so. #2882 capped this read at the first
    // page — total 50, truncated true. Now: 200 rows counted, the page the
    // caller sees paginated on top of them, truncated STILL true because the
    // source provably has more beyond the budget.
    const safe = uniqueSafe()
    const fetchMock = stubBlockscoutPages(safe.address, {
      null: { rows: EXPLORER_PAGE_SIZE, firstBlock: 45_000_000, next: 44_999_900 },
      44_999_900: { rows: EXPLORER_PAGE_SIZE, firstBlock: 44_999_900, next: 44_999_800 },
      44_999_800: { rows: EXPLORER_PAGE_SIZE, firstBlock: 44_999_800, next: 44_999_700 },
      44_999_700: { rows: EXPLORER_PAGE_SIZE, firstBlock: 44_999_700, next: 44_999_600 },
    })
    routeDbQueries(safe.rows)

    const response = await get('?fresh=1')
    const body = response.json()

    expect(response.statusCode).toBe(200)
    expect(body.total).toBe(EXPLORER_PAGE_SIZE * 4)
    expect(body.transactions).toHaveLength(25) // the route's own page, default limit
    expect(body.hasMore).toBe(true)
    expect(body.truncated).toBe(true)

    // Exactly the budget's worth of native-leg fetches, each following the
    // cursor the previous page handed back.
    const nativeCalls = fetchMock.mock.calls.filter(
      (call) => String(call[0]).includes('/transactions') && !String(call[0]).includes('token-transfers'),
    )
    expect(nativeCalls).toHaveLength(4)
    expect(String(nativeCalls[1][0])).toContain('block_number=44999900')
    expect(String(nativeCalls[2][0])).toContain('block_number=44999800')
    expect(String(nativeCalls[3][0])).toContain('block_number=44999700')
  })

  it('reports truncated: false when pagination reaches an exhausted source', async () => {
    // Two full pages, then a short one: the loop walks out the other side of
    // the feed. This is the read #2882 could only hedge about ("a full page
    // MIGHT have more") — with pagination the short page is a real answer,
    // so a 130-row history now reports COMPLETE instead of carrying a caveat
    // forever.
    const safe = uniqueSafe()
    stubBlockscoutPages(safe.address, {
      null: { rows: EXPLORER_PAGE_SIZE, firstBlock: 45_000_000, next: 44_999_900 },
      44_999_900: { rows: EXPLORER_PAGE_SIZE, firstBlock: 44_999_900, next: 44_999_800 },
      44_999_800: { rows: 30, firstBlock: 44_999_800, next: null },
    })
    routeDbQueries(safe.rows)

    const response = await get('?fresh=1')
    const body = response.json()

    expect(body.total).toBe(EXPLORER_PAGE_SIZE * 2 + 30)
    expect(body.truncated).toBe(false)
  })

  it('pages the cursorless Gnosis legs until a short page, without claiming truncation', async () => {
    const safe = uniqueSafe(100)
    const fetchMock = stubEtherscanPages(safe.address, [EXPLORER_PAGE_SIZE, 20])
    routeDbQueries(safe.rows)

    const response = await get('?fresh=1')
    const body = response.json()

    expect(body.total).toBe(EXPLORER_PAGE_SIZE + 20)
    expect(body.truncated).toBe(false)

    // Page sequence of the NATIVE leg (internal/erc20 make their own
    // short-first-page single fetches).
    const txlistCalls = fetchMock.mock.calls.filter(
      (call) => new URL(String(call[0])).searchParams.get('action') === 'txlist',
    )
    expect(txlistCalls.map((call) => new URL(String(call[0])).searchParams.get('page'))).toEqual([
      '1',
      '2',
    ])
    // The page size is requested explicitly on every hop.
    expect(String(txlistCalls[1][0])).toContain(`offset=${EXPLORER_PAGE_SIZE}`)
  })

  it('exports past one window: the CSV carries every page the loop read', async () => {
    // #2871's export over a feed that stops at the budget-with-more case:
    // 150 rows across three pages, of which #2882's one-window cap would
    // have written only the first fifty to the file.
    const safe = uniqueSafe()
    stubBlockscoutPages(safe.address, {
      null: { rows: EXPLORER_PAGE_SIZE, firstBlock: 45_000_000, next: 44_999_900 },
      44_999_900: { rows: EXPLORER_PAGE_SIZE, firstBlock: 44_999_900, next: 44_999_800 },
      44_999_800: { rows: 50, firstBlock: 44_999_800, next: null },
    })
    routeDbQueries(safe.rows)

    const token = app.jwt.sign({ sub: 'user-1', email: 'test@example.com' }, { expiresIn: '1h' })
    const response = await app.inject({
      method: 'GET',
      url: '/transactions/export.csv?fresh=1',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['x-export-row-count']).toBe(String(EXPLORER_PAGE_SIZE * 3))
    // Header + three pages' worth of records, newline-terminated.
    const dataLines = response.body.slice(1).trimEnd().split('\r\n')
    expect(dataLines).toHaveLength(EXPLORER_PAGE_SIZE * 3 + 1)
  })
})
