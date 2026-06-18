import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockPoolQuery, mockGetSafeDetails } = vi.hoisted(() => ({
  mockPoolQuery: vi.fn(),
  mockGetSafeDetails: vi.fn(),
}))

vi.mock('../../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
    connect: async () => ({ query: vi.fn(), release: vi.fn() }),
  },
}))

vi.mock('../../lib/safe-deployer.js', () => ({ relaySafeDeploy: vi.fn() }))
vi.mock('../../lib/safe-details.js', () => ({
  getSafeDetails: (...args: unknown[]) => mockGetSafeDetails(...args),
}))

import userSafesRoutes from '../user-safes.js'

const SAFE_ID = '11111111-1111-1111-1111-111111111111'
const SAFE_ADDRESS = '0x1111111111111111111111111111111111111111'
const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

const ownedSafeRow = { id: SAFE_ID, safe_address: SAFE_ADDRESS, chain_id: 8453 }

describe('approver routes on /user/safes/:safeId/approvers', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(userSafesRoutes, { prefix: '/user/safes' })
    token = app.jwt.sign({ sub: 'user-1', email: 'ada@example.com' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    mockPoolQuery.mockReset()
    mockGetSafeDetails.mockReset()
  })

  function auth() {
    return { authorization: `Bearer ${token}` }
  }

  it('rejects removing the last owner with 409 and builds no tx', async () => {
    // 1) ownership lookup → owned safe. 2) getSafeDetails → single owner.
    mockPoolQuery.mockResolvedValueOnce({ rows: [ownedSafeRow] })
    mockGetSafeDetails.mockResolvedValueOnce({ owners: [A], threshold: 1, nonce: 0 })

    const response = await app.inject({
      method: 'POST',
      url: `/user/safes/${SAFE_ID}/approvers/tx`,
      headers: auth(),
      payload: { action: 'remove', address: A },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toMatch(/last approver/i)
  })

  it('builds a removeOwner self-call when more than one owner remains', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [ownedSafeRow] })
    mockGetSafeDetails.mockResolvedValueOnce({ owners: [A, B], threshold: 1, nonce: 0 })

    const response = await app.inject({
      method: 'POST',
      url: `/user/safes/${SAFE_ID}/approvers/tx`,
      headers: auth(),
      payload: { action: 'remove', address: B },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.tx.to.toLowerCase()).toBe(SAFE_ADDRESS)
    expect(body.tx.operation).toBe(0)
    expect(body.tx.data.slice(0, 10)).toBe('0xf8dc5dd9') // removeOwner selector
  })

  it('rejects adding an address that is already an owner with 409', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [ownedSafeRow] })
    mockGetSafeDetails.mockResolvedValueOnce({ owners: [A], threshold: 1, nonce: 0 })

    const response = await app.inject({
      method: 'POST',
      url: `/user/safes/${SAFE_ID}/approvers/tx`,
      headers: auth(),
      payload: { action: 'add', address: A },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toMatch(/already an approver/i)
  })

  it('builds an addOwnerWithThreshold self-call for a new owner', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [ownedSafeRow] })
    mockGetSafeDetails.mockResolvedValueOnce({ owners: [A], threshold: 1, nonce: 0 })

    const response = await app.inject({
      method: 'POST',
      url: `/user/safes/${SAFE_ID}/approvers/tx`,
      headers: auth(),
      payload: { action: 'add', address: B },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().tx.data.slice(0, 10)).toBe('0x0d582f13') // addOwnerWithThreshold selector
  })

  it('404s when the safe is not owned by the caller', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] })

    const response = await app.inject({
      method: 'POST',
      url: `/user/safes/${SAFE_ID}/approvers/tx`,
      headers: auth(),
      payload: { action: 'add', address: B },
    })

    expect(response.statusCode).toBe(404)
  })

  it('lists owners merged with stored metadata', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [ownedSafeRow] }) // ownership
      .mockResolvedValueOnce({ rows: [{ address: A, type: 'passkey', label: 'My passkey' }] }) // metadata
    mockGetSafeDetails.mockResolvedValueOnce({ owners: [A, B], threshold: 1, nonce: 0 })

    const response = await app.inject({
      method: 'GET',
      url: `/user/safes/${SAFE_ID}/approvers`,
      headers: auth(),
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.threshold).toBe(1)
    expect(body.approvers).toEqual([
      { address: A, type: 'passkey', label: 'My passkey' },
      { address: B, type: 'eoa', label: null },
    ])
  })

  it('validates the address before doing any network read', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [ownedSafeRow] })

    const response = await app.inject({
      method: 'POST',
      url: `/user/safes/${SAFE_ID}/approvers/tx`,
      headers: auth(),
      payload: { action: 'add', address: 'not-an-address' },
    })

    expect(response.statusCode).toBe(400)
    expect(mockGetSafeDetails).not.toHaveBeenCalled()
  })
})
