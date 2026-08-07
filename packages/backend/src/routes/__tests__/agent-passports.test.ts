import { beforeEach, describe, expect, it, vi } from 'vitest'
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
  passportStanding: async () => ({ standing: 'revoked' }),
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
  })

  it('404s an agent that is not the caller’s', async () => {
    mockAgent(null)
    const res = await (await build()).inject({ method: 'POST', url: '/agents/a1/passport' })
    expect(res.statusCode).toBe(404)
    expect(mockIssue).not.toHaveBeenCalled()
  })

  it('is idempotent for an already-anchored passport', async () => {
    mockAgent({ chain_id: 84532, status: 'active' })
    mockGetPassport.mockResolvedValue({ status: 'anchored', attestation_uid: '0xabc' })
    const res = await (await build()).inject({ method: 'POST', url: '/agents/a1/passport' })
    expect(res.statusCode).toBe(200)
    expect(res.json().already_issued).toBe(true)
    expect(mockIssue).not.toHaveBeenCalled()
  })
})
