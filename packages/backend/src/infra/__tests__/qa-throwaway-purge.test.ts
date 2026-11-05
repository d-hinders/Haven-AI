/**
 * #4679 — the dev-only purge of throwaway QA identities.
 *
 * Two halves, both required by the issue:
 *
 *   - the pure guards (retention bounds, the URL tuple, the server identity)
 *     run without a database, because they must refuse BEFORE connecting;
 *   - the real-Postgres half proves the match, the deletion order, the
 *     per-user transaction and the `pg_constraint` guard against a migrated
 *     database, not against a mock.
 *
 * The standing QA identity is the case that matters most: its email
 * (`qa-delegation-<hex>@haven.test`) fits the throwaway email pattern, so an
 * email-only match would delete the user, agent and budget that `qa-dev.yml`
 * and the release gate depend on. It survives at any age.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import db from '../../db.js'
import { describeDb, initDbHarness, resetDb } from './helpers/db-harness.js'
import {
  DEFAULT_RETENTION_DAYS,
  KEPT_TABLES,
  PURGED_TABLES,
  PurgeRefusal,
  allowedTargetFromEnv,
  assertServerIdentity,
  assertUrlMatchesTarget,
  countCandidates,
  parseRetentionDays,
  renderSummary,
  runPurge,
  selectCandidates,
  type AllowedTarget,
} from '../repositories/qa-throwaway-purge.js'
import type { Executor } from '../transaction.js'

const DAY_MS = 24 * 60 * 60 * 1000

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY_MS)
}

// ── Pure guards ──────────────────────────────────────────────────────────────

describe('parseRetentionDays (#4679)', () => {
  it('accepts the bounds and the default', () => {
    expect(parseRetentionDays('1')).toBe(1)
    expect(parseRetentionDays('365')).toBe(365)
    expect(parseRetentionDays(String(DEFAULT_RETENTION_DAYS))).toBe(DEFAULT_RETENTION_DAYS)
    expect(parseRetentionDays(7)).toBe(7)
  })

  it('refuses 0 — there is no zero-day override', () => {
    expect(() => parseRetentionDays('0')).toThrow(PurgeRefusal)
    expect(() => parseRetentionDays(0)).toThrow(/between 1 and 365/)
  })

  it('refuses negative, malformed and out-of-range values', () => {
    for (const raw of ['-1', '-7', '1.5', 'abc', '7d', '366', '1000', '', '   ', undefined, null]) {
      expect(() => parseRetentionDays(raw as string | undefined), `raw=${String(raw)}`).toThrow(PurgeRefusal)
    }
  })
})

describe('assertUrlMatchesTarget (#4679)', () => {
  const target: AllowedTarget = {
    host: 'dev-db.internal',
    port: '5432',
    database: 'haven_dev',
    systemIdentifier: '7704626253794267170',
  }

  it('accepts the exact allowlisted tuple', () => {
    expect(() =>
      assertUrlMatchesTarget('postgres://u:p@dev-db.internal:5432/haven_dev', target),
    ).not.toThrow()
  })

  it('refuses the SAME host and port with the wrong database name', () => {
    // The spec-review finding: an endpoint is not a database.
    expect(() => assertUrlMatchesTarget('postgres://u:p@dev-db.internal:5432/railway', target)).toThrow(
      /database name railway is not the allowlisted haven_dev/,
    )
  })

  it('refuses a different host or port', () => {
    expect(() => assertUrlMatchesTarget('postgres://u:p@prod-db.internal:5432/haven_dev', target)).toThrow(/host/)
    expect(() => assertUrlMatchesTarget('postgres://u:p@dev-db.internal:6543/haven_dev', target)).toThrow(/port/)
  })

  it('does not match on a shared proxy suffix', () => {
    expect(() =>
      assertUrlMatchesTarget('postgres://u:p@dev-db.internal.proxy.rlwy.net:5432/haven_dev', target),
    ).toThrow(/host/)
  })

  it('refuses a URL that is not a URL', () => {
    expect(() => assertUrlMatchesTarget('not-a-url', target)).toThrow(PurgeRefusal)
  })
})

describe('assertServerIdentity (#4679)', () => {
  const target: AllowedTarget = {
    host: 'dev-db.internal',
    port: '5432',
    database: 'railway',
    systemIdentifier: '7704626253794267170',
  }

  function serverReporting(database: string, systemIdentifier: string): Executor {
    return {
      query: (async () => ({
        rows: [{ database, system_identifier: systemIdentifier }],
        rowCount: 1,
      })) as unknown as Executor['query'],
    }
  }

  it('accepts a server that agrees with the allowlisted tuple', async () => {
    await expect(
      assertServerIdentity(serverReporting('railway', '7704626253794267170'), target),
    ).resolves.toEqual({ database: 'railway', systemIdentifier: '7704626253794267170' })
  })

  it('refuses when the server reports a different database than the URL', async () => {
    await expect(assertServerIdentity(serverReporting('haven_dev', '7704626253794267170'), target)).rejects.toThrow(
      /server reports database haven_dev/,
    )
  })

  it('refuses when the server identity disagrees with the URL even though the name matches', async () => {
    // Both clusters are called `railway`; only the system identifier differs.
    await expect(assertServerIdentity(serverReporting('railway', '1234567890123456789'), target)).rejects.toThrow(
      /different cluster system identifier/,
    )
  })
})

describe('allowedTargetFromEnv (#4679)', () => {
  it('refuses when any part of the tuple is missing', () => {
    expect(() => allowedTargetFromEnv({})).toThrow(/QA_PURGE_ALLOWED_HOST/)
    expect(() =>
      allowedTargetFromEnv({
        QA_PURGE_ALLOWED_HOST: 'h',
        QA_PURGE_ALLOWED_PORT: '5432',
        QA_PURGE_ALLOWED_DATABASE: 'd',
      }),
    ).toThrow(/QA_PURGE_ALLOWED_SYSTEM_IDENTIFIER/)
  })

  it('reads the tuple from the environment', () => {
    expect(
      allowedTargetFromEnv({
        QA_PURGE_ALLOWED_HOST: 'h',
        QA_PURGE_ALLOWED_PORT: '5432',
        QA_PURGE_ALLOWED_DATABASE: 'd',
        QA_PURGE_ALLOWED_SYSTEM_IDENTIFIER: '42',
      }),
    ).toEqual({ host: 'h', port: '5432', database: 'd', systemIdentifier: '42' })
  })
})

// ── Real Postgres ────────────────────────────────────────────────────────────

let delegateCounter = 0
function nextDelegateAddress(): string {
  delegateCounter += 1
  return `0x${delegateCounter.toString(16).padStart(40, '0')}`
}

async function seedUser(email: string, name: string | null, ageDays: number): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO users (name, email, password_hash, created_at) VALUES ($1, $2, 'x', $3) RETURNING id`,
    [name, email, daysAgo(ageDays)],
  )
  return result.rows[0].id
}

async function seedAgent(userId: string, name = 'QA delegation agent'): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name, delegate_address, status) VALUES ($1, $2, $3, 'active') RETURNING id`,
    [userId, name, nextDelegateAddress()],
  )
  return result.rows[0].id
}

async function seedPaymentIntent(userId: string, agentId: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO payment_intents
       (agent_id, user_id, account_address, token_symbol, token_address, to_address,
        amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash, expires_at)
     VALUES ($1, $2, $3, 'USDC', $4, $5, '1000000', '1.00', $6, 1, $7, NOW() + interval '1 day')
     RETURNING id`,
    [
      agentId,
      userId,
      nextDelegateAddress(),
      nextDelegateAddress(),
      nextDelegateAddress(),
      nextDelegateAddress(),
      `0x${'b'.repeat(64)}`,
    ],
  )
  return result.rows[0].id
}

async function seedDelegation(agentId: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO agent_delegations
       (agent_id, chain_id, token_address, delegation_hash, delegation_json, version,
        budget_atomic, period_seconds, start_date, expires_at)
     VALUES ($1, 84532, $2, $3, '{}', 1, '1000000', 86400, 0, 9999999999)
     RETURNING id`,
    [agentId, nextDelegateAddress(), `0x${'c'.repeat(64)}`],
  )
  return result.rows[0].id
}

async function seedRekey(userId: string, agentId: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO agent_rekeys (agent_id, initiated_by_user_id, old_delegate_address, new_delegate_address)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [agentId, userId, nextDelegateAddress(), nextDelegateAddress()],
  )
  return result.rows[0].id
}

async function seedOrganization(userId: string, name: string, parentId: string | null = null): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO agent_organizations (user_id, parent_organization_id, name) VALUES ($1, $2, $3) RETURNING id`,
    [userId, parentId, name],
  )
  return result.rows[0].id
}

async function countUsers(): Promise<number> {
  const result = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM users')
  return Number(result.rows[0].count)
}

async function userExists(userId: string): Promise<boolean> {
  const result = await db.query<{ id: string }>('SELECT id FROM users WHERE id = $1', [userId])
  return result.rows.length > 0
}

describeDb('qa-throwaway-purge (#4679)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  it('deletes only old throwaways; the standing QA identity survives at any age', async () => {
    // The runbook's recipe: same email shape as a throwaway, name `QA Bot`.
    const standing = await seedUser('qa-delegation-ab12cd34@haven.test', 'QA Bot', 400)
    const ordinary = await seedUser('someone@example.com', 'Alice', 400)
    const youngThrowaway = await seedUser('qa-delegation-young1@haven.test', 'QA delegation (throwaway)', 1)
    const oldThrowaway = await seedUser('qa-delegation-old1@haven.test', 'QA delegation (throwaway)', 30)

    const dry = await runPurge(db, { retentionDays: 7, dryRun: true })
    expect(dry.candidates).toBe(1)
    expect(dry.purged.users).toBe(1)
    expect(dry.deletedUsers).toBe(0)
    expect(await countUsers()).toBe(4)

    const applied = await runPurge(db, { retentionDays: 7, dryRun: false })
    expect(applied.candidates).toBe(1)
    expect(applied.deletedUsers).toBe(1)
    expect(applied.failedUsers).toBe(0)
    expect(applied.purged.users).toBe(1)

    expect(await userExists(oldThrowaway)).toBe(false)
    expect(await userExists(standing)).toBe(true)
    expect(await userExists(ordinary)).toBe(true)
    expect(await userExists(youngThrowaway)).toBe(true)
  })

  it('deletes the whole graph in one transaction and keeps the SET NULL rows', async () => {
    const userId = await seedUser('qa-delegation-graph1@haven.test', 'QA delegation (throwaway)', 30)
    const agentId = await seedAgent(userId)
    const intentId = await seedPaymentIntent(userId, agentId)
    const delegationId = await seedDelegation(agentId)
    const rekeyId = await seedRekey(userId, agentId)
    // The NO ACTION reference that forces delegations to go before rekeys.
    await db.query('UPDATE agent_delegations SET rekey_id = $1 WHERE id = $2', [rekeyId, delegationId])

    const receipt = await db.query<{ id: string }>(
      `INSERT INTO machine_payment_receipts
         (rail, challenge_id, payment_intent_id, tx_hash, resource_url, recipient_address, amount_raw, chain_id)
       VALUES ('x402', 'challenge-4679', $1, $2, 'https://example.test/r', $3, '1000000', 84532)
       RETURNING id`,
      [intentId, `0x${'d'.repeat(64)}`, nextDelegateAddress()],
    )
    const delivery = await db.query<{ id: string }>(
      `INSERT INTO accounting_webhook_deliveries (provider, delivery_id, user_id)
       VALUES ('fortnox', 'delivery-4679', $1) RETURNING id`,
      [userId],
    )

    const result = await runPurge(db, { retentionDays: 7, dryRun: false })
    expect(result.failedUsers).toBe(0)
    expect(result.purged).toMatchObject({
      users: 1,
      agents: 1,
      payment_intents: 1,
      agent_delegations: 1,
      agent_rekeys: 1,
    })
    expect(result.kept).toEqual({ machine_payment_receipts: 1, accounting_webhook_deliveries: 1 })

    expect(await userExists(userId)).toBe(false)
    const agents = await db.query('SELECT id FROM agents WHERE id = $1', [agentId])
    expect(agents.rows).toHaveLength(0)
    const intents = await db.query('SELECT id FROM payment_intents WHERE id = $1', [intentId])
    expect(intents.rows).toHaveLength(0)

    // Kept on purpose: dev's accounting stays true.
    const keptReceipt = await db.query<{ payment_intent_id: string | null }>(
      'SELECT payment_intent_id FROM machine_payment_receipts WHERE id = $1',
      [receipt.rows[0].id],
    )
    expect(keptReceipt.rows).toHaveLength(1)
    expect(keptReceipt.rows[0].payment_intent_id).toBeNull()

    const keptDelivery = await db.query<{ user_id: string | null }>(
      'SELECT user_id FROM accounting_webhook_deliveries WHERE id = $1',
      [delivery.rows[0].id],
    )
    expect(keptDelivery.rows).toHaveLength(1)
    expect(keptDelivery.rows[0].user_id).toBeNull()
  })

  it('rolls a failed user back whole, continues, and reports the failure', async () => {
    // A's organization is the parent of B's, and B is not a throwaway, so the
    // RESTRICT reference makes A undeletable. A must stay whole; C must go.
    const failing = await seedUser('qa-delegation-fail1@haven.test', 'QA delegation (throwaway)', 30)
    const failingAgent = await seedAgent(failing)
    const failingOrg = await seedOrganization(failing, 'qa-org')
    const bystander = await seedUser('bystander@example.com', 'Bob', 30)
    await seedOrganization(bystander, 'bystander-org', failingOrg)
    const healthy = await seedUser('qa-delegation-ok1@haven.test', 'QA delegation (throwaway)', 30)

    const result = await runPurge(db, { retentionDays: 7, dryRun: false })

    expect(result.candidates).toBe(2)
    expect(result.deletedUsers).toBe(1)
    expect(result.failedUsers).toBe(1)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0].userId).toBe(failing)

    // The failed user is whole: user, agent and organization all still there.
    expect(await userExists(failing)).toBe(true)
    const agents = await db.query('SELECT id FROM agents WHERE id = $1', [failingAgent])
    expect(agents.rows).toHaveLength(1)
    const orgs = await db.query('SELECT id FROM agent_organizations WHERE user_id = $1', [failing])
    expect(orgs.rows).toHaveLength(1)

    expect(await userExists(healthy)).toBe(false)
    expect(await userExists(bystander)).toBe(true)
  })

  it('dry-run counts match what the apply run deletes', async () => {
    const userId = await seedUser('qa-delegation-counts@haven.test', 'QA delegation (throwaway)', 30)
    const agentId = await seedAgent(userId)
    await seedPaymentIntent(userId, agentId)
    await seedDelegation(agentId)
    await seedRekey(userId, agentId)
    await seedOrganization(userId, 'qa-org')

    const cutoff = daysAgo(7)
    const candidates = await selectCandidates(db, cutoff)
    expect(candidates).toHaveLength(1)

    const dry = await countCandidates(db, cutoff)
    const applied = await runPurge(db, { retentionDays: 7, dryRun: false })
    expect(applied.purged).toEqual(dry.purged)
    expect(applied.kept).toEqual(dry.kept)
    for (const table of PURGED_TABLES) expect(applied.purged[table]).toBeGreaterThan(0)
    for (const table of KEPT_TABLES) expect(dry.kept[table]).toBe(0)
  })

  it('pg_constraint: the restricting references to users and agents are exactly the handled set', async () => {
    const result = await db.query<{ child: string; attname: string; parent: string; delete_action: string }>(
      `SELECT c.conrelid::regclass::text AS child,
              a.attname AS attname,
              c.confrelid::regclass::text AS parent,
              c.confdeltype AS delete_action
       FROM pg_constraint c
       JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
       WHERE c.contype = 'f'
         AND c.confrelid IN ('users'::regclass, 'agents'::regclass)
         AND c.confdeltype IN ('a', 'r')
       ORDER BY child, attname`,
    )
    const found = result.rows.map((row) => `${row.child}.${row.attname} -> ${row.parent}`)
    expect(found).toEqual([
      'agent_rekeys.initiated_by_user_id -> users',
      'payment_intents.agent_id -> agents',
      'payment_intents.user_id -> users',
    ])
  })

  it('pg_constraint: the ordering constraints the purge depends on still exist', async () => {
    const result = await db.query<{ child: string; attname: string; parent: string }>(
      `SELECT c.conrelid::regclass::text AS child,
              a.attname AS attname,
              c.confrelid::regclass::text AS parent
       FROM pg_constraint c
       JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
       WHERE c.contype = 'f'
         AND c.confdeltype IN ('a', 'r')
         AND c.conrelid::regclass::text IN
             ('payment_intents', 'agent_delegations', 'agent_rekeys', 'agent_organizations', 'outbound_txs')
       ORDER BY child, attname`,
    )
    const found = result.rows.map((row) => `${row.child}.${row.attname} -> ${row.parent}`)
    expect(found).toEqual([
      'agent_delegations.rekey_id -> agent_rekeys',
      'agent_organizations.parent_organization_id -> agent_organizations',
      'agent_rekeys.initiated_by_user_id -> users',
      'outbound_txs.replaced_by -> outbound_txs',
      'payment_intents.agent_id -> agents',
      'payment_intents.sub_budget_id -> agent_sub_budgets',
      'payment_intents.task_budget_id -> agent_task_budgets',
      'payment_intents.user_id -> users',
    ])
  })

  it('the summary reports counts and never prints an email or an address', async () => {
    await seedUser('qa-delegation-summary@haven.test', 'QA delegation (throwaway)', 30)
    const result = await runPurge(db, { retentionDays: 7, dryRun: true })
    const summary = renderSummary(result)
    expect(summary).toContain('DRY RUN')
    expect(summary).toContain('| users | 1 |')
    expect(summary).not.toMatch(/@haven\.test/)
    expect(summary).not.toMatch(/0x[0-9a-fA-F]{6,}/)
  })
})
