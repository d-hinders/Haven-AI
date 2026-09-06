import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// db-mock-exempt: no database behaviour is under test here. The pool is mocked
// at the repository seam and balances at the chain-client seam (getChainClient),
// so the suite pins the ROUTE contract — auth, the owner_cli allow-list opt-in,
// the 404 scoping, and the funding payload shape — with no SQL and no chain
// state. Same boundary the sibling user-safes-list/delete/characterization route
// tests mock at; a new file cannot join the shrink-only positional-mock baseline,
// so the documented file-level exemption applies.

/**
 * Characterization coverage for `GET /user/safes/:safeId/funding` — written
 * BEFORE the endpoint exists (#2534, epic #2519 slice B4), so the route's
 * contract is pinned on the money-path-adjacent file before its first
 * behavior change, per the repo convention.
 *
 * What is pinned here, in the order the route checks it:
 *
 * 1. Auth. The default for a purpose-carrying token is refusal (#1640); the
 *    endpoint is read-only facts for a human hand-off, so the `owner_cli`
 *    device-code session is opted in via the central allow-list
 *    (`middleware/owner-cli.ts`), not by a route-local marker. Agent API keys
 *    (`sk_agent_…`) are a different door entirely — they never reach this
 *    module's `authMiddleware`, and the test asserts the refusal.
 * 2. Resolution. The Safe id is a UUID the caller names; every lookup is
 *    scoped to the JWT subject, so another user's Safe (or an unknown id)
 *    is a 404 that reveals nothing.
 * 3. The funding payload itself: the chain facts from `@haven_ai/core`
 *    (name, explorer), the `faucet_url` on a testnet and its absence on
 *    mainnets, per-token `minimum_useful_human` constants, native marked
 *    not-needed (gas is relay-sponsored), and `funded` = any token balance
 *    ≥ its minimum.
 *
 * Balances are mocked at the chain-client seam (`getChainClient`) — the same
 * boundary `balances.test.ts` mocks one layer lower — so these tests carry no
 * RPC and no chain state.
 */

const { mockPoolQuery, mockGetChainClient } = vi.hoisted(() => ({
  mockPoolQuery: vi.fn(),
  mockGetChainClient: vi.fn(),
}))

vi.mock('../../db.js', () => ({
  default: { query: (...args: unknown[]) => mockPoolQuery(...args) },
}))

vi.mock('../../infra/chain/index.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../infra/chain/index.js')>()
  return { ...actual, getChainClient: mockGetChainClient }
})

import userSafesRoutes from '../user-safes.js'

const SAFE_ID = 'd2c47f10-9a83-4e61-8b25-7c3f0e91a4d6'
const SAFE_ID_OTHER = 'e3d58f21-ab94-4f72-8c36-8d4f1f02b5e7'
const SAFE_ADDRESS = '0x1111111111111111111111111111111111111111'
const USER = 'user-1'

/** USDC balances are 6-decimal; 25 USDC = 25_000_000 atomic. */
const USDC_MINIMUM_ATOMIC = 5_000_000n

function ownershipRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SAFE_ID,
    safe_address: SAFE_ADDRESS,
    chain_id: 8453,
    ...overrides,
  }
}

/** A chain client whose ERC-20 (USDC) balance is `atomic` base units. */
function chainClientWithUsdc(atomic: bigint) {
  return {
    getNativeBalance: async () => 0n,
    getTokenBalance: async (_chainId: number, _token: string, _addr: string) => atomic,
  }
}

describe('GET /user/safes/:safeId/funding — characterization (#2534)', () => {
  let app: FastifyInstance
  let ownerToken: string
  let ownerCliToken: string

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(userSafesRoutes, { prefix: '/user/safes' })
    // Cast as in owner-cli-authorization.test.ts: the declared JWT payload
    // type names only { sub, email }, but purpose-carrying tokens are real.
    ownerToken = app.jwt.sign({ sub: USER, email: 'ada@example.com' })
    ownerCliToken = app.jwt.sign(
      { sub: USER, email: 'ada@example.com', purpose: 'owner_cli' } as unknown as { sub: string; email: string },
    )
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    mockPoolQuery.mockReset()
    mockGetChainClient.mockReset()
  })

  function auth(t: string = ownerToken) {
    return { authorization: `Bearer ${t}` }
  }

  // ── Auth ─────────────────────────────────────────────────────────

  it('requires authentication', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] })
    const res = await app.inject({
      method: 'GET',
      url: `/user/safes/${SAFE_ID}/funding`,
    })
    expect(res.statusCode).toBe(401)
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  it('accepts an ordinary owner JWT', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [ownershipRow()] })
    mockGetChainClient.mockReturnValue(chainClientWithUsdc(USDC_MINIMUM_ATOMIC))

    const res = await app.inject({
      method: 'GET',
      url: `/user/safes/${SAFE_ID}/funding`,
      headers: auth(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().funded).toBe(true)
  })

  it('accepts an owner_cli device-code session', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [ownershipRow()] })
    mockGetChainClient.mockReturnValue(chainClientWithUsdc(0n))

    const res = await app.inject({
      method: 'GET',
      url: `/user/safes/${SAFE_ID}/funding`,
      headers: auth(ownerCliToken),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().funded).toBe(false)
  })

  it('refuses an agent API key — a different door, never reaching this route', async () => {
    // A literal `sk_agent_…` key authenticates through a separate mechanism
    // (`authenticateAgentKey`), not through this module's authMiddleware.
    // An app WITHOUT that authenticator registered answers 401 with the
    // shared owner-session body — the assertion is that the key cannot reach
    // the funding read.
    const res = await app.inject({
      method: 'GET',
      url: `/user/safes/${SAFE_ID}/funding`,
      headers: { authorization: 'Bearer sk_agent_testkey000000000000000000000' },
    })
    expect(res.statusCode).toBe(401)
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  // ── Resolution ───────────────────────────────────────────────────

  it('404s another user’s Safe without leaking its existence', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] })

    const res = await app.inject({
      method: 'GET',
      url: `/user/safes/${SAFE_ID}/funding`,
      headers: auth(),
    })
    expect(res.statusCode).toBe(404)
    expect(mockGetChainClient).not.toHaveBeenCalled()
  })

  it('400s a path segment that is not a UUID', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/user/safes/not-a-uuid/funding',
      headers: auth(),
    })
    expect(res.statusCode).toBe(400)
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  // ── The payload ──────────────────────────────────────────────────

  it('returns chain facts, token minimums, and funded=false under the minimum (Base)', async () => {
    // Under the 5 USDC minimum: 2 USDC.
    mockPoolQuery.mockResolvedValueOnce({ rows: [ownershipRow()] })
    mockGetChainClient.mockReturnValue(chainClientWithUsdc(2_000_000n))

    const res = await app.inject({
      method: 'GET',
      url: `/user/safes/${SAFE_ID}/funding`,
      headers: auth(),
    })
    expect(res.statusCode).toBe(200)
    expect(mockPoolQuery).toHaveBeenCalledTimes(1)
    const body = res.json()
    expect(body.account_address).toBe(SAFE_ADDRESS)
    expect(body.chain).toEqual({ id: 8453, name: 'Base', explorer_url: 'https://basescan.org' })
    expect(body.native).toEqual({ symbol: 'ETH', balance_human: expect.any(String), needed: false })
    // Mainnets carry no faucet.
    expect(body.faucet_url).toBeUndefined()
    expect(body.funded).toBe(false)
    const usdc = body.tokens.find((t: { symbol: string }) => t.symbol === 'USDC')
    expect(usdc).toMatchObject({
      address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      decimals: 6,
      balance_human: expect.any(String),
      minimum_useful_human: '5',
    })
  })

  it('funded=true when any token balance reaches its minimum', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [ownershipRow()] })
    mockGetChainClient.mockReturnValue(chainClientWithUsdc(USDC_MINIMUM_ATOMIC))

    const res = await app.inject({
      method: 'GET',
      url: `/user/safes/${SAFE_ID}/funding`,
      headers: auth(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().funded).toBe(true)
  })

  it('carries faucet_url on Base Sepolia and omits it on Gnosis', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [ownershipRow({ chain_id: 84532 })] })
      .mockResolvedValueOnce({ rows: [ownershipRow({ chain_id: 100, id: SAFE_ID_OTHER })] })
    mockGetChainClient.mockReturnValue(chainClientWithUsdc(0n))

    const sepolia = await app.inject({
      method: 'GET',
      url: `/user/safes/${SAFE_ID}/funding`,
      headers: auth(),
    })
    expect(sepolia.statusCode).toBe(200)
    expect(sepolia.json().chain.name).toBe('Base Sepolia')
    expect(typeof sepolia.json().faucet_url).toBe('string')
    expect(sepolia.json().faucet_url).toMatch(/^https:\/\//)

    const gnosis = await app.inject({
      method: 'GET',
      url: `/user/safes/${SAFE_ID}/funding`,
      headers: auth(),
    })
    expect(gnosis.statusCode).toBe(200)
    expect(gnosis.json().chain.name).toBe('Gnosis Chain')
    expect('faucet_url' in gnosis.json()).toBe(false)
  })
})
