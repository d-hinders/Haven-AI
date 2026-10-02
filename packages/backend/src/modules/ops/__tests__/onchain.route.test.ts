/**
 * `GET /ops/users/:id/onchain` (#3513) against a REAL Postgres, with the
 * chain readers mocked at the route seam — the same seam `index.ts` wires
 * (`onchainReaders`), so this pins the wiring too:
 *
 * - one audit row per call, through the MAIN pool (never the ops executor);
 * - masked addresses; no `delegation_json` or `delegation_hash` in the body;
 * - the response matches its OpenAPI schema (`OpsOnchainView`);
 * - 404 for an unknown user, 404 while ops data or the readers are off,
 *   401 without an ops token, 503 when the audit write fails;
 * - off (404) without `onchainReaders` even when the read-only role is set.
 */
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import type { PoolClient } from 'pg'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { hexOf, seedOpsAccount, seedOpsAgent, seedOpsDelegation, seedOpsUser } from '../../../infra/__tests__/helpers/ops-fixtures.js'
import { installRequestValidation } from '../../../../src/openapi/request-validation.js'
import { expectMatchesSpec } from '../../../../src/openapi/response-shape.js'
import type { OpsConfig } from '../../../config/ops.js'
import type { OpsAccessLogEntry } from '../../../infra/repositories/ops-access-log.js'
import type { Executor, QueryRow } from '../../../infra/transaction.js'
import { signOpsToken } from '../tokens.js'
import opsRoutes, { type OpsRoutesOptions } from '../../../routes/ops.js'

// Dev's served-chains shape; read before the route module graph loads.
process.env.HAVEN_DEPLOY_CHAIN_IDS = '84532'

const API = 'https://api.example.com'
const OPS: OpsConfig = {
  githubClientId: 'gh-client-id',
  githubClientSecret: 'gh-client-secret',
  jwtSecret: 'ops-secret-for-tests-0123456789-abcdef',
  allowedGithubIds: [111],
  redirectOrigins: ['https://ops.example.com'],
  publicOrigin: API,
}

const HASH = `0x${'c'.repeat(64)}`
const ADDRESS = hexOf(0xabcd, 20)

const auth = { authorization: `Bearer ${signOpsToken({ secret: OPS.jwtSecret, issuer: API }, { githubId: 111, login: 'founder' })}` }

const testReaders = {
  chainHasDelegationPins: vi.fn((chainId: number) => chainId === 84532),
  accountHasCode: vi.fn(async () => true),
  readDisabledDelegationHashes: vi.fn(async () => new Set<`0x${string}`>()),
  readRemainingBudget: vi.fn(async (_chainId: number, _json: string, budget: string) => ({
    remainingAtomic: (BigInt(budget) / 4n).toString(),
    fromChain: true,
  })),
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

async function seedOnchainCustomer(): Promise<{ userId: string }> {
  const userId = await seedOpsUser('ada.lovelace@customer.example')
  const accountId = await seedOpsAccount(userId, { address: ADDRESS })
  const agentId = await seedOpsAgent(userId, { accountId })
  await seedOpsDelegation(agentId, { recipient: hexOf(0x77, 20) })
  return { userId }
}

describeDb('ops console — on-chain route (#3513)', () => {
  let client: PoolClient
  let userId: string

  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
    userId = (await seedOnchainCustomer()).userId
    client = await db.connect()
    testReaders.accountHasCode.mockClear()
    testReaders.readDisabledDelegationHashes.mockClear()
    testReaders.readRemainingBudget.mockClear()
    testReaders.chainHasDelegationPins.mockClear?.()
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    client.release()
  })

  it('answers the DB-vs-chain view: audited once, masked, schema-matching, read through the ops executor only', async () => {
    const audits: OpsAccessLogEntry[] = []
    const ops = recording(client)
    const app = await build({
      readDb: ops.exec,
      onchainReaders: testReaders,
      audit: async (e) => void audits.push(e),
    })
    const mainPool = vi.spyOn(db, 'query').mockRejectedValue(new Error('the main pool must not be read'))
    const res = await app.inject({ method: 'GET', url: `/ops/users/${userId}/onchain`, headers: auth })
    expect(res.statusCode).toBe(200)
    expect(mainPool).not.toHaveBeenCalled()
    expect(ops.sql.some((q) => /ops_access_log/.test(q))).toBe(false)

    const body = res.json()
    expect(body.user_id).toBe(userId)
    expect(body.accounts).toHaveLength(1)
    const account = body.accounts[0]
    // hexOf pads LEFT: 0xabcd as a 20-byte address masks to `0x0000…abcd`.
    expect(account.account_address).toBe('0x0000…abcd')
    expect(res.body).not.toContain(ADDRESS)
    expect(res.body).not.toContain(HASH)
    expect(res.body).not.toContain('{"signed"')
    expect(res.headers['cache-control']).toBe('no-store')
    expectMatchesSpec('GET', '/ops/users/{id}/onchain', body)

    // One audit row, through the main pool, naming the read.
    expect(audits).toEqual([
      expect.objectContaining({ action: 'view', targetType: 'user_onchain', targetId: userId, requestId: expect.any(String) }),
    ])
    await app.close()
  })

  it('404s an unknown user (still audited) and 401s without an ops token', async () => {
    const audits: OpsAccessLogEntry[] = []
    const app = await build({ readDb: recording(client).exec, onchainReaders: testReaders, audit: async (e) => void audits.push(e) })
    const unknown = await app.inject({
      method: 'GET',
      url: '/ops/users/00000000-0000-4000-8000-000000000000/onchain',
      headers: auth,
    })
    expect(unknown.statusCode).toBe(404)
    const noToken = await app.inject({ method: 'GET', url: `/ops/users/${userId}/onchain` })
    expect(noToken.statusCode).toBe(401)
    expect(audits.map((a) => [a.targetType, a.targetId])).toEqual([
      ['user_onchain', '00000000-0000-4000-8000-000000000000'],
    ])
    await app.close()
  })

  it('is off (404) without wired readers, without the read-only role, and on a failed audit write (503)', async () => {
    const noReaders = await build({ readDb: recording(client).exec, audit: async () => {} })
    expect(
      (await noReaders.inject({ method: 'GET', url: `/ops/users/${userId}/onchain`, headers: auth })).statusCode,
    ).toBe(404)
    await noReaders.close()

    const noDb = await build({ onchainReaders: testReaders, audit: async () => {} })
    expect(
      (await noDb.inject({ method: 'GET', url: `/ops/users/${userId}/onchain`, headers: auth })).statusCode,
    ).toBe(404)
    await noDb.close()

    const auditFails = await build({
      readDb: recording(client).exec,
      onchainReaders: testReaders,
      audit: async () => {
        throw new Error('audit store down')
      },
    })
    const failed = await auditFails.inject({ method: 'GET', url: `/ops/users/${userId}/onchain`, headers: auth })
    expect(failed.statusCode).toBe(503)
    expect(failed.body).not.toContain(userId)
    await auditFails.close()
  })
})
