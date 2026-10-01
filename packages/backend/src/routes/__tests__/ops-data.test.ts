/**
 * The ops console's data routes (#3512): `GET /ops/overview`,
 * `GET /ops/search`, `GET /ops/users/:id` — against a real Postgres.
 *
 * What is pinned here, beyond the SQL (which `ops-reads.test.ts` proves):
 * - reads use the executor the route was given, never the main pool;
 * - the audit row is written through the main pool, never the ops executor,
 *   and a search's audit row never stores the raw term;
 * - no response carries a credential-shaped key or an unmasked email;
 * - every route refuses a dashboard JWT, answers 404 while ops data is off or
 *   the login fails the self-check, and matches its OpenAPI schema.
 */
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import { createSigner } from 'fast-jwt'
import type { PoolClient } from 'pg'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import db from '../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../infra/__tests__/helpers/db-harness.js'
import {
  hexOf,
  seedOpsAccount,
  seedOpsAgent,
  seedOpsDelegation,
  seedOpsIntent,
  seedOpsRefusal,
  seedOpsSystemTx,
  seedOpsUser,
} from '../../infra/__tests__/helpers/ops-fixtures.js'
import { installRequestValidation } from '../../openapi/request-validation.js'
import { expectMatchesSpec } from '../../openapi/response-shape.js'
import type { OpsConfig } from '../../config/ops.js'
import type { OpsAccessLogEntry } from '../../infra/repositories/ops-access-log.js'
import { OpsReadRoleUnsafeError } from '../../infra/repositories/ops-read-role.js'
import type { Executor, QueryRow } from '../../infra/transaction.js'
import { signOpsToken } from '../../modules/ops/tokens.js'
import opsRoutes, { type OpsRoutesOptions } from '../ops.js'

const API = 'https://api.example.com'
const OPS: OpsConfig = {
  githubClientId: 'gh-client-id',
  githubClientSecret: 'gh-client-secret',
  jwtSecret: 'ops-secret-for-tests-0123456789-abcdef',
  allowedGithubIds: [111],
  redirectOrigins: ['https://ops.example.com'],
  publicOrigin: API,
}
const CUSTOMER_EMAIL = 'ada.lovelace@customer.example'
const FORBIDDEN_KEY = /password_hash|_token$|_hash$|ciphertext|delegation_json|signature|machine_metadata/

const auth = { authorization: `Bearer ${signOpsToken({ secret: OPS.jwtSecret, issuer: API }, { githubId: 111, login: 'founder' })}` }

async function build(overrides: Partial<OpsRoutesOptions>): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    void reply.status(error.statusCode ?? 500).send({ error: error.message })
  })
  installRequestValidation(app, { mode: 'enforce', enforcedModules: ['routes/ops.ts'] })
  await app.register(opsRoutes, { prefix: '/ops', ops: OPS, trustProxyHops: 0, ...overrides })
  await app.ready()
  return app
}

/** An executor over one checked-out client that records every statement it runs. */
function recording(client: PoolClient): { exec: Executor; sql: string[] } {
  const sql: string[] = []
  return {
    sql,
    exec: {
      async query<R extends QueryRow = QueryRow>(text: string, values?: unknown[]) {
        sql.push(text)
        return client.query<R>(text, values)
      },
    },
  }
}

function keysOf(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, out))
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k)
      keysOf(v, out)
    }
  }
  return out
}

interface Seeded {
  userId: string
  agentId: string
  address: string
  intentId: string
  txHash: string
}

async function seedCustomer(): Promise<Seeded> {
  const userId = await seedOpsUser(CUSTOMER_EMAIL)
  const address = hexOf(0xaaaa01, 20)
  const accountId = await seedOpsAccount(userId, { address })
  const agentId = await seedOpsAgent(userId, { accountId })
  await seedOpsDelegation(agentId, { recipient: hexOf(0x77, 20) })
  const txHash = hexOf(0x5151, 32)
  const intentId = await seedOpsIntent(userId, agentId, { txHash, error: 'nonce too low' })
  await seedOpsRefusal(userId, agentId)
  await seedOpsSystemTx(txHash)
  return { userId, agentId, address, intentId, txHash }
}

describeDb('ops console — data routes against a real database (#3512)', () => {
  let client: PoolClient
  let s: Seeded

  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
    s = await seedCustomer()
    client = await db.connect()
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    client.release()
  })

  const urls = () => [
    '/ops/overview',
    `/ops/search?q=${encodeURIComponent('ada.lov')}`,
    `/ops/search?q=${s.userId}`,
    `/ops/search?q=${s.address}`,
    `/ops/search?q=${s.txHash}`,
    `/ops/users/${s.userId}`,
  ]

  it('reads go through the given executor: with the main pool throwing, every route still answers', async () => {
    const audits: OpsAccessLogEntry[] = []
    const ops = recording(client)
    const app = await build({ readDb: ops.exec, audit: async (e) => void audits.push(e) })
    const mainPool = vi.spyOn(db, 'query').mockRejectedValue(new Error('the main pool must not be read'))
    for (const url of urls()) {
      const res = await app.inject({ method: 'GET', url, headers: auth })
      expect(res.statusCode, url).toBe(200)
    }
    expect(mainPool).not.toHaveBeenCalled()
    expect(ops.sql.length).toBeGreaterThan(0)
    expect(audits).toHaveLength(urls().length) // one audit row per call
    await app.close()
  })

  it('the audit row is written through the main pool, never the ops executor; a search stores the masked term only', async () => {
    const ops = recording(client)
    const app = await build({ readDb: ops.exec }) // default audit writer: the main pool
    const res = await app.inject({ method: 'GET', url: `/ops/search?q=${encodeURIComponent(CUSTOMER_EMAIL)}`, headers: auth })
    expect(res.statusCode).toBe(200)
    expect(res.json().hits).toEqual([expect.objectContaining({ kind: 'user', id: s.userId })])
    expect(ops.sql.some((q) => /ops_access_log/.test(q))).toBe(false)

    const { rows } = await db.query<{ action: string; target_type: string; detail: string; operator_github_id: string }>(
      'SELECT action, target_type, detail, operator_github_id FROM ops_access_log',
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ action: 'search', target_type: 'email', operator_github_id: '111' })
    expect(rows[0].detail).not.toContain(CUSTOMER_EMAIL)
    expect(rows[0].detail).not.toContain('ada.lovelace')
    expect(rows[0].detail).toBe('ad•••@customer.example')
    await app.close()
  })

  it('no response carries a credential-shaped key or the unmasked email, and each matches its schema', async () => {
    const app = await build({ readDb: recording(client).exec, audit: async () => {} })
    for (const url of urls()) {
      const res = await app.inject({ method: 'GET', url, headers: auth })
      expect(res.statusCode, url).toBe(200)
      const body = res.json()
      expect(keysOf(body).filter((k) => FORBIDDEN_KEY.test(k)), url).toEqual([])
      expect(res.body, url).not.toContain(CUSTOMER_EMAIL)
      expect(res.body, url).not.toContain('Ada Lovelace')
      expect(res.headers['cache-control']).toBe('no-store')
      const path = url.startsWith('/ops/users/') ? '/ops/users/{id}' : url.split('?')[0]
      expectMatchesSpec('GET', path, body)
    }
    await app.close()
  })

  it('search finds each key type: the customer by email and id, the account by address, the intent and a user-less system tx by hash', async () => {
    const app = await build({ readDb: recording(client).exec, audit: async () => {} })
    const get = async (q: string) => (await app.inject({ method: 'GET', url: `/ops/search?q=${encodeURIComponent(q)}`, headers: auth })).json()

    expect((await get('ADA.LOV')).hits.map((h: { kind: string }) => h.kind)).toEqual(['user'])
    expect((await get(s.userId)).hits.map((h: { kind: string }) => h.kind)).toEqual(['user'])
    expect((await get(s.intentId)).hits.map((h: { kind: string }) => h.kind)).toEqual(['payment_intent'])
    expect((await get(s.address.toUpperCase().replace('0X', '0x'))).hits.map((h: { kind: string }) => h.kind)).toEqual(['smart_account'])
    const byTx = await get(s.txHash)
    expect(byTx.key_type).toBe('tx_hash')
    expect(byTx.hits.map((h: { kind: string }) => h.kind)).toEqual(['payment_intent', 'system_tx'])
    expect(byTx.hits[1]).not.toHaveProperty('user_id')
    expect(await get('nobody-at-all')).toEqual({ key_type: 'email', hits: [], timed_out: [] })

    const short = await app.inject({ method: 'GET', url: '/ops/search?q=ad', headers: auth })
    expect(short.statusCode).toBe(400)
    await app.close()
  })

  it("user detail masks the user, lists the customer's records, and 404s an unknown id (still audited)", async () => {
    const audits: OpsAccessLogEntry[] = []
    const app = await build({ readDb: recording(client).exec, audit: async (e) => void audits.push(e) })
    const res = await app.inject({ method: 'GET', url: `/ops/users/${s.userId}`, headers: auth })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.user).toMatchObject({ id: s.userId, email: 'ad•••@customer.example', name: 'A•••' })
    expect(body.smart_accounts).toHaveLength(1)
    expect(body.agents.map((a: { id: string }) => a.id)).toEqual([s.agentId])
    expect(body.active_delegations[0]).toMatchObject({ recipient_address: hexOf(0x77, 20), expires_at: 9999999999 })
    expect(body.payment_intents[0]).toMatchObject({ id: s.intentId, error_message: 'nonce too low' })
    expect(body.payment_refusals[0]).toMatchObject({ reason: 'delegation_budget_exceeded' })

    const unknown = await app.inject({ method: 'GET', url: '/ops/users/00000000-0000-4000-8000-000000000000', headers: auth })
    expect(unknown.statusCode).toBe(404)
    expect(audits.map((a) => [a.action, a.targetType, a.targetId])).toEqual([
      ['view', 'user', s.userId],
      ['view', 'user', '00000000-0000-4000-8000-000000000000'],
    ])
    await app.close()
  })

  it('a failed audit write answers 503 with nothing returned', async () => {
    const app = await build({
      readDb: recording(client).exec,
      audit: async () => {
        throw new Error('audit store down')
      },
    })
    for (const url of urls()) {
      const res = await app.inject({ method: 'GET', url, headers: auth })
      expect(res.statusCode, url).toBe(503)
      expect(res.body, url).not.toContain(s.userId)
    }
    await app.close()
  })

  it('every data route refuses a dashboard JWT and a missing token, and is off (404) without a usable read-only role', async () => {
    const dashboardJwt = createSigner({ key: 'dashboard-secret-for-tests', expiresIn: 60_000 })({ sub: s.userId, email: CUSTOMER_EMAIL })
    const live = await build({ readDb: recording(client).exec, audit: async () => {} })
    const off = await build({ readDb: null, audit: async () => {} })
    const unsafe = await build({
      readDb: {
        query: async () => {
          throw new OpsReadRoleUnsafeError(['can read users.password_hash'])
        },
      },
      audit: async () => {
        throw new Error('must not be audited')
      },
    })
    for (const url of urls()) {
      expect((await live.inject({ method: 'GET', url, headers: { authorization: `Bearer ${dashboardJwt}` } })).statusCode, url).toBe(401)
      expect((await live.inject({ method: 'GET', url })).statusCode, url).toBe(401)
      expect((await off.inject({ method: 'GET', url, headers: auth })).statusCode, url).toBe(404)
      expect((await unsafe.inject({ method: 'GET', url, headers: auth })).statusCode, url).toBe(404)
    }
    await Promise.all([live.close(), off.close(), unsafe.close()])
  })
})
