import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { ethers } from 'ethers'

const USER = 'user-1'
const RESOURCE_ID = 'resource-1'
const RECEIPT_ID = 'receipt-1'
const SAFE = '0x135a9215604711AC70d970e12Caa812c53537EF4'
const PAYER_SAFE = '0x15179876c595922999C2d5DC7c23Cc7711fE799a'
const DELEGATE = '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const DAI = '0x00000000000000000000000000000000000000da'
const MODULE = '0x0000000000000000000000000000000000000042'
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const TX_HASH = `0x${'ab'.repeat(32)}`

const { mockQuery, allowanceMocks, chainMocks } = vi.hoisted(() => {
  const usdc = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
  const module = '0x0000000000000000000000000000000000000042'
  const chain = {
    tokens: {
      USDC: {
        symbol: 'USDC',
        address: usdc,
        decimals: 6,
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

vi.mock('../../lib/allowance-module.js', () => allowanceMocks)
vi.mock('../../lib/chains.js', () => chainMocks)

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
    })
  })
})
