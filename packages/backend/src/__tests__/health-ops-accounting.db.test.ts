/**
 * Real-DB proof for the two accounting counters on `GET /health/ops` (#2872,
 * epic #2858): the route is built with the module's REAL
 * `getAccountingOpsCounters`, rows are seeded on the harness, and the
 * numbers on the wire are asserted — so a wrong predicate in either query
 * fails HERE, at the route, not only in a repository test.
 *
 * MUTATION TARGETS (run by hand for the #2872 report):
 *   - `COUNT_EXHAUSTED_SYNCS_SQL` counting every `failed` row (drop the
 *     `attempts >= $1` term) → `exhaustedSyncs` reads 3, not 2.
 *   - `COUNT_CONNECTIONS_NEEDING_ATTENTION_SQL` counting every non-connected
 *     row (`status <> 'connected'`) → `connectionsNeedingAttention` reads 4,
 *     not 3 (the `disconnected` row is the user's own choice).
 */
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import db from '../db.js'
import { describeDb, initDbHarness, resetDb } from '../infra/__tests__/helpers/db-harness.js'
import { registerHealthRoutes } from '../routes/health.js'
import { getAccountingOpsCounters } from '../modules/accounting/ops-signals.js'
import { RETRY_MAX_ATTEMPTS } from '../infra/repositories/accounting-feed-syncs.js'
import { upsertConnection, setStatus, type ConnectionStatus } from '../infra/repositories/accounting-connections.js'

let seq = 0
async function seedUser(): Promise<string> {
  const r = await db.query<{ id: string }>(`INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`, [
    `ops-${++seq}-${Date.now()}@test.example`,
  ])
  return r.rows[0].id
}

async function seedSync(userId: string, paymentId: string, status: string, attempts: number): Promise<void> {
  await db.query(
    `INSERT INTO accounting_feed_syncs (user_id, provider, payment_id, status, attempts, error) VALUES ($1, 'fortnox', $2, $3, $4, 'boom')`,
    [userId, paymentId, status, attempts],
  )
}

async function seedConnection(userId: string, provider: string, status: ConnectionStatus): Promise<void> {
  await upsertConnection(userId, {
    provider,
    authKind: 'oauth2',
    secretsCiphertext: Buffer.from('{}'),
    secretsKeyVersion: 0,
    grantedScope: null,
    tokenExpiresAt: null,
  })
  if (status !== 'connected') await setStatus(userId, provider, status, `seeded ${status}`)
}

describeDb('GET /health/ops accounting counters (#2872) — real queries', () => {
  let app: FastifyInstance | undefined

  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
    app = Fastify({ logger: false })
    registerHealthRoutes(app, {
      checkDatabase: vi.fn().mockResolvedValue(undefined),
      getRelayerStatus: () => [],
      getPassportStatus: () => ({ configured: true }) as never,
      trustProxyHops: 1,
      opsToken: 'operator-secret',
      getAccountingCounters: () => getAccountingOpsCounters(),
    })
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  async function read(): Promise<{ exhaustedSyncs: number; connectionsNeedingAttention: number }> {
    const res = await app!.inject({ method: 'GET', url: '/health/ops', headers: { 'x-haven-ops-token': 'operator-secret' } })
    expect(res.statusCode).toBe(200)
    return res.json().accounting
  }

  it('reads 0 / 0 on an empty deployment', async () => {
    expect(await read()).toEqual({ exhaustedSyncs: 0, connectionsNeedingAttention: 0 })
  })

  it('exhaustedSyncs counts failed rows AT the cap across every tenant — not retryable failures, not skipped, not pushed', async () => {
    const a = await seedUser()
    const b = await seedUser()
    await seedSync(a, 'x1', 'failed', RETRY_MAX_ATTEMPTS) // exhausted
    await seedSync(b, 'x2', 'failed', RETRY_MAX_ATTEMPTS + 3) // exhausted (pushed past the cap by hand, still failed)
    await seedSync(a, 'f1', 'failed', 1) // retryable
    await seedSync(a, 'f2', 'failed', RETRY_MAX_ATTEMPTS - 1) // retryable, one short
    await seedSync(b, 's1', 'skipped', RETRY_MAX_ATTEMPTS) // skipped rows are not "exhausted" — the sweep's predicate is status = failed
    await seedSync(b, 'p1', 'pushed', RETRY_MAX_ATTEMPTS)
    await seedSync(b, 'q1', 'pending', RETRY_MAX_ATTEMPTS)
    expect((await read()).exhaustedSyncs).toBe(2)
  })

  it('connectionsNeedingAttention counts the three re-consent states across every tenant — never connected or disconnected', async () => {
    const a = await seedUser()
    const b = await seedUser()
    const c = await seedUser()
    await seedConnection(a, 'fortnox', 'needs_reauthorisation')
    await seedConnection(b, 'fortnox', 'scope_missing')
    await seedConnection(c, 'fortnox', 'revoked_at_provider')
    await seedConnection(a, 'accounted', 'connected')
    await seedConnection(b, 'accounted', 'disconnected')
    expect((await read()).connectionsNeedingAttention).toBe(3)
  })
})
