import { beforeEach, describe, expect, it, vi } from 'vitest'
import { expectMatchesSpec } from '../../openapi/response-shape.js'
import Fastify from 'fastify'
import agentPassportRoutes from '../agent-passports.js'

/**
 * Route-level guards for L0 passport issuance (#972 / #973).
 *
 * The one that matters is the revoked-agent guard: minting an attestation for
 * an agent Haven has already revoked spends gas to create exactly the DB/chain
 * divergence #973 exists to close — and it has to be revoked again immediately.
 */

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))
vi.mock('../../db.js', () => ({
  default: { query: (...args: unknown[]) => mockQuery(...args) },
}))

const { mockRequest, mockIssue, mockGetPassport } = vi.hoisted(() => ({
  mockRequest: vi.fn(),
  mockIssue: vi.fn(),
  mockGetPassport: vi.fn(),
}))
vi.mock('../../modules/passport/index.js', () => ({
  requestPassport: (...a: unknown[]) => mockRequest(...a),
  issuePassportBestEffort: (...a: unknown[]) => mockIssue(...a),
  getPassport: (...a: unknown[]) => mockGetPassport(...a),
  isPassportConfigured: () => true,
  // A whole PassportStanding, as the real function returns one (#1446) — the
  // route hands this straight to the client, so a partial mock would describe
  // a response the module cannot produce.
  passportStanding: async () => ({
    agentId: 'a1',
    standing: 'revoked',
    anchor: 'anchored',
    attestationUid: null,
    chainLagging: true,
    revocationConfirmedAt: null,
  }),
  PASSPORT_CHAIN_IDS: new Set([84532]),
}))

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: async (request: { user?: { sub: string } }) => {
    request.user = { sub: 'user-1' }
  },
}))

/** `findAgentChain` — the only DB read the POST path makes before its guards. */
function mockAgent(row: { chain_id: number | null; status: string } | null) {
  mockQuery.mockImplementation(async () => ({ rows: row ? [row] : [] }))
}

async function build() {
  const app = Fastify({ logger: false })
  await app.register(agentPassportRoutes, { prefix: '/agents' })
  return app
}

beforeEach(() => {
  mockQuery.mockReset()
  mockRequest.mockReset().mockResolvedValue(true)
  mockIssue.mockReset()
  mockGetPassport.mockReset().mockResolvedValue(null)
})

describe('POST /agents/:id/passport', () => {
  it('REFUSES to issue a passport for a revoked agent', async () => {
    mockAgent({ chain_id: 84532, status: 'revoked' })
    const res = await (await build()).inject({ method: 'POST', url: '/agents/a1/passport' })
    expect(res.statusCode).toBe(409)
    // The assertion that matters: no gas is spent and no row is written.
    expect(mockRequest).not.toHaveBeenCalled()
    expect(mockIssue).not.toHaveBeenCalled()
  })

  it('still issues for a PAUSED agent — pausing is reversible', async () => {
    // An EAS revoke is one-way, so blocking here would mean un-pausing required
    // re-issuing the passport. `standing` already reports paused as suspended.
    mockAgent({ chain_id: 84532, status: 'paused' })
    const res = await (await build()).inject({ method: 'POST', url: '/agents/a1/passport' })
    expect(res.statusCode).toBe(202)
    expect(mockIssue).toHaveBeenCalled()
  })

  it('issues for an active agent', async () => {
    mockAgent({ chain_id: 84532, status: 'active' })
    const res = await (await build()).inject({ method: 'POST', url: '/agents/a1/passport' })
    expect(res.statusCode).toBe(202)
    expect(mockRequest).toHaveBeenCalledWith('a1', 84532)
  expectMatchesSpec('POST', '/agents/{id}/passport', res.json(), '202')
  })

  it('404s an agent that is not the caller’s', async () => {
    mockAgent(null)
    const res = await (await build()).inject({ method: 'POST', url: '/agents/a1/passport' })
    expect(res.statusCode).toBe(404)
    expect(mockIssue).not.toHaveBeenCalled()
  })

  it('#1446: the GET returns the documented passport + standing shape', async () => {
    mockAgent({ chain_id: 84532, status: 'active' })
    mockGetPassport.mockResolvedValue({
      status: 'pending',
      assurance_level: 0,
      attestation_uid: null,
      tx_hash: null,
      chain_id: 84532,
      attempts: 0,
      last_error: null,
      requested_at: '2026-08-01T10:00:00.000Z',
      anchored_at: null,
    })
    const res = await (await build()).inject({ url: '/agents/a1/passport' })
    expect(res.statusCode).toBe(200)
    expectMatchesSpec('GET', '/agents/{id}/passport', res.json())
  })

  it('#1446: no passport is `passport: null` with a standing, not an error', async () => {
    mockAgent({ chain_id: 84532, status: 'active' })
    mockGetPassport.mockResolvedValue(null)
    const res = await (await build()).inject({ url: '/agents/a1/passport' })
    expect(res.statusCode).toBe(200)
    expect(res.json().passport).toBeNull()
    expectMatchesSpec('GET', '/agents/{id}/passport', res.json())
  })

  it('is idempotent for an already-anchored passport', async () => {
    mockAgent({ chain_id: 84532, status: 'active' })
    // A whole row, as getPassport really returns one — serialize() reads all
    // nine fields off it, so a partial fixture would describe a response the
    // table cannot produce (#1446).
    mockGetPassport.mockResolvedValue({
      status: 'anchored',
      assurance_level: 0,
      attestation_uid: `0x${'ab'.repeat(32)}`,
      tx_hash: `0x${'cd'.repeat(32)}`,
      chain_id: 84532,
      attempts: 1,
      last_error: null,
      requested_at: '2026-08-01T10:00:00.000Z',
      anchored_at: '2026-08-01T10:00:30.000Z',
    })
    const res = await (await build()).inject({ method: 'POST', url: '/agents/a1/passport' })
    expect(res.statusCode).toBe(200)
    expect(res.json().already_issued).toBe(true)
    expect(mockIssue).not.toHaveBeenCalled()
    expectMatchesSpec('POST', '/agents/{id}/passport', res.json(), '200')
  })
})
