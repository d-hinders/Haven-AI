/**
 * Real-Postgres route tests for the label surface (#3167). No mocks — the
 * claims are about what the SQL returns and which caller a refusal names,
 * the same posture `merchants.test.ts` set for this route generation.
 *
 *  - the CRUD vocabulary: create (case-folded, one name per user), list,
 *    rename (409 on a collision), recolor, delete (assignments cascade);
 *  - assignment: PUT /agents/:id/labels replaces the set, refuses a foreign
 *    label id with 404, and an empty array clears;
 *  - reads: GET /agents carries labels[] per agent;
 *  - every 200 matches the spec (#1444 response-shape);
 *  - the request-validation plugin runs ENFORCED for both new modules, so a
 *    spec/route mismatch on a legitimate request fails here, not on dev.
 *
 * Labels are DISPLAY/CATEGORIZATION ONLY; these tests keep them that way by
 * never touching a delegation, budget, or enforcement surface.
 */
import Fastify, { FastifyError, FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import db from '../../db.js'
import { assertWorkerSchemaAtHead, describeDb, initDbHarness, resetDb } from '../../infra/__tests__/helpers/db-harness.js'
import { expectMatchesSpec } from '../../openapi/response-shape.js'
import labelRoutes from '../labels.js'
import agentLabelRoutes from '../agent-labels.js'
import agentRoutes from '../agents.js'
import { installRequestValidation } from '../../openapi/request-validation.js'

let seq = 0

async function seedUser(): Promise<string> {
  seq += 1
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`labels-route-${seq}-${Date.now()}@test.example`],
  )
  return rows[0].id
}

async function seedAgent(userId: string): Promise<string> {
  // The single-record read (#2413) joins smart_accounts and keeps only
  // delegation-rail agents, so the fixture links one — same shape the
  // merchants suite seeds.
  const account = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type)
     VALUES ($1, $2, 8453, 'delegation', 'delegator_hybrid') RETURNING id`,
    [userId, '0x' + 'ef'.repeat(20)],
  )
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name, delegate_address, status, account_id)
     VALUES ($1, 'Labelled agent', $2, 'active', $3) RETURNING id`,
    // delegate_address is VARCHAR(42) — a 20-byte hex address + '0x' exactly.
    [userId, '0x' + 'cd'.repeat(20), account.rows[0].id],
  )
  return rows[0].id
}

describeDb('label routes (#3167)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    await initDbHarness()
    app = Fastify({ logger: false })
    app.setErrorHandler((error: FastifyError, _request, reply) => {
      void reply.status(error.statusCode ?? 500).send({ error: error.message })
    })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    // Both new modules are born ENFORCED in `src/index.ts` (#3028 rollout);
    // the suite runs every case under enforcement.
    installRequestValidation(app, {
      mode: 'off',
      enforcedModules: ['routes/labels.ts', 'routes/agent-labels.ts'],
    })
    await app.register(agentRoutes, { prefix: '/agents' })
    await app.register(agentLabelRoutes, { prefix: '/agents' })
    await app.register(labelRoutes, { prefix: '/labels' })
    await app.ready()
  })

  afterEach(async () => {
    await resetDb()
  })

  afterAll(async () => {
    await app.close()
    await assertWorkerSchemaAtHead()
  })

  function auth(userId: string): { headers: { authorization: string } } {
    // `email` is part of the JWT payload's declared type (merchants.test.ts
    // signs the same pair) — the middleware reads only `sub`.
    const token = app.jwt.sign({ sub: userId, email: 'labels@test.example' })
    return { headers: { authorization: `Bearer ${token}` } }
  }

  async function createLabel(
    userId: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await app.inject({ method: 'POST', url: '/labels', ...auth(userId), payload: body })
    return { status: res.statusCode, body: res.json() as Record<string, unknown> }
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  it('creates a label and lists it', async () => {
    const userId = await seedUser()
    const created = await createLabel(userId, { name: 'prod' })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ name: 'prod', color: 'neutral' })

    const list = await app.inject({ method: 'GET', url: '/labels', ...auth(userId) })
    expect(list.statusCode).toBe(200)
    const labels = (list.json() as { labels: Record<string, unknown>[] }).labels
    expect(labels).toHaveLength(1)
    expectMatchesSpec('GET', '/labels', list.json())
  })

  it('folds case on create: Prod lands as prod', async () => {
    const userId = await seedUser()
    const first = await createLabel(userId, { name: 'Prod' })
    expect(first.status).toBe(201)
    expect(first.body.name).toBe('prod')
    // Same name, different case: the upsert reuses the row instead of 500ing
    // on the unique index.
    const again = await createLabel(userId, { name: 'PROD', color: 'brand' })
    expect(again.status).toBe(201)
    expect(again.body.name).toBe('prod')
    expect(again.body.color).toBe('brand')

    const list = await app.inject({ method: 'GET', url: '/labels', ...auth(userId) })
    expect((list.json() as { labels: unknown[] }).labels).toHaveLength(1)
    expectMatchesSpec('GET', '/labels', list.json())
  })

  it('refuses a blank name and an unknown color with 400', async () => {
    const userId = await seedUser()
    const blank = await createLabel(userId, { name: '   ' })
    expect(blank.status).toBe(400)
    const hue = await createLabel(userId, { name: 'prod', color: 'chartreuse' })
    expect(hue.status).toBe(400)
  })

  it('renames and recolors; colliding rename is a 409; foreign id is a 404', async () => {
    const userId = await seedUser()
    const a = await createLabel(userId, { name: 'prod' })
    const b = await createLabel(userId, { name: 'staging', color: 'success' })
    const aId = a.body.id as string
    const bId = b.body.id as string

    const recolor = await app.inject({
      method: 'PUT', url: `/labels/${bId}`, ...auth(userId),
      payload: { color: 'debit' },
    })
    expect(recolor.statusCode).toBe(200)
    expect(recolor.json()).toMatchObject({ name: 'staging', color: 'debit' })

    const collide = await app.inject({
      method: 'PUT', url: `/labels/${bId}`, ...auth(userId),
      payload: { name: 'PROD' },
    })
    expect(collide.statusCode).toBe(409)

    const ok = await app.inject({
      method: 'PUT', url: `/labels/${bId}`, ...auth(userId),
      payload: { name: 'Staging' },
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().name).toBe('staging')

    const other = await seedUser()
    const foreign = await app.inject({
      method: 'PUT', url: `/labels/${aId}`, ...auth(other), payload: { name: 'x' },
    })
    expect(foreign.statusCode).toBe(404)
  })

  it('deleting a label removes assignments and leaves the agent untouched', async () => {
    const userId = await seedUser()
    const agentId = await seedAgent(userId)
    const label = await createLabel(userId, { name: 'prod' })
    const labelId = label.body.id as string

    const put = await app.inject({
      method: 'PUT', url: `/agents/${agentId}/labels`, ...auth(userId),
      payload: { label_ids: [labelId] },
    })
    expect(put.statusCode).toBe(200)

    const del = await app.inject({ method: 'DELETE', url: `/labels/${labelId}`, ...auth(userId) })
    expect(del.statusCode).toBe(200)

    const agent = await db.query<{ labels: unknown[] | null }>(
      `SELECT json_agg(l.name ORDER BY l.name) AS labels
       FROM agent_label_assignments a
       JOIN agent_labels l ON l.id = a.label_id
       WHERE a.agent_id = $1`,
      [agentId],
    )
    expect(agent.rows[0].labels).toBeNull()
    const agentRow = await db.query<{ name: string }>(`SELECT name FROM agents WHERE id = $1`, [agentId])
    expect(agentRow.rows).toHaveLength(1)
    expect(agentRow.rows[0].name).toBe('Labelled agent')
  })

  // ── Assignment ────────────────────────────────────────────────────────────

  it('PUT /agents/:id/labels replaces the set and the response matches the spec', async () => {
    const userId = await seedUser()
    const agentId = await seedAgent(userId)
    const one = await createLabel(userId, { name: 'prod', color: 'brand' })
    const two = await createLabel(userId, { name: 'finance', color: 'debit' })
    const three = await createLabel(userId, { name: 'experimental' })

    const first = await app.inject({
      method: 'PUT', url: `/agents/${agentId}/labels`, ...auth(userId),
      payload: { label_ids: [one.body.id, two.body.id] },
    })
    expect(first.statusCode).toBe(200)
    const labels1 = (first.json() as { labels: { name: string }[] }).labels
    expect(labels1.map((l) => l.name)).toEqual(['finance', 'prod'])
    expectMatchesSpec('PUT', '/agents/{id}/labels', first.json())

    // Replacement, not append: three replaces the first pair.
    const second = await app.inject({
      method: 'PUT', url: `/agents/${agentId}/labels`, ...auth(userId),
      payload: { label_ids: [three.body.id] },
    })
    expect(second.statusCode).toBe(200)
    expect((second.json() as { labels: { name: string }[] }).labels.map((l) => l.name)).toEqual([
      'experimental',
    ])
  })

  it('an empty label_ids array clears the labels', async () => {
    const userId = await seedUser()
    const agentId = await seedAgent(userId)
    const label = await createLabel(userId, { name: 'prod' })
    await app.inject({
      method: 'PUT', url: `/agents/${agentId}/labels`, ...auth(userId),
      payload: { label_ids: [label.body.id] },
    })
    const clear = await app.inject({
      method: 'PUT', url: `/agents/${agentId}/labels`, ...auth(userId),
      payload: { label_ids: [] },
    })
    expect(clear.statusCode).toBe(200)
    expect((clear.json() as { labels: unknown[] }).labels).toEqual([])
  })

  it('a foreign or unknown label id is a 404 and writes nothing', async () => {
    const owner = await seedUser()
    const other = await seedUser()
    const agentId = await seedAgent(owner)
    const foreign = await createLabel(other, { name: 'not-mine' })

    const res = await app.inject({
      method: 'PUT', url: `/agents/${agentId}/labels`, ...auth(owner),
      payload: { label_ids: [foreign.body.id as string] },
    })
    expect(res.statusCode).toBe(404)

    const labels = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_label_assignments WHERE agent_id = $1`,
      [agentId],
    )
    expect(labels.rows[0].count).toBe('0')
  })

  it('another user cannot label MY agent and I cannot read their labels', async () => {
    const owner = await seedUser()
    const intruder = await seedUser()
    const agentId = await seedAgent(owner)
    const label = await createLabel(intruder, { name: 'mine' })

    const res = await app.inject({
      method: 'PUT', url: `/agents/${agentId}/labels`, ...auth(intruder),
      payload: { label_ids: [label.body.id as string] },
    })
    expect(res.statusCode).toBe(404)
  })

  // ── Reads carry labels[] ─────────────────────────────────────────────────

  it('GET /agents returns labels[] per agent and matches the spec', async () => {
    const userId = await seedUser()
    const agentId = await seedAgent(userId)
    await createLabel(userId, { name: 'prod', color: 'brand' })
    const list = await db.query<{ id: string }>(`SELECT id FROM agent_labels WHERE user_id = $1`, [userId])

    await app.inject({
      method: 'PUT', url: `/agents/${agentId}/labels`, ...auth(userId),
      payload: { label_ids: list.rows.map((r) => r.id) },
    })

    const res = await app.inject({ method: 'GET', url: '/agents', ...auth(userId) })
    expect(res.statusCode).toBe(200)
    const agents = (res.json() as { agents: { id: string; labels: { name: string }[] }[] }).agents
    const mine = agents.find((a) => a.id === agentId)
    expect(mine?.labels.map((l) => l.name)).toEqual(['prod'])
    expectMatchesSpec('GET', '/agents', res.json())
  })

  it('GET /agents returns labels: [] for an unlabelled agent', async () => {
    const userId = await seedUser()
    await seedAgent(userId)
    const res = await app.inject({ method: 'GET', url: '/agents', ...auth(userId) })
    expect(res.statusCode).toBe(200)
    const agents = (res.json() as { agents: { labels: unknown[] }[] }).agents
    expect(agents[0].labels).toEqual([])
  })

  it('enforcement refuses an off-spec body (shape errors never reach the handler)', async () => {
    const userId = await seedUser()
    const agentId = await seedAgent(userId)
    // label_ids missing entirely — the spec requires it.
    const res = await app.inject({
      method: 'PUT', url: `/agents/${agentId}/labels`, ...auth(userId),
      payload: {},
    })
    expect(res.statusCode).toBe(400)
  })
})
