/**
 * Real-Postgres proof for migration 094 — agent organizations (#3164). No
 * mocks — #1219's rule.
 *
 * Pins the issue's acceptance criteria at the schema level: the tree is
 * per-user and self-referencing with multiple roots, sibling names are
 * unique per user on the LOWERCASED name (roots included), an organization
 * cannot be its own parent, deleting a folder promotes its agents one level
 * up through the service path (and the raw-SQL backstop demotes to the top
 * level), and `down()` drops exactly what `up()` created.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import db from '../../../db.js'
import {
  assertWorkerSchemaAtHead,
  describeDb,
  initDbHarness,
  resetDb,
  withMigrationReverted,
} from '../../../infra/__tests__/helpers/db-harness.js'
import { down, up, version } from '../094_agent_organizations.js'
import {
  ancestorIdsOf,
  createOrganization,
  ORGANIZATION_DEPTH_LIMIT,
  OrganizationTooDeepError,
} from '../../../infra/repositories/agent-organizations.js'

async function runUp(): Promise<void> {
  const client = await db.connect()
  try {
    await up(client)
  } finally {
    client.release()
  }
}

async function runDown(): Promise<void> {
  const client = await db.connect()
  try {
    await down(client)
  } finally {
    client.release()
  }
}

let seq = 0

async function seedUser(): Promise<string> {
  seq += 1
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`orgs-mig-${seq}-${Date.now()}@test.example`],
  )
  return rows[0].id
}

async function seedAgent(userId: string, organizationId: string | null = null): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name, delegate_address, status, organization_id)
     VALUES ($1, 'a', $2, 'active', $3) RETURNING id`,
    [userId, '0x' + 'ab'.repeat(20), organizationId],
  )
  return rows[0].id
}

async function insertOrg(userId: string, name: string, parentId: string | null = null): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO agent_organizations (user_id, parent_organization_id, name)
     VALUES ($1, $2, $3) RETURNING id`,
    [userId, parentId, name],
  )
  return rows[0].id
}

describeDb('migration 094_agent_organizations', () => {
  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
  })
  afterAll(async () => {
    await assertWorkerSchemaAtHead()
  })

  it('names itself', () => {
    expect(version).toBe('094_agent_organizations')
  })

  it('creates the table and the agents column; down() drops both', async () => {
    await runUp()
    const present = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_tables
       WHERE schemaname = current_schema()
         AND tablename IN ('agent_organizations')`,
    )
    expect(present.rows[0].count).toBe('1')
    const column = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'agents' AND column_name = 'organization_id'`,
    )
    expect(column.rows[0].count).toBe('1')
    await withMigrationReverted(
      () => runDown(),
      async () => {
        const gone = await db.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM pg_tables
           WHERE schemaname = current_schema()
             AND tablename IN ('agent_organizations')`,
        )
        expect(gone.rows[0].count).toBe('0')
        const columnGone = await db.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'agents' AND column_name = 'organization_id'`,
        )
        expect(columnGone.rows[0].count).toBe('0')
      },
      () => runUp(),
    )
  })

  it('is idempotent (IF NOT EXISTS re-run)', async () => {
    await runUp()
    await runUp()
  })

  it('allows multiple roots and deep chains', async () => {
    await runUp()
    const userId = await seedUser()
    const rootA = await insertOrg(userId, 'Company A')
    const rootB = await insertOrg(userId, 'Company B')
    const child = await insertOrg(userId, 'Tech Agents', rootA)
    const grandchild = await insertOrg(userId, 'DevOps', child)
    const greatGrandchild = await insertOrg(userId, 'CI runners', grandchild)
    const depth = await db.query<{ n: number }>(
      `WITH RECURSIVE chain AS (
         SELECT id, parent_organization_id, 1 AS d FROM agent_organizations WHERE id = $1
         UNION ALL
         SELECT o.id, o.parent_organization_id, c.d + 1
         FROM agent_organizations o JOIN chain c ON o.id = c.parent_organization_id
       ) SELECT max(d)::int AS n FROM chain`,
      [greatGrandchild],
    )
    expect(depth.rows[0].n).toBe(4)
    expect(rootA).toBeDefined()
    expect(rootB).toBeDefined()
  })

  // Round-3 review (S5): the self-FK's reverse lookups (the promote, the
  // subtree walk, the tree) need this index, and 094 is still unapplied on
  // dev — creating it with the table keeps it off the live-DDL path.
  it('indexes parent_organization_id (S5)', async () => {
    await runUp()
    const index = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_indexes
       WHERE schemaname = current_schema()
         AND tablename = 'agent_organizations'
         AND indexname = 'agent_organizations_parent_idx'`,
    )
    expect(index.rows[0].count).toBe('1')
  })

  // Round-3 review (NB1): the ancestor walk REFUSES past the cap (truncated
  // flag) instead of silently dropping the rest of the chain — a 67-level
  // chain used to let a root move under its deepest descendant.
  it('the ancestor walk reports truncation past the cap, not a partial chain', async () => {
    await runUp()
    const userId = await seedUser()
    let parentId: string | null = null
    let deepestId = ''
    let shallowId = ''
    let shallowParentId = ''
    for (let i = 0; i < 67; i += 1) {
      const { rows }: { rows: { id: string }[] } = await db.query(
        `INSERT INTO agent_organizations (user_id, parent_organization_id, name)
         VALUES ($1, $2, $3) RETURNING id`,
        [userId, parentId, `Level ${i}`],
      )
      // `parentId` still holds the PREVIOUS node here — the inserted row's parent.
      if (i === 62) {
        shallowId = rows[0].id
        shallowParentId = parentId as string
      }
      parentId = rows[0].id
      deepestId = rows[0].id
    }
    const truncated = await ancestorIdsOf(deepestId, userId)
    expect(truncated.truncated).toBe(true)
    // A node inside the cap is not truncated, and the ids are nearest-first:
    // Level 62 sits 62 edges deep with exactly 62 ancestors above it.
    const shallow = await ancestorIdsOf(shallowId, userId)
    expect(shallow.truncated).toBe(false)
    expect(shallow.ids).toHaveLength(62)
    expect(shallow.ids?.[0]).toBe(shallowParentId)
  })

  it('a create nesting past the depth limit is refused (OrganizationTooDeepError)', async () => {
    await runUp()
    const userId = await seedUser()
    let parentId: string | null = null
    for (let i = 0; i < ORGANIZATION_DEPTH_LIMIT; i += 1) {
      const { rows }: { rows: { id: string }[] } = await db.query(
        `INSERT INTO agent_organizations (user_id, parent_organization_id, name)
         VALUES ($1, $2, $3) RETURNING id`,
        [userId, parentId, `Level ${i}`],
      )
      parentId = rows[0].id
    }
    const deepParent = parentId as string
    await expect(
      createOrganization(userId, { name: 'One too deep', parent_organization_id: deepParent }),
    ).rejects.toBeInstanceOf(OrganizationTooDeepError)
    const count = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM agent_organizations WHERE user_id = $1`,
      [userId],
    )
    expect(count.rows[0].n).toBe(ORGANIZATION_DEPTH_LIMIT)
  })

  it('enforces one sibling name per user on the LOWERCASED name, roots included', async () => {
    await runUp()
    const userId = await seedUser()
    const parent = await insertOrg(userId, 'Company A')
    const root = await insertOrg(userId, 'Tech Agents', parent)
    expect(root).toBeDefined()
    // Same parent, case variant: 23505 on the unique index.
    await expect(insertOrg(userId, 'tech agents', parent)).rejects.toMatchObject({ code: '23505' })
    // Same NAME at the top level (a different parent slot) is allowed.
    await expect(insertOrg(userId, 'Tech Agents', null)).resolves.toBeDefined()
    // The same name under ANOTHER user is a different folder — per-user scope.
    const other = await seedUser()
    await expect(insertOrg(other, 'Tech Agents')).resolves.toBeDefined()
  })

  it('rejects blank names and a self parent', async () => {
    await runUp()
    const userId = await seedUser()
    await expect(insertOrg(userId, '   ')).rejects.toMatchObject({ code: '23514' })
    const org = await insertOrg(userId, 'Tech')
    await expect(
      db.query(`UPDATE agent_organizations SET parent_organization_id = id WHERE id = $1`, [org]),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('RESTRICTs deleting a folder that still has children (raw SQL)', async () => {
    await runUp()
    const userId = await seedUser()
    const root = await insertOrg(userId, 'Company A')
    await insertOrg(userId, 'Tech Agents', root)
    await expect(db.query(`DELETE FROM agent_organizations WHERE id = $1`, [root])).rejects.toMatchObject(
      { code: '23503' },
    )
  })

  it('raw-SQL delete of a membered folder SET NULLs its agents to the top level', async () => {
    await runUp()
    const userId = await seedUser()
    const root = await insertOrg(userId, 'Company A')
    const agentId = await seedAgent(userId, root)
    // No children — the RESTRICT does not fire; the agent FK demotes it.
    await db.query(`DELETE FROM agent_organizations WHERE id = $1`, [root])
    const agent = await db.query<{ organization_id: string | null }>(
      `SELECT organization_id FROM agents WHERE id = $1`,
      [agentId],
    )
    expect(agent.rows[0].organization_id).toBeNull()
    // The agent row itself is untouched.
    const agents = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agents WHERE user_id = $1`,
      [userId],
    )
    expect(agents.rows[0].count).toBe('1')
  })

  it('deleting a user removes their organizations (per-user scope)', async () => {
    await runUp()
    const userId = await seedUser()
    await insertOrg(userId, 'Company A')
    await db.query(`DELETE FROM users WHERE id = $1`, [userId])
    const orgs = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_organizations`,
    )
    expect(orgs.rows[0].count).toBe('0')
  })
})
