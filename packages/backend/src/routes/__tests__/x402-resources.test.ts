import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { expectMatchesSpec } from '../../openapi/response-shape.js'
import fastifyJwt from '@fastify/jwt'
import { ethers } from 'ethers'

const USER = 'user-1'
// A real row's id is a uuid (x402_resources.id is UUID PRIMARY KEY), and the
// spec says so (#1446) — 'resource-1' would describe a response the database
// cannot produce.
const RESOURCE_ID = '3f2b91c4-7d18-4a52-9c6e-1b8d0e5a7f43'
// x402_receipts.id is UUID PRIMARY KEY too (#1446).
const RECEIPT_ID = 'c81d47a9-05e6-4f30-b2a7-6e93f1c40d28'
const SAFE = '0x135a9215604711AC70d970e12Caa812c53537EF4'
const PAYER_SAFE = '0x15179876c595922999C2d5DC7c23Cc7711fE799a'
const DELEGATE = '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const DAI = '0x00000000000000000000000000000000000000da'
// Gnosis EURe. The chain registry is stubbed in this file, so the fixture's
// decimals come from the stub — the test below separately pins that the REAL
// registry agrees, which is what keeps the stub honest (#1630).
const EURE_GNOSIS = '0xcB444e90D8198415266c6a2724b7900fb12FC56E'
const MODULE = '0x0000000000000000000000000000000000000042'
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const TX_HASH = `0x${'ab'.repeat(32)}`

const { mockQuery, allowanceMocks, chainMocks } = vi.hoisted(() => {
  const usdc = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
  const module = '0x0000000000000000000000000000000000000042'
  // EURe (18 decimals) sits beside USDC (6) so a test can tell "asks the token"
  // apart from "hardcodes 6" (#1630) — with a single-token registry the two
  // are indistinguishable.
  const eure = '0xcB444e90D8198415266c6a2724b7900fb12FC56E'
  const chain = {
    tokens: {
      USDC: {
        symbol: 'USDC',
        address: usdc,
        decimals: 6,
      },
      EURE: {
        symbol: 'EURe',
        address: eure,
        decimals: 18,
      },
    },
    tokenByAddress: {
      [usdc.toLowerCase()]: {
        symbol: 'USDC',
        address: usdc,
        decimals: 6,
      },
    },
    contracts: {
      allowanceModule: module,
    },
  }

  return {
    mockQuery: vi.fn(),
    allowanceMocks: {
      getProvider: vi.fn(),
    },
    chainMocks: {
      getChain: vi.fn(() => chain),
    },
  }
})

vi.mock('../../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockQuery(...args),
  },
}))

vi.mock('../../rails/allowance-module.js', () => allowanceMocks)
vi.mock('../../domain/chains.js', () => chainMocks)

import x402ResourceRoutes from '../x402-resources.js'

const ALLOWANCE_MODULE_IFACE = new ethers.Interface([
  'function executeAllowanceTransfer(address safe, address token, address to, uint96 amount, address paymentToken, uint96 payment, address delegate, bytes signature)',
])

function resourceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RESOURCE_ID,
    user_id: USER,
    safe_id: 'safe-1',
    safe_address: SAFE,
    name: 'Weather API',
    description: 'Hourly forecast data',
    price_amount: '1500',
    token_address: USDC,
    token_symbol: 'USDC',
    chain_id: 8453,
    active: true,
    created_at: '2026-06-01T00:00:00.000Z',
    ...overrides,
  }
}

function validPaymentCalldata(amount = 1500n) {
  return ALLOWANCE_MODULE_IFACE.encodeFunctionData('executeAllowanceTransfer', [
    PAYER_SAFE,
    USDC,
    SAFE,
    amount,
    ZERO_ADDRESS,
    0n,
    DELEGATE,
    '0x1234',
  ])
}


/**
 * SQL-keyed DB stub (#1219's sanctioned form, not a positional once-chain):
 * each statement is answered by what it ASKS for, so adding a query to a
 * route cannot silently re-shuffle a test's answers. Used by the routes
 * documented under #1446.
 */
function mockDbFor(opts: {
  resources?: Array<Record<string, unknown>>
  receipts?: Array<Record<string, unknown>>
  deactivated?: Array<Record<string, unknown>>
} = {}) {
  mockQuery.mockImplementation(async (sql: string) => {
    const text = String(sql)
    if (/FROM x402_receipts/.test(text)) return { rows: opts.receipts ?? [] }
    if (/SET active = false/.test(text)) return { rows: opts.deactivated ?? [] }
    if (/FROM x402_resources/.test(text)) return { rows: opts.resources ?? [] }
    return { rows: [] }
  })
}

describe('x402 resource routes', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(x402ResourceRoutes, { prefix: '/x402' })
    token = app.jwt.sign({ sub: USER, email: 'ada@example.com' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    mockQuery.mockReset()
    allowanceMocks.getProvider.mockReset()
    chainMocks.getChain.mockClear()
  })

  function authed(
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    payload?: object,
  ) {
    return app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      payload,
    })
  }

  describe('authentication', () => {
    const protectedEndpoints: Array<['GET' | 'POST' | 'DELETE', string, object?]> = [
      ['POST', '/x402/resources', {
        name: 'Weather API',
        price_amount: '1500',
        token_address: USDC,
        token_symbol: 'USDC',
      }],
      ['GET', '/x402/resources'],
      ['DELETE', `/x402/resources/${RESOURCE_ID}`],
      ['GET', '/x402/receipts'],
    ]

    for (const [method, url, payload] of protectedEndpoints) {
      it(`${method} ${url} rejects unauthenticated requests before DB work`, async () => {
        const res = await app.inject({ method, url, payload })

        expect(res.statusCode).toBe(401)
        expect(mockQuery).not.toHaveBeenCalled()
        expect(allowanceMocks.getProvider).not.toHaveBeenCalled()
      })
    }
  })

  describe('POST /x402/resources', () => {
    it('rejects malformed token addresses before DB or provider work', async () => {
      const res = await authed('POST', '/x402/resources', {
        name: 'Weather API',
        price_amount: '1500',
        token_address: '0xbad',
        token_symbol: 'USDC',
      })

      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error: 'Valid token_address is required' })
      expect(mockQuery).not.toHaveBeenCalled()
      expect(allowanceMocks.getProvider).not.toHaveBeenCalled()
    })

    it('creates a resource for the caller and returns the current challenge shape', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ safe_address: SAFE }] })
        .mockResolvedValueOnce({ rows: [{ id: RESOURCE_ID }] })

      const res = await authed('POST', '/x402/resources', {
        name: '  Weather API  ',
        description: '  Hourly forecast data  ',
        price_amount: '1500',
        token_address: USDC,
        token_symbol: 'usdc',
        safe_id: 'safe-1',
      })

      expect(res.statusCode).toBe(201)
      expect(res.json()).toEqual({
        resource_id: RESOURCE_ID,
        name: 'Weather API',
        price_amount: '1500',
        price_human: '0.0015',
        token_symbol: 'USDC',
        token_address: USDC.toLowerCase(),
        chain_id: 8453,
        pay_to: SAFE,
        challenge: {
          version: '1',
          resource_id: RESOURCE_ID,
          accepts: [{
            scheme: 'exact',
            network: 'eip155:8453',
            asset: USDC,
            maxAmountRequired: '1500',
            payTo: SAFE,
            description: 'Weather API',
            extra: {
              name: 'Haven AllowanceModule',
              authorize_endpoint: '/x402/authorize',
              verify_endpoint: `/x402/resources/${RESOURCE_ID}/verify`,
            },
          }],
        },
      })
      // #1446: the documented 201 shape, against the real payload.
      expectMatchesSpec('POST', '/x402/resources', res.json(), '201')
      expect(mockQuery).toHaveBeenNthCalledWith(
        1,
        'SELECT safe_address FROM user_safes WHERE id = $1 AND user_id = $2',
        ['safe-1', USER],
      )
      expect(mockQuery.mock.calls[1][1]).toEqual([
        USER,
        'safe-1',
        'Weather API',
        'Hourly forecast data',
        '1500',
        USDC.toLowerCase(),
        'USDC',
        8453,
      ])
    })
  })


  // #1446: the three routes that had no test of their own — documented shapes
  // are worthless if nothing ever compares them to a real payload.
  describe('GET /x402/resources', () => {
    it('lists the caller\'s resources with a built challenge (#1446)', async () => {
      mockDbFor({ resources: [resourceRow()] })

      const res = await authed('GET', '/x402/resources')

      expect(res.statusCode).toBe(200)
      expect(res.json().resources).toHaveLength(1)
      expect(res.json().resources[0].resource_id).toBe(RESOURCE_ID)
      expectMatchesSpec('GET', '/x402/resources', res.json())
    })

    it('a detached Safe leaves pay_to AND challenge null together (#1446)', async () => {
      // safe_id is ON DELETE SET NULL, so this is a state the table can reach:
      // the resource stays listed but cannot be paid, and the spec says the two
      // nulls travel together.
      mockDbFor({ resources: [resourceRow({ safe_address: null, safe_id: null })] })

      const res = await authed('GET', '/x402/resources')

      expect(res.json().resources[0].pay_to).toBeNull()
      expect(res.json().resources[0].challenge).toBeNull()
      expectMatchesSpec('GET', '/x402/resources', res.json())
    })

    it('includes deactivated resources — active is a field, not a filter', async () => {
      mockDbFor({ resources: [resourceRow({ active: false })] })

      const res = await authed('GET', '/x402/resources')

      expect(res.json().resources[0].active).toBe(false)
      expectMatchesSpec('GET', '/x402/resources', res.json())
    })
  })

  describe('DELETE /x402/resources/:id', () => {
    it('deactivates the caller\'s resource and returns the documented shape', async () => {
      mockDbFor({ deactivated: [{ id: RESOURCE_ID }] })

      const res = await authed('DELETE', `/x402/resources/${RESOURCE_ID}`)

      expect(res.statusCode).toBe(200)
      expectMatchesSpec('DELETE', '/x402/resources/{id}', res.json())
      // Soft delete, scoped to the caller — the row survives so its receipts do.
      const [sql, params] = mockQuery.mock.calls[0]
      expect(String(sql)).toMatch(/SET active = false/)
      expect(String(sql)).not.toMatch(/DELETE FROM/)
      expect(params).toEqual([RESOURCE_ID, USER])
    })

    it("404s another user's resource rather than deactivating it", async () => {
      mockDbFor({ deactivated: [] })

      const res = await authed('DELETE', `/x402/resources/${RESOURCE_ID}`)

      expect(res.statusCode).toBe(404)
    })
  })

  describe('GET /x402/receipts', () => {
    it('returns verified payments in the documented shape (#1446)', async () => {
      mockDbFor({
        receipts: [{
          id: RECEIPT_ID,
          resource_id: RESOURCE_ID,
          resource_name: 'Weather API',
          user_id: USER,
          tx_hash: '0x' + 'ab'.repeat(32),
          payer_address: DELEGATE,
          amount_raw: '1500',
          chain_id: 8453,
          token_address: USDC,
          verified_at: '2026-06-26T09:00:00.000Z',
        }],
      })

      const res = await authed('GET', '/x402/receipts')

      expect(res.statusCode).toBe(200)
      expect(res.json().receipts[0].receipt_id).toBe(RECEIPT_ID)
      expectMatchesSpec('GET', '/x402/receipts', res.json())
      // The cap is part of the contract, not an implementation detail.
      expect(String(mockQuery.mock.calls[0][0])).toMatch(/LIMIT 100/)
    })

    it('#1630 MUTATION PROOF: an 18-decimal token formats with ITS decimals, not 6', async () => {
      // amount_human used to format every token with 6 decimals — correct for
      // USDC, off by twelve orders of magnitude for an 18-decimal one like
      // Gnosis EURe. amount_raw was always authoritative, but a dashboard
      // reading 1500000000000 EURe for a €1.50 receipt is not a small wart.
      mockDbFor({
        receipts: [{
          id: RECEIPT_ID,
          resource_id: RESOURCE_ID,
          resource_name: 'EU invoice API',
          user_id: USER,
          tx_hash: '0x' + 'cd'.repeat(32),
          payer_address: DELEGATE,
          amount_raw: '1500000000000000000', // 1.5 EURe
          chain_id: 100,
          token_address: EURE_GNOSIS,
          verified_at: '2026-06-26T09:00:00.000Z',
        }],
      })

      const res = await authed('GET', '/x402/receipts')

      expect(res.statusCode).toBe(200)
      // Against the previous unconditional 6 this reads '1500000000000.00'.
      expect(res.json().receipts[0].amount_human).toBe('1.50')
      // The authoritative field is untouched by the formatting change.
      expect(res.json().receipts[0].amount_raw).toBe('1500000000000000000')
    })

    it('#1630: the stubbed registry agrees with the REAL one about EURe', async () => {
      // The route test above runs against the stub. This one imports the
      // shared registry unmocked, so a stub that quietly disagreed with
      // reality could not keep the decimals test passing.
      const { getChainData } = await vi.importActual<
        typeof import('@haven_ai/core')
      >('@haven_ai/core')
      const eure = getChainData(100).tokens.find(
        (t) => t.address?.toLowerCase() === EURE_GNOSIS.toLowerCase(),
      )
      expect(eure?.decimals).toBe(18)
    })

    it('#1630: a token this deployment does not know still falls back to 6', async () => {
      // The fallback is what makes the fix safe: an unrecognised token is no
      // worse off than it was before, never NaN and never a thrown request.
      mockDbFor({
        receipts: [{
          id: RECEIPT_ID,
          resource_id: RESOURCE_ID,
          resource_name: 'Unknown token API',
          user_id: USER,
          tx_hash: '0x' + 'ef'.repeat(32),
          payer_address: DELEGATE,
          amount_raw: '1500',
          chain_id: 8453,
          token_address: '0x' + '99'.repeat(20),
          verified_at: '2026-06-26T09:00:00.000Z',
        }],
      })

      const res = await authed('GET', '/x402/receipts')

      expect(res.json().receipts[0].amount_human).toBe('0.0015')
    })

    it('an unverifiable payer is null, not absent', async () => {
      mockDbFor({
        receipts: [{
          id: RECEIPT_ID,
          resource_id: RESOURCE_ID,
          resource_name: 'Weather API',
          user_id: USER,
          tx_hash: '0x' + 'ab'.repeat(32),
          payer_address: null,
          amount_raw: '1500',
          chain_id: 8453,
          token_address: USDC,
          verified_at: '2026-06-26T09:00:00.000Z',
        }],
      })

      const res = await authed('GET', '/x402/receipts')

      expect(res.json().receipts[0].payer_address).toBeNull()
      expectMatchesSpec('GET', '/x402/receipts', res.json())
    })
  })

  describe('GET /x402/resources/:id/challenge', () => {
    it('is public and returns the current 402 challenge body', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [resourceRow()] })

      const res = await app.inject({
        method: 'GET',
        url: `/x402/resources/${RESOURCE_ID}/challenge`,
      })

      expect(res.statusCode).toBe(402)
      expect(res.json()).toEqual({
        version: '1',
        resource_id: RESOURCE_ID,
        accepts: [{
          scheme: 'exact',
          network: 'eip155:8453',
          asset: USDC,
          maxAmountRequired: '1500',
          payTo: SAFE,
          description: 'Weather API',
          extra: {
            name: 'Haven AllowanceModule',
            authorize_endpoint: '/x402/authorize',
            verify_endpoint: `/x402/resources/${RESOURCE_ID}/verify`,
          },
        }],
      })
      // The success code here is 402, and the spec documents it as such (#1446).
      expectMatchesSpec('GET', '/x402/resources/{id}/challenge', res.json(), '402')
    })
  })

  describe('POST /x402/resources/:id/verify', () => {
    it('rejects malformed tx hashes before DB or provider work', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/x402/resources/${RESOURCE_ID}/verify`,
        payload: { tx_hash: '0xbad' },
      })

      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error: 'Valid tx_hash (0x + 64 hex chars) is required' })
      expect(mockQuery).not.toHaveBeenCalled()
      expect(allowanceMocks.getProvider).not.toHaveBeenCalled()
    })

    it('short-circuits duplicate receipts before on-chain verification', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [resourceRow()] })
        .mockResolvedValueOnce({ rows: [{ id: RECEIPT_ID }] })

      const res = await app.inject({
        method: 'POST',
        url: `/x402/resources/${RESOURCE_ID}/verify`,
        payload: { tx_hash: TX_HASH },
      })

      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({ error: 'This transaction has already been used as payment' })
      expect(allowanceMocks.getProvider).not.toHaveBeenCalled()
      expect(mockQuery).toHaveBeenCalledTimes(2)
    })

    it('returns 402 when the transaction does not pay the resource Safe', async () => {
      const wrongRecipient = '0x0000000000000000000000000000000000000099'
      const data = ALLOWANCE_MODULE_IFACE.encodeFunctionData('executeAllowanceTransfer', [
        PAYER_SAFE,
        USDC,
        wrongRecipient,
        1500n,
        ZERO_ADDRESS,
        0n,
        DELEGATE,
        '0x1234',
      ])
      const provider = {
        getTransaction: vi.fn().mockResolvedValue({ to: MODULE, data }),
        getTransactionReceipt: vi.fn().mockResolvedValue({ status: 1 }),
      }
      allowanceMocks.getProvider.mockReturnValue(provider)
      mockQuery
        .mockResolvedValueOnce({ rows: [resourceRow()] })
        .mockResolvedValueOnce({ rows: [] })

      const res = await app.inject({
        method: 'POST',
        url: `/x402/resources/${RESOURCE_ID}/verify`,
        payload: { tx_hash: TX_HASH },
      })

      expect(res.statusCode).toBe(402)
      expect(res.json()).toMatchObject({
        verified: false,
        reason: `Payment went to ${wrongRecipient}, expected ${SAFE}`,
        expected: {
          to: SAFE,
          token: USDC,
          min_amount: '1500',
          chain_id: 8453,
        },
      })
      expect(mockQuery).toHaveBeenCalledTimes(2)
      // The documented NEGATIVE answer: verified:false plus the expected terms.
      expectMatchesSpec('POST', '/x402/resources/{id}/verify', res.json(), '402')
    })

    it('returns 402 when the payment uses the wrong token', async () => {
      const data = ALLOWANCE_MODULE_IFACE.encodeFunctionData('executeAllowanceTransfer', [
        PAYER_SAFE,
        DAI,
        SAFE,
        1500n,
        ZERO_ADDRESS,
        0n,
        DELEGATE,
        '0x1234',
      ])
      const provider = {
        getTransaction: vi.fn().mockResolvedValue({ to: MODULE, data }),
        getTransactionReceipt: vi.fn().mockResolvedValue({ status: 1 }),
      }
      allowanceMocks.getProvider.mockReturnValue(provider)
      mockQuery
        .mockResolvedValueOnce({ rows: [resourceRow()] })
        .mockResolvedValueOnce({ rows: [] })

      const res = await app.inject({
        method: 'POST',
        url: `/x402/resources/${RESOURCE_ID}/verify`,
        payload: { tx_hash: TX_HASH },
      })

      expect(res.statusCode).toBe(402)
      expect(res.json()).toMatchObject({
        verified: false,
        reason: expect.stringContaining(`expected ${USDC}`),
      })
      expect(mockQuery).toHaveBeenCalledTimes(2)
    })

    it('returns 402 when the payment amount is below the resource price', async () => {
      const provider = {
        getTransaction: vi.fn().mockResolvedValue({ to: MODULE, data: validPaymentCalldata(1499n) }),
        getTransactionReceipt: vi.fn().mockResolvedValue({ status: 1 }),
      }
      allowanceMocks.getProvider.mockReturnValue(provider)
      mockQuery
        .mockResolvedValueOnce({ rows: [resourceRow()] })
        .mockResolvedValueOnce({ rows: [] })

      const res = await app.inject({
        method: 'POST',
        url: `/x402/resources/${RESOURCE_ID}/verify`,
        payload: { tx_hash: TX_HASH },
      })

      expect(res.statusCode).toBe(402)
      expect(res.json()).toMatchObject({
        verified: false,
        reason: 'Insufficient amount: got 1499, required 1500',
      })
      expect(mockQuery).toHaveBeenCalledTimes(2)
    })

    it('stores one receipt for a valid AllowanceModule payment and returns its shape', async () => {
      const provider = {
        getTransaction: vi.fn().mockResolvedValue({ to: MODULE, data: validPaymentCalldata() }),
        getTransactionReceipt: vi.fn().mockResolvedValue({ status: 1 }),
      }
      allowanceMocks.getProvider.mockReturnValue(provider)
      mockQuery
        .mockResolvedValueOnce({ rows: [resourceRow()] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: RECEIPT_ID, verified_at: '2026-06-26T09:00:00.000Z' }] })

      const res = await app.inject({
        method: 'POST',
        url: `/x402/resources/${RESOURCE_ID}/verify`,
        payload: { tx_hash: TX_HASH },
      })

      expect(res.statusCode).toBe(201)
      expect(res.json()).toEqual({
        verified: true,
        receipt_id: RECEIPT_ID,
        resource_id: RESOURCE_ID,
        resource_name: 'Weather API',
        tx_hash: TX_HASH,
        payer_address: PAYER_SAFE.toLowerCase(),
        amount_raw: '1500',
        amount_human: '0.0015',
        token_symbol: 'USDC',
        verified_at: '2026-06-26T09:00:00.000Z',
      })
      expect(provider.getTransaction).toHaveBeenCalledWith(TX_HASH)
      expect(provider.getTransactionReceipt).toHaveBeenCalledWith(TX_HASH)
      expect(mockQuery).toHaveBeenNthCalledWith(
        3,
        expect.stringContaining('INSERT INTO x402_receipts'),
        [RESOURCE_ID, USER, TX_HASH, PAYER_SAFE.toLowerCase(), '1500', 8453],
      )
      expectMatchesSpec('POST', '/x402/resources/{id}/verify', res.json(), '201')
    })
  })
})
