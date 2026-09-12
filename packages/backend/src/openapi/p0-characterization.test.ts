// db-mock-exempt: no database behaviour is under test here — every mocked
// row below is a fixed literal pinned to the AC #1 recorded fixture, at the
// same route/repository boundary the sibling files listed below already mock
// (agents.test.ts, user-safes-list.test.ts, user-safes-funding.test.ts,
// agent-activity.test.ts, auth.test.ts, user.test.ts, machine-payments.test.ts).
/**
 * #2907 AC #1 — "Every old path/field/enum still works byte-for-byte for an
 * old client (characterization test first: a recorded response set from
 * before the change replays equal on the old names)."
 *
 * The recorded set lives in `__fixtures__/p0-characterization/*.json`,
 * captured from a worktree checked out at the PR's base commit (`6e3ea1dc`,
 * `_base` on every fixture) via `__fixtures__/p0-characterization/record.ts`
 * — the SAME mocked-db / mocked-repository harness style every sibling route
 * test in this directory tree uses (`agents.test.ts`, `user-safes-list.test.ts`,
 * `user-safes-funding.test.ts`, `agent-activity.test.ts`, `auth.test.ts`,
 * `user.test.ts`, `machine-payments.test.ts`), with fixed literal fixture
 * rows — no real Postgres data, so a re-recording always reproduces the
 * same bytes. See `record.ts`'s doc comment for the one documented
 * normalization (a JWT's `iat`/`exp` are time-variant, so a bearer token is
 * minted fresh at replay from the same `authClaims` the recorder used,
 * rather than replayed literally) and the one documented exclusion
 * (`POST /agents`'s `api_key` is a freshly generated secret by construction —
 * format-checked, not value-pinned, on both sides).
 *
 * This file, run at HEAD, re-issues every recorded request against the SAME
 * route module (registered the identical way `index.ts` does — the OLD
 * `/user/safes` prefix, not the new `/user/accounts` twin, except where a
 * route's own path is unaffected by the rename) and asserts:
 *
 *   1. Status code unchanged.
 *   2. Every OLD-named field's value is byte-for-byte unchanged (the
 *      recorded body, with the account-vocabulary twin keys stripped, deep-
 *      equals the HEAD body with the same twin keys stripped).
 *   3. Every twin key present in the HEAD response equals its old-name
 *      sibling (`account_id === safe_id`, etc.) — the additive half of the
 *      P0 contract, not just "the old half didn't break".
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The one shape every "live app" below needs: `inject` (real on any Fastify
 * instance) and, for the JWT-authenticated routes, `app.jwt.sign` — the
 * `@fastify/jwt` decoration's actual signature accepts `object`, so a
 * looser hand-written signature here would silently narrow it. `unknown`
 * bodies keep this file from depending on Fastify's generic type params,
 * which differ slightly between `Fastify({ ... })` and `buildApp()`.
 */
type LiveApp = Pick<FastifyInstance, 'inject' | 'close' | 'jwt'>

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__/p0-characterization')

// ── Twin-key registry — the ONE source this file and its sanity test share ──
//
// [oldKey, newKey] pairs actually exercised by the fixtures below. Every
// `newKey` here is asserted (in the 'twin-key registry' describe block) to be
// a literal argument to some `deprecatedSafeAlias(...)` call in `spec.ts` —
// the registry AC #7 in #2907 already requires ("`deprecated: true` +
// removal-release sentence on every old name"). This is a subset-of check,
// not a full set-equality with the registry: `deprecatedSafeAlias(...)` also
// covers path/operationId/enum deprecations (`listUserAccounts`,
// `fund_account_or_raise_allowance`, …) that carry no JS response key at
// all, so a strict equality would either omit real entries or fabricate
// pairs that do not exist. The subset check is what a mutation on this list
// can actually prove: removing an entry here fails the mutation-proof test
// below; the registry itself can only grow.
export const TWIN_KEY_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['safe_id', 'account_id'],
  ['safe_address', 'account_address'],
  ['safe_name', 'account_name'],
  ['safe_chain_id', 'account_chain_id'],
  ['safe', 'account'], // PaymentReceipt.payment.{safe,account} only
  ['safes', 'accounts'], // envelope key twin only
]

/** Strip every twin NEW key (`account_*`) from an object, recursively into arrays. */
function stripTwins(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripTwins)
  if (value === null || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (TWIN_KEY_PAIRS.some(([, newKey]) => newKey === k)) continue
    out[k] = stripTwins(v)
  }
  return out
}

/** Every place a `[oldKey, newKey]` pair's values must agree, recursively. */
function collectTwinMismatches(value: unknown, path0: string, mismatches: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => collectTwinMismatches(v, `${path0}[${i}]`, mismatches))
    return
  }
  if (value === null || typeof value !== 'object') return
  const obj = value as Record<string, unknown>
  for (const [oldKey, newKey] of TWIN_KEY_PAIRS) {
    if (oldKey === 'safes' || newKey === 'accounts') continue // envelope handled separately (array identity, not per-field)
    // Both keys must actually be present on this object: `account_address`
    // was ALREADY the sole neutral name on some pre-P0 shapes (the funding
    // response) with no `safe_address` sibling at all — that is not a P0
    // twin site, and asserting equality against an absent key would be a
    // false positive, not a real gap.
    if (newKey in obj && oldKey in obj) {
      if (obj[newKey] !== obj[oldKey]) {
        mismatches.push(`${path0}.${newKey} (${JSON.stringify(obj[newKey])}) !== ${path0}.${oldKey} (${JSON.stringify(obj[oldKey])})`)
      }
    }
  }
  for (const [k, v] of Object.entries(obj)) collectTwinMismatches(v, `${path0}.${k}`, mismatches)
}

interface Fixture {
  _base: string
  route: string
  request: {
    method: string
    url: string
    headers?: Record<string, string>
    payload?: unknown
    authClaims?: { sub: string; email: string }
  }
  status: number
  body: unknown
}

function loadFixture(slug: string): Fixture {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, `${slug}.json`), 'utf8')) as Fixture
}

function tokenFor(app: LiveApp, claims: { sub: string; email: string }): string {
  return app.jwt.sign(claims)
}

function injectOptsFrom(app: LiveApp | null, fixture: Fixture) {
  const headers = { ...(fixture.request.headers ?? {}) }
  if (fixture.request.authClaims && app) {
    headers.authorization = `Bearer ${tokenFor(app, fixture.request.authClaims)}`
  }
  return {
    method: fixture.request.method,
    url: fixture.request.url,
    headers: Object.keys(headers).length ? headers : undefined,
    payload: fixture.request.payload,
  }
}

// ── Mocks — identical shape to the base-worktree recorder and to the
// sibling route test files these routes are already pinned by. ────────────

const { mockQuery, mockGetChainClient } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetChainClient: vi.fn(),
}))

vi.mock('../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockQuery(...args),
    connect: async () => ({
      query: (...args: unknown[]) => mockQuery(...args),
      release: () => {},
    }),
  },
}))

vi.mock('../infra/chain/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/chain/index.js')>()
  return { ...actual, getChainClient: mockGetChainClient }
})

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: async (request: { user?: { sub: string } }) => {
    request.user = { sub: 'user-1' }
  },
}))

vi.mock('../modules/passport/index.js', () => ({
  requestPassport: vi.fn(),
  issuePassportBestEffort: vi.fn(),
  enqueuePassportRevocation: vi.fn().mockResolvedValue(true),
  revokePassportBestEffort: vi.fn(),
  isPassportConfigured: vi.fn().mockReturnValue(false),
  PASSPORT_CHAIN_IDS: new Set([84532]),
}))

import agentRoutes from '../routes/agents.js'
import agentActivityRoutes from '../routes/agent-activity.js'
import userSafesRoutes from '../routes/user-safes.js'
import machinePaymentRoutes from '../routes/machine-payments.js'
import { buildApp } from '../__tests__/helpers.js'
import { buildPaymentReceipt, type PaymentReceiptRow } from '../modules/payments/receipt.js'

beforeEach(() => {
  mockQuery.mockReset()
  mockGetChainClient.mockReset()
})

/**
 * Runs one fixture's request against HEAD's route module, asserts (1)-(3)
 * from the file header, and returns the live response body so a caller can
 * add a route-specific assertion (the funding route's path-twin check).
 */
async function replayAndAssert(
  fixture: Fixture,
  buildLiveApp: () => Promise<LiveApp>,
  opts: { excludeKeys?: string[] } = {},
): Promise<unknown> {
  const app = await buildLiveApp()
  const injectOpts = injectOptsFrom(app, fixture)
  const res = await app.inject(injectOpts as InjectOptions)
  await app.close()

  expect(res.statusCode).toBe(fixture.status)

  const exclude = new Set(opts.excludeKeys ?? [])
  const dropExcluded = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(dropExcluded)
    if (v === null || typeof v !== 'object') return v
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (exclude.has(k)) continue
      out[k] = dropExcluded(val)
    }
    return out
  }

  const liveBody = res.json()
  // (1) OLD names byte-for-byte: strip twin NEW keys and any excluded
  // (freshly-generated) keys from both sides, then deep-equal.
  expect(dropExcluded(stripTwins(liveBody))).toEqual(dropExcluded(stripTwins(fixture.body)))

  // (2) every twin present in the LIVE response equals its old sibling.
  const mismatches: string[] = []
  collectTwinMismatches(liveBody, 'body', mismatches)
  expect(mismatches).toEqual([])

  return liveBody
}

describe('#2907 AC #1 — old-name response characterization replay (base 6e3ea1dc → HEAD)', () => {
  it('GET /user/safes (list)', async () => {
    const fixture = loadFixture('user-safes-list')
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'd2c47f10-9a83-4e61-8b25-7c3f0e91a4d6',
          safe_address: '0x' + 'ab'.repeat(20),
          chain_id: 8453,
          name: 'Main',
          is_default: true,
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    })
    const liveBody = await replayAndAssert(fixture, async () => {
      const app = Fastify({ logger: false })
      await app.register(fastifyJwt, { secret: 'test-secret' })
      await app.register(userSafesRoutes, { prefix: '/user/safes' })
      return app
    })
    // The additive envelope twin: `accounts` carries the same array as `safes`.
    expect((liveBody as { accounts: unknown; safes: unknown }).accounts).toEqual(
      (liveBody as { accounts: unknown; safes: unknown }).safes,
    )
  })

  it('GET /user/safes/{id}/funding — old path AND the /user/accounts/{id}/funding twin agree', async () => {
    const fixture = loadFixture('user-safes-funding')
    const fundingRow = { id: 'd2c47f10-9a83-4e61-8b25-7c3f0e91a4d6', safe_address: '0x' + 'ab'.repeat(20), chain_id: 8453 }
    const chainClient = { getNativeBalance: async () => 0n, getTokenBalance: async () => 5_000_000n }

    const app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(userSafesRoutes, { prefix: '/user/safes' })
    // #2907: the SAME module mounted a second time under the twin prefix,
    // exactly as index.ts registers it in production.
    await app.register(userSafesRoutes, { prefix: '/user/accounts' })
    const token = tokenFor(app, fixture.request.authClaims!)

    // Call 1: the OLD path, replayed against the fixture (AC #1 proper).
    mockQuery.mockResolvedValueOnce({ rows: [fundingRow] })
    mockGetChainClient.mockReturnValue(chainClient)
    const res = await app.inject({
      method: 'GET',
      url: fixture.request.url,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(fixture.status)
    expect(stripTwins(res.json())).toEqual(stripTwins(fixture.body))
    const mismatches: string[] = []
    collectTwinMismatches(res.json(), 'body', mismatches)
    expect(mismatches).toEqual([])

    // Call 2: the SAME request against the NEW /user/accounts/{id}/funding
    // twin path — same fixed mock, re-armed identically (mockResolvedValueOnce
    // was consumed above).
    mockQuery.mockResolvedValueOnce({ rows: [fundingRow] })
    mockGetChainClient.mockReturnValue(chainClient)
    const twinRes = await app.inject({
      method: 'GET',
      url: '/user/accounts/d2c47f10-9a83-4e61-8b25-7c3f0e91a4d6/funding',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(twinRes.statusCode).toBe(fixture.status)
    expect(twinRes.json()).toEqual(fixture.body)
    await app.close()
  })

  it('GET /agents (list)', async () => {
    const fixture = loadFixture('agents-list')
    mockQuery.mockImplementation(async () => ({
      rows: [
        {
          id: '4f9a1c2e-7b3d-4a10-9c55-2f8e6d0b1a34',
          name: 'Research Agent',
          description: null,
          delegate_address: '0x1111111111111111111111111111111111111111',
          safe_id: 'b1d7c9a4-3e28-4f61-8a0d-5c7e2b9f4d16',
          safe_address: '0x2222222222222222222222222222222222222222',
          safe_name: 'Main wallet',
          safe_chain_id: 8453,
          api_key_prefix: 'sk_agent_abc',
          status: 'active',
          account_type: 'hybrid',
          created_at: '2026-05-25T12:00:00.000Z',
          mcp_last_seen_at: null,
        },
      ],
    }))
    await replayAndAssert(fixture, async () => {
      const app = Fastify({ logger: false })
      await app.register(agentRoutes, { prefix: '/agents' })
      return app
    })
  })

  it('GET /agents/{id}', async () => {
    const fixture = loadFixture('agents-get')
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: '4f9a1c2e-7b3d-4a10-9c55-2f8e6d0b1a34',
          name: 'Research Agent',
          description: null,
          delegate_address: '0x1111111111111111111111111111111111111111',
          safe_id: 'b1d7c9a4-3e28-4f61-8a0d-5c7e2b9f4d16',
          safe_address: '0x2222222222222222222222222222222222222222',
          safe_name: 'Main wallet',
          safe_chain_id: 8453,
          api_key_prefix: 'sk_agent_abc',
          status: 'active',
          created_at: '2026-05-25T12:00:00.000Z',
          mcp_last_seen_at: null,
        },
      ],
    })
    await replayAndAssert(fixture, async () => {
      const app = Fastify({ logger: false })
      await app.register(agentRoutes, { prefix: '/agents' })
      return app
    })
  })

  it('POST /agents (create) — api_key is a fresh secret, excluded (format-checked separately)', async () => {
    const fixture = loadFixture('agents-create')
    mockQuery.mockImplementation(async (sql: string) => {
      const s = String(sql)
      if (/SELECT id FROM user_safes/.test(s)) return { rows: [{ id: 'b1d7c9a4-3e28-4f61-8a0d-5c7e2b9f4d16' }] }
      if (/INSERT INTO agents/.test(s)) {
        return {
          rows: [
            {
              id: '4f9a1c2e-7b3d-4a10-9c55-2f8e6d0b1a34',
              name: 'A',
              description: null,
              delegate_address: '0x1111111111111111111111111111111111111111',
              safe_id: 'b1d7c9a4-3e28-4f61-8a0d-5c7e2b9f4d16',
              api_key_prefix: 'sk_a',
              status: 'active',
              created_at: '2026-07-26T00:00:00.000Z',
              mcp_last_seen_at: null,
            },
          ],
        }
      }
      if (/SELECT safe_address, name AS safe_name/.test(s)) {
        return {
          rows: [
            {
              safe_address: '0x2222222222222222222222222222222222222222',
              safe_name: 'Main',
              safe_chain_id: 84532,
            },
          ],
        }
      }
      return { rows: [] }
    })
    const liveBody = await replayAndAssert(
      fixture,
      async () => {
        const app = Fastify({ logger: false })
        await app.register(agentRoutes, { prefix: '/agents' })
        return app
      },
      { excludeKeys: ['api_key'] },
    )
    expect((liveBody as { api_key: string }).api_key).toMatch(/^sk_agent_[0-9a-f]{48}$/)
  })

  it('GET /agents/{id}/activity', async () => {
    const fixture = loadFixture('agent-activity')
    mockQuery.mockImplementation(async (sql: string) => {
      const s = String(sql)
      if (s.includes('SELECT id FROM agents')) return { rows: [{ id: 'agent-1' }] }
      if (s.includes('FROM payment_intents pi')) {
        return {
          rows: [
            {
              id: 'payment-1',
              agent_id: 'agent-1',
              safe_id: 'safe-base',
              safe_address: '0x1111111111111111111111111111111111111111',
              safe_name: 'Base wallet',
              chain_id: 8453,
              token_symbol: 'USDC',
              token_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
              amount_raw: '10000',
              amount_human: '0.01',
              to_address: '0x2222222222222222222222222222222222222222',
              status: 'confirmed',
              tx_hash: '0x72d03a8ff551e443c118c93c54d32260941deb613e51fcd2733cd3455e8fa1a1',
              source: 'x402',
              x402_resource_url: 'https://api.example.com/data',
              x402_merchant_address: '0x2222222222222222222222222222222222222222',
              payment_rail: 'x402',
              payment_resource_url: 'https://api.example.com/data',
              merchant_address: '0x2222222222222222222222222222222222222222',
              payment_proof_status: 'payment_confirmed',
              payment_reconciliation_event_type: null,
              created_at: '2026-05-08T11:49:00Z',
              confirmed_at: '2026-05-08T11:49:59Z',
            },
          ],
        }
      }
      if (s.includes('FROM agent_tool_invocations')) return { rows: [] }
      throw new Error(`Unexpected query: ${s}`)
    })
    await replayAndAssert(fixture, async () => {
      const app = Fastify({ logger: false })
      await app.register(fastifyJwt, { secret: 'test-secret' })
      await app.register(agentActivityRoutes, { prefix: '/agent-activity' })
      return app
    })
  })

  it('buildPaymentReceipt (pure function) — payment.account twins payment.safe', () => {
    const fixture = loadFixture('payment-receipt')
    const receipt = buildPaymentReceipt(fixture.request.payload as PaymentReceiptRow)
    expect(dropTwinsLocal(receipt)).toEqual(dropTwinsLocal(fixture.body))
    const mismatches: string[] = []
    collectTwinMismatches(receipt, 'receipt', mismatches)
    expect(mismatches).toEqual([])

    function dropTwinsLocal(v: unknown) {
      return stripTwins(v)
    }
  })

  it('POST /auth/login (wrong password, 401 — no wire-alias fields on this branch)', async () => {
    const fixture = loadFixture('auth-login')
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: '4f6c2b18-7d90-4a35-9e81-2c5b7f3a0d64',
          name: 'Ada Lovelace',
          email: 'test@example.com',
          password_hash: '$2b$10$C1z6c6c6c6c6c6c6c6c6c.u6c6c6c6c6c6c6c6c6c6c6c6c6c6c6C',
          wallet_address: '0x1234567890abcdef1234567890abcdef12345678',
          safe_address: null,
        },
      ],
    })
    mockQuery.mockResolvedValueOnce({ rows: [] })
    await replayAndAssert(fixture, () => buildApp())
  })

  it('GET /auth/me', async () => {
    const fixture = loadFixture('auth-me')
    mockQuery.mockImplementation((sql: string) => {
      const text = String(sql)
      if (text.includes('FROM users WHERE id')) {
        return Promise.resolve({
          rows: [
            {
              id: '4f6c2b18-7d90-4a35-9e81-2c5b7f3a0d64',
              name: 'Ada Lovelace',
              email: 'test@example.com',
              wallet_address: '0x1234567890abcdef1234567890abcdef12345678',
              safe_address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              currency_preference: 'USD',
              created_at: '2025-01-01T00:00:00.000Z',
            },
          ],
        })
      }
      if (text.includes('FROM user_safes')) {
        return Promise.resolve({
          rows: [
            {
              id: 'safe-1',
              safe_address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              chain_id: 8453,
              name: 'Main',
              is_default: true,
              account_type: 'delegator_hybrid',
            },
          ],
        })
      }
      throw new Error(`Unexpected query: ${text}`)
    })
    const liveBody = await replayAndAssert(fixture, () => buildApp())
    expect((liveBody as { accounts: unknown; safes: unknown }).accounts).toEqual(
      (liveBody as { accounts: unknown; safes: unknown }).safes,
    )
  })

  it('GET /passkeys', async () => {
    const fixture = loadFixture('passkeys-list')
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'passkey-1',
          credential_id: 'cred-1',
          signer_address: '0x3333333333333333333333333333333333333333',
          chain_id: 8453,
          safe_address: '0x4444444444444444444444444444444444444444',
          created_at: '2026-02-01T00:00:00.000Z',
        },
      ],
    })
    await replayAndAssert(fixture, () => buildApp())
  })

  it('GET /machine-payments/agent', async () => {
    const fixture = loadFixture('machine-payments-agent')
    const AGENT = {
      id: '11111111-1111-1111-1111-111111111111',
      user_id: '22222222-2222-2222-2222-222222222222',
      name: 'Payment Agent',
      delegate_address: '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1',
      safe_address: '0x135a9215604711AC70d970e12Caa812c53537EF4',
      chain_id: 8453,
      status: 'active',
    }
    mockQuery.mockImplementation(async (sql: string) => {
      if (/api_key_hash = \$1/.test(String(sql))) return { rows: [AGENT] }
      return { rows: [] }
    })
    await replayAndAssert(fixture, async () => {
      const app = Fastify({ logger: false })
      await app.register(machinePaymentRoutes, { prefix: '/machine-payments' })
      return app
    })
  })

  it('PUT /user/profile', async () => {
    const fixture = loadFixture('user-profile')
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: '4f6c2b18-7d90-4a35-9e81-2c5b7f3a0d64',
          name: 'Ada Lovelace',
          email: 'test@example.com',
          wallet_address: null,
          safe_address: null,
          currency_preference: 'USD',
          created_at: '2025-01-01T00:00:00.000Z',
        },
      ],
    })
    await replayAndAssert(fixture, () => buildApp())
  })

  it('PUT /user/wallet', async () => {
    const fixture = loadFixture('user-wallet')
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'user-1',
          email: 'test@example.com',
          wallet_address: '0x1234567890abcdef1234567890abcdef12345678',
          safe_address: null,
        },
      ],
    })
    await replayAndAssert(fixture, () => buildApp())
  })
})

describe('#2907 AC #1 — twin-key registry sanity', () => {
  const specSource = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'spec.ts'), 'utf8')

  it('every field-level twin NEW key is a real deprecatedSafeAlias(...) argument in spec.ts', () => {
    // The envelope pair (safes -> accounts) is excluded here on purpose: the
    // `safes` property itself carries no `deprecated: true` (the envelope
    // KEY is not retired, only its item-shape gains a same-value twin key
    // alongside it — spec.ts:806-807's own comment says so). Every other
    // pair here IS a field-level twin, and every one of THOSE is asserted.
    for (const [oldKey, newKey] of TWIN_KEY_PAIRS) {
      if (oldKey === 'safes') continue
      expect(specSource).toContain(`deprecatedSafeAlias('${newKey}')`)
    }
  })

  it('the envelope pair is NOT claimed as a deprecatedSafeAlias(...) site (documents why it is excluded above)', () => {
    expect(specSource).not.toContain(`deprecatedSafeAlias('accounts')`)
  })

  it('the fixture directory has one JSON file per route recorded, plus the recorder script', () => {
    const files = readdirSync(FIXTURES_DIR)
    const jsonFixtures = files.filter((f) => f.endsWith('.json'))
    expect(jsonFixtures.length).toBeGreaterThanOrEqual(13)
    for (const f of jsonFixtures) {
      const fixture = loadFixture(f.replace(/\.json$/, ''))
      expect(fixture._base).toBe('6e3ea1dc')
    }
  })
})
