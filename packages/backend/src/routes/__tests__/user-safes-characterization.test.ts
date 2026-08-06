import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Characterization coverage for the user-safes route paths #988 extracts into
 * `infra/repositories/user-safes.ts` (per the #985 convention). Landed BEFORE
 * the extraction commit; must pass unchanged on both sides of it.
 *
 * The previously uncovered query paths pinned here: POST / (import, including
 * the first-Safe-becomes-default rule and the legacy users.safe_address
 * mirror), PUT /:safeId (rename), PUT /:safeId/default (transaction sequence),
 * the DELETE default-promotion branches, and the approver metadata
 * upsert/delete pair.
 */

const { mockPoolQuery, mockClientQuery, mockRelease } = vi.hoisted(() => ({
  mockPoolQuery: vi.fn(),
  mockClientQuery: vi.fn(),
  mockRelease: vi.fn(),
}))

vi.mock('../../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
    connect: async () => ({
      query: (...args: unknown[]) => mockClientQuery(...args),
      release: mockRelease,
    }),
  },
}))

// Avoid pulling chain/ethers deploy machinery into this route test.
vi.mock('../../lib/safe-deployer.js', () => ({ relaySafeDeploy: vi.fn() }))

import userSafesRoutes from '../user-safes.js'

const SAFE_ID = '11111111-1111-1111-1111-111111111111'
const SAFE_ADDRESS = '0x1111111111111111111111111111111111111111'
const USER = 'user-1'

describe('user-safes characterization (#988)', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(userSafesRoutes, { prefix: '/user/safes' })
    token = app.jwt.sign({ sub: USER, email: 'ada@example.com' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    mockPoolQuery.mockReset()
    mockClientQuery.mockReset()
    mockRelease.mockReset()
  })

  function auth() {
    return { authorization: `Bearer ${token}` }
  }

  describe('POST /user/safes — import', () => {
    it('the first Safe becomes default and mirrors into legacy users.safe_address', async () => {
      mockPoolQuery.mockImplementation(async (sql: string) => {
        const s = String(sql)
        if (/SELECT id FROM user_safes WHERE user_id = \$1 AND LOWER/.test(s)) return { rows: [] }
        if (/SELECT COUNT\(\*\)/.test(s)) return { rows: [{ count: '0' }] }
        if (/INSERT INTO user_safes/.test(s)) {
          return { rows: [{ id: SAFE_ID, safe_address: SAFE_ADDRESS, chain_id: 8453, name: 'My account', is_default: true, created_at: '2026-08-05T00:00:00.000Z' }] }
        }
        return { rows: [] }
      })

      const res = await app.inject({
        method: 'POST',
        url: '/user/safes',
        headers: auth(),
        payload: { safe_address: SAFE_ADDRESS, chain_id: 8453 },
      })

      expect(res.statusCode).toBe(201)
      expect(res.json()).toMatchObject({ id: SAFE_ID, is_default: true })

      const calls = mockPoolQuery.mock.calls.map(([sql, params]) => [String(sql), params] as const)
      const insert = calls.find(([s]) => /INSERT INTO user_safes/.test(s))
      expect(insert?.[1]).toEqual([USER, SAFE_ADDRESS, 8453, 'My account', true])
      const legacy = calls.find(([s]) => /UPDATE users SET safe_address = \$1/.test(s))
      expect(legacy?.[1]).toEqual([SAFE_ADDRESS, USER])
    })

    it('a second Safe is not default and leaves users.safe_address alone', async () => {
      mockPoolQuery.mockImplementation(async (sql: string) => {
        const s = String(sql)
        if (/SELECT id FROM user_safes WHERE user_id = \$1 AND LOWER/.test(s)) return { rows: [] }
        if (/SELECT COUNT\(\*\)/.test(s)) return { rows: [{ count: '1' }] }
        if (/INSERT INTO user_safes/.test(s)) {
          return { rows: [{ id: 'safe-2', safe_address: SAFE_ADDRESS, chain_id: 8453, name: 'Second', is_default: false, created_at: '2026-08-05T00:00:00.000Z' }] }
        }
        return { rows: [] }
      })

      const res = await app.inject({
        method: 'POST',
        url: '/user/safes',
        headers: auth(),
        payload: { safe_address: SAFE_ADDRESS, chain_id: 8453, name: 'Second' },
      })

      expect(res.statusCode).toBe(201)
      expect(res.json().is_default).toBe(false)
      const sqls = mockPoolQuery.mock.calls.map(([sql]) => String(sql))
      expect(sqls.some((s) => /UPDATE users SET safe_address/.test(s))).toBe(false)
    })

    it('409s when the same address+chain is already linked', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: SAFE_ID }] })

      const res = await app.inject({
        method: 'POST',
        url: '/user/safes',
        headers: auth(),
        payload: { safe_address: SAFE_ADDRESS, chain_id: 8453 },
      })

      expect(res.statusCode).toBe(409)
      expect(mockPoolQuery.mock.calls[0][1]).toEqual([USER, SAFE_ADDRESS, 8453])
      expect(mockPoolQuery).toHaveBeenCalledTimes(1)
    })
  })

  describe('PUT /user/safes/:safeId — rename', () => {
    it('renames a Safe scoped to the caller', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: SAFE_ID, safe_address: SAFE_ADDRESS, chain_id: 8453, name: 'Treasury', is_default: true, created_at: '2026-08-05T00:00:00.000Z' }],
      })

      const res = await app.inject({
        method: 'PUT',
        url: `/user/safes/${SAFE_ID}`,
        headers: auth(),
        payload: { name: '  Treasury  ' },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json().name).toBe('Treasury')
      expect(mockPoolQuery.mock.calls[0][1]).toEqual(['Treasury', SAFE_ID, USER])
    })

    it('404s when the Safe is not the caller’s', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] })

      const res = await app.inject({
        method: 'PUT',
        url: `/user/safes/${SAFE_ID}`,
        headers: auth(),
        payload: { name: 'X' },
      })

      expect(res.statusCode).toBe(404)
    })
  })

  describe('PUT /user/safes/:safeId/default', () => {
    it('clears every default, sets the new one, and mirrors the legacy column — in a transaction', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: SAFE_ID, safe_address: SAFE_ADDRESS }] })
      mockClientQuery.mockResolvedValue({ rows: [] })

      const res = await app.inject({
        method: 'PUT',
        url: `/user/safes/${SAFE_ID}/default`,
        headers: auth(),
      })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ success: true })

      const calls = mockClientQuery.mock.calls.map(([sql, params]) => [String(sql), params] as const)
      const sqls = calls.map(([s]) => s)
      const idx = {
        begin: sqls.indexOf('BEGIN'),
        clear: sqls.findIndex((s) => /SET is_default = false/.test(s)),
        set: sqls.findIndex((s) => /SET is_default = true/.test(s)),
        legacy: sqls.findIndex((s) => /UPDATE users SET safe_address/.test(s)),
        commit: sqls.indexOf('COMMIT'),
      }
      expect(Object.values(idx).every((i) => i !== -1)).toBe(true)
      expect(idx.begin).toBeLessThan(idx.clear)
      expect(idx.clear).toBeLessThan(idx.set)
      expect(idx.set).toBeLessThan(idx.legacy)
      expect(idx.legacy).toBeLessThan(idx.commit)
      expect(calls[idx.clear][1]).toEqual([USER])
      expect(calls[idx.set][1]).toEqual([SAFE_ID])
      expect(calls[idx.legacy][1]).toEqual([SAFE_ADDRESS, USER])
      expect(mockRelease).toHaveBeenCalledTimes(1)
    })

    it('404s (and opens no transaction) when the Safe is not the caller’s', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] })

      const res = await app.inject({
        method: 'PUT',
        url: `/user/safes/${SAFE_ID}/default`,
        headers: auth(),
      })

      expect(res.statusCode).toBe(404)
      expect(mockClientQuery).not.toHaveBeenCalled()
    })
  })

  describe('DELETE /user/safes/:safeId — default promotion branches', () => {
    it('promotes the oldest remaining Safe when the default is deleted', async () => {
      const NEXT = { id: 'safe-2', safe_address: '0x2222222222222222222222222222222222222222' }
      mockPoolQuery.mockResolvedValue({ rows: [{ id: SAFE_ID, is_default: true }] })
      mockClientQuery.mockImplementation(async (sql: string) => {
        if (/SELECT id, safe_address FROM user_safes/.test(String(sql))) return { rows: [NEXT] }
        return { rows: [] }
      })

      const res = await app.inject({
        method: 'DELETE',
        url: `/user/safes/${SAFE_ID}`,
        headers: auth(),
      })

      expect(res.statusCode).toBe(200)
      const calls = mockClientQuery.mock.calls.map(([sql, params]) => [String(sql), params] as const)
      const sqls = calls.map(([s]) => s)
      const promoteIdx = sqls.findIndex((s) => /SET is_default = true/.test(s))
      const legacyIdx = sqls.findIndex((s) => /UPDATE users SET safe_address = \$1/.test(s))
      const deleteIdx = sqls.findIndex((s) => /DELETE FROM user_safes/.test(s))
      expect(deleteIdx).not.toBe(-1)
      expect(promoteIdx).toBeGreaterThan(deleteIdx)
      expect(calls[promoteIdx][1]).toEqual([NEXT.id])
      expect(calls[legacyIdx][1]).toEqual([NEXT.safe_address, USER])
    })

    it('clears legacy users.safe_address when the last Safe is deleted', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [{ id: SAFE_ID, is_default: true }] })
      mockClientQuery.mockResolvedValue({ rows: [] }) // no remaining Safe

      const res = await app.inject({
        method: 'DELETE',
        url: `/user/safes/${SAFE_ID}`,
        headers: auth(),
      })

      expect(res.statusCode).toBe(200)
      const calls = mockClientQuery.mock.calls.map(([sql, params]) => [String(sql), params] as const)
      const clear = calls.find(([s]) => /UPDATE users SET safe_address = NULL/.test(s))
      expect(clear).toBeDefined()
      expect(clear?.[1]).toEqual([USER])
    })
  })

  describe('approver metadata upsert/delete', () => {
    it('upserts approver metadata for an owned Safe', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ id: SAFE_ID, safe_address: SAFE_ADDRESS, chain_id: 8453 }] })
        .mockResolvedValueOnce({ rows: [] })

      const res = await app.inject({
        method: 'POST',
        url: `/user/safes/${SAFE_ID}/approvers`,
        headers: auth(),
        payload: { address: SAFE_ADDRESS, type: 'passkey', label: '  My passkey  ' },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ success: true })
      const [sql, params] = mockPoolQuery.mock.calls[1]
      expect(String(sql)).toContain('INSERT INTO safe_approver_metadata')
      expect(String(sql)).toContain('ON CONFLICT (safe_id, LOWER(address))')
      expect(params).toEqual([SAFE_ID, SAFE_ADDRESS, 'passkey', 'My passkey'])
    })

    it('rejects an invalid approver type', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: SAFE_ID, safe_address: SAFE_ADDRESS, chain_id: 8453 }] })

      const res = await app.inject({
        method: 'POST',
        url: `/user/safes/${SAFE_ID}/approvers`,
        headers: auth(),
        payload: { address: SAFE_ADDRESS, type: 'ledger' },
      })

      expect(res.statusCode).toBe(400)
      expect(mockPoolQuery).toHaveBeenCalledTimes(1)
    })

    it('deletes approver metadata case-insensitively for an owned Safe', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ id: SAFE_ID, safe_address: SAFE_ADDRESS, chain_id: 8453 }] })
        .mockResolvedValueOnce({ rows: [] })

      const res = await app.inject({
        method: 'DELETE',
        url: `/user/safes/${SAFE_ID}/approvers/${SAFE_ADDRESS.toUpperCase().replace('0X', '0x')}`,
        headers: auth(),
      })

      expect(res.statusCode).toBe(200)
      const [sql, params] = mockPoolQuery.mock.calls[1]
      expect(String(sql)).toContain('DELETE FROM safe_approver_metadata')
      expect(String(sql)).toContain('LOWER(address) = LOWER($2)')
      expect(params[0]).toBe(SAFE_ID)
    })

    it('404s the upsert when the Safe is not the caller’s', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] })

      const res = await app.inject({
        method: 'POST',
        url: `/user/safes/${SAFE_ID}/approvers`,
        headers: auth(),
        payload: { address: SAFE_ADDRESS },
      })

      expect(res.statusCode).toBe(404)
      expect(mockPoolQuery).toHaveBeenCalledTimes(1)
    })
  })
})
