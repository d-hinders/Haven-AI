/**
 * #825 Hybrid provisioning route. Pattern-matched DB mocks (#775); the
 * address derivation (network-touching) is mocked — its determinism is the
 * kit's contract, exercised live by pilot:provision-hybrid.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { mockQuery, mockCompute } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockCompute: vi.fn(),
}))
vi.mock('../../db.js', () => ({ default: { query: (...a: unknown[]) => mockQuery(...a) } }))
vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: async (request: { user?: unknown }) => {
    request.user = { sub: 'user-1' }
  },
}))
vi.mock('../../lib/hybrid-provisioning.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/hybrid-provisioning.js')>()
  return { ...actual, computeHybridAccountAddress: (...a: unknown[]) => mockCompute(...a) }
})

const hybridAccountRoutes = (await import('../hybrid-accounts.js')).default

const OWNER = '0x' + 'ab'.repeat(20)
const HYBRID = '0x' + 'cd'.repeat(20)

function mockDb(opts: { existing?: boolean; count?: string } = {}) {
  mockQuery.mockImplementation((sql: string) => {
    const s = String(sql)
    if (/SELECT id FROM user_safes/.test(s)) {
      return Promise.resolve({ rows: opts.existing ? [{ id: 'acct-0' }] : [] })
    }
    if (/COUNT\(\*\)/.test(s)) return Promise.resolve({ rows: [{ count: opts.count ?? '1' }] })
    if (/INSERT INTO user_safes/.test(s)) {
      return Promise.resolve({ rows: [{ id: 'acct-1', created_at: '2026-07-10T00:00:00Z' }] })
    }
    return Promise.resolve({ rows: [] })
  })
}

describe('POST /accounts/hybrid (#825)', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(hybridAccountRoutes, { prefix: '/accounts' })
  })
  afterAll(async () => app.close())
  beforeEach(() => {
    mockQuery.mockReset()
    mockCompute.mockReset()
    mockCompute.mockResolvedValue(HYBRID)
  })

  it('provisions an EOA-owner account: counterfactual, no deployment', async () => {
    mockDb({})
    const res = await app.inject({
      method: 'POST', url: '/accounts/hybrid',
      payload: { owner_address: OWNER, name: 'Delegation account' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({
      account_address: HYBRID,
      account_type: 'delegator_hybrid',
      chain_id: 84532,
      deployed: false,
    })
    const insert = mockQuery.mock.calls.find((c) => /INSERT INTO user_safes/.test(String(c[0])))!
    expect(String(insert[0])).toContain("'delegator_hybrid'")
    expect(String(insert[0])).toContain("'delegation'")
  })

  it('provisions a pure-passkey account (P256 coords, no EOA)', async () => {
    mockDb({})
    const res = await app.inject({
      method: 'POST', url: '/accounts/hybrid',
      payload: { passkeys: [{ key_id: 'cred-1', x: '0x' + '11'.repeat(32), y: '0x' + '22'.repeat(32) }] },
    })
    expect(res.statusCode).toBe(201)
    expect(mockCompute).toHaveBeenCalledWith(84532, expect.objectContaining({
      passkeys: [expect.objectContaining({ keyId: 'cred-1' })],
    }))
    // #885: the passkey set is persisted so the config round-trips for deploy/revoke.
    const pkInsert = mockQuery.mock.calls.find((c) => /INSERT INTO hybrid_account_passkeys/.test(String(c[0])))!
    expect(pkInsert, 'passkey set must be persisted').toBeDefined()
    expect(pkInsert[1]).toEqual(['acct-1', 'cred-1', '0x' + '11'.repeat(32), '0x' + '22'.repeat(32)])
  })

  it.each([
    ['no owner at all', {}],
    ['bad owner address', { owner_address: 'nope' }],
    ['passkey without coords', { passkeys: [{ key_id: 'k' }] }],
    ['unpinned chain', { owner_address: OWNER, chain_id: 1 }],
  ])('rejects %s', async (_label, payload) => {
    mockDb({})
    const res = await app.inject({ method: 'POST', url: '/accounts/hybrid', payload })
    expect(res.statusCode).toBe(400)
  })

  it('409s a re-registration of the same account', async () => {
    mockDb({ existing: true })
    const res = await app.inject({
      method: 'POST', url: '/accounts/hybrid', payload: { owner_address: OWNER },
    })
    expect(res.statusCode).toBe(409)
  })

  it('first account becomes the default', async () => {
    mockDb({ count: '0' })
    await app.inject({ method: 'POST', url: '/accounts/hybrid', payload: { owner_address: OWNER } })
    const insert = mockQuery.mock.calls.find((c) => /INSERT INTO user_safes/.test(String(c[0])))!
    expect(insert[1][4]).toBe(true) // is_default
  })

  it('502s cleanly when derivation fails (never a half-registered row)', async () => {
    mockDb({})
    mockCompute.mockRejectedValueOnce(new Error('rpc down'))
    const res = await app.inject({
      method: 'POST', url: '/accounts/hybrid', payload: { owner_address: OWNER },
    })
    expect(res.statusCode).toBe(502)
    expect(mockQuery.mock.calls.some((c) => /INSERT/.test(String(c[0])))).toBe(false)
  })
})
