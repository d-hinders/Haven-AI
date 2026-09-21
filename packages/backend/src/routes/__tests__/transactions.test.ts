import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import transactionRoutes from '../transactions.js'
import { installRequestValidation } from '../../openapi/request-validation.js'
// #992: aggregation/enrichment/caching moved to src/modules/transactions/ —
// these characterization tests (committed before the move) now import them
// from there. Only this import changed; no test body or assertion did.
import {
  type EnrichedTransaction,
  buildTransactionCacheKey,
  enrichTransactionsWithAgents,
  fetchAccountTransactions,
  mergeX402Transactions,
} from '../../modules/transactions/index.js'
import pool from '../../db.js'
import { expectMatchesSpec } from '../../openapi/response-shape.js'

const SAFE_ADDRESS = '0x135a9215604711AC70d970e12Caa812c53537EF4'
const LOWERCASE_SAFE_ADDRESS = SAFE_ADDRESS.toLowerCase()
const SENDER = '0x55C9d84427756D6f82480427Bb778F6dc0cC755E'
const TX_HASH = '0x72d03a8ff551e443c118c93c54d32260941deb613e51fcd2733cd3455e8fa1a1'
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

/** SQL-routing feed mock — the db-mock ratchet (#1227) forbids growing the
 * positional resolved-once chain in this file, so new feed tests route
 * queries by table instead (same pattern as machine-payments.test.ts).
 * #2055: no more `approval_requests` branch — the table (and every query
 * against it) is gone, so `payment_intents` is the only feed source left. */
function routeFeedQueries(rows: { payment_intents?: unknown[] } = {}) {
  return vi.spyOn(pool, 'query').mockImplementation(
    (async (sql: unknown) => {
      const text = String(sql)
      if (text.includes('FROM payment_intents')) return { rows: rows.payment_intents ?? [] }
      return { rows: [] }
    }) as never,
  )
}

/** A distinct Safe address per cache-behavior test avoids cross-test cache pollution — the
 * module-level cache persists for the lifetime of this test file (see `#992 caching` below). */
const CACHE_TEST_SAFE_ADDRESS_1 = '0xCACE00000000000000000000000000000000CAC1'
const CACHE_TEST_SAFE_ADDRESS_2 = '0xCACE00000000000000000000000000000000CAC2'

function nativeTx(hash: string, blockNumber: number, timestamp: string) {
  return {
    hash,
    block_number: blockNumber,
    timestamp,
    from: { hash: SENDER },
    to: { hash: SAFE_ADDRESS },
    value: '1000000000000000000',
    gas_limit: '21000',
    gas_used: '21000',
    status: 'ok',
    method: null,
  }
}

function erc20Tx(hash: string, blockNumber: number, timestamp: string, value: string) {
  return {
    transaction_hash: hash,
    block_number: blockNumber,
    timestamp,
    from: { hash: SENDER },
    to: { hash: SAFE_ADDRESS },
    total: { decimals: '6', value },
    token: {
      address_hash: USDC_ADDRESS,
      name: 'USD Coin',
      symbol: 'USDC',
      decimals: '6',
    },
  }
}

/**
 * Base-chain (blockscout-v2) fixture with THREE native transactions (distinct
 * hashes/timestamps, newest first by block) and ONE ERC-20 transfer — enough
 * to characterize pagination and tokenKey filtering deterministically.
 */
function stubMixedTransactionFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = input.toString()

    if (url.includes('/api/v1/safes/') && url.includes('/transfers/')) {
      return jsonResponse({ count: 0, next: null, previous: null, results: [] })
    }

    if (url.includes('/addresses/') && url.includes('/token-transfers')) {
      return jsonResponse({
        items: [erc20Tx('0xE20000000000000000000000000000000000000000000000000000000E20', 100, '2026-05-01T00:00:00Z', '5000000')],
        next_page_params: null,
      })
    }

    if (url.includes('/addresses/') && url.includes('/transactions')) {
      return jsonResponse({
        items: [
          nativeTx('0xAAA0000000000000000000000000000000000000000000000000000000AAA', 300, '2026-05-03T00:00:00Z'),
          nativeTx('0xBBB0000000000000000000000000000000000000000000000000000000BBB', 200, '2026-05-02T00:00:00Z'),
          nativeTx('0xCCC0000000000000000000000000000000000000000000000000000000CCC', 100, '2026-05-01T12:00:00Z'),
        ],
        next_page_params: null,
      })
    }

    throw new Error(`Unexpected fetch URL: ${url}`)
  })

  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function stubEmptyTransactionFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = input.toString()

    if (url.includes('/api/v1/safes/') && url.includes('/transfers/')) {
      return jsonResponse({ count: 0, next: null, previous: null, results: [] })
    }

    if (url.includes('/addresses/') && url.includes('/transactions')) {
      return jsonResponse({ items: [], next_page_params: null })
    }

    if (url.includes('/addresses/') && url.includes('/token-transfers')) {
      return jsonResponse({ items: [], next_page_params: null })
    }

    if (url.includes('module=account')) {
      return jsonResponse({ status: '1', message: 'OK', result: [] })
    }

    throw new Error(`Unexpected fetch URL: ${url}`)
  })

  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function stubOneNativeTransactionFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = input.toString()

    if (url.includes('/api/v1/safes/') && url.includes('/transfers/')) {
      return jsonResponse({ count: 0, next: null, previous: null, results: [] })
    }

    if (url.includes('/addresses/') && url.includes('/token-transfers')) {
      return jsonResponse({ items: [], next_page_params: null })
    }

    if (url.includes('/addresses/') && url.includes('/transactions')) {
      return jsonResponse({
        items: [{
          hash: TX_HASH,
          block_number: 45725826,
          timestamp: '2026-05-08T11:49:59Z',
          timestampSource: 'block',
          from: { hash: SENDER },
          to: { hash: SAFE_ADDRESS },
          value: '1000000000000000000',
          gas_limit: '21000',
          gas_used: '21000',
          status: 'ok',
          method: null,
        }],
        next_page_params: null,
      })
    }

    if (url.includes('module=account') && url.includes('action=txlistinternal')) {
      return jsonResponse({ status: '1', message: 'OK', result: [] })
    }

    if (url.includes('module=account') && url.includes('action=tokentx')) {
      return jsonResponse({ status: '1', message: 'OK', result: [] })
    }

    if (url.includes('module=account') && url.includes('action=txlist')) {
      return jsonResponse({
        status: '1',
        message: 'OK',
        result: [{
          blockNumber: '45725826',
          timeStamp: '1778240999',
          hash: TX_HASH,
          from: SENDER,
          to: SAFE_ADDRESS,
          value: '1000000000000000000',
          gas: '21000',
          gasUsed: '21000',
          isError: '0',
          functionName: '',
        }],
      })
    }

    throw new Error(`Unexpected fetch URL: ${url}`)
  })

  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('transaction routes', () => {
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

  function signToken(payload: { sub: string; email: string }): string {
    return app.jwt.sign(payload, { expiresIn: '1h' })
  }

  function mockSafeRows(rows: Array<{ id: string; chain_id: number }>) {
    return vi.spyOn(pool, 'query').mockImplementation(async (sql: unknown) => {
      if (String(sql).includes('FROM smart_accounts')) {
        return { rows } as never
      }
      return { rows: [] } as never
    })
  }

  it('uses the requested owned chain when fetching legacy Safe transactions', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    const fetchMock = stubEmptyTransactionFetch()
    const queryMock = mockSafeRows([{ id: 'safe-base', chain_id: 8453 }])

    const response = await app.inject({
      method: 'GET',
      url: `/transactions/${SAFE_ADDRESS}?page=1&limit=10&chain_id=8453&fresh=1`,
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('AND chain_id = $3'),
      ['user-1', SAFE_ADDRESS, 8453],
    )
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('https://base.blockscout.com/api/v2/addresses/'),
    )
    expect(response.json()).toMatchObject({
      transactions: [],
      total: 0,
      page: 1,
      limit: 10,
      pages: 0,
    })
  })

  it('keeps legacy address-only transaction reads when one chain owns the address', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    const fetchMock = stubEmptyTransactionFetch()
    const queryMock = mockSafeRows([{ id: 'safe-gnosis', chain_id: 100 }])

    const response = await app.inject({
      method: 'GET',
      url: `/transactions/${SAFE_ADDRESS}?page=1&limit=10&fresh=1`,
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    expect(queryMock).toHaveBeenCalledWith(
      expect.not.stringContaining('AND chain_id = $3'),
      ['user-1', SAFE_ADDRESS],
    )
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('https://api.etherscan.io/v2/api'),
    )
  })

  it('requires chain_id for legacy transaction reads matching multiple owned chains', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    const fetchMock = stubEmptyTransactionFetch()
    mockSafeRows([
      { id: 'safe-gnosis', chain_id: 100 },
      { id: 'safe-base', chain_id: 8453 },
    ])

    const response = await app.inject({
      method: 'GET',
      url: `/transactions/${SAFE_ADDRESS}?page=1&limit=10`,
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('chain_id required')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects malformed chain_id values before transaction ownership lookup', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    const fetchMock = stubEmptyTransactionFetch()
    const queryMock = vi.spyOn(pool, 'query')

    const response = await app.inject({
      method: 'GET',
      url: `/transactions/${SAFE_ADDRESS}?chain_id=8453.5`,
      headers: { authorization: `Bearer ${token}` },
    })

    // #3030: the shape refusal is the spec's (`integer, minimum: 1`), the
    // enforced module's envelope; the handler never runs.
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: 'Request does not match the API spec', error_code: 'invalid_request' })
    expect(response.json().details).toContain('querystring/chain_id')
    expect(queryMock).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses every off-spec filter with the 400 envelope before any query or fetch (#3030)', async () => {
    // Each of these was a hand-rolled 400 in the handler before the module
    // was enforced: pagination bounds, the uuid filters, `agentId` as
    // `user`-or-uuid, `tokenKey` as `<chain>:<address|native>`, the
    // `direction` enum, the address pattern, positive chain ids. Mutation:
    // drop the module from enforcedModules → the non-uuid accountId reaches
    // `listBasicAccountsForUser` (queryMock called).
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    const fetchMock = stubEmptyTransactionFetch()
    const queryMock = vi.spyOn(pool, 'query')
    const cases: Array<[string, string]> = [
      ['/transactions?limit=500', 'querystring/limit'],
      ['/transactions?offset=-1', 'querystring/offset'],
      ['/transactions?accountId=not-a-uuid', 'querystring/accountId'],
      ['/transactions?agentId=nope', 'querystring/agentId'],
      ['/transactions?tokenKey=garbage', 'querystring/tokenKey'],
      ['/transactions?tokenKey=0:native', 'querystring/tokenKey'],
      ['/transactions/export.csv?direction=sideways', 'querystring/direction'],
      ['/transactions/export.csv?chainId=0', 'querystring/chainId'],
      ['/transactions/payment-intents/not-a-uuid/evidence', 'params/paymentId'],
      ['/transactions/not-an-address', 'params/accountAddress'],
      [`/transactions/${SAFE_ADDRESS}?page=0`, 'querystring/page'],
      [`/transactions/${SAFE_ADDRESS}?chain_id=-1`, 'querystring/chain_id'],
    ]
    for (const [url, field] of cases) {
      const response = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } })
      expect(response.statusCode, url).toBe(400)
      expect(response.json(), url).toMatchObject({ error: 'Request does not match the API spec', statusCode: 400, error_code: 'invalid_request' })
      expect(response.json().details, url).toContain(field)
    }
    expect(queryMock).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()

    // The literal `user` and a uuid are the two conformant agentId spellings.
    queryMock.mockResolvedValue({ rows: [] } as never)
    const ok = await app.inject({ method: 'GET', url: '/transactions?agentId=user&tokenKey=8453:native&limit=100', headers: { authorization: `Bearer ${token}` } })
    expect(ok.statusCode).not.toBe(400)
  })

  it('rejects unsupported transaction chains before ownership lookup', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    const fetchMock = stubEmptyTransactionFetch()
    const queryMock = vi.spyOn(pool, 'query')

    const response = await app.inject({
      method: 'GET',
      url: `/transactions/${SAFE_ADDRESS}?chain_id=999999`,
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('Unsupported chain: 999999')
    expect(queryMock).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not fall back to another chain when requested transaction chain is not owned', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    const fetchMock = stubEmptyTransactionFetch()
    const queryMock = mockSafeRows([])

    const response = await app.inject({
      method: 'GET',
      url: `/transactions/${SAFE_ADDRESS}?chain_id=8453`,
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json().error).toBe('Not your Safe')
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('AND chain_id = $3'),
      ['user-1', SAFE_ADDRESS, 8453],
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // #3132 (owner decision 3 on #3130): every row states its population and
  // its narrowing as two values. The feed is wallet-scoped; agentId /
  // accountId narrow it. Explorer rows mark their timestamp as the block's.
  describe('per-row scope and marked timestamp (#3132)', () => {
    const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222'
    const AGENT_ID = '33333333-3333-4333-8333-333333333333'
    const INTENT_ID = '44444444-4444-4444-8444-444444444444'
    /** One account, one agent, and one confirmed x402 intent WITHOUT a confirmation time and WITHOUT an evidence row. */
    function mockOneAccountOneIntent() {
      vi.spyOn(pool, 'query').mockImplementation(async (sql: unknown) => {
        const text = String(sql)
        if (text.includes('FROM smart_accounts') && text.includes('ORDER BY created_at ASC')) {
          return { rows: [{ id: ACCOUNT_ID, account_address: SAFE_ADDRESS, chain_id: 8453, name: 'Base wallet' }] } as never
        }
        if (text.includes("pi.source = 'x402'")) {
          return { rows: [{
            id: INTENT_ID, tx_hash: '0x' + 'cd'.repeat(32), agent_id: AGENT_ID, agent_name: 'Buyer',
            account_id: ACCOUNT_ID, account_address: SAFE_ADDRESS, account_name: 'Base wallet', chain_id: 8453,
            token_symbol: 'USDC', token_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', to_address: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
            amount_raw: '20000', amount_human: '0.02', x402_merchant_address: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
            x402_resource_url: 'https://merchant.example/paid', payment_proof_status: null, payment_reconciliation_event_type: null,
            amount_sek: null, fx_rate_sek: null, fx_source: null, settlement_scheme: 'erc7710', confirmed_at: null, created_at: '2026-09-18T09:59:00.000Z',
          }] } as never
        }
        if (text.includes('FROM agents')) return { rows: [{ id: AGENT_ID }] } as never
        return { rows: [] } as never
      })
    }
    async function rowsFor(query: string) {
      const token = signToken({ sub: 'user-1', email: 'test@example.com' })
      stubOneNativeTransactionFetch()
      mockOneAccountOneIntent()
      const response = await app.inject({ method: 'GET', url: `/transactions?limit=10&fresh=1${query}`, headers: { authorization: `Bearer ${token}` } })
      expect(response.statusCode).toBe(200)
      const body = response.json() as { transactions: Array<Record<string, unknown>> }
      expectMatchesSpec('GET', '/transactions', body)
      // The guard is only evidence if it found rows to check.
      expect(body.transactions.length).toBeGreaterThan(0)
      return body
    }

    it('unfiltered: every row is { source: wallet, filter: null }; the explorer row says block, the x402 row says created_at with a null confirmedAt and a null proof status', async () => {
      const { transactions } = await rowsFor('')
      expect(transactions).toHaveLength(2)
      for (const tx of transactions) expect(tx.scope).toEqual({ source: 'wallet', filter: null })
      const explorer = transactions.find((tx) => tx.source !== 'x402')!
      const synthesized = transactions.find((tx) => tx.source === 'x402')!
      expect(explorer.timestampSource).toBe('block')
      expect(explorer).not.toHaveProperty('confirmedAt')
      expect(synthesized.timestampSource).toBe('created_at')
      expect(synthesized.confirmedAt).toBeNull()
      expect(synthesized.paymentProofStatus).toBeNull()
      expect(synthesized.paymentFlowStatus).toBe('confirming_merchant')
    })

    it('agentId narrows: filter agent — the population is still the wallet, never the receipts view', async () => {
      const { transactions } = await rowsFor(`&agentId=${AGENT_ID}`)
      expect(transactions).toHaveLength(1)
      for (const tx of transactions) expect(tx.scope).toEqual({ source: 'wallet', filter: 'agent' })
    })

    it('accountId narrows: filter account; both: account+agent', async () => {
      const a = await rowsFor(`&accountId=${ACCOUNT_ID}`)
      for (const tx of a.transactions) expect(tx.scope).toEqual({ source: 'wallet', filter: 'account' })
      const b = await rowsFor(`&accountId=${ACCOUNT_ID}&agentId=${AGENT_ID}`)
      expect(b.transactions).toHaveLength(1)
      for (const tx of b.transactions) expect(tx.scope).toEqual({ source: 'wallet', filter: 'account+agent' })
    })

    it('additive: the pre-#3132 row shape (no scope, no timestampSource, no confirmedAt) still validates against the spec', async () => {
      const body = await rowsFor('')
      const legacy = {
        ...body,
        transactions: body.transactions.map((tx) => {
          const { scope: _s, timestampSource: _t, confirmedAt: _c, ...rest } = tx
          return rest
        }),
      }
      expectMatchesSpec('GET', '/transactions', legacy)
    })
  })

  it('keeps aggregate transactions separate for the same Safe address on different chains', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    stubOneNativeTransactionFetch()
    vi.spyOn(pool, 'query').mockImplementation(async (sql: unknown) => {
      const text = String(sql)
      if (text.includes('FROM smart_accounts') && text.includes('ORDER BY created_at ASC')) {
        return {
          rows: [
            {
              // #2885: expectMatchesSpec below actually checks the uuid
              // format now — a fixture id of `'safe-gnosis'` fails it,
              // correctly (same lesson #1444 recorded for `'agent-1'`).
              id: '11111111-1111-4111-8111-111111111111',
              account_address: SAFE_ADDRESS,
              chain_id: 100,
              name: 'Gnosis wallet',
            },
            {
              id: '22222222-2222-4222-8222-222222222222',
              account_address: SAFE_ADDRESS,
              chain_id: 8453,
              name: 'Base wallet',
            },
          ],
        } as never
      }
      return { rows: [] } as never
    })

    const response = await app.inject({
      method: 'GET',
      url: '/transactions?limit=10&fresh=1',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.transactions).toHaveLength(2)
    expect(body.transactions.map((tx: { chainId: number }) => tx.chainId).sort()).toEqual([
      100,
      8453,
    ])
    // #2885: the FULL response, not an emptied stand-in — `Transaction` now
    // declares `chainId`/`safeId`/`safeAddress`/`safeName` (and `fxRateSek`/
    // `fxSource`, also missing from the contract), so this can actually pass.
    expectMatchesSpec('GET', '/transactions', body)
  })

  it('strips the aggregated-feed-only account fields from the legacy per-Safe response (#2885)', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    stubOneNativeTransactionFetch()
    const queryMock = mockSafeRows([{ id: 'safe-base', chain_id: 8453 }])

    const response = await app.inject({
      method: 'GET',
      url: `/transactions/${SAFE_ADDRESS}?page=1&limit=10&chain_id=8453&fresh=1`,
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    expect(queryMock).toHaveBeenCalled()
    const body = response.json()
    expect(body.transactions).toHaveLength(1)
    // The legacy route's destructure (`routes/transactions.ts`) drops these —
    // `TransactionsPageResponse` uses the narrow `TransactionBase`, which does
    // not declare them, so a leak would also fail `expectMatchesSpec` below.
    for (const field of ['chainId', 'accountId', 'accountAddress', 'accountName', 'agentId']) {
      expect(body.transactions[0]).not.toHaveProperty(field)
    }
    // Full payload against the spec's own schema — the same assertion the
    // feed test above makes, on the route whose `TransactionBase` schema was
    // never the composed one. #2914: the path segment is `{accountAddress}`
    // now — a single dynamic segment has no wire-visible name, so this was
    // always the same Fastify route as the old `{safeAddress}` spelling; only
    // the documented OpenAPI key moved.
    expectMatchesSpec('GET', '/transactions/{accountAddress}', body)
  })
})

describe('mergeX402Transactions', () => {
  it('requires chain context for x402 address fallback joins', async () => {
    const queryMock = vi.spyOn(pool, 'query').mockResolvedValue({ rows: [] } as never)

    await mergeX402Transactions(
      'user-id',
      [
        {
          id: 'safe-gnosis',
          account_address: SAFE_ADDRESS,
          chain_id: 100,
          name: 'Gnosis wallet',
        },
        {
          id: 'safe-base',
          account_address: SAFE_ADDRESS,
          chain_id: 8453,
          name: 'Base wallet',
        },
      ],
      [],
    )

    const paymentIntentSql = String(queryMock.mock.calls[0][0])

    expect(paymentIntentSql).toContain('LOWER(us.account_address) = LOWER(pi.account_address)')
    expect(paymentIntentSql).toContain('pi.chain_id IS NOT NULL')
    expect(paymentIntentSql).toContain('us.chain_id = pi.chain_id')
    expect(paymentIntentSql).not.toContain('us.id = a.account_id')
    // #2055: `findConfirmedX402ApprovalRequests` is gone with
    // `approval_requests` — confirmed x402 history is payment_intents alone,
    // so exactly one query fires here now.
    expect(queryMock.mock.calls).toHaveLength(1)
  })

  it('normalizes x402 funding intents into merchant-facing transactions', async () => {
    vi.spyOn(pool, 'query')
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'payment-id',
            tx_hash: TX_HASH,
            agent_id: 'agent-id',
            agent_name: 'Research assistant',
            account_id: 'safe-id',
            account_address: SAFE_ADDRESS,
            account_name: 'Main wallet',
            chain_id: 8453,
            token_symbol: 'USDC',
            token_address: USDC_ADDRESS,
            to_address: '0x1111111111111111111111111111111111111111',
            amount_raw: '20000',
            amount_human: '0.02',
            x402_merchant_address: '0x2222222222222222222222222222222222222222',
            x402_resource_url: 'https://api.example.com/data',
            payment_proof_status: 'protocol_receipt_attached',
            confirmed_at: '2026-05-08T11:50:10Z',
            created_at: '2026-05-08T11:49:55Z',
          },
        ],
      } as never)
      .mockResolvedValueOnce({ rows: [] } as never)

    const result = await mergeX402Transactions(
      'user-id',
      [{
        id: 'safe-id',
        account_address: SAFE_ADDRESS,
        chain_id: 8453,
        name: 'Main wallet',
      }],
      [{
        hash: TX_HASH,
        type: 'erc20',
        from: SAFE_ADDRESS,
        to: '0x1111111111111111111111111111111111111111',
        value: '20000',
        valueFormatted: '0.02',
        asset: 'USDC',
        decimals: 6,
        direction: 'out',
        timestamp: 1778240999,
        timestampSource: 'block',
        blockNumber: 45725826,
        isError: false,
        tokenAddress: USDC_ADDRESS,
        tokenSymbol: 'USDC',
        chainId: 8453,
        accountId: 'safe-id',
        accountAddress: SAFE_ADDRESS,
        accountName: 'Main wallet',
      }],
    )

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      hash: TX_HASH,
      from: SAFE_ADDRESS,
      to: '0x2222222222222222222222222222222222222222',
      value: '20000',
      valueFormatted: '0.02',
      asset: 'USDC',
      direction: 'out',
      source: 'x402',
      x402ResourceUrl: 'https://api.example.com/data',
      x402MerchantAddress: '0x2222222222222222222222222222222222222222',
      accountId: 'safe-id',
      accountName: 'Main wallet',
      agentId: 'agent-id',
      agentName: 'Research assistant',
      paymentId: 'payment-id',
      paymentProofStatus: 'protocol_receipt_attached',
      paymentFlowStatus: 'paid',
      paymentAttentionReason: null,
    })
  })

  it('keeps same-hash raw transactions on a different chain when merging x402 rows', async () => {
    vi.spyOn(pool, 'query')
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'payment-id',
            tx_hash: TX_HASH,
            agent_id: 'agent-id',
            agent_name: 'Research assistant',
            account_id: 'safe-id',
            account_address: SAFE_ADDRESS,
            account_name: 'Base wallet',
            chain_id: 8453,
            token_symbol: 'USDC',
            token_address: USDC_ADDRESS,
            to_address: '0x1111111111111111111111111111111111111111',
            amount_raw: '20000',
            amount_human: '0.02',
            x402_merchant_address: '0x2222222222222222222222222222222222222222',
            x402_resource_url: 'https://api.example.com/data',
            payment_proof_status: 'payment_confirmed',
            payment_reconciliation_event_type: null,
            confirmed_at: '2026-05-08T11:50:10Z',
            created_at: '2026-05-08T11:49:55Z',
          },
        ],
      } as never)
      .mockResolvedValueOnce({ rows: [] } as never)

    const result = await mergeX402Transactions(
      'user-id',
      [{
        id: 'safe-id',
        account_address: SAFE_ADDRESS,
        chain_id: 8453,
        name: 'Base wallet',
      }],
      [{
        hash: TX_HASH,
        type: 'erc20',
        from: SAFE_ADDRESS,
        to: '0x1111111111111111111111111111111111111111',
        value: '20000',
        valueFormatted: '0.02',
        asset: 'USDC',
        decimals: 6,
        direction: 'out',
        timestamp: 1778240999,
        timestampSource: 'block',
        blockNumber: 45725826,
        isError: false,
        tokenAddress: USDC_ADDRESS,
        tokenSymbol: 'USDC',
        chainId: 100,
        accountId: 'safe-id',
        accountAddress: SAFE_ADDRESS,
        accountName: 'Gnosis wallet',
      }],
    )

    expect(result).toHaveLength(2)
    expect(result.map((tx) => tx.chainId).sort()).toEqual([100, 8453])
    const rawGnosisTransaction = result.find((tx) => tx.chainId === 100)
    expect(rawGnosisTransaction).toMatchObject({
      hash: TX_HASH,
    })
    expect(rawGnosisTransaction?.source).toBeUndefined()
    expect(rawGnosisTransaction?.paymentId).toBeUndefined()
    expect(result.find((tx) => tx.chainId === 8453)).toMatchObject({
      hash: TX_HASH,
      source: 'x402',
      paymentId: 'payment-id',
    })
  })

  // #2055 (epic #1440, #2021 readability waiver): was "normalizes manually
  // approved x402 approval requests into merchant-facing transactions" —
  // `findConfirmedX402ApprovalRequests` is gone with `approval_requests`, so
  // there is no longer a second, approval-sourced merchant-facing x402
  // transaction to normalize. The behaviour it pinned (funding record →
  // merchant-facing transaction, with agent/proof enrichment) survives
  // unchanged on the payment_intents path and stays proven by "normalizes
  // x402 funding intents into merchant-facing transactions" above — this
  // test is deleted rather than converted because it would just be a
  // byte-for-byte duplicate of that one with the row source swapped.

  it('carries settlement_scheme from machine_metadata on a confirmed x402 payment intent (eip3009)', async () => {
    const spy = routeFeedQueries({
      payment_intents: [
        {
          id: 'payment-id',
          tx_hash: TX_HASH,
          agent_id: 'agent-id',
          agent_name: 'Research assistant',
          account_id: 'safe-id',
          account_address: SAFE_ADDRESS,
          account_name: 'Main wallet',
          chain_id: 8453,
          token_symbol: 'USDC',
          token_address: USDC_ADDRESS,
          to_address: '0x1111111111111111111111111111111111111111',
          amount_raw: '20000',
          amount_human: '0.02',
          x402_merchant_address: '0x2222222222222222222222222222222222222222',
          x402_resource_url: 'https://api.example.com/data',
          payment_proof_status: 'payment_confirmed',
          payment_reconciliation_event_type: null,
          settlement_scheme: 'eip3009',
          confirmed_at: '2026-05-08T11:50:10Z',
          created_at: '2026-05-08T11:49:55Z',
        },
      ],
    })

    const result = await mergeX402Transactions(
      'user-id',
      [{ id: 'safe-id', account_address: SAFE_ADDRESS, chain_id: 8453, name: 'Main wallet' }],
      [],
    )

    expect(result).toHaveLength(1)
    expect(result[0].settlementScheme).toBe('eip3009')
    // The SELECT itself reads the metadata key — asserted at the SQL level,
    // not just by passing a pre-stamped row through the mapper.
    expect(String(spy.mock.calls[0][0])).toContain('FROM payment_intents')
    expect(String(spy.mock.calls[0][0])).toContain("machine_metadata->>'settlement_scheme'")
  })

  // #2055: was "...on an executed x402 approval request (erc7710)" —
  // `findConfirmedX402ApprovalRequests` is gone with `approval_requests`;
  // `settlement_scheme` is carried on `payment_intents.machine_metadata` the
  // same way regardless of scheme, so this is re-anchored there (same as the
  // eip3009 case above it, different scheme value).
  it('carries settlement_scheme from machine_metadata on a confirmed x402 payment intent (erc7710)', async () => {
    const spy = routeFeedQueries({
      payment_intents: [
        {
          id: 'payment-id',
          tx_hash: TX_HASH,
          agent_id: 'agent-id',
          agent_name: 'Research assistant',
          account_id: 'safe-id',
          account_address: SAFE_ADDRESS,
          account_name: 'Main wallet',
          chain_id: 8453,
          token_symbol: 'USDC',
          token_address: USDC_ADDRESS,
          to_address: '0x1111111111111111111111111111111111111111',
          amount_raw: '10000',
          amount_human: '0.01',
          x402_merchant_address: '0x2222222222222222222222222222222222222222',
          x402_resource_url: 'https://mcp.soundside.ai/mcp',
          payment_proof_status: 'payment_confirmed',
          payment_reconciliation_event_type: null,
          settlement_scheme: 'erc7710',
          confirmed_at: '2026-05-22T07:50:10Z',
          created_at: '2026-05-22T07:49:55Z',
        },
      ],
    })

    const result = await mergeX402Transactions(
      'user-id',
      [{ id: 'safe-id', account_address: SAFE_ADDRESS, chain_id: 8453, name: 'Main wallet' }],
      [],
    )

    expect(result).toHaveLength(1)
    expect(result[0].settlementScheme).toBe('erc7710')
    expect(String(spy.mock.calls[0][0])).toContain('FROM payment_intents')
    expect(String(spy.mock.calls[0][0])).toContain("machine_metadata->>'settlement_scheme'")
  })

  it('leaves settlementScheme null-in-null-out when the metadata key is absent', async () => {
    routeFeedQueries({
      payment_intents: [
        {
          id: 'payment-id',
          tx_hash: TX_HASH,
          agent_id: 'agent-id',
          agent_name: 'Research assistant',
          account_id: 'safe-id',
          account_address: SAFE_ADDRESS,
          account_name: 'Main wallet',
          chain_id: 8453,
          token_symbol: 'USDC',
          token_address: USDC_ADDRESS,
          to_address: '0x1111111111111111111111111111111111111111',
          amount_raw: '20000',
          amount_human: '0.02',
          x402_merchant_address: '0x2222222222222222222222222222222222222222',
          x402_resource_url: 'https://api.example.com/data',
          payment_proof_status: 'payment_confirmed',
          payment_reconciliation_event_type: null,
          confirmed_at: '2026-05-08T11:50:10Z',
          created_at: '2026-05-08T11:49:55Z',
        },
      ],
    })

    const result = await mergeX402Transactions(
      'user-id',
      [{ id: 'safe-id', account_address: SAFE_ADDRESS, chain_id: 8453, name: 'Main wallet' }],
      [],
    )

    expect(result).toHaveLength(1)
    expect(result[0].settlementScheme).toBeUndefined()
  })

  it('keeps settlementScheme on a feed row when agent enrichment does not overwrite it', async () => {
    routeFeedQueries()

    const [result] = await enrichTransactionsWithAgents('user-id', [
      {
        hash: TX_HASH,
        type: 'erc20',
        from: SAFE_ADDRESS,
        to: '0x1111111111111111111111111111111111111111',
        value: '20000',
        valueFormatted: '0.02',
        asset: 'USDC',
        decimals: 6,
        direction: 'out',
        timestamp: 1778240999,
        timestampSource: 'block',
        blockNumber: 45725826,
        isError: false,
        tokenAddress: USDC_ADDRESS,
        tokenSymbol: 'USDC',
        chainId: 8453,
        accountId: 'safe-id',
        accountAddress: SAFE_ADDRESS,
        accountName: 'Main wallet',
        source: 'x402',
        settlementScheme: 'eip3009',
      } as EnrichedTransaction,
    ])

    expect(result.settlementScheme).toBe('eip3009')
  })

  it('marks x402 transactions with open merchant reconciliation as needing attention', async () => {
    vi.spyOn(pool, 'query')
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'payment-id',
            tx_hash: TX_HASH,
            agent_id: 'agent-id',
            agent_name: 'Research assistant',
            account_id: 'safe-id',
            account_address: SAFE_ADDRESS,
            account_name: 'Main wallet',
            chain_id: 8453,
            token_symbol: 'USDC',
            token_address: USDC_ADDRESS,
            to_address: '0x1111111111111111111111111111111111111111',
            amount_raw: '20000',
            amount_human: '0.02',
            x402_merchant_address: '0x2222222222222222222222222222222222222222',
            x402_resource_url: 'https://api.example.com/data',
            payment_proof_status: 'payment_confirmed',
            payment_reconciliation_event_type: 'merchant_retry_rejected_after_payment',
            confirmed_at: '2026-05-08T11:50:10Z',
            created_at: '2026-05-08T11:49:55Z',
          },
        ],
      } as never)
      .mockResolvedValueOnce({ rows: [] } as never)

    const result = await mergeX402Transactions(
      'user-id',
      [{
        id: 'safe-id',
        account_address: SAFE_ADDRESS,
        chain_id: 8453,
        name: 'Main wallet',
      }],
      [],
    )

    expect(result[0]).toMatchObject({
      source: 'x402',
      paymentProofStatus: 'payment_confirmed',
      paymentFlowStatus: 'needs_attention',
      paymentAttentionReason: 'merchant_retry_rejected_after_payment',
    })
  })
})

describe('enrichTransactionsWithAgents', () => {
  function explorerTransfer(
    overrides: Partial<EnrichedTransaction> = {},
  ): EnrichedTransaction {
    return {
      hash: TX_HASH,
      type: 'erc20',
      from: SAFE_ADDRESS,
      to: '0xA87300000000000000000000000000000000DD35',
      value: '10000',
      valueFormatted: '0.01',
      asset: 'USDC',
      decimals: 6,
      direction: 'out',
      timestamp: 1779436199,
      timestampSource: 'block',
      blockNumber: 45725826,
      isError: false,
      tokenAddress: USDC_ADDRESS,
      tokenSymbol: 'USDC',
      chainId: 8453,
      accountId: 'safe-base',
      accountAddress: SAFE_ADDRESS,
      accountName: 'Based',
      ...overrides,
    }
  }

  it('scopes payment intent enrichment to the matching Safe and chain', async () => {
    const queryMock = vi.spyOn(pool, 'query')
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'payment-id',
            tx_hash: TX_HASH.toLowerCase(),
            account_id: 'safe-base',
            chain_id: 8453,
            agent_id: 'agent-id',
            agent_name: 'Soundside agent',
            source: 'x402',
            payment_resource_url: 'https://mcp.soundside.ai/mcp',
            merchant_address: '0x2222222222222222222222222222222222222222',
            payment_proof_status: 'protocol_receipt_attached',
            payment_reconciliation_event_type: null,
          },
        ],
      } as never)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)

    const result = await enrichTransactionsWithAgents('user-id', [
      explorerTransfer(),
      explorerTransfer({
        accountId: 'safe-gnosis',
        chainId: 100,
        accountName: 'Gnosis',
      }),
    ])

    expect(result[0]).toMatchObject({
      hash: TX_HASH,
      source: 'x402',
      x402ResourceUrl: 'https://mcp.soundside.ai/mcp',
      x402MerchantAddress: '0x2222222222222222222222222222222222222222',
      agentId: 'agent-id',
      agentName: 'Soundside agent',
      paymentId: 'payment-id',
      paymentProofStatus: 'protocol_receipt_attached',
    })
    expect(result[1]).toMatchObject({
      hash: TX_HASH,
      accountId: 'safe-gnosis',
      chainId: 100,
    })
    expect(result[1].agentId).toBeUndefined()
    expect(result[1].paymentId).toBeUndefined()

    const paymentIntentSql = String(queryMock.mock.calls[0][0])
    expect(paymentIntentSql).toContain('JOIN smart_accounts us')
    expect(paymentIntentSql).toContain('LOWER(us.account_address) = LOWER(pi.account_address)')
    expect(paymentIntentSql).toContain('us.id = ANY($3)')
    expect(paymentIntentSql).toContain('us.chain_id = pi.chain_id')
    expect(paymentIntentSql).not.toContain('us.id = a.account_id')
    expect(queryMock.mock.calls[0][1]).toEqual([
      [TX_HASH.toLowerCase()],
      'user-id',
      ['safe-base', 'safe-gnosis'],
    ])
  })

  // #2055 (epic #1440, #2021 readability waiver): was "enriches raw explorer
  // transfers from executed x402 approvals by Safe and chain" —
  // `findApprovalRequestAgentMatches` is gone with `approval_requests`, and
  // with it the approval-sourced attribution pass this pinned. x402
  // attribution from a funding record survives unchanged on the
  // payment_intents pass, already proven above by "scopes payment intent
  // enrichment to the matching Safe and chain" — deleted rather than
  // converted for the same reason as its `mergeX402Transactions` sibling.

  it('labels submitted delegate sweeps with agent context by Safe and chain', async () => {
    // #2055: the enrichment pipeline is payment_intents → delegate_sweeps
    // now (the approval_requests pass in between is gone), so the sweep
    // query is the SECOND call, not the third.
    const queryMock = vi.spyOn(pool, 'query')
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'sweep-id',
            tx_hash: TX_HASH.toLowerCase(),
            account_id: 'safe-base',
            chain_id: 8453,
            agent_id: 'agent-id',
            agent_name: 'Research assistant',
            from_address: '0xA87300000000000000000000000000000000DD35',
            to_address: SAFE_ADDRESS,
          },
        ],
      } as never)

    const result = await enrichTransactionsWithAgents('user-id', [
      explorerTransfer({
        from: '0xA87300000000000000000000000000000000DD35',
        to: SAFE_ADDRESS,
        direction: 'in',
      }),
      explorerTransfer({
        accountId: 'safe-gnosis',
        chainId: 100,
        accountName: 'Gnosis',
        from: '0xA87300000000000000000000000000000000DD35',
        to: SAFE_ADDRESS,
        direction: 'in',
      }),
    ])

    expect(result[0]).toMatchObject({
      hash: TX_HASH,
      direction: 'in',
      agentId: 'agent-id',
      agentName: 'Research assistant',
      paymentId: 'sweep-id',
      activityType: 'delegate_sweep',
    })
    expect(result[0].source).toBeUndefined()
    expect(result[0].paymentFlowStatus).toBeUndefined()
    expect(result[1]).toMatchObject({
      hash: TX_HASH,
      accountId: 'safe-gnosis',
      chainId: 100,
    })
    expect(result[1].activityType).toBeUndefined()
    expect(result[1].agentId).toBeUndefined()

    const sweepSql = String(queryMock.mock.calls[1][0])
    expect(sweepSql).toContain('FROM delegate_sweeps ds')
    expect(sweepSql).toContain('LOWER(us.account_address) = LOWER(ds.to_address)')
    expect(sweepSql).toContain('us.chain_id = ds.chain_id')
    expect(sweepSql).toContain("ds.status = 'submitted'")
    expect(queryMock.mock.calls[1][1]).toEqual([
      [TX_HASH.toLowerCase()],
      'user-id',
      ['safe-base', 'safe-gnosis'],
    ])
  })
})

// ── #992 characterization: cache keying, pagination, filtering, CSV shape ───
//
// Added BEFORE the routes/transactions.ts → src/modules/transactions/ move
// (own commit, per the #985 lesson) so they pin CURRENT behavior. The
// cache-key assertions use `.toBe` on the exact string — asserting the
// predicate, not a params array that stays identical when scoping breaks
// (#985's second lesson).

describe('buildTransactionCacheKey (#992 characterization — exact key pin)', () => {
  it('is `tx:<chainId>:<lowercased safe address>`, independent of input casing', () => {
    expect(buildTransactionCacheKey(8453, SAFE_ADDRESS)).toBe(
      `tx:8453:${LOWERCASE_SAFE_ADDRESS}`,
    )
    expect(buildTransactionCacheKey(100, SAFE_ADDRESS.toUpperCase())).toBe(
      `tx:100:${LOWERCASE_SAFE_ADDRESS}`,
    )
    expect(buildTransactionCacheKey(8453, SAFE_ADDRESS)).not.toBe(
      buildTransactionCacheKey(100, SAFE_ADDRESS),
    )
  })
})

describe('transaction cache hit/miss (#992 characterization)', () => {
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

  function signToken(payload: { sub: string; email: string }): string {
    return app.jwt.sign(payload, { expiresIn: '1h' })
  }

  function mockSafeRows(rows: Array<{ id: string; chain_id: number }>) {
    return vi.spyOn(pool, 'query').mockImplementation(async (sql: unknown) => {
      if (String(sql).includes('FROM smart_accounts')) {
        return { rows } as never
      }
      return { rows: [] } as never
    })
  }

  it('reuses the cached result on a second read for the same key (no fresh flag)', async () => {
    const token = signToken({ sub: 'cache-user', email: 'cache@example.com' })
    const fetchMock = stubEmptyTransactionFetch()
    mockSafeRows([{ id: 'cache-safe-1', chain_id: 8453 }])

    const first = await app.inject({
      method: 'GET',
      url: `/transactions/${CACHE_TEST_SAFE_ADDRESS_1}?chain_id=8453&fresh=1`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(first.statusCode).toBe(200)
    const callsAfterFirst = fetchMock.mock.calls.length
    expect(callsAfterFirst).toBeGreaterThan(0)

    const second = await app.inject({
      method: 'GET',
      url: `/transactions/${CACHE_TEST_SAFE_ADDRESS_1}?chain_id=8453`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(second.statusCode).toBe(200)

    // Cache hit: the second read makes NO further explorer-API calls.
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst)
  })

  it('bypasses the cache on both reads when fresh=1 is passed each time', async () => {
    const token = signToken({ sub: 'cache-user-2', email: 'cache2@example.com' })
    const fetchMock = stubEmptyTransactionFetch()
    mockSafeRows([{ id: 'cache-safe-2', chain_id: 8453 }])

    const first = await app.inject({
      method: 'GET',
      url: `/transactions/${CACHE_TEST_SAFE_ADDRESS_2}?chain_id=8453&fresh=1`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(first.statusCode).toBe(200)
    const callsAfterFirst = fetchMock.mock.calls.length
    expect(callsAfterFirst).toBeGreaterThan(0)

    const second = await app.inject({
      method: 'GET',
      url: `/transactions/${CACHE_TEST_SAFE_ADDRESS_2}?chain_id=8453&fresh=1`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(second.statusCode).toBe(200)

    // fresh=1 forces a real explorer-API round trip every time.
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirst)
  })
})

describe('GET /transactions pagination and filtering (#992 characterization)', () => {
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

  function signToken(payload: { sub: string; email: string }): string {
    return app.jwt.sign(payload, { expiresIn: '1h' })
  }

  function mockPoolForAggregation(
    safes: Array<{ id: string; account_address: string; chain_id: number; name: string }>,
    validAgentIds: string[] = [],
  ) {
    return vi.spyOn(pool, 'query').mockImplementation(async (sql: unknown, params?: unknown[]) => {
      const text = String(sql)
      if (text.includes('FROM smart_accounts')) {
        return { rows: safes } as never
      }
      if (text.includes('FROM agents WHERE id')) {
        const agentId = (params as string[] | undefined)?.[0]
        return {
          rows: agentId && validAgentIds.includes(agentId) ? [{ id: agentId }] : [],
        } as never
      }
      // payment_intents / delegate_sweeps enrichment and x402 merge queries
      // (#2055: the approval_requests pass is gone) — no machine-payment
      // activity in these fixtures.
      return { rows: [] } as never
    })
  }

  it('paginates the merged, timestamp-sorted feed with exact offset/limit slicing', async () => {
    const token = signToken({ sub: 'page-user', email: 'page@example.com' })
    stubMixedTransactionFetch()
    mockPoolForAggregation([
      { id: 'safe-page', account_address: SAFE_ADDRESS, chain_id: 8453, name: 'Main' },
    ])

    const page1 = await app.inject({
      method: 'GET',
      url: '/transactions?limit=2&offset=0&fresh=1',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(page1.statusCode).toBe(200)
    const body1 = page1.json()
    expect(body1.total).toBe(4)
    expect(body1.offset).toBe(0)
    expect(body1.limit).toBe(2)
    expect(body1.hasMore).toBe(true)
    expect(body1.transactions).toHaveLength(2)
    // Newest-first: the two native txs at blocks 300 and 200.
    expect(body1.transactions.map((tx: { hash: string }) => tx.hash)).toEqual([
      '0xAAA0000000000000000000000000000000000000000000000000000000AAA',
      '0xBBB0000000000000000000000000000000000000000000000000000000BBB',
    ])

    const page2 = await app.inject({
      method: 'GET',
      url: '/transactions?limit=2&offset=2&fresh=1',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(page2.statusCode).toBe(200)
    const body2 = page2.json()
    expect(body2.total).toBe(4)
    expect(body2.hasMore).toBe(false)
    expect(body2.transactions).toHaveLength(2)
    expect(body2.transactions.map((tx: { hash: string }) => tx.hash)).toEqual([
      '0xCCC0000000000000000000000000000000000000000000000000000000CCC',
      '0xE20000000000000000000000000000000000000000000000000000000E20',
    ])
  })

  // #2914 (naming epic #2906 phase 5, the contraction): the twin `#2907`
  // dual-emitted is gone. Every transaction row, and the top-level
  // `failedAccountIds`, carry the account_* names ONLY — a request-level
  // check, not just the mapper's own unit test (the mapper itself is
  // deleted).
  it('#2914 follow-up: transactions[] and failedAccountIds drop every retired safe* name', async () => {
    const token = signToken({ sub: 'twin-user', email: 'twin@example.com' })
    stubMixedTransactionFetch()
    mockPoolForAggregation([
      { id: 'safe-twin', account_address: SAFE_ADDRESS, chain_id: 8453, name: 'Main' },
    ])

    const response = await app.inject({
      method: 'GET',
      url: '/transactions?fresh=1',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.transactions.length).toBeGreaterThan(0)
    for (const tx of body.transactions) {
      expect(tx.safeId).toBeUndefined()
      expect(tx.safeAddress).toBeUndefined()
      expect(tx.accountId).toBeDefined()
      expect(tx.accountAddress).toBeDefined()
      // `safeName` outlived #2914 by one release, because the published CLI
      // rendered its ACCOUNT column from it and would have printed every row
      // blank. `latest` is 0.3.0-alpha.0 now and reads `accountName`.
      expect(tx.safeName).toBeUndefined()
      expect(tx.accountName).toBeDefined()
    }
    expect(body.failedSafeIds).toBeUndefined()
    expect(body.failedAccountIds).toBeDefined()
  })

  it('filters by tokenKey: native excludes ERC-20, and the token address excludes native', async () => {
    const token = signToken({ sub: 'filter-user', email: 'filter@example.com' })
    stubMixedTransactionFetch()
    mockPoolForAggregation([
      { id: 'safe-filter', account_address: SAFE_ADDRESS, chain_id: 8453, name: 'Main' },
    ])

    const nativeOnly = await app.inject({
      method: 'GET',
      url: '/transactions?tokenKey=8453:native&fresh=1',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(nativeOnly.statusCode).toBe(200)
    const nativeBody = nativeOnly.json()
    expect(nativeBody.total).toBe(3)
    expect(nativeBody.transactions.every((tx: { type: string }) => tx.type !== 'erc20')).toBe(true)

    const erc20Only = await app.inject({
      method: 'GET',
      url: `/transactions?tokenKey=8453:${USDC_ADDRESS.toLowerCase()}&fresh=1`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(erc20Only.statusCode).toBe(200)
    const erc20Body = erc20Only.json()
    expect(erc20Body.total).toBe(1)
    expect(erc20Body.transactions[0].type).toBe('erc20')
    expect(erc20Body.transactions[0].tokenAddress).toBe(USDC_ADDRESS)
  })

  it('filters by accountId to a single owned account, rejecting an unrecognized one earlier', async () => {
    const token = signToken({ sub: 'safeid-user', email: 'safeid@example.com' })
    const fetchMock = stubEmptyTransactionFetch()
    const SAFE_A_ID = '33333333-3333-4333-8333-333333333333'
    const SAFE_B_ID = '44444444-4444-4444-8444-444444444444'
    mockPoolForAggregation([
      { id: SAFE_A_ID, account_address: SAFE_ADDRESS, chain_id: 8453, name: 'A' },
      { id: SAFE_B_ID, account_address: SENDER, chain_id: 100, name: 'B' },
    ])

    const scoped = await app.inject({
      method: 'GET',
      url: `/transactions?accountId=${SAFE_A_ID}&fresh=1`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(scoped.statusCode).toBe(200)
    // Only safe-a's chain (8453, Base Blockscout) is ever queried.
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('https://base.blockscout.com/api/v2/addresses/'),
    )
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('https://api.etherscan.io/v2/api'),
    )

    const unowned = await app.inject({
      method: 'GET',
      url: '/transactions?accountId=00000000-0000-4000-8000-000000000000&fresh=1',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(unowned.statusCode).toBe(400)
    expect(unowned.json().error).toBe('Invalid accountId')
  })

  // #2914 (naming epic #2906 phase 5, the contraction) ends the #2907 parity
  // window: `?safeId=` is now REFUSED with a 400 naming `accountId`, never
  // silently ignored. This is the important one: Fastify drops an undeclared
  // query key in silence, so without the explicit refusal the response would
  // be a 200 carrying EVERY row the user owns instead of one account's.
  it('?safeId= is refused with a 400 naming accountId — never a silent ignore that returns every row', async () => {
    const token = signToken({ sub: 'safeid-refused-user', email: 'safeid-refused@example.com' })
    stubEmptyTransactionFetch()
    const SAFE_A_ID = '33333333-3333-4333-8333-333333333333'
    mockPoolForAggregation([
      { id: SAFE_A_ID, account_address: SAFE_ADDRESS, chain_id: 8453, name: 'A' },
    ])

    const res = await app.inject({
      method: 'GET',
      url: `/transactions?safeId=${SAFE_A_ID}&fresh=1`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().replacement).toBe('accountId')
    // The important guard: NOT a 200 carrying every row the user owns.
    expect(res.json().transactions).toBeUndefined()
    expect(res.json().total).toBeUndefined()
  })

  // #2907 gave `accountId` a same-value input twin, `safeId`, for one
  // release. #2914 ends the window: asserted on a REAL count difference, not
  // just "200 OK" — an unknown query key is silently ignored by Fastify, so a
  // missing filter would have returned ALL transactions with no error, the
  // exact failure mode this guards against.
  it('filters by accountId (the retired safeId is refused, not read) — filtered count differs from unfiltered', async () => {
    const token = signToken({ sub: 'accountid-user', email: 'accountid@example.com' })
    const ACCOUNT_WITH_TXS_ID = '55555555-5555-4555-8555-555555555555'
    const ACCOUNT_EMPTY_ID = '66666666-6666-4666-8666-666666666666'

    // Per-address routing: SAFE_ADDRESS returns the 4-tx mixed fixture,
    // SENDER (the second account) returns nothing.
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString()
      if (url.includes('/api/v1/safes/') && url.includes('/transfers/')) {
        return jsonResponse({ count: 0, next: null, previous: null, results: [] })
      }
      if (url.toLowerCase().includes(LOWERCASE_SAFE_ADDRESS)) {
        if (url.includes('/token-transfers')) {
          return jsonResponse({
            items: [erc20Tx('0xE20000000000000000000000000000000000000000000000000000000E20', 100, '2026-05-01T00:00:00Z', '5000000')],
            next_page_params: null,
          })
        }
        return jsonResponse({
          items: [
            nativeTx('0xAAA0000000000000000000000000000000000000000000000000000000AAA', 300, '2026-05-03T00:00:00Z'),
            nativeTx('0xBBB0000000000000000000000000000000000000000000000000000000BBB', 200, '2026-05-02T00:00:00Z'),
            nativeTx('0xCCC0000000000000000000000000000000000000000000000000000000CCC', 100, '2026-05-01T12:00:00Z'),
          ],
          next_page_params: null,
        })
      }
      // The second account (SENDER, on a different chain): nothing.
      if (url.includes('module=account')) return jsonResponse({ status: '1', message: 'OK', result: [] })
      return jsonResponse({ items: [], next_page_params: null })
    })
    vi.stubGlobal('fetch', fetchMock)

    mockPoolForAggregation([
      { id: ACCOUNT_WITH_TXS_ID, account_address: SAFE_ADDRESS, chain_id: 8453, name: 'Has txs' },
      { id: ACCOUNT_EMPTY_ID, account_address: SENDER, chain_id: 100, name: 'Empty' },
    ])

    const unfiltered = await app.inject({
      method: 'GET',
      url: '/transactions?fresh=1',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(unfiltered.statusCode).toBe(200)
    const unfilteredTotal = unfiltered.json().total as number
    expect(unfilteredTotal).toBeGreaterThan(0)

    const filteredToEmptyByAccountId = await app.inject({
      method: 'GET',
      url: `/transactions?accountId=${ACCOUNT_EMPTY_ID}&fresh=1`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(filteredToEmptyByAccountId.statusCode).toBe(200)
    expect(filteredToEmptyByAccountId.json().total).toBe(0)
    expect(filteredToEmptyByAccountId.json().total).not.toBe(unfilteredTotal)

    // `?safeId=` is refused outright now (#2914) — asserted on this same
    // fixture so the refusal is proven on a request that would otherwise
    // have filtered to something meaningful, not a vacuous empty case.
    const refusedBySafeId = await app.inject({
      method: 'GET',
      url: `/transactions?safeId=${ACCOUNT_EMPTY_ID}&fresh=1`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(refusedBySafeId.statusCode).toBe(400)
    expect(refusedBySafeId.json().replacement).toBe('accountId')

    // An unrecognized accountId still 400s (proves the param is actually
    // read, not silently ignored).
    const unrecognized = await app.inject({
      method: 'GET',
      url: '/transactions?accountId=00000000-0000-4000-8000-000000000000&fresh=1',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(unrecognized.statusCode).toBe(400)
    expect(unrecognized.json().error).toBe('Invalid accountId')
  })

  // #2914 (naming epic #2906 phase 5, the contraction): `safeId` alongside
  // `accountId` is STILL refused — the retired name's mere PRESENCE is
  // refused, not resolved by precedence. `#2907`'s "accountId wins" rule
  // (finding #10) does not survive the contraction: there is no longer a
  // second accepted name to arbitrate between.
  it('safeId DISAGREEING with accountId is refused — two answers to one question', async () => {
    const token = signToken({ sub: 'precedence-user', email: 'precedence@example.com' })
    const ACCOUNT_WITH_TXS_ID = '77777777-7777-4777-8777-777777777777'
    const ACCOUNT_EMPTY_ID = '88888888-8888-4888-8888-888888888888'

    stubMixedTransactionFetch()
    mockPoolForAggregation([
      { id: ACCOUNT_WITH_TXS_ID, account_address: SAFE_ADDRESS, chain_id: 8453, name: 'Has txs' },
      { id: ACCOUNT_EMPTY_ID, account_address: SENDER, chain_id: 100, name: 'Empty' },
    ])

    const response = await app.inject({
      method: 'GET',
      url: `/transactions?accountId=${ACCOUNT_WITH_TXS_ID}&safeId=${ACCOUNT_EMPTY_ID}&fresh=1`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().replacement).toBe('accountId')
  })

  it('safeId MATCHING accountId is accepted — the published CLI dual-sends, and #2908 told it to', async () => {
    // The regression this exists for. `@haven_ai/cli` on `latest` sends
    // `params.set('accountId', id); params.set('safeId', id)` because #2908's
    // migration instruction said to. A refusal keyed on PRESENCE fires before
    // the new name is read, so the contraction would have 400'd exactly the
    // clients that followed the instruction most faithfully — on
    // `activity list`, `activity export` and `agents connect`.
    //
    // The bar is unchanged for a client that has NOT migrated: `safeId` alone
    // is still a typed 400 (asserted above). What is accepted is a caller
    // that sends both and agrees with itself.
    const token = signToken({ sub: 'dualsend-user', email: 'dualsend@example.com' })
    const ACCOUNT_ID = '77777777-7777-4777-8777-777777777777'

    stubMixedTransactionFetch()
    mockPoolForAggregation([
      { id: ACCOUNT_ID, account_address: SAFE_ADDRESS, chain_id: 8453, name: 'Has txs' },
    ])

    const response = await app.inject({
      method: 'GET',
      url: `/transactions?accountId=${ACCOUNT_ID}&safeId=${ACCOUNT_ID}&fresh=1`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(200)
    // And it actually FILTERED — a 200 carrying every row would be the silent
    // failure the refusal exists to prevent, wearing a success code.
    expect(response.json().transactions.length).toBeGreaterThan(0)
  })

  it('agentId=user selects the unattributed outbound tx, not the agent-attributed one', async () => {
    const token = signToken({ sub: 'agentfilter-user', email: 'agentfilter@example.com' })
    const UNATTRIBUTED_HASH = '0xD11000000000000000000000000000000000000000000000000000000D11'
    const AGENT_HASH = '0xD22000000000000000000000000000000000000000000000000000000D22'
    const AGENT_ID = '22222222-2222-4222-8222-222222222222'
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString()
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
              hash: UNATTRIBUTED_HASH,
              block_number: 400,
              timestamp: '2026-05-04T00:00:00Z',
              timestampSource: 'block',
              from: { hash: SAFE_ADDRESS },
              to: { hash: SENDER },
              value: '1000000000000000000',
              gas_limit: '21000',
              gas_used: '21000',
              status: 'ok',
              method: null,
            },
            {
              hash: AGENT_HASH,
              block_number: 401,
              timestamp: '2026-05-04T01:00:00Z',
              timestampSource: 'block',
              from: { hash: SAFE_ADDRESS },
              to: { hash: SENDER },
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
      throw new Error(`Unexpected fetch URL: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    vi.spyOn(pool, 'query').mockImplementation(async (sql: unknown, params?: unknown[]) => {
      const text = String(sql)
      if (text.includes('FROM smart_accounts')) {
        return {
          rows: [{ id: 'safe-agentfilter', account_address: SAFE_ADDRESS, chain_id: 8453, name: 'Main' }],
        } as never
      }
      if (text.includes('FROM agents WHERE id')) {
        const agentId = (params as string[] | undefined)?.[0]
        return { rows: agentId === AGENT_ID ? [{ id: agentId }] : [] } as never
      }
      // Only the enrichTransactionsWithAgents piResult query matches on this
      // WHERE clause — fetchConfirmedX402Transactions's payment_intents query
      // (also `FROM payment_intents pi` / `JOIN agents a`) does not, and falls
      // through to the empty default below, so this raw explorer tx is
      // attributed by enrichment rather than replaced by an x402-synthesized row.
      if (text.includes('WHERE LOWER(pi.tx_hash) = ANY')) {
        return {
          rows: [
            {
              id: 'payment-agentfilter',
              tx_hash: AGENT_HASH.toLowerCase(),
              account_id: 'safe-agentfilter',
              chain_id: 8453,
              agent_id: AGENT_ID,
              agent_name: 'Research assistant',
              source: 'direct',
              payment_resource_url: null,
              merchant_address: null,
              payment_proof_status: null,
              payment_reconciliation_event_type: null,
              amount_sek: null,
            },
          ],
        } as never
      }
      return { rows: [] } as never
    })

    const userScoped = await app.inject({
      method: 'GET',
      url: '/transactions?agentId=user&fresh=1',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(userScoped.statusCode).toBe(200)
    const userBody = userScoped.json()
    expect(userBody.total).toBe(1)
    expect(userBody.transactions[0].hash).toBe(UNATTRIBUTED_HASH)

    const agentScoped = await app.inject({
      method: 'GET',
      url: `/transactions?agentId=${AGENT_ID}&fresh=1`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(agentScoped.statusCode).toBe(200)
    const agentBody = agentScoped.json()
    expect(agentBody.total).toBe(1)
    expect(agentBody.transactions[0].hash).toBe(AGENT_HASH)
    expect(agentBody.transactions[0].agentId).toBe(AGENT_ID)
  })

  it('rejects an agentId that does not belong to the caller before aggregation', async () => {
    const token = signToken({ sub: 'agentreject-user', email: 'agentreject@example.com' })
    const fetchMock = stubEmptyTransactionFetch()
    mockPoolForAggregation(
      [{ id: 'safe-agentreject', account_address: SAFE_ADDRESS, chain_id: 8453, name: 'Main' }],
      ['agent-owned'],
    )

    const response = await app.inject({
      method: 'GET',
      url: '/transactions?agentId=11111111-1111-4111-8111-111111111111&fresh=1',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('Invalid agentId')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('GET /transactions CSV export field fidelity (#992 characterization)', () => {
  // The CSV export (packages/frontend/src/lib/transaction-csv.ts) is a pure
  // client-side transform over whatever this endpoint returns — there is no
  // separate backend export route. This test locks the field set and values
  // transactionsToCsv() depends on, sourced through the full aggregation +
  // x402 enrichment path, so a field silently dropped or renamed during the
  // #992 module extraction shows up here rather than as a blank CSV column.
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

  function signToken(payload: { sub: string; email: string }): string {
    return app.jwt.sign(payload, { expiresIn: '1h' })
  }

  it('returns every field the CSV exporter reads, correctly populated for an x402 payment', async () => {
    const token = signToken({ sub: 'csv-user', email: 'csv@example.com' })
    stubEmptyTransactionFetch()
    vi.spyOn(pool, 'query').mockImplementation(async (sql: unknown) => {
      const text = String(sql)
      if (text.includes('FROM smart_accounts')) {
        return {
          rows: [{ id: '11111111-2222-4333-8444-555555555501', account_address: SAFE_ADDRESS, chain_id: 8453, name: 'Main wallet' }],
        } as never
      }
      if (text.includes('FROM payment_intents pi') && text.includes('JOIN agents a')) {
        return {
          rows: [
            {
              id: 'payment-csv',
              tx_hash: TX_HASH,
              agent_id: '11111111-2222-4333-8444-555555555502',
              agent_name: 'Research assistant',
              account_id: '11111111-2222-4333-8444-555555555501',
              account_address: SAFE_ADDRESS,
              account_name: 'Main wallet',
              chain_id: 8453,
              token_symbol: 'USDC',
              token_address: USDC_ADDRESS,
              to_address: '0x1111111111111111111111111111111111111111',
              amount_raw: '20000',
              amount_human: '0.02',
              x402_merchant_address: '0x2222222222222222222222222222222222222222',
              x402_resource_url: 'https://api.example.com/data',
              payment_proof_status: 'protocol_receipt_attached',
              amount_sek: '0.21',
              fx_rate_sek: '10.5000',
              fx_source: 'riksbank',
              fx_rates: { SEK: 10.5, USD: 1.02, EUR: 0.93 },
              payment_reconciliation_event_type: null,
              confirmed_at: '2026-05-08T11:50:10Z',
              created_at: '2026-05-08T11:49:55Z',
            },
          ],
        } as never
      }
      return { rows: [] } as never
    })

    const response = await app.inject({
      method: 'GET',
      url: '/transactions?fresh=1',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    const [tx] = response.json().transactions

    // Every column transactionsToCsv() reads (see transaction-csv.ts COLUMNS).
    expect(tx).toMatchObject({
      hash: TX_HASH,
      direction: 'out',
      valueFormatted: '0.02',
      tokenSymbol: 'USDC',
      asset: 'USDC',
      tokenAddress: USDC_ADDRESS,
      from: SAFE_ADDRESS,
      to: '0x2222222222222222222222222222222222222222',
      chainId: 8453,
      agentName: 'Research assistant',
      amountSek: '0.21',
      fxRateSek: '10.5000',
      fxSource: 'riksbank',
      isError: false,
      paymentFlowStatus: 'paid',
      source: 'x402',
      // #3127: this user has no preference row, so the served default is SEK
      // (documented, deliberate — domain/transaction-currency.ts). The
      // converted triple names the currency as a FIELD; SEK mirrors
      // `amountSek` exactly and the rate is the row's own `fxRateSek` fact.
      convertedAmount: '0.21',
      convertedCurrency: 'SEK',
      convertedFxRate: null,
    })
    expect(typeof tx.timestamp).toBe('number')
    expect(tx.timestamp).toBeGreaterThan(0)
    expect(tx.activityType).toBeUndefined()
    // #2885: this is the one fixture that carries `fxRateSek`/`fxSource`, so it
    // is the assertion that keeps them declared on the spec — removing either
    // property from `transactionBaseProperties` fails here with
    // "must NOT have additional properties".
    expectMatchesSpec('GET', '/transactions', response.json())
  })

  it('strikes the converted triple in the user’s preferred currency (#3127)', async () => {
    const token = signToken({ sub: 'csv-user', email: 'csv@example.com' })
    stubEmptyTransactionFetch()
    vi.spyOn(pool, 'query').mockImplementation(async (sql: unknown) => {
      const text = String(sql)
      if (text.includes('FROM smart_accounts')) {
        return {
          rows: [{ id: '11111111-2222-4333-8444-555555555501', account_address: SAFE_ADDRESS, chain_id: 8453, name: 'Main wallet' }],
        } as never
      }
      if (text.includes('FROM payment_intents pi') && text.includes('JOIN agents a')) {
        return {
          rows: [
            {
              id: 'payment-csv',
              tx_hash: TX_HASH,
              agent_id: '11111111-2222-4333-8444-555555555502',
              agent_name: 'Research assistant',
              account_id: '11111111-2222-4333-8444-555555555501',
              account_address: SAFE_ADDRESS,
              account_name: 'Main wallet',
              chain_id: 8453,
              token_symbol: 'USDC',
              token_address: USDC_ADDRESS,
              to_address: '0x1111111111111111111111111111111111111111',
              amount_raw: '20000',
              amount_human: '0.02',
              x402_merchant_address: '0x2222222222222222222222222222222222222222',
              x402_resource_url: 'https://api.example.com/data',
              payment_proof_status: 'protocol_receipt_attached',
              amount_sek: '0.21',
              fx_rate_sek: '10.5000',
              fx_source: 'riksbank',
              fx_rates: { SEK: 10.5, USD: 1.02, EUR: 0.93 },
              payment_reconciliation_event_type: null,
              confirmed_at: '2026-05-08T11:50:10Z',
              created_at: '2026-05-08T11:49:55Z',
            },
          ],
        } as never
      }
      // #3127: the preference read rides every feed request. EUR → the
      // triple is struck in EUR from the row's own book-time rate map —
      // 0.02 USDC × 0.93 = 0.0186, the same arithmetic (and scale) as the
      // accounting feed's `ledgerAmount`, never a serve-time price read.
      if (text.includes('SELECT currency_preference FROM users')) {
        return { rows: [{ currency_preference: 'EUR' }] } as never
      }
      return { rows: [] } as never
    })

    const response = await app.inject({
      method: 'GET',
      url: '/transactions?fresh=1',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    const [tx] = response.json().transactions
    expect(tx).toMatchObject({
      // The SEK-named originals are untouched — dual-emit-free additive change.
      amountSek: '0.21',
      fxRateSek: '10.5000',
      fxSource: 'riksbank',
      convertedAmount: '0.0186',
      convertedCurrency: 'EUR',
      convertedFxRate: '0.9300',
    })
    // The new fields are DECLARED, not just emitted: additionalProperties is
    // false on the transaction schemas, so an undeclared key fails here with
    // "must NOT have additional properties" (#2885 precedent).
    expectMatchesSpec('GET', '/transactions', response.json())
  })
})
