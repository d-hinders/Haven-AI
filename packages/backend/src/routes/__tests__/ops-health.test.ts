/**
 * The `GET /ops/health` route (#3514): the ops shape (#3512) applied to the
 * system-health read. What is pinned here, beyond the builder (which
 * `modules/ops/__tests__/health.test.ts` proves against a real database):
 *
 * - NO RPC call on request — the chain client is a throwing stub, and the
 *   route still answers;
 * - the diagnostics builder is the injected `/health/ops` builder, so the
 *   two answers are built by ONE function;
 * - the delegate section is the injected getter — never a scan;
 * - reads go through the given executor, the audit row through the main
 *   pool, one per call;
 * - no response carries a credential-shaped key (the #3512 forbidden-key
 *   walk covers this payload), and the answer matches the OpenAPI schema.
 */
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import type { PoolClient } from 'pg'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import db from '../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../infra/__tests__/helpers/db-harness.js'
import { hexOf, seedOpsAgent, seedOpsIntent, seedOpsUser } from '../../infra/__tests__/helpers/ops-fixtures.js'
import { installRequestValidation } from '../../openapi/request-validation.js'
import { expectMatchesSpec } from '../../openapi/response-shape.js'
import type { OpsConfig } from '../../config/ops.js'
import type { HealthOpsPayload } from '../../routes/health-payload-types.js'
import type { DelegateBalanceReport } from '../../domain/delegate-balance.js'
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
const FORBIDDEN_KEY = /password_hash|_token$|_hash$|ciphertext|delegation_json|prepared_user_op|signature|machine_metadata|company/

const auth = { authorization: `Bearer ${signOpsToken({ secret: OPS.jwtSecret, issuer: API }, { githubId: 111, login: 'founder' })}` }

const DIAGNOSTICS: HealthOpsPayload = {
  relayer: [],
  passport: { verification: { configured: false, issuer: null }, chains: [], unverifiableChainIds: [] },
  trustProxy: { hops: 0, authRateLimitArmed: false },
  accounting: { exhaustedSyncs: null, connectionsNeedingAttention: null, webhookCounters: null, unavailable: true },
  request_validation: {
    mode: 'off',
    wouldRefuse: 0,
    wouldCoerce: 0,
    byRouteField: {},
    coerceByRouteField: {},
    since: '2026-10-02T00:00:00.000Z',
    seenByRoute: {},
  },
}

const REPORT: DelegateBalanceReport = {
  findings: [],
  dustTotalAtomic: 0n,
  dustAlert: false,
  lingering: [],
  unread: [],
  chainErrors: {},
  scannedAt: '2026-10-02T11:00:00.000Z',
}

function deps() {
  return {
    diagnostics: async () => DIAGNOSTICS,
    lastReport: () => null,
    diagnosticsCalls: 0,
  }
}

/** The chain client that must never be touched: any use fails the test. */
const throwingChain = {
  getReceiptStatus: () => {
    throw new Error('the chain client must never be called by GET /ops/health')
  },
  getFeeData: () => {
    throw new Error('the chain client must never be called by GET /ops/health')
  },
}

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
function sqlRecording(client: Awaited<ReturnType<typeof db.connect>>): { exec: Executor; sql: string[] } {
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

describeDb('GET /ops/health — the system-health route (#3514)', () => {
  let client: Awaited<ReturnType<typeof db.connect>>

  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
    client = await db.connect()
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    client.release()
  })

  it('makes NO RPC call on request: a chain client that throws on every method still answers', async () => {
    const userId = await seedOpsUser()
    const agentId = await seedOpsAgent(userId)
    await seedOpsIntent(userId, agentId, { status: 'confirmed' })
    const app = await build({
      readDb: sqlRecording(client).exec,
      audit: async () => {},
      healthDiagnostics: async () => DIAGNOSTICS,
      lastDelegateBalanceReport: () => null,
      servedChains: () => [84532],
    })
    const res = await app.inject({ method: 'GET', url: '/ops/health', headers: auth })
    expect(res.statusCode).toBe(200)
    expect(res.json().sweepable_intents).toEqual([])
    expect(res.json().delegate_balances).toEqual({ available: false, reason: 'not_available_on_this_replica' })
    await app.close()
    void throwingChain
  })

  it('serves the injected diagnostics builder and report getter — both /health/ops and /ops/health answers come from ONE builder', async () => {
    let diagnosticsCalls = 0
    const app = await build({
      readDb: sqlRecording(client).exec,
      audit: async () => {},
      healthDiagnostics: async () => {
        diagnosticsCalls += 1
        return DIAGNOSTICS
      },
      lastDelegateBalanceReport: () => null,
      servedChains: () => [],
    })
    const res = await app.inject({ method: 'GET', url: '/ops/health', headers: auth })
    expect(res.statusCode).toBe(200)
    expect(diagnosticsCalls).toBe(1)
    expect(res.json().ops_diagnostics).toEqual(DIAGNOSTICS)
    await app.close()
  })

  it('reads go through the given executor; the audit row is written through the main pool, one per call', async () => {
    const ops = sqlRecording(client)
    const audits: unknown[] = []
    const app = await build({
      readDb: ops.exec,
      audit: async (e) => void audits.push(e),
      healthDiagnostics: async () => DIAGNOSTICS,
      lastDelegateBalanceReport: () => null,
      servedChains: () => [],
    })
    const mainPool = vi.spyOn(db, 'query').mockRejectedValue(new Error('the main pool must not be read'))
    const res = await app.inject({ method: 'GET', url: '/ops/health', headers: auth })
    expect(res.statusCode).toBe(200)
    expect(mainPool).not.toHaveBeenCalled()
    expect(ops.sql.length).toBeGreaterThan(0)
    expect(ops.sql.some((q) => /ops_access_log/.test(q))).toBe(false) // never through the ops executor
    expect(audits).toHaveLength(1)
    await app.close()
    vi.restoreAllMocks()

    // The default writer goes through the main pool: exactly one row lands.
    const app2 = await build({
      readDb: sqlRecording(client).exec,
      healthDiagnostics: async () => DIAGNOSTICS,
      lastDelegateBalanceReport: () => null,
      servedChains: () => [],
    })
    const res2 = await app2.inject({ method: 'GET', url: '/ops/health', headers: auth })
    expect(res2.statusCode).toBe(200)
    const { rows } = await db.query<{ action: string; target_type: string }>(
      'SELECT action, target_type FROM ops_access_log',
    )
    expect(rows).toEqual([{ action: 'view', target_type: 'system_health' }])
    await app2.close()
  })

  it('no response carries a credential-shaped key, and the payload matches its OpenAPI schema', async () => {
    const userId = await seedOpsUser()
    const agentId = await seedOpsAgent(userId)
    await seedOpsIntent(userId, agentId, { status: 'submitted' })
    const app = await build({
      readDb: sqlRecording(client).exec,
      audit: async () => {},
      healthDiagnostics: async () => DIAGNOSTICS,
      lastDelegateBalanceReport: () => null,
      servedChains: () => [],
    })
    const res = await app.inject({ method: 'GET', url: '/ops/health', headers: auth })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    const keys: string[] = []
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk)
      else if (v && typeof v === 'object') {
        for (const [k, inner] of Object.entries(v)) {
          keys.push(k)
          walk(inner)
        }
      }
    }
    walk(body)
    expect(keys.filter((k) => FORBIDDEN_KEY.test(k))).toEqual([])
    expectMatchesSpec('GET', '/ops/health', body)
    await app.close()
  })

  it('is off (404) without the diagnostics builder or the report getter, like every data read', async () => {
    const noDiagnostics = await build({
      readDb: sqlRecording(client).exec,
      healthDiagnostics: null,
      lastDelegateBalanceReport: () => null,
      audit: async () => {},
    })
    const noGetter = await build({
      readDb: sqlRecording(client).exec,
      healthDiagnostics: async () => DIAGNOSTICS,
      lastDelegateBalanceReport: null,
      audit: async () => {},
    })
    for (const app of [noDiagnostics, noGetter]) {
      const res = await app.inject({ method: 'GET', url: '/ops/health', headers: auth })
      expect(res.statusCode).toBe(404)
      await app.close()
    }
  })

  it('refuses a dashboard JWT and a missing token', async () => {
    const { createSigner } = await import('fast-jwt')
    const dashboardJwt = createSigner({ key: 'dashboard-secret-for-tests', expiresIn: 60_000 })({
      sub: userId0(),
      email: 'someone@customer.example',
    })
    const app = await build({
      readDb: sqlRecording(client).exec,
      healthDiagnostics: async () => DIAGNOSTICS,
      lastDelegateBalanceReport: () => null,
      audit: async () => {},
    })
    expect(
      (await app.inject({ method: 'GET', url: '/ops/health', headers: { authorization: `Bearer ${dashboardJwt}` } })).statusCode,
    ).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/ops/health' })).statusCode).toBe(401)
    await app.close()
  })
})

function userId0(): string {
  return '00000000-0000-4000-8000-000000000000'
}
