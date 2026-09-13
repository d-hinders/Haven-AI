/**
 * #2907 AC #1 — old-name response characterization recorder.
 *
 * Run ONLY from a worktree checked out at the PR's base commit
 * (`6e3ea1dc`), via the thin `record.run.test.ts` wrapper (vitest owns the
 * ESM module-mocking; a plain script cannot intercept native ESM named
 * exports). Every route below is driven through the SAME mocked-db /
 * mocked-repository harness style the existing route test suites use
 * (`agents.test.ts`, `user-safes-list.test.ts`, `user-safes-funding.test.ts`,
 * `agent-activity.test.ts`, `auth.test.ts`, `user.test.ts`,
 * `machine-payments.test.ts`) — fixed literal rows, no real Postgres data, so
 * the same input always produces the same output. No timestamps or UUIDs are
 * generated at record time: every id/date in a request or fixture row below
 * is a literal string copied from an existing test file (or newly chosen and
 * then reused verbatim at HEAD), never `new Date()` / `crypto.randomUUID()`.
 *
 * Each recorded fixture is written as JSON:
 *   { _base, route, request: { method, url, headers?, payload? }, status, body }
 *
 * `_base` names the commit the OLD-name response was captured at, so a
 * reader of the fixture file never has to cross-reference this recorder to
 * know what it proves.
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import Fastify, { type InjectOptions } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import type { Mock } from 'vitest'

import agentRoutes from '../../../routes/agents.js'
import agentActivityRoutes from '../../../routes/agent-activity.js'
import userSafesRoutes from '../../../routes/user-safes.js'
import machinePaymentRoutes from '../../../routes/machine-payments.js'
import { buildApp } from '../../../__tests__/helpers.js'
import { buildPaymentReceipt, type PaymentReceiptRow } from '../../../modules/payments/index.js'

const FIXTURES_DIR = path.dirname(fileURLToPath(import.meta.url))
const BASE_SHA = '6e3ea1dc'

/**
 * HARD GUARD (added after an incident): this recorder must only ever run
 * from a worktree checked out AT `BASE_SHA`. Running it anywhere else —
 * including HEAD of the P0 branch itself, by accident (e.g. re-running the
 * wrapper test file to "just check it still works") — silently overwrites
 * these fixtures with the NEW-shaped (twinned) response, which defeats the
 * entire point of an old-name characterization set without any error. This
 * is checked once, at the top of `recordAll`, against the actual worktree
 * HEAD via `git rev-parse HEAD`.
 */
function assertRunningAtBaseSha(): void {
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: FIXTURES_DIR, encoding: 'utf8' }).trim()
  if (!headSha.startsWith(BASE_SHA)) {
    throw new Error(
      `p0-characterization/record.ts refuses to run: this worktree's HEAD is ${headSha}, ` +
        `not the fixture base ${BASE_SHA}. Re-recording from any other commit overwrites the ` +
        `OLD-name fixtures with a NEW-shaped response and silently defeats AC #1. Check out a ` +
        `scratch worktree at ${BASE_SHA} and run record.run.test.ts there instead.`,
    )
  }
}

interface RecordedRequest {
  method: string
  url: string
  headers?: Record<string, string>
  payload?: unknown
  /**
   * A JWT's `iat`/`exp` are time-variant by construction, so a literal
   * bearer token cannot be replayed byte-for-byte across a recording run
   * and a later replay run. Routes that need a signed session token record
   * the CLAIMS here instead of (or alongside, for a route with no other
   * auth-dependent behavior) the literal header; the replay test mints a
   * fresh token from the same claims against the same `'test-secret'`
   * fastifyJwt secret every route test in this repo already uses. This is
   * the one documented normalization in the whole fixture set — every other
   * field (method, url, query, payload, response body, status) replays
   * literally.
   */
  authClaims?: { sub: string; email: string }
}

function save(slug: string, route: string, request: RecordedRequest, status: number, body: unknown) {
  const fixture = { _base: BASE_SHA, route, request, status, body }
  writeFileSync(path.join(FIXTURES_DIR, `${slug}.json`), JSON.stringify(fixture, null, 2) + '\n')
}

/**
 * Records the request WITHOUT the literal bearer token (replaced by the
 * claims that minted it) when `authClaims` is given — see the field's doc
 * comment above. `injectOpts` is what actually goes to `app.inject`.
 */
function recorded(injectOpts: InjectOptions, authClaims?: { sub: string; email: string }): RecordedRequest {
  const base: RecordedRequest = {
    method: String(injectOpts.method ?? 'GET'),
    url: String(injectOpts.url),
    payload: injectOpts.payload,
  }
  if (!authClaims) return { ...base, headers: injectOpts.headers as Record<string, string> | undefined }
  return { ...base, authClaims }
}

// ── Fixed literals reused across every recording (never regenerated) ───────

const USER_UUID = '4f6c2b18-7d90-4a35-9e81-2c5b7f3a0d64'
const SAFE_UUID = 'd2c47f10-9a83-4e61-8b25-7c3f0e91a4d6'
const SAFE_ADDRESS = '0x' + 'ab'.repeat(20)
const AGENT_UUID = '4f9a1c2e-7b3d-4a10-9c55-2f8e6d0b1a34'
const AGENT_SAFE_UUID = 'b1d7c9a4-3e28-4f61-8a0d-5c7e2b9f4d16'
const VALID_DELEGATE = '0x1111111111111111111111111111111111111111'
const CREATED_AT = '2026-05-25T12:00:00.000Z'

export async function recordAll(deps: {
  mockQuery: Mock
  mockGetChainClient: Mock
}): Promise<void> {
  assertRunningAtBaseSha()
  const { mockQuery, mockGetChainClient } = deps

  // ── 1. GET /user/safes (list) ─────────────────────────────────────────
  {
    const app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(userSafesRoutes, { prefix: '/user/safes' })
    const token = app.jwt.sign({ sub: USER_UUID, email: 'ada@example.com' })

    mockQuery.mockReset().mockResolvedValueOnce({
      rows: [
        {
          id: SAFE_UUID,
          safe_address: SAFE_ADDRESS,
          chain_id: 8453,
          name: 'Main',
          is_default: true,
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    })
    const injectOpts: InjectOptions = {
      method: 'GET',
      url: '/user/safes',
      headers: { authorization: `Bearer ${token}` },
    }
    const authClaims = { sub: USER_UUID, email: 'ada@example.com' }
    const res = await app.inject(injectOpts)
    save('user-safes-list', 'GET /user/safes', recorded(injectOpts, authClaims), res.statusCode, res.json())
    await app.close()
  }

  // ── 2. GET /user/safes/{id}/funding ────────────────────────────────────
  {
    const app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(userSafesRoutes, { prefix: '/user/safes' })
    const token = app.jwt.sign({ sub: USER_UUID, email: 'ada@example.com' })

    mockQuery.mockReset().mockResolvedValueOnce({
      rows: [{ id: SAFE_UUID, safe_address: SAFE_ADDRESS, chain_id: 8453 }],
    })
    mockGetChainClient.mockReset().mockReturnValue({
      getNativeBalance: async () => 0n,
      getTokenBalance: async () => 5_000_000n,
    })
    const injectOpts: InjectOptions = {
      method: 'GET',
      url: `/user/safes/${SAFE_UUID}/funding`,
      headers: { authorization: `Bearer ${token}` },
    }
    const authClaims = { sub: USER_UUID, email: 'ada@example.com' }
    const res = await app.inject(injectOpts)
    save(
      'user-safes-funding',
      'GET /user/safes/{id}/funding',
      recorded(injectOpts, authClaims),
      res.statusCode,
      res.json(),
    )
    await app.close()
  }

  // ── 3. GET /agents (list) ──────────────────────────────────────────────
  {
    const app = Fastify({ logger: false })
    await app.register(agentRoutes, { prefix: '/agents' })

    mockQuery.mockReset().mockImplementation(async () => ({
      rows: [
        {
          id: AGENT_UUID,
          name: 'Research Agent',
          description: null,
          delegate_address: VALID_DELEGATE,
          safe_id: AGENT_SAFE_UUID,
          safe_address: '0x2222222222222222222222222222222222222222',
          safe_name: 'Main wallet',
          safe_chain_id: 8453,
          api_key_prefix: 'sk_agent_abc',
          status: 'active',
          account_type: 'hybrid',
          created_at: CREATED_AT,
          mcp_last_seen_at: null,
        },
      ],
    }))
    const request: RecordedRequest = { method: 'GET', url: '/agents' }
    const res = await app.inject(request as InjectOptions)
    save('agents-list', 'GET /agents', request, res.statusCode, res.json())
    await app.close()
  }

  // ── 4. GET /agents/{id} ─────────────────────────────────────────────────
  {
    const app = Fastify({ logger: false })
    await app.register(agentRoutes, { prefix: '/agents' })

    mockQuery.mockReset().mockResolvedValueOnce({
      rows: [
        {
          id: AGENT_UUID,
          name: 'Research Agent',
          description: null,
          delegate_address: VALID_DELEGATE,
          safe_id: AGENT_SAFE_UUID,
          safe_address: '0x2222222222222222222222222222222222222222',
          safe_name: 'Main wallet',
          safe_chain_id: 8453,
          api_key_prefix: 'sk_agent_abc',
          status: 'active',
          created_at: CREATED_AT,
          mcp_last_seen_at: null,
        },
      ],
    })
    const request: RecordedRequest = { method: 'GET', url: `/agents/${AGENT_UUID}` }
    const res = await app.inject(request as InjectOptions)
    save('agents-get', 'GET /agents/{id}', request, res.statusCode, res.json())
    await app.close()
  }

  // ── 5. POST /agents (create) ────────────────────────────────────────────
  {
    const app = Fastify({ logger: false })
    await app.register(agentRoutes, { prefix: '/agents' })

    mockQuery.mockReset().mockImplementation(async (sql: string) => {
      const s = String(sql)
      if (/SELECT id FROM user_safes/.test(s)) return { rows: [{ id: AGENT_SAFE_UUID }] }
      if (/INSERT INTO agents/.test(s)) {
        return {
          rows: [
            {
              id: AGENT_UUID,
              name: 'A',
              description: null,
              delegate_address: VALID_DELEGATE,
              safe_id: AGENT_SAFE_UUID,
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
    const request: RecordedRequest = {
      method: 'POST',
      url: '/agents',
      payload: { name: 'A', delegate_address: VALID_DELEGATE, safe_id: AGENT_SAFE_UUID },
    }
    const res = await app.inject(request as InjectOptions)
    save('agents-create', 'POST /agents', request, res.statusCode, res.json())
    await app.close()
  }

  // ── 6. GET /agent-activity/{id}/activity ────────────────────────────────
  {
    const app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(agentActivityRoutes, { prefix: '/agent-activity' })
    const token = app.jwt.sign({ sub: 'user-1', email: 'test@example.com' })

    const SAFE_ADDRESS_ACTIVITY = '0x1111111111111111111111111111111111111111'
    mockQuery.mockReset().mockImplementation(async (sql: string) => {
      const s = String(sql)
      if (s.includes('SELECT id FROM agents')) return { rows: [{ id: 'agent-1' }] }
      if (s.includes('FROM payment_intents pi')) {
        return {
          rows: [
            {
              id: 'payment-1',
              agent_id: 'agent-1',
              safe_id: 'safe-base',
              safe_address: SAFE_ADDRESS_ACTIVITY,
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
    const injectOpts: InjectOptions = {
      method: 'GET',
      url: '/agent-activity/agent-1/activity',
      headers: { authorization: `Bearer ${token}` },
    }
    const authClaims = { sub: 'user-1', email: 'test@example.com' }
    const res = await app.inject(injectOpts)
    save(
      'agent-activity',
      'GET /agents/{id}/activity',
      recorded(injectOpts, authClaims),
      res.statusCode,
      res.json(),
    )
    await app.close()
  }

  // ── 7. buildPaymentReceipt (pure function, PaymentReceipt.payment shape) ─
  {
    const row: PaymentReceiptRow = {
      id: 'pi1',
      safe_address: '0x135a9215604711AC70d970e12Caa812c53537EF4',
      chain_id: 100,
      token_symbol: 'xDAI',
      token_address: '0x0000000000000000000000000000000000000000',
      to_address: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
      amount_human: '1',
      delegate_address: '0x1111111111111111111111111111111111111111',
      sign_hash: `0x${'ab'.repeat(32)}`,
      signature: '0xsig',
      tx_hash: `0x${'cd'.repeat(32)}`,
      confirmed_at: '2026-06-20T10:00:00.000Z',
      resource_url: 'https://api.example/resource',
      amount_sek: '10.60',
    }
    const receipt = buildPaymentReceipt(row)
    save(
      'payment-receipt',
      'buildPaymentReceipt (pure function, packages/backend/src/modules/payments/receipt.ts)',
      { method: 'CALL', url: 'buildPaymentReceipt(row)', payload: row },
      200,
      receipt,
    )
  }

  // ── 8. POST /auth/login ─────────────────────────────────────────────────
  {
    const app = await buildApp()
    mockQuery.mockReset()
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: USER_UUID,
          name: 'Ada Lovelace',
          email: 'test@example.com',
          password_hash: '$2b$10$C1z6c6c6c6c6c6c6c6c6c.u6c6c6c6c6c6c6c6c6c6c6c6c6c6c6C',
          wallet_address: '0x1234567890abcdef1234567890abcdef12345678',
          safe_address: null,
        },
      ],
    })
    mockQuery.mockResolvedValueOnce({ rows: [] })
    // password_hash above is not a real bcrypt hash for 'password123' — this
    // route is characterized on its 401 (wrong-password) branch, which is
    // still the OLD-name `user.safes` / no-account_address shape we need:
    // the 401 body carries no wire-alias fields at all, so this fixture
    // exists to pin "wrong password still answers 401 with the same body",
    // not the 200 shape (auth-me below covers the 200 session-user shape).
    const request: RecordedRequest = {
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'test@example.com', password: 'wrong-password' },
    }
    const res = await app.inject(request as InjectOptions)
    save('auth-login', 'POST /auth/login', request, res.statusCode, res.json())
    await app.close()
  }

  // ── 9. GET /auth/me ──────────────────────────────────────────────────────
  {
    const app = await buildApp()
    const token = app.jwt.sign({ sub: USER_UUID, email: 'test@example.com' }, { expiresIn: '1h' })
    const SAFE_ADDRESS_ME = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

    mockQuery.mockReset().mockImplementation((sql: string) => {
      const text = String(sql)
      if (text.includes('FROM users WHERE id')) {
        return Promise.resolve({
          rows: [
            {
              id: USER_UUID,
              name: 'Ada Lovelace',
              email: 'test@example.com',
              wallet_address: '0x1234567890abcdef1234567890abcdef12345678',
              safe_address: SAFE_ADDRESS_ME,
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
              safe_address: SAFE_ADDRESS_ME,
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
    const injectOpts: InjectOptions = {
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${token}` },
    }
    const authClaims = { sub: USER_UUID, email: 'test@example.com' }
    const res = await app.inject(injectOpts)
    save('auth-me', 'GET /auth/me', recorded(injectOpts, authClaims), res.statusCode, res.json())
    await app.close()
  }

  // ── 10. GET /passkeys ────────────────────────────────────────────────────
  {
    const app = await buildApp()
    const token = app.jwt.sign({ sub: 'user-1', email: 'test@example.com' }, { expiresIn: '1h' })
    mockQuery.mockReset().mockResolvedValueOnce({
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
    const injectOpts: InjectOptions = {
      method: 'GET',
      url: '/passkeys',
      headers: { authorization: `Bearer ${token}` },
    }
    const authClaims = { sub: 'user-1', email: 'test@example.com' }
    const res = await app.inject(injectOpts)
    save('passkeys-list', 'GET /passkeys', recorded(injectOpts, authClaims), res.statusCode, res.json())
    await app.close()
  }

  // ── 11. GET /machine-payments/agent ─────────────────────────────────────
  {
    const app = Fastify({ logger: false })
    await app.register(machinePaymentRoutes, { prefix: '/machine-payments' })
    const AGENT = {
      id: '11111111-1111-1111-1111-111111111111',
      user_id: '22222222-2222-2222-2222-222222222222',
      name: 'Payment Agent',
      delegate_address: '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1',
      safe_address: '0x135a9215604711AC70d970e12Caa812c53537EF4',
      chain_id: 8453,
      status: 'active',
    }
    mockQuery.mockReset().mockImplementation(async (sql: string) => {
      if (/api_key_hash = \$1/.test(String(sql))) return { rows: [AGENT] }
      return { rows: [] }
    })
    const request: RecordedRequest = {
      method: 'GET',
      url: '/machine-payments/agent',
      headers: { authorization: 'Bearer sk_agent_test' },
    }
    const res = await app.inject(request as InjectOptions)
    save('machine-payments-agent', 'GET /machine-payments/agent', request, res.statusCode, res.json())
    await app.close()
  }

  // ── 12. PUT /user/profile ───────────────────────────────────────────────
  {
    const app = await buildApp()
    const token = app.jwt.sign({ sub: USER_UUID, email: 'test@example.com' }, { expiresIn: '1h' })
    mockQuery.mockReset().mockResolvedValueOnce({
      rows: [
        {
          id: USER_UUID,
          name: 'Ada Lovelace',
          email: 'test@example.com',
          wallet_address: null,
          safe_address: null,
          currency_preference: 'USD',
          created_at: '2025-01-01T00:00:00.000Z',
        },
      ],
    })
    const injectOpts: InjectOptions = {
      method: 'PUT',
      url: '/user/profile',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: ' Ada   Lovelace ' },
    }
    const authClaims = { sub: USER_UUID, email: 'test@example.com' }
    const res = await app.inject(injectOpts)
    save('user-profile', 'PUT /user/profile', recorded(injectOpts, authClaims), res.statusCode, res.json())
    await app.close()
  }

  // ── 13. PUT /user/wallet ────────────────────────────────────────────────
  {
    const app = await buildApp()
    const token = app.jwt.sign({ sub: 'user-1', email: 'test@example.com' }, { expiresIn: '1h' })
    const walletAddress = '0x1234567890abcdef1234567890abcdef12345678'
    mockQuery.mockReset().mockResolvedValueOnce({
      rows: [{ id: 'user-1', email: 'test@example.com', wallet_address: walletAddress, safe_address: null }],
    })
    const injectOpts: InjectOptions = {
      method: 'PUT',
      url: '/user/wallet',
      headers: { authorization: `Bearer ${token}` },
      payload: { wallet_address: walletAddress },
    }
    const authClaims = { sub: 'user-1', email: 'test@example.com' }
    const res = await app.inject(injectOpts)
    save('user-wallet', 'PUT /user/wallet', recorded(injectOpts, authClaims), res.statusCode, res.json())
    await app.close()
  }
}
