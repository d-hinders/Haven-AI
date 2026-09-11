/**
 * The truncation signal on `GET /transactions` (#2882).
 *
 * Each explorer leg reports for itself whether more rows exist beyond the
 * ones it returned. On Blockscout (the default chain's provider) that is the
 * `next_page_params` cursor, NOT a row count: `fetchFromV2` sends no page-size
 * parameter and slices locally, so counting rows there would measure
 * Blockscout's own default rather than anything Haven asked for, and would
 * start lying the day that default changed. The Etherscan-shaped legs have no
 * cursor, so they fall back to a full page.
 *
 * These tests pin both mechanisms, both directions, and the per-account cache
 * — which is where a naive implementation drops the flag.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import transactionRoutes from '../transactions.js'
import pool from '../../db.js'
import { EXPLORER_PAGE_SIZE } from '../../infra/explorer-api.js'
import { expectMatchesSpec } from '../../openapi/response-shape.js'

const SENDER = '0xAAAA0000000000000000000000000000000000A1'

function jsonResponse(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response)
}

interface LegOptions {
  /** Rows the native leg returns. */
  native?: number
  /** Rows the ERC-20 leg returns. */
  erc20?: number
  /** Whether Blockscout reports another page for the native leg. */
  nativeNextPage?: boolean
  /** Whether Blockscout reports another page for the ERC-20 leg. */
  erc20NextPage?: boolean
}

function nativeItems(count: number, safe: string) {
  return Array.from({ length: count }, (_, i) => ({
    hash: `0x${(i + 1).toString(16).padStart(64, '0')}`,
    block_number: 45_000_000 + i,
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

function erc20Items(count: number, safe: string) {
  return Array.from({ length: count }, (_, i) => ({
    transaction_hash: `0x${(i + 5001).toString(16).padStart(64, '0')}`,
    block_number: 46_000_000 + i,
    timestamp: '2026-05-08T11:49:59Z',
    from: { hash: SENDER },
    to: { hash: safe },
    total: { value: '1000000', decimals: '6' },
    token: { address_hash: '0xusdc', name: 'USD Coin', symbol: 'USDC', decimals: '6' },
  }))
}

/** Stubs the Base (Blockscout v2) legs for one account. */
function stubBlockscout(safe: string, opts: LegOptions) {
  const fetchMock = vi.fn((input: string | URL) => {
    const url = String(input)
    if (url.includes('/token-transfers')) {
      return jsonResponse({
        items: erc20Items(opts.erc20 ?? 0, safe),
        next_page_params: opts.erc20NextPage ? { block_number: 1 } : null,
      })
    }
    if (url.includes('/addresses/') && url.includes('/transactions')) {
      return jsonResponse({
        items: nativeItems(opts.native ?? 0, safe),
        next_page_params: opts.nativeNextPage ? { block_number: 1 } : null,
      })
    }
    return jsonResponse({ items: [], next_page_params: null })
  })

  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/**
 * Stubs the Gnosis (etherscan-v2) legs. That provider has no cursor, so
 * `hasMore` there is `rows.length >= offset` — a different mechanism from
 * Blockscout's, live for every Gnosis account, and the half these tests
 * would otherwise leave unpinned.
 */
function stubEtherscan(safe: string, nativeRows: number) {
  const result = Array.from({ length: nativeRows }, (_, i) => ({
    blockNumber: String(45_000_000 + i),
    timeStamp: '1778240999',
    hash: `0x${(i + 9001).toString(16).padStart(64, '0')}`,
    from: SENDER,
    to: safe,
    value: '1000000000000000000',
    gas: '21000',
    gasUsed: '21000',
    isError: '0',
    functionName: '',
  }))

  const fetchMock = vi.fn((input: string | URL) => {
    const url = String(input)
    if (url.includes('action=txlist') && !url.includes('txlistinternal')) {
      return jsonResponse({ status: '1', message: 'OK', result })
    }
    return jsonResponse({ status: '1', message: 'OK', result: [] })
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

describe('GET /transactions — truncation signal (#2882)', () => {
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

  /**
   * A distinct address per test. The per-account cache outlives each case, so
   * a shared address would let one test read another's result.
   */
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

  it('matches the documented response shape, truncated field included', async () => {
    // The backend playbook (#1444) asks for this whenever a documented
    // route's response changes. It is also the guard that catches a fixture
    // modelling a response the server cannot emit: `truncated` is required
    // and the schema is `additionalProperties: false`.
    const safe = uniqueSafe()
    stubBlockscout(safe.address, { native: 10, nativeNextPage: true })
    routeDbQueries(safe.rows)

    const response = await get('?fresh=1')

    // Envelope only, deliberately. Asserting the whole payload trips a
    // PRE-EXISTING validator bug this assertion surfaced (#2885): the spec's
    // `Transaction` correctly declares `chainId`/`safeId`/`safeAddress`/
    // `safeName` in an `allOf` branch, but `response-shape.ts` closes the
    // `$ref`'d `TransactionBase` where it is ALSO registered standalone, so
    // the composed schema rejects its own sibling's properties. The contract
    // is right and the validator is wrong, which is not #2882's to fix — so
    // the rows are emptied here rather than the envelope guard dropped.
    const body = response.json() as Record<string, unknown>
    expectMatchesSpec('GET', '/transactions', { ...body, transactions: [] })
  })

  it('reports truncated when Blockscout offers another page', async () => {
    const safe = uniqueSafe()
    stubBlockscout(safe.address, { native: 10, nativeNextPage: true })
    routeDbQueries(safe.rows)

    const response = await get('?fresh=1')

    expect(response.statusCode).toBe(200)
    expect(response.json().truncated).toBe(true)
  })

  it('does NOT report truncated on a full page with no cursor', async () => {
    // The load-bearing case. Blockscout takes no page-size parameter, so a
    // response holding exactly EXPLORER_PAGE_SIZE rows says nothing about
    // whether more exist — only the cursor does. Counting rows here would
    // measure Blockscout's default and claim a truncation that is not real.
    const safe = uniqueSafe()
    stubBlockscout(safe.address, { native: EXPLORER_PAGE_SIZE, nativeNextPage: false })
    routeDbQueries(safe.rows)

    const response = await get('?fresh=1')

    expect(response.json().truncated).toBe(false)
  })

  it('reports truncated from the ERC-20 leg, not just the native one', async () => {
    // On a stablecoin account this is the realistic truncation: no native
    // transfers at all, a full page of USDC.
    const safe = uniqueSafe()
    stubBlockscout(safe.address, { native: 2, erc20: 25, erc20NextPage: true })
    routeDbQueries(safe.rows)

    const response = await get('?fresh=1')

    expect(response.json().truncated).toBe(true)
  })

  it('does not report truncated for an account with no history', async () => {
    const safe = uniqueSafe()
    stubBlockscout(safe.address, {})
    routeDbQueries(safe.rows)

    const response = await get('?fresh=1')

    expect(response.json().truncated).toBe(false)
  })

  it('reports truncated: false when the user has no accounts at all', async () => {
    const safe = uniqueSafe()
    stubBlockscout(safe.address, {})
    routeDbQueries([])

    const response = await get('?fresh=1')

    expect(response.json()).toMatchObject({ truncated: false, total: 0 })
  })

  it('keeps the flag across a cache hit', async () => {
    // The second read is served from the per-account cache. If the flag did
    // not ride with the rows, this is where a capped read would start
    // reporting itself as complete for the rest of the TTL.
    const safe = uniqueSafe()
    stubBlockscout(safe.address, { native: 10, nativeNextPage: true })
    routeDbQueries(safe.rows)

    const first = await get('?fresh=1')
    expect(first.json().truncated).toBe(true)

    const second = await get()
    expect(second.json().truncated).toBe(true)
  })

  it('reports truncated on a cursorless provider when a leg returns a full page', async () => {
    // Gnosis: `offset` really is requested, so a full page IS evidence the
    // source had more. This is the other mechanism, and it is live.
    const safe = uniqueSafe(100)
    stubEtherscan(safe.address, EXPLORER_PAGE_SIZE)
    routeDbQueries(safe.rows)

    const response = await get('?fresh=1')

    expect(response.json().truncated).toBe(true)
  })

  it('does not report truncated on a cursorless provider one row below the window', async () => {
    const safe = uniqueSafe(100)
    stubEtherscan(safe.address, EXPLORER_PAGE_SIZE - 1)
    routeDbQueries(safe.rows)

    const response = await get('?fresh=1')

    expect(response.json().truncated).toBe(false)
  })

  it('is independent of partialFailure', async () => {
    const safe = uniqueSafe()
    stubBlockscout(safe.address, { native: 10, nativeNextPage: true })
    routeDbQueries(safe.rows)

    const response = await get('?fresh=1')

    expect(response.json().truncated).toBe(true)
    expect(response.json().partialFailure).toBe(false)
  })

  it('does not let a FAILED leg claim the feed is truncated', async () => {
    // A leg that threw is unknown, not capped. Reporting truncation from a
    // failure would tell the user their history is longer than shown when
    // the real answer is that we could not read it.
    const safe = uniqueSafe()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('explorer down'))),
    )
    routeDbQueries(safe.rows)

    const response = await get('?fresh=1')

    expect(response.json().truncated).toBe(false)
    expect(response.json().partialFailure).toBe(true)
  })
})
