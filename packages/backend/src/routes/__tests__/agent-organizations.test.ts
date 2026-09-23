/**
 * Real-Postgres route tests for the organization surface (#3164). No mocks —
 * the claims are about what the SQL returns and which caller a refusal names,
 * the posture `labels.test.ts` set for this route generation.
 *
 *  - the tree CRUD: create (root and nested, 409 on a sibling collision),
 *    list (flat rows with parent ids + direct member counts), rename, move
 *    (into own subtree refused with 400, foreign parent 404), delete
 *    (contents promoted one level up — agents never orphaned);
 *  - agent filing: PUT /agents/:id with organization_id (null clears, a
 *    foreign id is a 404 and writes nothing), and organization_id riding on
 *    the agent reads;
 *  - every 200 matches the spec (#1444 response-shape);
 *  - the request-validation plugin runs ENFORCED for the new module, so a
 *    spec/route mismatch on a legitimate request fails here, not on dev.
 *
 * Organizations are DISPLAY/CATEGORIZATION ONLY; these tests keep them that
 * way by never touching a delegation, budget, or enforcement surface — and
 * the delete-promotion assertions double as the issue's "org membership has
 * zero effect on spending power" proof: the agent row's status, allowances
 * and delegations are untouched by every org write here.
 */
import Fastify, { FastifyError, FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import db from '../../db.js'
import { assertWorkerSchemaAtHead, describeDb, initDbHarness, resetDb } from '../../infra/__tests__/helpers/db-harness.js'
import { expectMatchesSpec } from '../../openapi/response-shape.js'
import agentRoutes from '../agents.js'
import agentOrganizationRoutes from '../agent-organizations.js'
import { installRequestValidation } from '../../openapi/request-validation.js'
import {
  deleteOrganizationPromoting,
  OrganizationNotDeletedError,
  updateOrganization,
} from '../../infra/repositories/agent-organizations.js'

let seq = 0

async function seedUser(): Promise<string> {
  seq += 1
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`orgs-route-${seq}-${Date.now()}@test.example`],
  )
  return rows[0].id
}

async function seedAgent(userId: string): Promise<string> {
  // The single-record read (#2413) joins smart_accounts and keeps only
  // delegation-rail agents, so the fixture links one — same shape the
  // labels suite seeds. The address varies per call: (user_id,
  // account_address, chain_id) is UNIQUE on smart_accounts.
  seq += 1
  const account = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type)
     VALUES ($1, $2, 8453, 'delegation', 'delegator_hybrid') RETURNING id`,
    [userId, ('0x' + 'ef'.repeat(19)) + seq.toString(16).padStart(2, '0')],
  )
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name, delegate_address, status, account_id)
     VALUES ($1, 'Filed agent', $2, 'active', $3) RETURNING id`,
    // delegate_address is VARCHAR(42) — a 20-byte hex address + '0x' exactly;
    // unique among the user's non-revoked agents, so it varies per call too.
    [userId, ('0x' + 'cd'.repeat(19)) + seq.toString(16).padStart(2, '0'), account.rows[0].id],
  )
  return rows[0].id
}

describeDb('organization routes (#3164)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    await initDbHarness()
    app = Fastify({ logger: false })
    app.setErrorHandler((error: FastifyError, _request, reply) => {
      void reply.status(error.statusCode ?? 500).send({ error: error.message })
    })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    // Born ENFORCED in `src/index.ts` (#3028 rollout); the suite runs every
    // case under enforcement. agents.ts is enforced since slice 2 —
    // registration here covers the PUT /agents/:id org-move cases.
    installRequestValidation(app, {
      mode: 'off',
      enforcedModules: ['routes/agents.ts', 'routes/agent-organizations.ts'],
    })
    await app.register(agentRoutes, { prefix: '/agents' })
    await app.register(agentOrganizationRoutes, { prefix: '/organizations' })
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
    // `email` is part of the JWT payload's declared type (labels.test.ts
    // signs the same pair) — the middleware reads only `sub`.
    const token = app.jwt.sign({ sub: userId, email: 'orgs@test.example' })
    return { headers: { authorization: `Bearer ${token}` } }
  }

  async function createOrg(
    userId: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await app.inject({ method: 'POST', url: '/organizations', ...auth(userId), payload: body })
    return { status: res.statusCode, body: res.json() as Record<string, unknown> }
  }

  // ── Tree CRUD ─────────────────────────────────────────────────────────────

  it('creates a root organization and lists it', async () => {
    const userId = await seedUser()
    const created = await createOrg(userId, { name: 'Company A' })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ name: 'Company A', parent_organization_id: null, agent_count: 0 })

    const list = await app.inject({ method: 'GET', url: '/organizations', ...auth(userId) })
    expect(list.statusCode).toBe(200)
    const orgs = (list.json() as { organizations: Record<string, unknown>[] }).organizations
    expect(orgs).toHaveLength(1)
    expect(orgs[0]).toMatchObject({ name: 'Company A', agent_count: 0 })
    expectMatchesSpec('GET', '/organizations', list.json())
  })

  it('creates a nested organization under an owned parent', async () => {
    const userId = await seedUser()
    const root = await createOrg(userId, { name: 'Company A' })
    const child = await createOrg(userId, {
      name: 'Tech Agents',
      parent_organization_id: root.body.id,
    })
    expect(child.status).toBe(201)
    expect(child.body.parent_organization_id).toBe(root.body.id)
  })

  it('refuses a foreign parent with 404 and a sibling collision with 409', async () => {
    const userId = await seedUser()
    const other = await seedUser()
    const foreignRoot = await createOrg(other, { name: 'Not mine' })

    const noParent = await createOrg(userId, {
      name: 'X',
      parent_organization_id: foreignRoot.body.id,
    })
    expect(noParent.status).toBe(404)

    await createOrg(userId, { name: 'Tech Agents' })
    // Case variant of a sibling name is the same name (the lower(name) index).
    const collide = await createOrg(userId, { name: 'tech agents' })
    expect(collide.status).toBe(409)
    // The same name under a DIFFERENT parent is fine.
    const root = await createOrg(userId, { name: 'Company B' })
    const nested = await createOrg(userId, { name: 'Tech Agents', parent_organization_id: root.body.id })
    expect(nested.status).toBe(201)
  })

  it('refuses blank and over-long names with 400', async () => {
    const userId = await seedUser()
    const blank = await createOrg(userId, { name: '   ' })
    expect(blank.status).toBe(400)
    const long = await createOrg(userId, { name: 'x'.repeat(65) })
    expect(long.status).toBe(400)
  })

  it('renames; a colliding rename is a 409; a foreign id is a 404', async () => {
    const userId = await seedUser()
    const a = await createOrg(userId, { name: 'prod' })
    const b = await createOrg(userId, { name: 'staging' })
    const aId = a.body.id as string
    const bId = b.body.id as string

    const ok = await app.inject({
      method: 'PUT', url: `/organizations/${bId}`, ...auth(userId),
      payload: { name: 'Staging 2' },
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ name: 'Staging 2' })
    expectMatchesSpec('PUT', '/organizations/{id}', ok.json())

    const collide = await app.inject({
      method: 'PUT', url: `/organizations/${bId}`, ...auth(userId),
      payload: { name: 'PROD' },
    })
    expect(collide.statusCode).toBe(409)

    const other = await seedUser()
    const foreign = await app.inject({
      method: 'PUT', url: `/organizations/${aId}`, ...auth(other), payload: { name: 'x' },
    })
    expect(foreign.statusCode).toBe(404)
  })

  it('moves a folder; moving into its own subtree is a 400; moving to the top level is null', async () => {
    const userId = await seedUser()
    const root = await createOrg(userId, { name: 'Company A' })
    const child = await createOrg(userId, { name: 'Tech Agents', parent_organization_id: root.body.id })
    const grandchild = await createOrg(userId, {
      name: 'DevOps',
      parent_organization_id: child.body.id,
    })
    const rootId = root.body.id as string
    const childId = child.body.id as string
    const grandchildId = grandchild.body.id as string

    // A move under the folder's own DESCENDANT would make it its own ancestor.
    const intoOwnSubtree = await app.inject({
      method: 'PUT', url: `/organizations/${rootId}`, ...auth(userId),
      payload: { parent_organization_id: grandchildId },
    })
    expect(intoOwnSubtree.statusCode).toBe(400)

    // Self-parenting is refused by the route (and the schema's CHECK).
    const selfParent = await app.inject({
      method: 'PUT', url: `/organizations/${rootId}`, ...auth(userId),
      payload: { parent_organization_id: rootId },
    })
    expect(selfParent.statusCode).toBe(400)

    // A legitimate move: DevOps under a new sibling of its old parent.
    const rootB = await createOrg(userId, { name: 'Company B' })
    const move = await app.inject({
      method: 'PUT', url: `/organizations/${childId}`, ...auth(userId),
      payload: { parent_organization_id: rootB.body.id },
    })
    expect(move.statusCode).toBe(200)
    expect(move.json().parent_organization_id).toBe(rootB.body.id)
    // Grandchild rode along — it points at its (moved) parent, depth intact.
    const stillNested = await db.query<{ parent_organization_id: string }>(
      `SELECT parent_organization_id FROM agent_organizations WHERE id = $1`,
      [grandchildId],
    )
    expect(stillNested.rows[0].parent_organization_id).toBe(childId)

    // Back to the top level: the key present with null moves; absent keeps.
    const toTop = await app.inject({
      method: 'PUT', url: `/organizations/${childId}`, ...auth(userId),
      payload: { parent_organization_id: null },
    })
    expect(toTop.statusCode).toBe(200)
    expect(toTop.json().parent_organization_id).toBeNull()
  })

  it('deleting a folder promotes sub-organizations and agents one level up', async () => {
    const userId = await seedUser()
    const root = await createOrg(userId, { name: 'Company A' })
    const child = await createOrg(userId, { name: 'Tech Agents', parent_organization_id: root.body.id })
    const grandchild = await createOrg(userId, {
      name: 'DevOps',
      parent_organization_id: child.body.id,
    })
    const rootId = root.body.id as string
    const childId = child.body.id as string
    const grandchildId = grandchild.body.id as string

    // File two agents under the doomed child.
    const agentA = await seedAgent(userId)
    const agentB = await seedAgent(userId)
    for (const agentId of [agentA, agentB]) {
      const put = await app.inject({
        method: 'PUT', url: `/agents/${agentId}`, ...auth(userId),
        payload: { organization_id: childId },
      })
      expect(put.statusCode).toBe(200)
    }

    // Delete the CHILD: agents and grandchild move up to the ROOT.
    const del = await app.inject({ method: 'DELETE', url: `/organizations/${childId}`, ...auth(userId) })
    expect(del.statusCode).toBe(200)
    expectMatchesSpec('DELETE', '/organizations/{id}', del.json())
    expect(del.json().ok).toBe(true)

    const movedAgent = await db.query<{ organization_id: string | null }>(
      `SELECT organization_id FROM agents WHERE id = $1`,
      [agentA],
    )
    expect(movedAgent.rows[0].organization_id).toBe(rootId)
    const movedOrg = await db.query<{ parent_organization_id: string | null }>(
      `SELECT parent_organization_id FROM agent_organizations WHERE id = $1`,
      [grandchildId],
    )
    expect(movedOrg.rows[0].parent_organization_id).toBe(rootId)

    // The agent itself is untouched beyond placement: same name, active.
    const agent = await db.query<{ name: string; status: string }>(
      `SELECT name, status FROM agents WHERE id = $1`,
      [agentA],
    )
    expect(agent.rows[0]).toMatchObject({ name: 'Filed agent', status: 'active' })
    expect(agentB).toBeDefined()

    // Deleting the ROOT promotes its contents to the TOP LEVEL (null).
    const delRoot = await app.inject({ method: 'DELETE', url: `/organizations/${rootId}`, ...auth(userId) })
    expect(delRoot.statusCode).toBe(200)
    const topAgent = await db.query<{ organization_id: string | null }>(
      `SELECT organization_id FROM agents WHERE id = $1`,
      [agentA],
    )
    expect(topAgent.rows[0].organization_id).toBeNull()
    const topOrg = await db.query<{ parent_organization_id: string | null }>(
      `SELECT parent_organization_id FROM agent_organizations WHERE id = $1`,
      [grandchildId],
    )
    expect(topOrg.rows[0].parent_organization_id).toBeNull()
  })

  it('deleting a foreign or unknown organization is a 404 that writes nothing', async () => {
    const owner = await seedUser()
    const other = await seedUser()
    const root = await createOrg(owner, { name: 'Company A' })
    const foreign = await createOrg(other, { name: 'Not mine' })

    const delForeign = await app.inject({
      method: 'DELETE', url: `/organizations/${foreign.body.id as string}`, ...auth(owner),
    })
    expect(delForeign.statusCode).toBe(404)

    const delUnknown = await app.inject({
      method: 'DELETE', url: `/organizations/00000000-0000-0000-0000-000000000000`, ...auth(owner),
    })
    expect(delUnknown.statusCode).toBe(404)

    // Owner's folder is untouched.
    const still = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_organizations WHERE user_id = $1`,
      [owner],
    )
    expect(still.rows[0].count).toBe('1')
    expect(root).toBeDefined()
  })

  // ── Cycle / depth integrity (round-3 review, NB1 + S1 + S2) ───────────────

  it('moving a folder under another user\'s folder is a 404 that writes nothing (S2)', async () => {
    const owner = await seedUser()
    const other = await seedUser()
    const mine = await createOrg(owner, { name: 'Mine' })
    const foreign = await createOrg(other, { name: 'Not mine' })

    const res = await app.inject({
      method: 'PUT', url: `/organizations/${mine.body.id as string}`, ...auth(owner),
      payload: { parent_organization_id: foreign.body.id as string },
    })
    expect(res.statusCode).toBe(404)
    const row = await db.query<{ parent_organization_id: string | null }>(
      `SELECT parent_organization_id FROM agent_organizations WHERE id = $1`,
      [mine.body.id],
    )
    expect(row.rows[0].parent_organization_id).toBeNull()
  })

  it('the repository itself refuses a foreign parent: null, nothing written, the owner can still delete theirs (N2)', async () => {
    // Behind the route's pre-check: calling the repository directly with a
    // foreign target used to run the UPDATE anyway and store the other
    // user's folder as the parent, after which their own DELETE answered 500.
    const owner = await seedUser()
    const other = await seedUser()
    const mine = (await createOrg(owner, { name: 'Mine' })).body.id as string
    const foreign = (await createOrg(other, { name: 'Theirs' })).body.id as string

    expect(await updateOrganization(mine, owner, { parent_organization_id: foreign })).toBeNull()
    const row = await db.query<{ parent_organization_id: string | null }>(
      `SELECT parent_organization_id FROM agent_organizations WHERE id = $1`,
      [mine],
    )
    expect(row.rows[0].parent_organization_id).toBeNull()

    const del = await app.inject({ method: 'DELETE', url: `/organizations/${foreign}`, ...auth(other) })
    expect(del.statusCode).toBe(200)
  })

  it('serializes two crossing moves — no cycle is stored in 40 trials (NB1 race)', async () => {
    // The codeowner's probe: A under B and B under A, fired in parallel,
    // stored an A<->B cycle in 39/40 trials when the walk and the write ran
    // as separate pool queries. Under the per-user advisory lock the loser
    // of the interleave sees the winner's committed parent and refuses.
    //
    // 40 trials, calling the repository directly on the pool: one pair of
    // HTTP injects inside the whole suite never interleaved, so a single
    // trial passed with the lock deleted (13/13) — a guard that could not
    // fail (#3222 re-review N1). Each trial resets the pair to the top level.
    const userId = await seedUser()
    const a = await createOrg(userId, { name: 'A' })
    const b = await createOrg(userId, { name: 'B' })
    const aId = a.body.id as string
    const bId = b.body.id as string

    let cycles = 0
    const outcomes = new Map<string, number>()
    for (let trial = 0; trial < 40; trial += 1) {
      await db.query(`UPDATE agent_organizations SET parent_organization_id = NULL WHERE id = ANY($1::uuid[])`, [[aId, bId]])
      const settled = await Promise.allSettled([
        updateOrganization(aId, userId, { parent_organization_id: bId }),
        updateOrganization(bId, userId, { parent_organization_id: aId }),
      ])
      const { rows } = await db.query<{ id: string; parent_organization_id: string | null }>(
        `SELECT id, parent_organization_id FROM agent_organizations WHERE id = ANY($1::uuid[])`,
        [[aId, bId]],
      )
      const parent = new Map(rows.map((r) => [r.id, r.parent_organization_id]))
      if (parent.get(aId) === bId && parent.get(bId) === aId) cycles += 1
      const key = settled
        .map((r) => (r.status === 'fulfilled' ? 'ok' : (r.reason as Error).constructor.name))
        .sort()
        .join('+')
      outcomes.set(key, (outcomes.get(key) ?? 0) + 1)
    }
    expect(cycles).toBe(0)
    // Every trial: exactly one move wins, the other is refused as a cycle.
    expect([...outcomes.keys()]).toEqual(['OrganizationCycleError+ok'])
  }, 30_000)

  it('DELETE on a member of a stored (pre-existing) cycle answers 200, not 500 (NB1)', async () => {
    const userId = await seedUser()
    const a = await createOrg(userId, { name: 'A' })
    const b = await createOrg(userId, { name: 'B' })
    const aId = a.body.id as string
    const bId = b.body.id as string
    // A LEGACY cycle, stored by an older build (the write path can no
    // longer produce one): the schema's self-parent CHECK only refuses the
    // one-row shape, so the two-row shape is expressible by hand.
    await db.query(`UPDATE agent_organizations SET parent_organization_id = $2 WHERE id = $1`, [aId, bId])
    await db.query(`UPDATE agent_organizations SET parent_organization_id = $2 WHERE id = $1`, [bId, aId])

    // A->B->A: deleting A would promote B to A's parent (itself) — the old
    // shape tripped agent_organizations_no_self_parent and answered 500.
    // The delete must succeed cleanly and break the cycle; B lands at the
    // top level.
    const del = await app.inject({ method: 'DELETE', url: `/organizations/${aId}`, ...auth(userId) })
    expect(del.statusCode).toBe(200)
    const bParent = await db.query<{ parent_organization_id: string | null }>(
      `SELECT parent_organization_id FROM agent_organizations WHERE id = $1`,
      [bId],
    )
    expect(bParent.rows[0].parent_organization_id).toBeNull()
  })

  it('refuses a move under a target whose chain exceeds the depth cap (NB1, no silent truncation)', async () => {
    const userId = await seedUser()
    // A chain longer than the walk's cap, built directly (the routes now
    // refuse depth > 64 one request at a time — same guard the migration
    // tests exercise below).
    const depth = 67
    let parentId: string | null = null
    let deepestId = ''
    for (let i = 0; i < depth; i += 1) {
      const { rows }: { rows: { id: string }[] } = await db.query<{ id: string }>(
        `INSERT INTO agent_organizations (user_id, parent_organization_id, name)
         VALUES ($1, $2, $3) RETURNING id`,
        [userId, parentId, `Level ${i}`],
      )
      parentId = rows[0].id
      deepestId = rows[0].id
    }
    const mover = await createOrg(userId, { name: 'Mover' })
    // The deepest node's ancestor chain is 67 long — past the cap. Moving
    // ANY folder under it used to decide on a silently-truncated chain.
    const res = await app.inject({
      method: 'PUT', url: `/organizations/${mover.body.id as string}`, ...auth(userId),
      payload: { parent_organization_id: deepestId },
    })
    expect(res.statusCode).toBe(400)
    const row = await db.query<{ parent_organization_id: string | null }>(
      `SELECT parent_organization_id FROM agent_organizations WHERE id = $1`,
      [mover.body.id],
    )
    expect(row.rows[0].parent_organization_id).toBeNull()
  })

  it('a foreign user\'s failed delete promotes nothing and rolls back (S1)', async () => {
    const owner = await seedUser()
    const intruder = await seedUser()
    const victimAgent = await seedAgent(owner)
    const victimFolder = await createOrg(owner, { name: 'Victim folder' })
    const victimId = victimFolder.body.id as string
    const file = await app.inject({
      method: 'PUT', url: `/agents/${victimAgent}`, ...auth(owner),
      payload: { organization_id: victimId },
    })
    expect(file.statusCode).toBe(200)

    // The intruder walks in with an ownership check first (the route's own
    // 404 gate) — the probe ran the REPOSITORY call with a foreign id, so
    // this proves the repository itself refuses, not just the route.
    await expect(deleteOrganizationPromoting(victimId, intruder)).rejects.toBeInstanceOf(
      OrganizationNotDeletedError,
    )

    // Nothing was promoted, nothing was deleted.
    const agentRow = await db.query<{ organization_id: string | null }>(
      `SELECT organization_id FROM agents WHERE id = $1`,
      [victimAgent],
    )
    expect(agentRow.rows[0].organization_id).toBe(victimId)
    const folders = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_organizations WHERE id = $1`,
      [victimId],
    )
    expect(folders.rows[0].count).toBe('1')
  })

  // ── Agent filing ──────────────────────────────────────────────────────────

  it('files an agent under an organization; the agent reads carry organization_id', async () => {
    const userId = await seedUser()
    const agentId = await seedAgent(userId)
    const root = await createOrg(userId, { name: 'Company A' })
    const child = await createOrg(userId, { name: 'Tech Agents', parent_organization_id: root.body.id })

    const put = await app.inject({
      method: 'PUT', url: `/agents/${agentId}`, ...auth(userId),
      payload: { organization_id: child.body.id },
    })
    expect(put.statusCode).toBe(200)
    expect(put.json().organization_id).toBe(child.body.id)
    expectMatchesSpec('PUT', '/agents/{id}', put.json())

    const list = await app.inject({ method: 'GET', url: '/agents', ...auth(userId) })
    expect(list.statusCode).toBe(200)
    const agents = (list.json() as { agents: { id: string; organization_id: string | null }[] }).agents
    expect(agents.find((a) => a.id === agentId)?.organization_id).toBe(child.body.id)
    expectMatchesSpec('GET', '/agents', list.json())

    // The folder's direct count reflects the filing.
    const orgList = await app.inject({ method: 'GET', url: '/organizations', ...auth(userId) })
    const orgs = (orgList.json() as { organizations: { id: string; agent_count: number }[] }).organizations
    expect(orgs.find((o) => o.id === child.body.id)?.agent_count).toBe(1)
    expect(orgs.find((o) => o.id === root.body.id)?.agent_count).toBe(0)
  })

  it('an organization_id of null returns the agent to the top level; absent keeps it', async () => {
    const userId = await seedUser()
    const agentId = await seedAgent(userId)
    const root = await createOrg(userId, { name: 'Company A' })

    const file = await app.inject({
      method: 'PUT', url: `/agents/${agentId}`, ...auth(userId),
      payload: { organization_id: root.body.id },
    })
    expect(file.statusCode).toBe(200)
    expect(file.json().organization_id).toBe(root.body.id)

    // Absent key: placement kept, name-only edit.
    const rename = await app.inject({
      method: 'PUT', url: `/agents/${agentId}`, ...auth(userId),
      payload: { name: 'Renamed in place' },
    })
    expect(rename.statusCode).toBe(200)
    expect(rename.json().organization_id).toBe(root.body.id)
    expect(rename.json().name).toBe('Renamed in place')

    // Explicit null: back to the top level.
    const clear = await app.inject({
      method: 'PUT', url: `/agents/${agentId}`, ...auth(userId),
      payload: { organization_id: null },
    })
    expect(clear.statusCode).toBe(200)
    expect(clear.json().organization_id).toBeNull()
  })

  it('a foreign or unknown organization id on the agent is a 404 and files nothing', async () => {
    const owner = await seedUser()
    const other = await seedUser()
    const agentId = await seedAgent(owner)
    const foreign = await createOrg(other, { name: 'Not mine' })

    const res = await app.inject({
      method: 'PUT', url: `/agents/${agentId}`, ...auth(owner),
      payload: { organization_id: foreign.body.id as string },
    })
    expect(res.statusCode).toBe(404)

    const agent = await db.query<{ organization_id: string | null }>(
      `SELECT organization_id FROM agents WHERE id = $1`,
      [agentId],
    )
    expect(agent.rows[0].organization_id).toBeNull()
  })

  it('another user cannot file MY agent into their organization', async () => {
    const owner = await seedUser()
    const intruder = await seedUser()
    const agentId = await seedAgent(owner)
    const org = await createOrg(intruder, { name: 'Theirs' })

    const res = await app.inject({
      method: 'PUT', url: `/agents/${agentId}`, ...auth(intruder),
      payload: { organization_id: org.body.id as string },
    })
    expect(res.statusCode).toBe(404)
  })

  it('enforcement refuses an off-spec organization body (shape errors never reach the handler)', async () => {
    const userId = await seedUser()
    // `name` required — its absence is a 400 under enforcement. (A wrong
    // scalar type, e.g. `name: 42`, is COERCED to a string by the plugin's
    // ajv configuration, so it is not a refusal case.)
    const missing = await app.inject({
      method: 'POST', url: '/organizations', ...auth(userId),
      payload: {},
    })
    expect(missing.statusCode).toBe(400)
    // additionalProperties: false — an unknown key is refused, no coercion.
    const extra = await app.inject({
      method: 'POST', url: '/organizations', ...auth(userId),
      payload: { name: 'x', color: 'brand' },
    })
    expect(extra.statusCode).toBe(400)
  })
})
