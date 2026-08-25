import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { expectMatchesSpec } from '../../openapi/response-shape.js'
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

vi.mock('../../modules/accounts/index.js', () => ({
  getSafeDetails: (...args: unknown[]) => mockGetSafeDetails(...args),
}))

import { buildApp } from '../../__tests__/helpers.js'

/** users.id is a UUID column; fixtures must look like one (#1446). */
const USER_UUID = '4f6c2b18-7d90-4a35-9e81-2c5b7f3a0d64'
/** user_safes.id likewise. */
const SAFE_UUID_A = 'b7e1d0c4-3a52-4f68-8c91-5d2e7a4b0f31'
const SAFE_UUID_B = '1c93a6f8-2e40-4b57-9d83-6f0a5c1e8b72'

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
          // users.id is a UUID column (migration 000), so 'user-1' described
          // a row the database cannot produce (#1446).
          id: USER_UUID,
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
      expect(body.id).toBe(USER_UUID)
      expect(body.name).toBe('Ada Lovelace')
      expectMatchesSpec('PUT', '/user/profile', response.json())
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
  // INFLOW CLOSED (#1984, epic #1440). This route linked a Safe into
  // `user_safes` and emitted the `safe_imported` funnel event — it is an
  // import, so it is retired with the rail. The behavioural cases that used
  // to live here (200 on a valid address, 400 on a bad one, the Base
  // chain_id default, the #1178 vanished-row 404) all exercised a handler
  // that can no longer run; the full refusal proof, including that nothing
  // is written on the way to it, lives in `safe-inflow-retired.test.ts`.
  describe('PUT /user/safe', () => {
    it('is retired — 410, and no Safe is linked', async () => {
      const token = signToken({ sub: 'user-1', email: 'test@example.com' })

      const response = await app.inject({
        method: 'PUT',
        url: '/user/safe',
        headers: { authorization: `Bearer ${token}` },
        payload: { safe_address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' },
      })

      expect(response.statusCode).toBe(410)
      expect(response.json().error).toMatch(/Safe rail is retired/)
      expect(mockQuery, 'the retired route wrote nothing').not.toHaveBeenCalled()
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
              id: SAFE_UUID_A,
              safe_address: '0x1111111111111111111111111111111111111111',
              chain_id: 100,
              name: 'Main account',
            },
            {
              id: SAFE_UUID_B,
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
                id: SAFE_UUID_A,
                safe_address: '0x1111111111111111111111111111111111111111',
                chain_id: 100,
                name: 'Main account',
              },
              {
                id: SAFE_UUID_B,
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
                id: SAFE_UUID_A,
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
      expectMatchesSpec('GET', '/user/owners', response.json())
    })

    it('hides aliases for removed owners by querying only current owner addresses', async () => {
      const token = signToken({ sub: 'user-1', email: 'test@example.com' })
      const currentOwner = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

      mockQuery
        .mockResolvedValueOnce({
          rows: [
            {
              id: SAFE_UUID_A,
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
              id: SAFE_UUID_A,
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
      expectMatchesSpec('PUT', '/user/owners/{ownerAddress}', response.json())
    })

    it('does not save an alias for an address that is not a current owner', async () => {
      const token = signToken({ sub: 'user-1', email: 'test@example.com' })

      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: SAFE_UUID_A,
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
      expectMatchesSpec('DELETE', '/user/owners/{ownerAddress}', response.json())
    })
  })
})

describe('a vanished user row is a 404, not a hang or a 500 (#1178)', () => {
  // Reachable only if the account is deleted while a valid token for it is
  // still in flight. Before #1178 the four writes answered that one cause two
  // different wrong ways: three returned `undefined` — which Fastify reads as
  // "the handler replied itself", leaving the request open until the client
  // gives up — and the fourth threw a bare Error and 500ed.
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp()
  })
  afterAll(async () => {
    await app.close()
  })
  beforeEach(() => {
    mockQuery.mockReset()
  })

  const token = () => app.jwt.sign({ sub: 'user-gone', email: 'gone@example.com' }, { expiresIn: '1h' })

  it.each([
    ['PUT', '/user/profile', { name: 'Ada Lovelace' }],
    ['PUT', '/user/wallet', { wallet_address: '0x1234567890abcdef1234567890abcdef12345678' }],
    ['PUT', '/user/preferences', { currency_preference: 'EUR' }],
  ])('%s %s answers 404', async (method, url, payload) => {
    mockQuery.mockResolvedValue({ rows: [] })

    const response = await app.inject({
      method: method as 'PUT',
      url,
      headers: { authorization: `Bearer ${token()}` },
      payload,
    })

    expect(response.statusCode).toBe(404)
  })

  // PUT /user/safe is absent from both the table above and this file's
  // vanished-row cases on purpose: it is retired (#1984) and answers 410
  // before it reads the user row at all, so it can no longer distinguish a
  // vanished user. Its refusal is pinned in `safe-inflow-retired.test.ts`.
})
