import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { FastifyInstance } from 'fastify'

const { mockQuery, mockGetSafeDetails } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetSafeDetails: vi.fn(),
}))

vi.mock('../../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockQuery(...args),
  },
}))

vi.mock('../../lib/safe-details.js', () => ({
  getSafeDetails: (...args: unknown[]) => mockGetSafeDetails(...args),
}))

import { buildApp } from '../../__tests__/helpers.js'

describe('User routes', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp()
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    mockQuery.mockReset()
    mockGetSafeDetails.mockReset()
  })

  function signToken(payload: { sub: string; email: string }): string {
    return app.jwt.sign(payload, { expiresIn: '1h' })
  }

  // --- PUT /user/profile ---
  describe('PUT /user/profile', () => {
    it('updates the user name for valid input + valid JWT', async () => {
      const token = signToken({ sub: 'user-1', email: 'test@example.com' })

      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          name: 'Ada Lovelace',
          email: 'test@example.com',
          wallet_address: null,
          safe_address: null,
          currency_preference: 'USD',
          created_at: '2025-01-01T00:00:00.000Z',
        }],
      })

      const response = await app.inject({
        method: 'PUT',
        url: '/user/profile',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: ' Ada   Lovelace ' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body.id).toBe('user-1')
      expect(body.name).toBe('Ada Lovelace')
    })

    it('returns 400 for invalid name', async () => {
      const token = signToken({ sub: 'user-1', email: 'test@example.com' })

      const response = await app.inject({
        method: 'PUT',
        url: '/user/profile',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Bad\nName' },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json().error).toBe('Enter a name using 80 characters or fewer')
    })

    it('returns 401 without auth', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/user/profile',
        payload: { name: 'Ada Lovelace' },
      })

      expect(response.statusCode).toBe(401)
      expect(response.json().error).toBe('Unauthorized')
    })
  })

  // --- PUT /user/wallet ---
  describe('PUT /user/wallet', () => {
    it('returns updated user for valid address + valid JWT', async () => {
      const token = signToken({ sub: 'user-1', email: 'test@example.com' })
      const walletAddress = '0x1234567890abcdef1234567890abcdef12345678'

      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'test@example.com',
          wallet_address: walletAddress,
          safe_address: null,
        }],
      })

      const response = await app.inject({
        method: 'PUT',
        url: '/user/wallet',
        headers: { authorization: `Bearer ${token}` },
        payload: { wallet_address: walletAddress },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body.id).toBe('user-1')
      expect(body.wallet_address).toBe(walletAddress)
    })

    it('returns 400 for invalid address', async () => {
      const token = signToken({ sub: 'user-1', email: 'test@example.com' })

      const response = await app.inject({
        method: 'PUT',
        url: '/user/wallet',
        headers: { authorization: `Bearer ${token}` },
        payload: { wallet_address: 'not-a-valid-address' },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json().error).toBe('Invalid Ethereum address')
    })

    it('returns 401 without auth', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/user/wallet',
        payload: { wallet_address: '0x1234567890abcdef1234567890abcdef12345678' },
      })

      expect(response.statusCode).toBe(401)
      expect(response.json().error).toBe('Unauthorized')
    })
  })

  // --- PUT /user/safe ---
  describe('PUT /user/safe', () => {
    it('returns updated user for valid address + valid JWT', async () => {
      const token = signToken({ sub: 'user-1', email: 'test@example.com' })
      const safeAddress = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'

      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'test@example.com',
          wallet_address: '0x1234567890abcdef1234567890abcdef12345678',
          safe_address: safeAddress,
        }],
      })

      const response = await app.inject({
        method: 'PUT',
        url: '/user/safe',
        headers: { authorization: `Bearer ${token}` },
        payload: { safe_address: safeAddress },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body.id).toBe('user-1')
      expect(body.safe_address).toBe(safeAddress)
    })

    it('returns 400 for invalid address', async () => {
      const token = signToken({ sub: 'user-1', email: 'test@example.com' })

      const response = await app.inject({
        method: 'PUT',
        url: '/user/safe',
        headers: { authorization: `Bearer ${token}` },
        payload: { safe_address: '0xinvalid' },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json().error).toBe('Invalid Ethereum address')
    })

    it('returns 401 without auth', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/user/safe',
        payload: { safe_address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' },
      })

      expect(response.statusCode).toBe(401)
      expect(response.json().error).toBe('Unauthorized')
    })

    it('defaults chain_id to 8453 (Base) when the body omits it', async () => {
      // Guards the Base-default change: a body without chain_id must link the
      // Safe on Base (8453), not Gnosis (100).
      const token = signToken({ sub: 'user-1', email: 'test@example.com' })
      const safeAddress = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'

      mockQuery
        .mockResolvedValueOnce({
          rows: [{ id: 'user-1', email: 'test@example.com', wallet_address: '0x1234567890abcdef1234567890abcdef12345678', safe_address: safeAddress }],
        }) // UPDATE users
        .mockResolvedValueOnce({ rows: [] }) // INSERT INTO user_safes

      const response = await app.inject({
        method: 'PUT',
        url: '/user/safe',
        headers: { authorization: `Bearer ${token}` },
        payload: { safe_address: safeAddress }, // no chain_id
      })

      expect(response.statusCode).toBe(200)
      const insertCall = mockQuery.mock.calls.find(
        (c) => typeof c[0] === 'string' && /INSERT INTO user_safes/.test(c[0] as string),
      )
      expect(insertCall, 'a user_safes INSERT was issued').toBeDefined()
      // params: [user_id, safe_address, chain_id, ...]
      expect((insertCall![1] as unknown[])[2]).toBe(8453)
    })
  })

  describe('GET /user/owners', () => {
    it('dedupes current on-chain owners across linked accounts and applies private aliases', async () => {
      const token = signToken({ sub: 'user-1', email: 'test@example.com' })
      const ownerA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      const ownerB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

      mockQuery
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'safe-1',
              safe_address: '0x1111111111111111111111111111111111111111',
              chain_id: 100,
              name: 'Main account',
            },
            {
              id: 'safe-2',
              safe_address: '0x2222222222222222222222222222222222222222',
              chain_id: 8453,
              name: 'Base account',
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              owner_address: ownerA,
              name: 'Ledger main',
            },
          ],
        })

      mockGetSafeDetails.mockImplementation(async (safeAddress: string) => {
        if (safeAddress === '0x1111111111111111111111111111111111111111') {
          return { address: safeAddress, owners: [ownerA, ownerB], threshold: 1, nonce: 0 }
        }
        return { address: safeAddress, owners: [ownerA], threshold: 1, nonce: 0 }
      })

      const response = await app.inject({
        method: 'GET',
        url: '/user/owners',
        headers: { authorization: `Bearer ${token}` },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({
        owners: [
          {
            owner_address: ownerA,
            name: 'Ledger main',
            accounts: [
              {
                id: 'safe-1',
                safe_address: '0x1111111111111111111111111111111111111111',
                chain_id: 100,
                name: 'Main account',
              },
              {
                id: 'safe-2',
                safe_address: '0x2222222222222222222222222222222222222222',
                chain_id: 8453,
                name: 'Base account',
              },
            ],
          },
          {
            owner_address: ownerB,
            name: null,
            accounts: [
              {
                id: 'safe-1',
                safe_address: '0x1111111111111111111111111111111111111111',
                chain_id: 100,
                name: 'Main account',
              },
            ],
          },
        ],
        partialFailure: false,
        failedSafeIds: [],
      })

      expect(mockQuery.mock.calls[1][1]).toEqual(['user-1', [ownerA, ownerB]])
    })

    it('hides aliases for removed owners by querying only current owner addresses', async () => {
      const token = signToken({ sub: 'user-1', email: 'test@example.com' })
      const currentOwner = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

      mockQuery
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'safe-1',
              safe_address: '0x1111111111111111111111111111111111111111',
              chain_id: 100,
              name: 'Main account',
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] })

      mockGetSafeDetails.mockResolvedValueOnce({
        address: '0x1111111111111111111111111111111111111111',
        owners: [currentOwner],
        threshold: 1,
        nonce: 0,
      })

      const response = await app.inject({
        method: 'GET',
        url: '/user/owners',
        headers: { authorization: `Bearer ${token}` },
      })

      expect(response.statusCode).toBe(200)
      expect(mockQuery.mock.calls[1][1]).toEqual(['user-1', [currentOwner]])
      expect(response.json().owners).toHaveLength(1)
    })
  })

  describe('PUT /user/owners/:ownerAddress', () => {
    it('upserts a private alias only after verifying current ownership', async () => {
      const token = signToken({ sub: 'user-1', email: 'test@example.com' })
      const owner = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

      mockQuery
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'safe-1',
              safe_address: '0x1111111111111111111111111111111111111111',
              chain_id: 100,
              name: 'Main account',
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [{ owner_address: owner, name: 'Ledger main' }],
        })

      mockGetSafeDetails.mockResolvedValueOnce({
        address: '0x1111111111111111111111111111111111111111',
        owners: [owner],
        threshold: 1,
        nonce: 0,
      })

      const response = await app.inject({
        method: 'PUT',
        url: `/user/owners/0x${owner.slice(2).toUpperCase()}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: ' Ledger   main ' },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({
        owner_address: owner,
        name: 'Ledger main',
      })
      expect(mockQuery.mock.calls[1][1]).toEqual(['user-1', owner, 'Ledger main'])
    })

    it('does not save an alias for an address that is not a current owner', async () => {
      const token = signToken({ sub: 'user-1', email: 'test@example.com' })

      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'safe-1',
            safe_address: '0x1111111111111111111111111111111111111111',
            chain_id: 100,
            name: 'Main account',
          },
        ],
      })
      mockGetSafeDetails.mockResolvedValueOnce({
        address: '0x1111111111111111111111111111111111111111',
        owners: ['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
        threshold: 1,
        nonce: 0,
      })

      const response = await app.inject({
        method: 'PUT',
        url: '/user/owners/0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Not an owner' },
      })

      expect(response.statusCode).toBe(404)
      expect(response.json().error).toBe('Owner not found for linked accounts')
      expect(mockQuery).toHaveBeenCalledTimes(1)
    })
  })

  describe('DELETE /user/owners/:ownerAddress', () => {
    it('clears an alias for the authenticated user only', async () => {
      const token = signToken({ sub: 'user-1', email: 'test@example.com' })
      mockQuery.mockResolvedValueOnce({ rows: [] })

      const response = await app.inject({
        method: 'DELETE',
        url: '/user/owners/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        headers: { authorization: `Bearer ${token}` },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ success: true })
      expect(mockQuery.mock.calls[0][1]).toEqual([
        'user-1',
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ])
    })
  })
})
