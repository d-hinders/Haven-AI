import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { mockQuery, mockLoadOwner } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockLoadOwner: vi.fn(),
}))
vi.mock('../../db.js', () => ({ default: { query: (...a: unknown[]) => mockQuery(...a) } }))
vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: async (request: { user?: unknown }) => {
    request.user = { sub: 'user-1' }
  },
}))
vi.mock('../../lib/hybrid-account-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/hybrid-account-config.js')>()
  return { ...actual, loadHybridOwnerConfig: mockLoadOwner }
})

const routes = (await import('../hybrid-accounts.js')).default
const ACCOUNT = '0x' + 'ab'.repeat(20)

describe('GET /accounts/hybrid/:address/signers (#1079)', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(routes, { prefix: '/accounts' })
  })
  afterAll(async () => app.close())
  beforeEach(() => {
    mockQuery.mockReset()
    mockLoadOwner.mockReset()
  })

  it('returns the AccountSigners shape for an owned delegation account', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
    mockLoadOwner.mockResolvedValueOnce({
      config: {
        ownerAddress: null,
        passkeys: [{ keyId: '0xdeadbeef', x: 7n, y: 9n }],
      },
    })
    const res = await app.inject({ method: 'GET', url: `/accounts/hybrid/${ACCOUNT}/signers?chain_id=84532` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      account_address: ACCOUNT,
      chain_id: 84532,
      owner_address: null,
      passkeys: [{ key_id: '0xdeadbeef', x: '0x7', y: '0x9' }],
    })
    // Ownership is in the SQL: user_id + address + chain + delegation rail.
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toMatch(/account_type = 'delegator_hybrid'/)
    expect(params).toEqual(['user-1', ACCOUNT, 84532])
  })

  it("404s another user's account and 400s bad input", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })
    const notMine = await app.inject({ method: 'GET', url: `/accounts/hybrid/${ACCOUNT}/signers?chain_id=84532` })
    expect(notMine.statusCode).toBe(404)

    const badAddr = await app.inject({ method: 'GET', url: '/accounts/hybrid/nonsense/signers?chain_id=84532' })
    expect(badAddr.statusCode).toBe(400)

    const noChain = await app.inject({ method: 'GET', url: `/accounts/hybrid/${ACCOUNT}/signers` })
    expect(noChain.statusCode).toBe(400)
  })
})
