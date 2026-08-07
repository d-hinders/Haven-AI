import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import transactionRoutes, {
  type EnrichedTransaction,
  buildTransactionCacheKey,
  enrichTransactionsWithAgents,
  fetchSafeTransactions,
  mergeX402Transactions,
} from '../transactions.js'
import pool from '../../db.js'

const SAFE_ADDRESS = '0x135a9215604711AC70d970e12Caa812c53537EF4'
const LOWERCASE_SAFE_ADDRESS = SAFE_ADDRESS.toLowerCase()
const SENDER = '0x55C9d84427756D6f82480427Bb778F6dc0cC755E'
const TX_HASH = '0x72d03a8ff551e443c118c93c54d32260941deb613e51fcd2733cd3455e8fa1a1'
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

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

describe('fetchSafeTransactions', () => {
  it('uses Safe Transaction Service transfers when Base Blockscout address history is empty', async () => {
    let safeServiceUrl = ''
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString()

      if (url.includes('/token-transfers')) {
        return jsonResponse({ items: [], next_page_params: null })
      }

      if (url.includes('/addresses/') && url.includes('/transactions')) {
        return jsonResponse({ items: [], next_page_params: null })
      }

      if (url.includes('/api/v1/safes/') && url.includes('/transfers/')) {
        safeServiceUrl = url
        return jsonResponse({
          count: 1,
          next: null,
          previous: null,
          results: [
            {
              type: 'ERC20_TRANSFER',
              executionDate: '2026-05-08T11:49:59Z',
              blockNumber: 45725826,
              transactionHash: TX_HASH,
              to: SAFE_ADDRESS,
              value: '20000',
              tokenAddress: USDC_ADDRESS,
              tokenInfo: {
                type: 'ERC20',
                address: USDC_ADDRESS,
                name: 'USDC',
                symbol: 'USDC',
                decimals: 6,
              },
              from: SENDER,
            },
          ],
        })
      }

      throw new Error(`Unexpected fetch URL: ${url}`)
    })

    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchSafeTransactions({
      safeId: 'safe-id',
      safeAddress: LOWERCASE_SAFE_ADDRESS,
      chainId: 8453,
      log: { warn: vi.fn() } as unknown as FastifyBaseLogger,
      fresh: true,
    })

    expect(result.hadFailures).toBe(false)
    expect(result.transactions).toHaveLength(1)
    expect(result.transactions[0]).toMatchObject({
      hash: TX_HASH,
      type: 'erc20',
      from: SENDER,
      to: SAFE_ADDRESS,
      value: '20000',
      valueFormatted: '0.02',
      asset: 'USDC',
      decimals: 6,
      direction: 'in',
      timestamp: 1778240999,
      blockNumber: 45725826,
      isError: false,
      tokenAddress: USDC_ADDRESS,
      tokenSymbol: 'USDC',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(
        'https://api.safe.global/tx-service/base/api/v1/safes/',
      ),
    )
    expect(safeServiceUrl).toContain(`/safes/${SAFE_ADDRESS}/transfers/`)
  })
})

describe('transaction routes', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify({ logger: false })
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
      if (String(sql).includes('FROM user_safes')) {
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

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('Invalid chain_id')
    expect(queryMock).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
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

  it('keeps aggregate transactions separate for the same Safe address on different chains', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    stubOneNativeTransactionFetch()
    vi.spyOn(pool, 'query').mockImplementation(async (sql: unknown) => {
      const text = String(sql)
      if (text.includes('FROM user_safes') && text.includes('ORDER BY created_at ASC')) {
        return {
          rows: [
            {
              id: 'safe-gnosis',
              safe_address: SAFE_ADDRESS,
              chain_id: 100,
              name: 'Gnosis wallet',
            },
            {
              id: 'safe-base',
              safe_address: SAFE_ADDRESS,
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
          safe_address: SAFE_ADDRESS,
          chain_id: 100,
          name: 'Gnosis wallet',
        },
        {
          id: 'safe-base',
          safe_address: SAFE_ADDRESS,
          chain_id: 8453,
          name: 'Base wallet',
        },
      ],
      [],
    )

    const paymentIntentSql = String(queryMock.mock.calls[0][0])
    const approvalRequestSql = String(queryMock.mock.calls[1][0])

    expect(paymentIntentSql).toContain('LOWER(us.safe_address) = LOWER(pi.safe_address)')
    expect(paymentIntentSql).toContain('pi.chain_id IS NOT NULL')
    expect(paymentIntentSql).toContain('us.chain_id = pi.chain_id')
    expect(paymentIntentSql).not.toContain('us.id = a.safe_id')
    expect(approvalRequestSql).toContain('LOWER(us.safe_address) = LOWER(ar.safe_address)')
    expect(approvalRequestSql).toContain('ar.chain_id IS NOT NULL')
    expect(approvalRequestSql).toContain('us.chain_id = ar.chain_id')
    expect(approvalRequestSql).not.toContain('us.id = a.safe_id')
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
            safe_id: 'safe-id',
            safe_address: SAFE_ADDRESS,
            safe_name: 'Main wallet',
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
        safe_address: SAFE_ADDRESS,
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
        blockNumber: 45725826,
        isError: false,
        tokenAddress: USDC_ADDRESS,
        tokenSymbol: 'USDC',
        chainId: 8453,
        safeId: 'safe-id',
        safeAddress: SAFE_ADDRESS,
        safeName: 'Main wallet',
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
      safeId: 'safe-id',
      safeName: 'Main wallet',
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
            safe_id: 'safe-id',
            safe_address: SAFE_ADDRESS,
            safe_name: 'Base wallet',
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
        safe_address: SAFE_ADDRESS,
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
        blockNumber: 45725826,
        isError: false,
        tokenAddress: USDC_ADDRESS,
        tokenSymbol: 'USDC',
        chainId: 100,
        safeId: 'safe-id',
        safeAddress: SAFE_ADDRESS,
        safeName: 'Gnosis wallet',
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

  it('normalizes manually approved x402 approval requests into merchant-facing transactions', async () => {
    vi.spyOn(pool, 'query')
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'approval-id',
            tx_hash: TX_HASH,
            agent_id: 'agent-id',
            agent_name: 'Research assistant',
            safe_id: 'safe-id',
            safe_address: SAFE_ADDRESS,
            safe_name: 'Main wallet',
            chain_id: 8453,
            token_symbol: 'USDC',
            token_address: USDC_ADDRESS,
            to_address: '0x1111111111111111111111111111111111111111',
            amount_raw: '10000',
            amount_human: '0.01',
            merchant_address: '0x2222222222222222222222222222222222222222',
            payment_resource_url: 'https://mcp.soundside.ai/mcp',
            payment_proof_status: 'protocol_receipt_attached',
            payment_reconciliation_event_type: null,
            executed_at: '2026-05-22T07:50:10Z',
            created_at: '2026-05-22T07:49:55Z',
          },
        ],
      } as never)

    const result = await mergeX402Transactions(
      'user-id',
      [{
        id: 'safe-id',
        safe_address: SAFE_ADDRESS,
        chain_id: 8453,
        name: 'Main wallet',
      }],
      [{
        hash: TX_HASH,
        type: 'erc20',
        from: SAFE_ADDRESS,
        to: '0x1111111111111111111111111111111111111111',
        value: '10000',
        valueFormatted: '0.01',
        asset: 'USDC',
        decimals: 6,
        direction: 'out',
        timestamp: 1779436199,
        blockNumber: 45725826,
        isError: false,
        tokenAddress: USDC_ADDRESS,
        tokenSymbol: 'USDC',
        chainId: 8453,
        safeId: 'safe-id',
        safeAddress: SAFE_ADDRESS,
        safeName: 'Main wallet',
      }],
    )

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      hash: TX_HASH,
      from: SAFE_ADDRESS,
      to: '0x2222222222222222222222222222222222222222',
      value: '10000',
      valueFormatted: '0.01',
      asset: 'USDC',
      direction: 'out',
      source: 'x402',
      x402ResourceUrl: 'https://mcp.soundside.ai/mcp',
      x402MerchantAddress: '0x2222222222222222222222222222222222222222',
      safeId: 'safe-id',
      safeName: 'Main wallet',
      agentId: 'agent-id',
      agentName: 'Research assistant',
      paymentId: 'approval-id',
      paymentProofStatus: 'protocol_receipt_attached',
      paymentFlowStatus: 'paid',
      paymentAttentionReason: null,
    })
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
            safe_id: 'safe-id',
            safe_address: SAFE_ADDRESS,
            safe_name: 'Main wallet',
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
        safe_address: SAFE_ADDRESS,
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
      blockNumber: 45725826,
      isError: false,
      tokenAddress: USDC_ADDRESS,
      tokenSymbol: 'USDC',
      chainId: 8453,
      safeId: 'safe-base',
      safeAddress: SAFE_ADDRESS,
      safeName: 'Based',
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
            safe_id: 'safe-base',
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
        safeId: 'safe-gnosis',
        chainId: 100,
        safeName: 'Gnosis',
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
      safeId: 'safe-gnosis',
      chainId: 100,
    })
    expect(result[1].agentId).toBeUndefined()
    expect(result[1].paymentId).toBeUndefined()

    const paymentIntentSql = String(queryMock.mock.calls[0][0])
    expect(paymentIntentSql).toContain('JOIN user_safes us')
    expect(paymentIntentSql).toContain('LOWER(us.safe_address) = LOWER(pi.safe_address)')
    expect(paymentIntentSql).toContain('us.id = ANY($3)')
    expect(paymentIntentSql).toContain('us.chain_id = pi.chain_id')
    expect(paymentIntentSql).not.toContain('us.id = a.safe_id')
    expect(queryMock.mock.calls[0][1]).toEqual([
      [TX_HASH.toLowerCase()],
      'user-id',
      ['safe-base', 'safe-gnosis'],
    ])
  })

  it('enriches raw explorer transfers from executed x402 approvals by Safe and chain', async () => {
    const queryMock = vi.spyOn(pool, 'query')
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'approval-id',
            tx_hash: TX_HASH.toLowerCase(),
            safe_id: 'safe-base',
            chain_id: 8453,
            agent_id: 'agent-id',
            agent_name: 'Soundside agent',
            source: 'x402',
            payment_resource_url: 'https://mcp.soundside.ai/mcp',
            merchant_address: '0x2222222222222222222222222222222222222222',
            payment_proof_status: null,
            payment_reconciliation_event_type: null,
          },
        ],
      } as never)
      .mockResolvedValueOnce({ rows: [] } as never)

    const result = await enrichTransactionsWithAgents('user-id', [
      explorerTransfer(),
      explorerTransfer({
        safeId: 'safe-gnosis',
        chainId: 100,
        safeName: 'Gnosis',
      }),
    ])

    expect(result[0]).toMatchObject({
      hash: TX_HASH,
      source: 'x402',
      x402ResourceUrl: 'https://mcp.soundside.ai/mcp',
      x402MerchantAddress: '0x2222222222222222222222222222222222222222',
      agentId: 'agent-id',
      agentName: 'Soundside agent',
      paymentId: 'approval-id',
      paymentProofStatus: 'payment_confirmed',
    })
    expect(result[1]).toMatchObject({
      hash: TX_HASH,
      safeId: 'safe-gnosis',
      chainId: 100,
    })
    expect(result[1].agentId).toBeUndefined()
    expect(result[1].paymentId).toBeUndefined()

    const approvalRequestSql = String(queryMock.mock.calls[1][0])
    expect(approvalRequestSql).toContain('JOIN user_safes us')
    expect(approvalRequestSql).toContain('LOWER(us.safe_address) = LOWER(ar.safe_address)')
    expect(approvalRequestSql).toContain('us.id = ANY($3)')
    expect(approvalRequestSql).toContain('us.chain_id = ar.chain_id')
    expect(approvalRequestSql).not.toContain('us.id = a.safe_id')
    expect(queryMock.mock.calls[1][1]).toEqual([
      [TX_HASH.toLowerCase()],
      'user-id',
      ['safe-base', 'safe-gnosis'],
    ])
  })

  it('labels submitted delegate sweeps with agent context by Safe and chain', async () => {
    const queryMock = vi.spyOn(pool, 'query')
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'sweep-id',
            tx_hash: TX_HASH.toLowerCase(),
            safe_id: 'safe-base',
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
        safeId: 'safe-gnosis',
        chainId: 100,
        safeName: 'Gnosis',
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
      safeId: 'safe-gnosis',
      chainId: 100,
    })
    expect(result[1].activityType).toBeUndefined()
    expect(result[1].agentId).toBeUndefined()

    const sweepSql = String(queryMock.mock.calls[2][0])
    expect(sweepSql).toContain('FROM delegate_sweeps ds')
    expect(sweepSql).toContain('LOWER(us.safe_address) = LOWER(ds.to_address)')
    expect(sweepSql).toContain('us.chain_id = ds.chain_id')
    expect(sweepSql).toContain("ds.status = 'submitted'")
    expect(queryMock.mock.calls[2][1]).toEqual([
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
      if (String(sql).includes('FROM user_safes')) {
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
    safes: Array<{ id: string; safe_address: string; chain_id: number; name: string }>,
    validAgentIds: string[] = [],
  ) {
    return vi.spyOn(pool, 'query').mockImplementation(async (sql: unknown, params?: unknown[]) => {
      const text = String(sql)
      if (text.includes('FROM user_safes')) {
        return { rows: safes } as never
      }
      if (text.includes('FROM agents WHERE id')) {
        const agentId = (params as string[] | undefined)?.[0]
        return {
          rows: agentId && validAgentIds.includes(agentId) ? [{ id: agentId }] : [],
        } as never
      }
      // payment_intents / approval_requests / delegate_sweeps enrichment
      // and x402 merge queries — no machine-payment activity in these fixtures.
      return { rows: [] } as never
    })
  }

  it('paginates the merged, timestamp-sorted feed with exact offset/limit slicing', async () => {
    const token = signToken({ sub: 'page-user', email: 'page@example.com' })
    stubMixedTransactionFetch()
    mockPoolForAggregation([
      { id: 'safe-page', safe_address: SAFE_ADDRESS, chain_id: 8453, name: 'Main' },
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

  it('filters by tokenKey: native excludes ERC-20, and the token address excludes native', async () => {
    const token = signToken({ sub: 'filter-user', email: 'filter@example.com' })
    stubMixedTransactionFetch()
    mockPoolForAggregation([
      { id: 'safe-filter', safe_address: SAFE_ADDRESS, chain_id: 8453, name: 'Main' },
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

  it('filters by safeId to a single owned Safe, rejecting an unrecognized one earlier', async () => {
    const token = signToken({ sub: 'safeid-user', email: 'safeid@example.com' })
    const fetchMock = stubEmptyTransactionFetch()
    const SAFE_A_ID = '33333333-3333-4333-8333-333333333333'
    const SAFE_B_ID = '44444444-4444-4444-8444-444444444444'
    mockPoolForAggregation([
      { id: SAFE_A_ID, safe_address: SAFE_ADDRESS, chain_id: 8453, name: 'A' },
      { id: SAFE_B_ID, safe_address: SENDER, chain_id: 100, name: 'B' },
    ])

    const scoped = await app.inject({
      method: 'GET',
      url: `/transactions?safeId=${SAFE_A_ID}&fresh=1`,
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
      url: '/transactions?safeId=00000000-0000-4000-8000-000000000000&fresh=1',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(unowned.statusCode).toBe(400)
    expect(unowned.json().error).toBe('Invalid safeId')
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
      if (text.includes('FROM user_safes')) {
        return {
          rows: [{ id: 'safe-agentfilter', safe_address: SAFE_ADDRESS, chain_id: 8453, name: 'Main' }],
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
              safe_id: 'safe-agentfilter',
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
      [{ id: 'safe-agentreject', safe_address: SAFE_ADDRESS, chain_id: 8453, name: 'Main' }],
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
      if (text.includes('FROM user_safes')) {
        return {
          rows: [{ id: 'safe-csv', safe_address: SAFE_ADDRESS, chain_id: 8453, name: 'Main wallet' }],
        } as never
      }
      if (text.includes('FROM payment_intents pi') && text.includes('JOIN agents a')) {
        return {
          rows: [
            {
              id: 'payment-csv',
              tx_hash: TX_HASH,
              agent_id: 'agent-csv',
              agent_name: 'Research assistant',
              safe_id: 'safe-csv',
              safe_address: SAFE_ADDRESS,
              safe_name: 'Main wallet',
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
      isError: false,
      paymentFlowStatus: 'paid',
      source: 'x402',
    })
    expect(typeof tx.timestamp).toBe('number')
    expect(tx.timestamp).toBeGreaterThan(0)
    expect(tx.activityType).toBeUndefined()
  })
})
