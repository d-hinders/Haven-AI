import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// db-mock-exempt: no database behaviour is under test here. The pool is mocked
// at the repository seam and balances at the chain-client seam (getChainClient),
// so the suite pins the ROUTE contract — auth, the owner_cli allow-list opt-in,
// the 404 scoping, and the funding payload shape — with no SQL and no chain
// state. Same boundary the sibling smart-accounts-list/delete/characterization route
// tests mock at; a new file cannot join the shrink-only positional-mock baseline,
// so the documented file-level exemption applies.

/**
 * Characterization coverage for `GET /user/accounts/:accountId/funding` —
 * written BEFORE the endpoint exists (#2534, epic #2519 slice B4), so the
 * route's contract is pinned on the money-path-adjacent file before its
 * first behavior change, per the repo convention.
 *
 * #2914 (naming epic #2906 phase 5, the contraction) ended the one-release
 * dual mount `#2907` opened: `userAccountsRoutes` now registers ONLY at
 * `/user/accounts`, and `/user/safes` is a separate, unrelated NAMING
 * tombstone module (`user-accounts-retired.ts`, covered by
 * `user-accounts-retired.test.ts`) that 410s every request before
 * `owner_cli`/JWT distinctions even matter. The former "#2907 owner_cli
 * parity between /user/safes and /user/accounts" section is retired with it
 * — there is no longer a second mount of this module to compare against.
 *
 * What is pinned here, in the order the route checks it:
 *
 * 1. Auth. The default for a purpose-carrying token is refusal (#1640); the
 *    endpoint is read-only facts for a human hand-off, so the `owner_cli`
 *    device-code session is opted in via the central allow-list
 *    (`middleware/owner-cli.ts`), not by a route-local marker. Agent API keys
 *    (`sk_agent_…`) are a different door entirely — they never reach this
 *    module's `authMiddleware`, and the test asserts the refusal.
 * 2. Resolution. The account id is a UUID the caller names; every lookup is
 *    scoped to the JWT subject, so another user's account (or an unknown id)
 *    is a 404 that reveals nothing.
 * 3. The funding payload itself: the chain facts from `@haven_ai/core`
 *    (name, explorer), the `faucet_url` on a testnet and its absence on
 *    mainnets, per-token `minimum_useful_human` constants, native marked
 *    not-needed (gas is relay-sponsored), and `funded` = any token balance
 *    ≥ its minimum.
 * 4. The degraded read (#3317): a failed balance leg serves the last-known
 *    balance marked stale instead of fabricating a zero, a never-read token
 *    is marked unavailable, `funded` counts only known values, and a clean
 *    read stays byte-identical to the pre-#3317 response.
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

import userAccountsRoutes from '../user-accounts.js'
import { installRequestValidation } from '../../openapi/request-validation.js'
import { resetLastKnownBalancesForTests } from '../../modules/accounts/index.js'

const ACCOUNT_ID = 'd2c47f10-9a83-4e61-8b25-7c3f0e91a4d6'
const ACCOUNT_ID_OTHER = 'e3d58f21-ab94-4f72-8c36-8d4f1f02b5e7'
const ACCOUNT_ADDRESS = '0x1111111111111111111111111111111111111111'
const USER = 'user-1'

/** USDC balances are 6-decimal; 25 USDC = 25_000_000 atomic. */
const USDC_MINIMUM_ATOMIC = 5_000_000n

function ownershipRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ACCOUNT_ID,
    account_address: ACCOUNT_ADDRESS,
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

describe('GET /user/accounts/:accountId/funding — characterization (#2534)', () => {
  let app: FastifyInstance
  let ownerToken: string
  let ownerCliToken: string

  beforeAll(async () => {
    app = Fastify({ logger: false })
    // The production wiring (#3030, slice 2 of #3028): root-scope install, the
    // module(s) enforced — off-spec requests answer the 400 envelope before the
    // handler, conformant ones reach it unchanged.
    installRequestValidation(app, { mode: 'enforce', enforcedModules: ['routes/user-accounts.ts'] })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    // #2914: one mount now, matching production (`index.ts`) — `#2907`'s
    // dual registration is gone.
    await app.register(userAccountsRoutes, { prefix: '/user/accounts' })
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
    resetLastKnownBalancesForTests()
  })

  function auth(t: string = ownerToken) {
    return { authorization: `Bearer ${t}` }
  }

  // ── Auth ─────────────────────────────────────────────────────────

  it('requires authentication', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] })
    const res = await app.inject({
      method: 'GET',
      url: `/user/accounts/${ACCOUNT_ID}/funding`,
    })
    expect(res.statusCode).toBe(401)
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  it('accepts an ordinary owner JWT', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [ownershipRow()] })
    mockGetChainClient.mockReturnValue(chainClientWithUsdc(USDC_MINIMUM_ATOMIC))

    const res = await app.inject({
      method: 'GET',
      url: `/user/accounts/${ACCOUNT_ID}/funding`,
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
      url: `/user/accounts/${ACCOUNT_ID}/funding`,
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
      url: `/user/accounts/${ACCOUNT_ID}/funding`,
      headers: { authorization: 'Bearer sk_agent_testkey000000000000000000000' },
    })
    expect(res.statusCode).toBe(401)
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  // ── Resolution ───────────────────────────────────────────────────

  it('404s another user’s account without leaking its existence', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] })

    const res = await app.inject({
      method: 'GET',
      url: `/user/accounts/${ACCOUNT_ID}/funding`,
      headers: auth(),
    })
    expect(res.statusCode).toBe(404)
    expect(mockGetChainClient).not.toHaveBeenCalled()
  })

  it('400s a path segment that is not a UUID', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/user/accounts/not-a-uuid/funding',
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
      url: `/user/accounts/${ACCOUNT_ID}/funding`,
      headers: auth(),
    })
    expect(res.statusCode).toBe(200)
    expect(mockPoolQuery).toHaveBeenCalledTimes(1)
    const body = res.json()
    expect(body.account_address).toBe(ACCOUNT_ADDRESS)
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
      url: `/user/accounts/${ACCOUNT_ID}/funding`,
      headers: auth(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().funded).toBe(true)
  })

  it('carries faucet_url on Base Sepolia and omits it on Gnosis', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [ownershipRow({ chain_id: 84532 })] })
      .mockResolvedValueOnce({ rows: [ownershipRow({ chain_id: 100, id: ACCOUNT_ID_OTHER })] })
    mockGetChainClient.mockReturnValue(chainClientWithUsdc(0n))

    const sepolia = await app.inject({
      method: 'GET',
      url: `/user/accounts/${ACCOUNT_ID}/funding`,
      headers: auth(),
    })
    expect(sepolia.statusCode).toBe(200)
    expect(sepolia.json().chain.name).toBe('Base Sepolia')
    expect(typeof sepolia.json().faucet_url).toBe('string')
    expect(sepolia.json().faucet_url).toMatch(/^https:\/\//)

    const gnosis = await app.inject({
      method: 'GET',
      url: `/user/accounts/${ACCOUNT_ID}/funding`,
      headers: auth(),
    })
    expect(gnosis.statusCode).toBe(200)
    expect(gnosis.json().chain.name).toBe('Gnosis Chain')
    expect('faucet_url' in gnosis.json()).toBe(false)
  })

  // #2907's "owner_cli parity between /user/safes and /user/accounts" section
  // is retired with the dual mount (see the file header): there is exactly
  // one registration of this module now, so there is nothing left to compare
  // it against. Coverage that an `owner_cli` token is accepted on the one
  // surviving mount stays above ("accepts an owner_cli device-code session").

  // ── Degraded read: the three balance states (#3317) ──────────────
  //
  // The endpoint shares `GET /balances/:accountAddress`'s #3295 degraded
  // read: the module-level last-known store (written ONLY by fulfilled
  // reads) substitutes on a rejected leg, and the additive
  // `balanceFreshness` marker says which happened. `funded` counts only a
  // KNOWN value — a fresh read or the stale last-known one — so the three
  // states are: failed-after-good (stale), never-read (unavailable), and
  // clean (no marker at all).

  /** A client whose USDC read rejects; the native read always succeeds. */
  function chainClientWithFailingUsdc() {
    return {
      getNativeBalance: async () => 0n,
      getTokenBalance: async () => {
        throw new Error('Batch of more than 3 requests are not allowed on free plan')
      },
    }
  }

  it('a rejected read after a good read serves the last-known balance marked stale, and stays funded', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [ownershipRow()] })

    // Good read first: 25 USDC — above the 5 USDC minimum, so funded=true,
    // and the store records the value the chain actually returned.
    mockGetChainClient.mockReturnValue(chainClientWithUsdc(25_000_000n))
    const good = await app.inject({
      method: 'GET',
      url: `/user/accounts/${ACCOUNT_ID}/funding`,
      headers: auth(),
    })
    expect(good.statusCode).toBe(200)
    expect(good.json().funded).toBe(true)
    expect(good.json().tokens[0].balanceFreshness).toBeUndefined()
    expect(good.json().native.balanceFreshness).toBeUndefined()
    expect(good.json().balanceFreshness).toBeUndefined()

    // The RPC blip (#2769's failure class): the USDC leg rejects. The
    // response carries the LAST-KNOWN balance marked stale — not a
    // fabricated zero — and `funded` stays true off that known figure.
    mockGetChainClient.mockReturnValue(chainClientWithFailingUsdc())
    const degraded = await app.inject({
      method: 'GET',
      url: `/user/accounts/${ACCOUNT_ID}/funding`,
      headers: auth(),
    })
    expect(degraded.statusCode).toBe(200)
    const body = degraded.json()
    expect(body.tokens[0].balance_human).toBe('25.00')
    expect(body.tokens[0].balanceFreshness).toEqual({ status: 'stale', asOf: expect.any(String) })
    expect(body.native.balanceFreshness).toBeUndefined()
    expect(body.balanceFreshness).toEqual({ status: 'stale', asOf: expect.any(String) })
    expect(body.funded).toBe(true)
  })

  it('a failed read with no prior good read reports the token unavailable, and funded stays false', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [ownershipRow()] })
    mockGetChainClient.mockReturnValue(chainClientWithFailingUsdc())

    // First read after a deploy: the store has never seen this token, so
    // the balance is the '0' FILLER marked unavailable — and unknown is
    // not unfunded, so the token cannot answer the `funded` comparison.
    const res = await app.inject({
      method: 'GET',
      url: `/user/accounts/${ACCOUNT_ID}/funding`,
      headers: auth(),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.tokens[0].balance_human).toBe('0')
    expect(body.tokens[0].balanceFreshness).toEqual({ status: 'unavailable' })
    expect(body.native.balanceFreshness).toBeUndefined()
    expect(body.balanceFreshness).toEqual({ status: 'unavailable' })
    expect(body.funded).toBe(false)
  })

  it('a stale last-known balance still counts toward funded; only the unavailable filler cannot', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [ownershipRow()] })

    // Known-stale counts (the issue's option (a) wording: funded from
    // known-fresh OR known-stale values): a good 10 USDC read, then a
    // failing one — funded remains true off the stale figure.
    mockGetChainClient.mockReturnValue(chainClientWithUsdc(10_000_000n))
    await app.inject({ method: 'GET', url: `/user/accounts/${ACCOUNT_ID}/funding`, headers: auth() })
    mockGetChainClient.mockReturnValue(chainClientWithFailingUsdc())
    const staleFunded = await app.inject({
      method: 'GET',
      url: `/user/accounts/${ACCOUNT_ID}/funding`,
      headers: auth(),
    })
    expect(staleFunded.json().tokens[0].balanceFreshness).toEqual({ status: 'stale', asOf: expect.any(String) })
    expect(staleFunded.json().funded).toBe(true)

    // The unavailable filler is the ONLY state that cannot answer: reset
    // the store (as a deploy would), fail the read — the fabricated-zero
    // path #3317 removes would have compared 0 < minimum and unfunded the
    // account; now the token simply cannot make the answer false.
    resetLastKnownBalancesForTests()
    const unknown = await app.inject({
      method: 'GET',
      url: `/user/accounts/${ACCOUNT_ID}/funding`,
      headers: auth(),
    })
    expect(unknown.json().tokens[0].balanceFreshness).toEqual({ status: 'unavailable' })
    expect(unknown.json().funded).toBe(false)
  })

  it('a clean read is byte-identical to the pre-#3317 response — no freshness key anywhere', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [ownershipRow()] })
    mockGetChainClient.mockReturnValue(chainClientWithUsdc(USDC_MINIMUM_ATOMIC))

    const res = await app.inject({
      method: 'GET',
      url: `/user/accounts/${ACCOUNT_ID}/funding`,
      headers: auth(),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toEqual({
      account_address: ACCOUNT_ADDRESS,
      chain: { id: 8453, name: 'Base', explorer_url: 'https://basescan.org' },
      tokens: [
        {
          symbol: 'USDC',
          address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          decimals: 6,
          balance_human: '5.00',
          minimum_useful_human: '5',
        },
      ],
      native: { symbol: 'ETH', balance_human: '0.0', needed: false },
      funded: true,
    })
    // The byte-identical guarantee stated as a key census too: a clean
    // response carries NO balanceFreshness at any level, so a consumer
    // cannot distinguish this payload from the pre-#3317 one.
    expect(Object.keys(body)).not.toContain('balanceFreshness')
    expect(Object.keys(body.tokens[0])).not.toContain('balanceFreshness')
    expect(Object.keys(body.native)).not.toContain('balanceFreshness')
    expect(JSON.parse(res.body).tokens[0]).not.toHaveProperty('balanceFreshness')
  })
})
