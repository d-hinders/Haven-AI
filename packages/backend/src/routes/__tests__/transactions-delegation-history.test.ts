/**
 * #2849 (safe-retirement slice 3) — the behavioural upside of dropping the
 * Safe Transaction Service leg from transaction history.
 *
 * Before #2849, `fetchSafeTransactions` called the Safe Transaction
 * Service's transfers endpoint unconditionally for every account. A Hybrid
 * DeleGator is unknown to that service, so the leg failed on every
 * delegation-rail history read, was swallowed into `logFail('safe-transfers')`,
 * and permanently pinned `hadFailures` — the route reported
 * `partialFailure: true` for a healthy account, forever.
 *
 * This file is NEW in #2849. The pre-existing characterization tests in
 * `transactions.test.ts` are untouched by this slice (its only change there
 * is the removal of the one test whose subject was the deleted leg itself).
 */
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import transactionRoutes from '../transactions.js'
import pool from '../../db.js'

const SAFE_ADDRESS = '0x135a9215604711AC70d970e12Caa812c53537EF4'
const SENDER = '0x55C9d84427756D6f82480427Bb778F6dc0cC755E'
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const NATIVE_HASH = '0xA11100000000000000000000000000000000000000000000000000000000A1'
const ERC20_HASH = '0xB22200000000000000000000000000000000000000000000000000000000B2'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Blockscout serves both rows (it is the source for delegation-rail history
 * too — #2669). Any other URL — including a Safe Transaction Service
 * transfers call, should the leg ever come back — rejects, which the
 * aggregation swallows into `hadFailures` and this test fails on. A
 * delegation read that touches api.safe.global again cannot pass here.
 */
function stubBlockscoutOnlyFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = input.toString()

    if (url.includes('/addresses/') && url.includes('/token-transfers')) {
      return jsonResponse({
        items: [{
          transaction_hash: ERC20_HASH,
          block_number: 400,
          timestamp: '2026-05-08T00:00:00Z',
          from: { hash: SENDER },
          to: { hash: SAFE_ADDRESS },
          total: { decimals: '6', value: '20000' },
          token: {
            address_hash: USDC_ADDRESS,
            name: 'USD Coin',
            symbol: 'USDC',
            decimals: '6',
          },
        }],
        next_page_params: null,
      })
    }

    if (url.includes('/addresses/') && url.includes('/transactions')) {
      return jsonResponse({
        items: [{
          hash: NATIVE_HASH,
          block_number: 500,
          timestamp: '2026-05-08T06:00:00Z',
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

    throw new Error(`Unexpected fetch URL: ${url}`)
  })

  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

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

describe('#2849 delegation-account history read', () => {
  it('returns partialFailure: false when Blockscout succeeds, with rows intact', async () => {
    const token = app.jwt.sign({ sub: 'delegation-user', email: 'delegation@example.com' }, { expiresIn: '1h' })
    const fetchMock = stubBlockscoutOnlyFetch()
    const queryMock = vi.spyOn(pool, 'query').mockImplementation(async (sql: unknown) => {
      if (String(sql).includes('FROM user_safes')) {
        return {
          rows: [{ id: 'safe-delegation', safe_address: SAFE_ADDRESS, chain_id: 8453, name: 'Delegation' }],
        } as never
      }
      return { rows: [] } as never
    })

    const response = await app.inject({
      method: 'GET',
      url: '/transactions?fresh=1&limit=100',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json() as {
      partialFailure: boolean
      failedSafeIds: string[]
      transactions: Array<{ hash: string }>
    }

    // The behavioural change: a healthy delegation read is no longer a
    // permanent "partial failure".
    expect(body.partialFailure).toBe(false)
    expect(body.failedSafeIds).toEqual([])

    // Blockscout rows flow through unchanged — the retired leg contributed
    // none of them before either (it 404'd), so rows are identical to the
    // pre-#2849 read.
    expect(body.transactions.map((tx) => tx.hash)).toEqual([NATIVE_HASH, ERC20_HASH])

    // And the read went to Blockscout, not the Safe Transaction Service.
    const safesCall = queryMock.mock.calls.find((call) => String(call[0]).includes('FROM user_safes'))
    expect(safesCall).toBeDefined()
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('https://base.blockscout.com/api/v2/addresses/'),
    )
  })
})
