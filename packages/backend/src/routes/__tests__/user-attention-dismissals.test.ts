import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FastifyInstance } from 'fastify'

/**
 * Route-level invariants for the #3813 dismissal endpoints
 * (`GET`/`POST /user/attention-dismissals`).
 *
 * Pins: user-JWT-only auth (anonymous refused), the spec's kind/shape
 * pairing enforced BEFORE the handler (`no-backup` must carry `account_id`,
 * `needs-setup` must carry `agent_id`, nothing else passes), the 201/404
 * contract over the repository's result, and — the acceptance criterion that
 * names the feature — that a dismissal written by one request is returned
 * by a LATER GET for the SAME user (the "survives devices" property is the
 * server round-trip: any later session of the same user reads the same
 * row), while a different user's GET reads an empty list.
 *
 * Mocks `infra/repositories/attention-dismissals.js` — what this file tests
 * is ROUTING, not what Postgres does (that is
 * `infra/repositories/__tests__/attention-dismissals.test.ts` and the
 * migration's own test, both on the real-DB harness).
 */

const { mockList, mockDismissBackup, mockDismissSetup } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockDismissBackup: vi.fn(),
  mockDismissSetup: vi.fn(),
}))

vi.mock('../../infra/repositories/attention-dismissals.js', () => ({
  listAttentionDismissals: mockList,
  dismissBackupSigner: mockDismissBackup,
  dismissNeedsSetup: mockDismissSetup,
}))

import { buildApp } from '../../__tests__/helpers.js'
import { expectMatchesSpec } from '../../openapi/response-shape.js'

const USER = '4f6c2b18-7d90-4a35-9e81-2c5b7f3a0d64'
const OTHER = '8c1f5e2a-3b47-4d69-9a0c-1e5f7b8d2a36'
const ACCOUNT_ID = 'b7e1d0c4-3a52-4f68-8c91-5d2e7a4b0f31'
const AGENT_ID = '1c93a6f8-2e40-4b57-9d83-6f0a5c1e8b72'

const STORED_BACKUP = {
  id: '7c41b8e0-2d95-4a63-b1f7-8e5c39a0d264',
  user_id: USER,
  item_kind: 'no-backup' as const,
  account_id: ACCOUNT_ID,
  agent_id: null,
  created_at: '2026-10-09T21:00:00.000Z',
}

describe('user attention-dismissals routes (#3813)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp()
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    mockList.mockReset()
    mockDismissBackup.mockReset()
    mockDismissSetup.mockReset()
  })

  function token(sub: string): string {
    return app.jwt.sign({ sub, email: 'ada@example.com' }, { expiresIn: '1h' })
  }

  describe('authentication', () => {
    it('rejects an anonymous caller with 401', async () => {
      const res = await app.inject({ method: 'GET', url: '/user/attention-dismissals' })
      expect(res.statusCode).toBe(401)
      expect(mockList).not.toHaveBeenCalled()
    })

    it('rejects an anonymous dismiss with 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/user/attention-dismissals',
        payload: { item_kind: 'no-backup', account_id: ACCOUNT_ID },
      })
      expect(res.statusCode).toBe(401)
      expect(mockDismissBackup).not.toHaveBeenCalled()
    })
  })

  describe('POST /user/attention-dismissals', () => {
    it('stores a no-backup dismissal for the JWT subject — 201 with the stored row', async () => {
      mockDismissBackup.mockResolvedValue(STORED_BACKUP)

      const res = await app.inject({
        method: 'POST',
        url: '/user/attention-dismissals',
        headers: { authorization: `Bearer ${token(USER)}` },
        payload: { item_kind: 'no-backup', account_id: ACCOUNT_ID },
      })

      expect(res.statusCode).toBe(201)
      expect(res.json()).toEqual({
        id: STORED_BACKUP.id,
        item_kind: 'no-backup',
        account_id: ACCOUNT_ID,
        agent_id: null,
        created_at: STORED_BACKUP.created_at,
      })
      expect(mockDismissBackup).toHaveBeenCalledExactlyOnceWith(USER, ACCOUNT_ID)
      expectMatchesSpec('POST', '/user/attention-dismissals', res.json(), '201')
    })

    it('stores a needs-setup dismissal per agent', async () => {
      mockDismissSetup.mockResolvedValue({
        ...STORED_BACKUP,
        item_kind: 'needs-setup',
        account_id: null,
        agent_id: AGENT_ID,
      })

      const res = await app.inject({
        method: 'POST',
        url: '/user/attention-dismissals',
        headers: { authorization: `Bearer ${token(USER)}` },
        payload: { item_kind: 'needs-setup', agent_id: AGENT_ID },
      })

      expect(res.statusCode).toBe(201)
      expect(res.json().item_kind).toBe('needs-setup')
      expect(res.json().agent_id).toBe(AGENT_ID)
      expect(mockDismissSetup).toHaveBeenCalledExactlyOnceWith(USER, AGENT_ID)
      expect(mockDismissBackup).not.toHaveBeenCalled()
    })

    it('refuses a kind/shape mismatch before the handler (spec-enforced 400)', async () => {
      const noAccount = await app.inject({
        method: 'POST',
        url: '/user/attention-dismissals',
        headers: { authorization: `Bearer ${token(USER)}` },
        payload: { item_kind: 'no-backup', agent_id: AGENT_ID },
      })
      const noAgent = await app.inject({
        method: 'POST',
        url: '/user/attention-dismissals',
        headers: { authorization: `Bearer ${token(USER)}` },
        payload: { item_kind: 'needs-setup' },
      })
      const unknownKind = await app.inject({
        method: 'POST',
        url: '/user/attention-dismissals',
        headers: { authorization: `Bearer ${token(USER)}` },
        payload: { item_kind: 'low-balance', account_id: ACCOUNT_ID },
      })

      for (const res of [noAccount, noAgent, unknownKind]) {
        expect(res.statusCode).toBe(400)
      }
      expect(mockDismissBackup).not.toHaveBeenCalled()
      expect(mockDismissSetup).not.toHaveBeenCalled()
    })

    it('a foreign or unknown account is a 404, never a 403', async () => {
      mockDismissBackup.mockResolvedValue(null)

      const res = await app.inject({
        method: 'POST',
        url: '/user/attention-dismissals',
        headers: { authorization: `Bearer ${token(USER)}` },
        payload: { item_kind: 'no-backup', account_id: ACCOUNT_ID },
      })

      expect(res.statusCode).toBe(404)
    })
  })

  describe('GET /user/attention-dismissals — a dismissal survives the round-trip', () => {
    it('a later GET for the same user returns what an earlier POST stored', async () => {
      // The write: one device dismisses.
      mockDismissBackup.mockResolvedValue(STORED_BACKUP)
      const write = await app.inject({
        method: 'POST',
        url: '/user/attention-dismissals',
        headers: { authorization: `Bearer ${token(USER)}` },
        payload: { item_kind: 'no-backup', account_id: ACCOUNT_ID },
      })
      expect(write.statusCode).toBe(201)

      // The read: ANOTHER device of the SAME user, later — a fresh request
      // through the same route. The repository answers with what is stored.
      mockList.mockResolvedValue([STORED_BACKUP])
      const read = await app.inject({
        method: 'GET',
        url: '/user/attention-dismissals',
        headers: { authorization: `Bearer ${token(USER)}` },
      })

      expect(read.statusCode).toBe(200)
      expect(read.json()).toEqual({
        dismissals: [
          {
            id: STORED_BACKUP.id,
            item_kind: 'no-backup',
            account_id: ACCOUNT_ID,
            agent_id: null,
            created_at: STORED_BACKUP.created_at,
          },
        ],
      })
      expectMatchesSpec('GET', '/user/attention-dismissals', read.json())
    })

    it('a different user reads an empty list — dismissals are per user', async () => {
      mockList.mockImplementation(async (sub: string) =>
        sub === USER
          ? [{ ...STORED_BACKUP, user_id: sub }]
          : [],
      )

      const mine = await app.inject({
        method: 'GET',
        url: '/user/attention-dismissals',
        headers: { authorization: `Bearer ${token(USER)}` },
      })
      const theirs = await app.inject({
        method: 'GET',
        url: '/user/attention-dismissals',
        headers: { authorization: `Bearer ${token(OTHER)}` },
      })

      expect(mine.json().dismissals).toHaveLength(1)
      expect(theirs.json().dismissals).toEqual([])
    })

    it('a user with no dismissals reads an empty list', async () => {
      mockList.mockResolvedValue([])

      const res = await app.inject({
        method: 'GET',
        url: '/user/attention-dismissals',
        headers: { authorization: `Bearer ${token(USER)}` },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ dismissals: [] })
    })
  })
})
