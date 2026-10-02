import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'

/**
 * Route-level invariants for `POST /feedback` (#3597).
 *
 * Pins: user-JWT-only auth (an agent API key and an anonymous caller are both
 * refused — neither is a verifiable JWT; an owner_cli device-flow token IS
 * accepted, #3597 B1), the backend's own re-run of layers 1/3/4 against a
 * bypassing caller, body-size and length ceilings, and the 201 shape.
 *
 * Mocks `infra/repositories/feedback.js` directly — `insertFeedback` and
 * `isKeyBackedAddress` — rather than the pg pool module: what this file
 * tests is ROUTING and REFUSAL, not what Postgres does (that is
 * `infra/repositories/__tests__/feedback.test.ts`, on the real-DB harness),
 * and mocking at the repository boundary keeps this file off the
 * `db-mock-ratchet` gauge entirely: no pool-module mock, and no positional
 * once-suffixed mock chain to reshuffle on the next added query.
 */

const { mockInsertFeedback, mockIsKeyBackedAddress } = vi.hoisted(() => ({
  mockInsertFeedback: vi.fn(),
  mockIsKeyBackedAddress: vi.fn(),
}))
vi.mock('../../infra/repositories/feedback.js', () => ({
  insertFeedback: mockInsertFeedback,
  isKeyBackedAddress: mockIsKeyBackedAddress,
}))

import feedbackRoutes from '../feedback.js'
import { installRequestValidation } from '../../openapi/request-validation.js'

const USER = 'user-1'
const FEEDBACK_ROW = {
  id: '7c41b8e0-2d95-4a63-b1f7-8e5c39a0d264',
  user_id: USER,
  text: 'The CLI timed out on wallets funding.',
  created_at: '2026-10-02T00:00:00.000Z',
  expires_at: '2026-10-09T00:00:00.000Z',
}

describe('POST /feedback', () => {
  let app: FastifyInstance
  let userToken: string
  let ownerCliToken: string
  let agentKeyLikeToken: string

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    installRequestValidation(app, { mode: 'enforce', enforcedModules: ['routes/feedback.ts'] })
    await app.register(feedbackRoutes, { prefix: '/feedback' })
    userToken = app.jwt.sign({ sub: USER, email: 'ada@example.com' })
    // The device-flow shape (`routes/auth.ts:384`) — a `haven login` session,
    // which is the ONLY way a real CLI call reaches this route (#3597, B1).
    ownerCliToken = app.jwt.sign(
      { sub: USER, email: 'ada@example.com', purpose: 'owner_cli' } as unknown as {
        sub: string
        email: string
      },
    )
    // Not a JWT at all — the shape an agent API key actually has. jwtVerify
    // must fail on it exactly as it would on garbage.
    agentKeyLikeToken = 'sk_agent_deadbeefdeadbeefdeadbeefdeadbeef'
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    mockInsertFeedback.mockReset()
    mockIsKeyBackedAddress.mockReset()
    mockInsertFeedback.mockResolvedValue(FEEDBACK_ROW)
  })

  function post(payload: object, token?: string) {
    return app.inject({
      method: 'POST',
      url: '/feedback',
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload,
    })
  }

  describe('authentication', () => {
    it('rejects an anonymous caller with 401', async () => {
      const res = await post({ text: 'hello' })
      expect(res.statusCode).toBe(401)
      expect(mockInsertFeedback).not.toHaveBeenCalled()
    })

    it('rejects an agent API key with 401 — it is not a verifiable JWT', async () => {
      const res = await post({ text: 'hello' }, agentKeyLikeToken)
      expect(res.statusCode).toBe(401)
      expect(mockInsertFeedback).not.toHaveBeenCalled()
    })

    it('an owner_cli (device-flow `haven login`) token reaches the handler — 201, not 401 (#3597 B1)', async () => {
      const res = await post({ text: FEEDBACK_ROW.text }, ownerCliToken)
      expect(res.statusCode).toBe(201)
    })
  })

  describe('success', () => {
    it('stores clean text and returns 201 with id/created_at/expires_at', async () => {
      const res = await post({ text: FEEDBACK_ROW.text }, userToken)

      expect(res.statusCode).toBe(201)
      expect(res.json()).toEqual({
        id: FEEDBACK_ROW.id,
        created_at: FEEDBACK_ROW.created_at,
        expires_at: FEEDBACK_ROW.expires_at,
      })
      expect(mockInsertFeedback).toHaveBeenCalledWith(USER, FEEDBACK_ROW.text)
    })
  })

  describe('layer 1 — labelled secrets refused before any write', () => {
    it.each([
      ['an agent API key', 'my key is sk_agent_abc123def456'],
      ['a setup token', 'the token was hv_setup_abc123'],
      ['a session JWT', 'token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJl'],
      ['a labelled query param', 'url was https://x.test/?api_key=supersecretvalue'],
      ['url credentials', 'it was at https://user:pass@host.example/path'],
      ['an rpc-path key', 'bundler at https://api.pimlico.io/v2/base/rpc/abcdefabcdefabcd'],
    ])('refuses text containing %s', async (_label, text) => {
      const res = await post({ text }, userToken)
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toBe('text_refused')
      expect(mockInsertFeedback).not.toHaveBeenCalled()
      // The refused text itself must never echo back.
      expect(res.body).not.toContain('supersecretvalue')
    })
  })

  describe('layer 3 — key-backed-address derivation, fail-closed', () => {
    const KNOWN_PRIVATE_KEY = '0000000000000000000000000000000000000000000000000000000000000001'
    // `deriveAddressFromHexToken` (`privateKeyToAddress`) returns the
    // CHECKSUMMED-case address; the route passes it straight through —
    // `isKeyBackedAddress`'s own SQL lowercases both sides.
    const KNOWN_ADDRESS = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf'

    it('refuses when the derived address is key-backed in the database', async () => {
      mockIsKeyBackedAddress.mockResolvedValue(true)

      const res = await post({ text: `my key is ${KNOWN_PRIVATE_KEY}` }, userToken)

      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ error: 'text_refused', reason: 'private_key' })
      expect(mockIsKeyBackedAddress).toHaveBeenCalledWith(KNOWN_ADDRESS)
      expect(mockInsertFeedback).not.toHaveBeenCalled()
    })

    it('MUTATION PROOF: passes when the derived address is NOT key-backed', async () => {
      mockIsKeyBackedAddress.mockResolvedValue(false)

      const res = await post({ text: `a real tx hash is ${KNOWN_PRIVATE_KEY}` }, userToken)

      expect(res.statusCode).toBe(201)
    })

    it('fails CLOSED — a failed address read refuses rather than silently passing', async () => {
      mockIsKeyBackedAddress.mockRejectedValue(new Error('connection terminated'))

      const res = await post({ text: `my key is ${KNOWN_PRIVATE_KEY}` }, userToken)

      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ error: 'text_refused', reason: 'address_check_unavailable' })
      expect(mockInsertFeedback).not.toHaveBeenCalled()
    })

    it('does not run the address read at all when there is no 64-hex candidate', async () => {
      const res = await post({ text: 'no hex tokens in this report at all' }, userToken)
      expect(res.statusCode).toBe(201)
      expect(mockIsKeyBackedAddress).not.toHaveBeenCalled()
    })

    it('a zero key is not a candidate address — it passes through to a normal write', async () => {
      const zeroKey = '0'.repeat(64)
      const res = await post({ text: `calldata was ${zeroKey}` }, userToken)
      expect(res.statusCode).toBe(201)
      // No address lookup for an invalid key.
      expect(mockIsKeyBackedAddress).not.toHaveBeenCalled()
    })

    it('a 128-hex calldata run is not windowed into two 64-hex candidates', async () => {
      const longRun = KNOWN_PRIVATE_KEY + KNOWN_PRIVATE_KEY
      const res = await post({ text: `calldata was 0x${longRun}` }, userToken)
      expect(res.statusCode).toBe(201)
      expect(mockIsKeyBackedAddress).not.toHaveBeenCalled()
    })
  })

  describe('layer 4 — recovery phrases', () => {
    it('refuses a run of 12 consecutive BIP-39 words', async () => {
      const phrase = 'abandon ability able about above absent absorb abstract absurd abuse access accident'
      const res = await post({ text: `backup words: ${phrase}` }, userToken)
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ error: 'text_refused', reason: 'recovery_phrase' })
      expect(mockInsertFeedback).not.toHaveBeenCalled()
    })

    it('MUTATION PROOF: 11 consecutive BIP-39 words is not refused on length alone', async () => {
      const words = 'abandon ability able about above absent absorb abstract absurd abuse access'
      const res = await post({ text: words }, userToken)
      expect(res.statusCode).toBe(201)
    })
  })

  describe('body shape', () => {
    it('rejects a blank text with 400 before any write', async () => {
      const res = await post({ text: '   ' }, userToken)
      expect(res.statusCode).toBe(400)
      expect(mockInsertFeedback).not.toHaveBeenCalled()
    })

    it('rejects text past the length ceiling with 400 before any write', async () => {
      const res = await post({ text: 'x'.repeat(4001) }, userToken)
      expect(res.statusCode).toBe(400)
      expect(mockInsertFeedback).not.toHaveBeenCalled()
    })
  })
})
