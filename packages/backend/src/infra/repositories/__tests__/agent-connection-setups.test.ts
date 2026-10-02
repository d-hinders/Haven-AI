/**
 * Real-DB tests for the agent-connection-setups repository (#1225, epic
 * #1219). Onboarding's data layer: the `FOR UPDATE OF s` row lock that
 * serialises concurrent register/cancel/approve, the setup+allowances write
 * that must be one unit, and the guarded state machine around cancel.
 * On the #1220 harness; zero mocks.
 */
import { randomUUID } from 'node:crypto'
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { archiveAgent, revokeAgent, updateAgentProfile } from '../agents.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import {
  ACTIVATE_AGENT_SQL,
  applyApprovalState,
  cancelSetup,
  findSetupByTokenHash,
  findSetupForUser,
  insertPendingAgent,
  insertSetupWithAllowances,
  inTransaction,
  listSetupAllowances,
  lockSetupByTokenHash,
  markSetupRegistered,
  mergeInstallStatus,
  revokePendingAgent,
  type NewSetup,
} from '../agent-connection-setups.js'

let seq = 0
const ADDR = (n: string) => `0x${n.repeat(40).slice(0, 40)}`

async function seedUserAndSafe(): Promise<{ userId: string; accountId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`acs-${++seq}-${Date.now()}@test.example`],
  )
  const safe = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, name, chain_id)
     VALUES ($1, $2, 'Main account', 84532) RETURNING id`,
    [user.rows[0].id, ADDR(String(seq % 10))],
  )
  return { userId: user.rows[0].id, accountId: safe.rows[0].id }
}

function newSetup(userId: string, accountId: string, overrides: Partial<NewSetup> = {}): NewSetup {
  return {
    id: randomUUID(),
    userId,
    accountId,
    name: 'Connect setup',
    description: null,
    runtime: null,
    setupTokenHash: `hash-${++seq}-${Date.now()}`,
    setupTokenPrefix: 'hvn_setup_ab',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    challengeId: randomUUID(),
    challengeMessage: 'sign me',
    issuePassport: false,
    source: null,
    via: null,
    ...overrides,
  }
}

const USDC_ALLOWANCE = {
  token_address: ADDR('0e'),
  token_symbol: 'USDC',
  allowance_amount: '25000000',
  reset_period_min: 1440,
}

describeDb('agent-connection-setups repository (#1225)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  // ── The one-unit write ─────────────────────────────────────────────────

  it('insertSetupWithAllowances commits setup + allowances together', async () => {
    const { userId, accountId } = await seedUserAndSafe()
    const setup = newSetup(userId, accountId)
    // Distinct token addresses — (setup_id, token_address) is unique.
    await insertSetupWithAllowances(setup, [
      USDC_ALLOWANCE,
      { ...USDC_ALLOWANCE, token_address: ADDR('1f'), token_symbol: 'EURe' },
    ])

    const row = await findSetupForUser(setup.id, userId)
    expect(row).not.toBeNull()
    expect(row!.status).toBe('awaiting_connection')
    expect(row!.account_chain_id).toBe(84532) // the smart_accounts join carries the wallet
    expect(await listSetupAllowances(setup.id)).toHaveLength(2)
  })

  it('persists the discovery source at insert and returns it on every wide read (#2302)', async () => {
    const { userId, accountId } = await seedUserAndSafe()
    const tagged = newSetup(userId, accountId, { source: '402-page' })
    await insertSetupWithAllowances(tagged, [USDC_ALLOWANCE])
    const taggedRow = await findSetupForUser(tagged.id, userId)
    expect(taggedRow!.source).toBe('402-page')
    // The register path reads by token hash — the source must survive that
    // projection too, since it is echoed into the agent_created funnel event.
    const byToken = await findSetupByTokenHash(tagged.setupTokenHash)
    expect(byToken!.source).toBe('402-page')

    // Absent source is the normal (organic) case and stores as NULL.
    const untagged = newSetup(userId, accountId)
    await insertSetupWithAllowances(untagged, [USDC_ALLOWANCE])
    expect((await findSetupForUser(untagged.id, userId))!.source).toBeNull()
  })

  it('a failing allowance write rolls back the SETUP row too — no half-approved agent', async () => {
    const { userId, accountId } = await seedUserAndSafe()
    const setup = newSetup(userId, accountId)

    await expect(
      insertSetupWithAllowances(setup, [
        USDC_ALLOWANCE,
        // NOT NULL violation on the SECOND allowance — after the setup row
        // and the first allowance are already written inside the tx.
        { ...USDC_ALLOWANCE, token_symbol: null as unknown as string },
      ]),
    ).rejects.toMatchObject({ code: '23502' })

    expect(await findSetupForUser(setup.id, userId)).toBeNull()
    expect(await listSetupAllowances(setup.id)).toHaveLength(0)
  })

  it('the setup token hash is unique — a duplicate insert violates, not overwrites', async () => {
    const { userId, accountId } = await seedUserAndSafe()
    const first = newSetup(userId, accountId, { setupTokenHash: 'hash-dup' })
    await insertSetupWithAllowances(first, [])

    await expect(
      insertSetupWithAllowances(newSetup(userId, accountId, { setupTokenHash: 'hash-dup' }), []),
    ).rejects.toMatchObject({ code: '23505' })
  })

  // ── FOR UPDATE OF s: the serialisation the epic names ──────────────────

  it('lockSetupByTokenHash SERIALISES two concurrent transactions — the second sees the first commit', async () => {
    const { userId, accountId } = await seedUserAndSafe()
    const setup = newSetup(userId, accountId)
    await insertSetupWithAllowances(setup, [])
    const events: string[] = []

    const tx1 = inTransaction(async (tx) => {
      await lockSetupByTokenHash(setup.setupTokenHash, tx)
      events.push('tx1:locked')
      await new Promise((r) => setTimeout(r, 250)) // hold the lock
      await tx.query(`UPDATE agent_connection_setups SET status = 'cancelled' WHERE id = $1`, [
        setup.id,
      ])
      events.push('tx1:committing')
    })
    // Wait until tx1 actually HOLDS the lock before starting tx2 — a fixed
    // head start is a race against pool-connect latency (review of #1234:
    // if tx1's connect+lock ever took longer than the sleep, tx2 would win
    // the lock and the test would fail for scheduling reasons, not product
    // reasons). Event-based, this cannot mis-order.
    while (!events.includes('tx1:locked')) {
      await new Promise((r) => setTimeout(r, 5))
    }
    const tx2 = inTransaction(async (tx) => {
      events.push('tx2:waiting')
      const locked = await lockSetupByTokenHash(setup.setupTokenHash, tx)
      events.push('tx2:locked')
      return locked!.status
    })

    const [, tx2Status] = await Promise.all([tx1, tx2])
    // tx2's lock could not resolve until tx1 committed, so its read is of
    // the POST-commit row — the exact property FOR UPDATE exists to give
    // the register/cancel race.
    expect(tx2Status).toBe('cancelled')
    expect(events).toEqual(['tx1:locked', 'tx2:waiting', 'tx1:committing', 'tx2:locked'])
  })

  // ── Register consumes the token ────────────────────────────────────────

  it('markSetupRegistered links the agent, consumes the token, and stamps install state', async () => {
    const { userId, accountId } = await seedUserAndSafe()
    const setup = newSetup(userId, accountId)
    await insertSetupWithAllowances(setup, [USDC_ALLOWANCE])
    const agent = await db.query<{ id: string }>(
      `INSERT INTO agents (user_id, name, status) VALUES ($1, 'pending', 'pending_approval') RETURNING id`,
      [userId],
    )

    await inTransaction(async (tx) => {
      await markSetupRegistered(
        {
          setupId: setup.id,
          agentId: agent.rows[0].id,
          delegateAddress: ADDR('d1'),
          proofSignature: '0xproof',
          apiKeyPrefix: 'sk_agent_ab',
          connectorVersion: '1.2.3',
          runtime: 'node',
          runMode: null,
          connectorContext: { host: 'mac' },
          installStatus: { step: 'registered' },
        },
        tx,
      )
    })

    const row = await findSetupByTokenHash(setup.setupTokenHash)
    expect(row!.status).toBe('connected_local')
    expect(row!.agent_id).toBe(agent.rows[0].id)
    expect(row!.setup_token_consumed_at).not.toBeNull()
    expect(row!.install_status).toEqual({ step: 'registered' })
  })

  /**
   * #2528: `run_mode` on the real table, not a mock's argument list.
   *
   * The claim under test is the database's — that a column added by migration
   * 077 is written by the register UPDATE and reads back — which is exactly
   * the class `testing-strategy.md` (epic #1219) says belongs on the real-DB
   * harness. A positional-mock route test can only prove the value reached
   * `pg.query`; it cannot prove the column exists or that the SQL binds the
   * parameter it thinks it does. The `$8`/`$9`/`$10` renumbering this change
   * required is precisely the mistake that survives a mock and fails here.
   */
  it('markSetupRegistered persists run_mode (#2528)', async () => {
    const { userId, accountId } = await seedUserAndSafe()
    const setup = newSetup(userId, accountId)
    await insertSetupWithAllowances(setup, [])
    const agent = await db.query<{ id: string }>(
      `INSERT INTO agents (user_id, name, status) VALUES ($1, 'pending', 'pending_approval') RETURNING id`,
      [userId],
    )

    await inTransaction(async (tx) => {
      await markSetupRegistered(
        {
          setupId: setup.id,
          agentId: agent.rows[0].id,
          delegateAddress: ADDR('d7'),
          proofSignature: '0xproof',
          apiKeyPrefix: 'sk_agent_ab',
          connectorVersion: '1.2.3',
          runtime: 'claude-code',
          runMode: 'json',
          connectorContext: {},
          installStatus: {},
        },
        tx,
      )
    })

    const row = await db.query<{ run_mode: string | null; runtime: string | null }>(
      `SELECT run_mode, runtime FROM agent_connection_setups WHERE id = $1`,
      [setup.id],
    )
    expect(row.rows[0].run_mode).toBe('json')
    // Asserted together on purpose: the two travel in adjacent bind positions,
    // so a renumbering slip would show up as one landing in the other's column
    // — which a single-column assertion reads as a pass.
    expect(row.rows[0].runtime).toBe('claude-code')
  })

  /**
   * The older-connector case, on the real table: a register that sends no
   * `run_mode` must leave the column NULL rather than fail, and must not
   * disturb `runtime` beside it.
   */
  it('markSetupRegistered leaves run_mode NULL when the connector does not send it (#2528)', async () => {
    const { userId, accountId } = await seedUserAndSafe()
    const setup = newSetup(userId, accountId)
    await insertSetupWithAllowances(setup, [])
    const agent = await db.query<{ id: string }>(
      `INSERT INTO agents (user_id, name, status) VALUES ($1, 'pending', 'pending_approval') RETURNING id`,
      [userId],
    )

    await inTransaction(async (tx) => {
      await markSetupRegistered(
        {
          setupId: setup.id,
          agentId: agent.rows[0].id,
          delegateAddress: ADDR('d8'),
          proofSignature: '0xproof',
          apiKeyPrefix: 'sk_agent_ab',
          connectorVersion: '1.2.3',
          runtime: 'node',
          runMode: null,
          connectorContext: {},
          installStatus: {},
        },
        tx,
      )
    })

    const row = await db.query<{ run_mode: string | null; runtime: string | null }>(
      `SELECT run_mode, runtime FROM agent_connection_setups WHERE id = $1`,
      [setup.id],
    )
    expect(row.rows[0].run_mode).toBeNull()
    expect(row.rows[0].runtime).toBe('node')
  })

  it('mergeInstallStatus MERGES jsonb keys — later steps never erase earlier ones', async () => {
    const { userId, accountId } = await seedUserAndSafe()
    const setup = newSetup(userId, accountId)
    await insertSetupWithAllowances(setup, [])

    await mergeInstallStatus(setup.id, { downloaded: true }, null, null)
    const merged = await mergeInstallStatus(setup.id, { configured: true }, '2.0.0', 'bun')
    expect(merged).toEqual({ downloaded: true, configured: true })

    const row = await findSetupForUser(setup.id, userId)
    expect(row!.connector_version).toBe('2.0.0')
    expect(row!.runtime).toBe('bun')
  })

  // ── Cancel: the guarded state machine ──────────────────────────────────

  it('cancelSetup cancels only cancellable states, and revokePendingAgent only a pending agent', async () => {
    const { userId, accountId } = await seedUserAndSafe()
    const setup = newSetup(userId, accountId)
    await insertSetupWithAllowances(setup, [])
    const agent = await db.query<{ id: string }>(
      `INSERT INTO agents (user_id, name, status, api_key_hash, api_key_prefix)
       VALUES ($1, 'pending', 'pending_approval', 'abc123', 'sk_agent_ab') RETURNING id`,
      [userId],
    )

    // Happy path, under the lock the route would hold:
    const cancelled = await inTransaction(async (tx) => {
      const ok = await cancelSetup(setup.id, userId, tx)
      await revokePendingAgent(agent.rows[0].id, userId, tx)
      return ok
    })
    expect(cancelled).toBe(true)
    expect((await findSetupForUser(setup.id, userId))!.status).toBe('cancelled')
    const agentRow = await db.query<{ status: string; api_key_hash: string | null }>(
      `SELECT status, api_key_hash FROM agents WHERE id = $1`,
      [agent.rows[0].id],
    )
    expect(agentRow.rows[0]).toEqual({ status: 'revoked', api_key_hash: null })

    // A second cancel matches nothing — the caller must NOT report success.
    expect(await inTransaction(async (tx) => cancelSetup(setup.id, userId, tx))).toBe(false)
  })

  it('cancelSetup refuses once an approval transaction exists — money may be moving', async () => {
    const { userId, accountId } = await seedUserAndSafe()
    const setup = newSetup(userId, accountId)
    await insertSetupWithAllowances(setup, [])
    await db.query(
      `UPDATE agent_connection_setups SET status = 'awaiting_wallet_approval', account_tx_hash = '0xsafe' WHERE id = $1`,
      [setup.id],
    )

    expect(await inTransaction(async (tx) => cancelSetup(setup.id, userId, tx))).toBe(false)
    expect((await findSetupForUser(setup.id, userId))!.status).toBe('awaiting_wallet_approval')

    // …and the wrong user can never cancel someone else's setup.
    const stranger = await seedUserAndSafe()
    const own = newSetup(stranger.userId, stranger.accountId)
    await insertSetupWithAllowances(own, [])
    expect(await inTransaction(async (tx) => cancelSetup(own.id, userId, tx))).toBe(false)
  })

  it('a revoked agent releases its delegate for re-registration (partial unique index)', async () => {
    // idx_agents_user_delegate_non_revoked_unique: (user_id, delegate) unique
    // EXCEPT revoked rows — the property that lets a cancelled setup's
    // connector re-register the same signer.
    const { userId } = await seedUserAndSafe()
    await db.query(
      `INSERT INTO agents (user_id, name, status, delegate_address) VALUES ($1, 'a1', 'active', $2)`,
      [userId, ADDR('d1')],
    )
    await expect(
      db.query(
        `INSERT INTO agents (user_id, name, status, delegate_address) VALUES ($1, 'a2', 'active', $2)`,
        [userId, ADDR('d1')],
      ),
    ).rejects.toMatchObject({ code: '23505' })

    await db.query(`UPDATE agents SET status = 'revoked' WHERE user_id = $1`, [userId])
    await expect(
      db.query(
        `INSERT INTO agents (user_id, name, status, delegate_address) VALUES ($1, 'a3', 'active', $2)`,
        [userId, ADDR('d1')],
      ),
    ).resolves.toBeTruthy()
  })

  // ── #1878: the MCP server name the connector reported ──────────────────
  //
  // The column is written here and read back by the agents list, so the
  // round trip belongs on the real DB rather than against a mock: what these
  // assert is what Postgres actually stored, including the three-way
  // distinction NULL has to carry.

  it('stores the reported MCP server name for a NAMED pair', async () => {
    const { userId, accountId } = await seedUserAndSafe()
    const agentId = await inTransaction((tx) =>
      insertPendingAgent(
        {
          userId,
          name: 'Research agent',
          description: null,
          delegateAddress: ADDR('2a'),
          apiKeyHash: 'b'.repeat(64),
          apiKeyPrefix: 'sk_agent_abc',
          accountId,
          mcpServerName: 'haven-research',
        },
        tx,
      ),
    )
    const row = await db.query<{ mcp_server_name: string | null }>(
      `SELECT mcp_server_name FROM agents WHERE id = $1`,
      [agentId],
    )
    expect(row.rows[0].mcp_server_name).toBe('haven-research')
  })

  it('stores the BARE pair as a value, distinct from never-reported', async () => {
    // The whole reason the column holds the resolved NAME rather than the
    // slug. If the bare pair were stored as NULL it would be indistinguishable
    // from an agent an older connector registered, and the dashboard would
    // have to guess — wrongly, for every agent wired with --name before
    // #1878.
    const { userId, accountId } = await seedUserAndSafe()
    const base = {
      userId,
      description: null,
      apiKeyHash: 'c'.repeat(64),
      apiKeyPrefix: 'sk_agent_def',
      accountId,
    }
    const bareId = await inTransaction((tx) =>
      insertPendingAgent(
        { ...base, name: 'Bare', delegateAddress: ADDR('3b'), mcpServerName: 'haven' },
        tx,
      ),
    )
    const legacyId = await inTransaction((tx) =>
      insertPendingAgent({ ...base, name: 'Legacy', delegateAddress: ADDR('4c') }, tx),
    )

    const rows = await db.query<{ id: string; mcp_server_name: string | null }>(
      `SELECT id, mcp_server_name FROM agents WHERE id = ANY($1::uuid[])`,
      [[bareId, legacyId]],
    )
    const byId = new Map(rows.rows.map((r) => [r.id, r.mcp_server_name]))
    expect(byId.get(bareId)).toBe('haven')
    expect(byId.get(legacyId)).toBeNull()
  })

  it('renaming an agent leaves the wiring name untouched', async () => {
    // #1694's decision is "editable display name, immutable wiring slug".
    // The rename UPDATE must not disturb this column, and the row it returns
    // must still carry it — otherwise the card blanks out after a rename.
    const { userId, accountId } = await seedUserAndSafe()
    const agentId = await inTransaction((tx) =>
      insertPendingAgent(
        {
          userId,
          name: 'Before',
          description: null,
          delegateAddress: ADDR('5d'),
          apiKeyHash: 'd'.repeat(64),
          apiKeyPrefix: 'sk_agent_ghi',
          accountId,
          mcpServerName: 'haven-work',
        },
        tx,
      ),
    )

    const updated = await updateAgentProfile(agentId, userId, 'After', null)
    expect(updated?.name).toBe('After')
    expect(updated?.mcp_server_name).toBe('haven-work')
  })

})

// ── #3544: revoke a pending_approval agent; the open setup goes with it ──
//
// The issue's acceptance criteria, on the real database: revoke widens to
// `pending_approval`, nothing flips a revoked agent back to `active`,
// revoking cancels the agent's open setup, `applyApprovalState` abandons on a
// zero-row activation, and the credential's `api_key_hash` survives revoke
// (sweep recovery keeps working). Every test here FAILED on 3739fd3b except
// the two marked regression pins, which pass there and pin the widening's
// safety.
describeDb('revoke accepts pending_approval (#3544, real DB)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  /**
   * The issue's repro shape: a user, a delegator_hybrid account, and a
   * connect-modal agent on it with no delegations — `pending_approval`, the
   * normal starting state (#1130).
   */
  async function seedPendingAgentOnDelegatorAccount(): Promise<{
    userId: string
    agentId: string
    apiKeyHash: string
  }> {
    const user = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`revoke-pending-${++seq}-${Date.now()}@test.example`],
    )
    const account = await db.query<{ id: string }>(
      `INSERT INTO smart_accounts (user_id, account_address, name, chain_id, is_default, account_type)
       VALUES ($1, $2, 'Delegation account', 84532, true, 'delegator_hybrid') RETURNING id`,
      [user.rows[0].id, ADDR(String(++seq % 10))],
    )
    const apiKeyHash = `k${++seq}`.padEnd(64, '0')
    const agentId = await inTransaction(async (tx) =>
      insertPendingAgent(
        {
          userId: user.rows[0].id,
          name: 'Pending connect agent',
          description: null,
          delegateAddress: ADDR(`d${seq}`),
          apiKeyHash,
          apiKeyPrefix: 'sk_agent_pnd',
          accountId: account.rows[0].id,
        },
        tx,
      ),
    )
    return { userId: user.rows[0].id, agentId, apiKeyHash }
  }

  /** The owning account's id — setups and the agent must share it. */
  async function agentAccountId(agentId: string): Promise<string> {
    const account = await db.query<{ account_id: string }>(
      `SELECT account_id FROM agents WHERE id = $1`,
      [agentId],
    )
    return account.rows[0].account_id
  }

  /** A connected_local setup whose agent_id points at the given agent. */
  async function seedConnectedSetup(agentId: string, userId: string): Promise<string> {
    const setup = newSetup(userId, await agentAccountId(agentId))
    await insertSetupWithAllowances(setup, [USDC_ALLOWANCE])
    await inTransaction(async (tx) => {
      await markSetupRegistered(
        {
          setupId: setup.id,
          agentId,
          delegateAddress: ADDR(`d${++seq}r`),
          proofSignature: '0xproof',
          apiKeyPrefix: 'sk_agent_pnd',
          connectorVersion: '1.2.3',
          runtime: 'node',
          runMode: null,
          connectorContext: {},
          installStatus: {},
        },
        tx,
      )
    })
    return setup.id
  }

  async function agentRow(agentId: string): Promise<{
    status: string
    api_key_hash: string | null
    archived_at: Date | null
  }> {
    const row = await db.query<{
      status: string
      api_key_hash: string | null
      archived_at: Date | null
    }>(`SELECT status, api_key_hash, archived_at FROM agents WHERE id = $1`, [agentId])
    return row.rows[0]
  }

  it('revokeAgent succeeds for a pending_approval agent on a delegator_hybrid account, and archiveAgent then succeeds', async () => {
    const { userId, agentId } = await seedPendingAgentOnDelegatorAccount()

    expect(await revokeAgent(agentId, userId)).toBe(true)
    const revoked = await agentRow(agentId)
    expect(revoked.status).toBe('revoked')

    // The second half of the Remove dialog's chain — previously the 409
    // "Only revoked agents can be archived".
    expect(await archiveAgent(agentId, userId)).toMatchObject({ id: agentId })
    expect((await agentRow(agentId)).archived_at).not.toBeNull()
  })

  it('revoking cancels the agent\u2019s open connection setup, in the revoke transaction', async () => {
    const { userId, agentId } = await seedPendingAgentOnDelegatorAccount()
    const setupId = await seedConnectedSetup(agentId, userId)
    expect((await findSetupForUser(setupId, userId))!.status).toBe('connected_local')

    expect(await revokeAgent(agentId, userId)).toBe(true)

    expect((await findSetupForUser(setupId, userId))!.status).toBe('cancelled')
    expect((await agentRow(agentId)).status).toBe('revoked')
  })

  it('a revoke with no setup, and an idempotent re-revoke, both behave', async () => {
    const { userId, agentId } = await seedPendingAgentOnDelegatorAccount()

    expect(await revokeAgent(agentId, userId)).toBe(true)
    // No setup existed for this agent; the cancel matched nothing and the
    // revoke still committed.
    expect((await agentRow(agentId)).status).toBe('revoked')

    // Already revoked: the agent UPDATE matches nothing, the whole
    // transaction answers false without touching anything.
    expect(await revokeAgent(agentId, userId)).toBe(false)
  })

  it('applyApprovalState abandons when ACTIVATE_AGENT_SQL matches no row — the setup never commits active (failed on 3739fd3b)', async () => {
    const { userId, agentId } = await seedPendingAgentOnDelegatorAccount()
    const setupId = await seedConnectedSetup(agentId, userId)
    // The zero-row frame: an agent revoked OUTSIDE the revoke transaction —
    // a row written before cancel-on-revoke existed (#3544), or any direct
    // revocation path. The setup is still open, so every guard passes and
    // approval proceeds to the activation leg — where the agent UPDATE
    // matches nothing. Without the guard this transaction COMMITS the setup
    // `active` next to a revoked agent: exactly the half-apply the invariant
    // forbids.
    await db.query(`UPDATE agents SET status = 'revoked' WHERE id = $1`, [agentId])

    const result = await applyApprovalState(
      { id: setupId, user_id: userId },
      {
        status: 'active',
        approvalStatus: 'confirmed',
        txHash: null,
        accountTxHash: null,
        failureReason: null,
        activateAgent: true,
      },
    )
    expect(result).toBeNull()
    // Abandoned: the setup keeps its open state (NOT cancelled — this test
    // isolates the zero-row guard from the cancel-on-revoke one) and the
    // agent stays revoked.
    expect((await findSetupForUser(setupId, userId))!.status).toBe('connected_local')
    expect((await agentRow(agentId)).status).toBe('revoked')
  })

  it('applyApprovalState still activates a pending_approval agent when nothing revoked it (guard is narrow)', async () => {
    const { userId, agentId } = await seedPendingAgentOnDelegatorAccount()
    const setupId = await seedConnectedSetup(agentId, userId)

    const result = await applyApprovalState(
      { id: setupId, user_id: userId },
      {
        status: 'active',
        approvalStatus: 'confirmed',
        txHash: null,
        accountTxHash: null,
        failureReason: null,
        activateAgent: true,
      },
    )
    expect(result).not.toBeNull()
    expect(result!.status).toBe('active')
    expect((await agentRow(agentId)).status).toBe('active')
  })

  it('ACTIVATE_AGENT_SQL and the first-budget activation never flip a revoked agent back to active (regression pin)', async () => {
    const { userId, agentId } = await seedPendingAgentOnDelegatorAccount()
    expect(await revokeAgent(agentId, userId)).toBe(true)

    // `ACTIVATE_AGENT_SQL` — the setup path's idempotent safety net.
    await inTransaction(async (tx) => {
      await tx.query(ACTIVATE_AGENT_SQL, [agentId, userId])
    })
    // The first-budget activation, `routes/agent-delegations.ts:751`.
    await inTransaction(async (tx) => {
      await tx.query(
        `UPDATE agents SET status = 'active', updated_at = NOW()
         WHERE id = $1 AND status = 'pending_approval'`,
        [agentId],
      )
    })
    expect((await agentRow(agentId)).status).toBe('revoked')
  })

  it('revoke keeps api_key_hash and api_key_prefix — sweep recovery survives (regression pin)', async () => {
    const { userId, agentId, apiKeyHash } = await seedPendingAgentOnDelegatorAccount()

    expect(await revokeAgent(agentId, userId)).toBe(true)
    const revoked = await agentRow(agentId)
    expect(revoked.status).toBe('revoked')
    expect(revoked.api_key_hash).toBe(apiKeyHash)
    // And it must NOT fork toward REVOKE_PENDING_AGENT_SQL's behaviour
    // (setup-cancel nulls the key; the dashboard revoke deliberately does not).
    const key = await db.query<{ api_key_prefix: string | null }>(
      `SELECT api_key_prefix FROM agents WHERE id = $1`,
      [agentId],
    )
    expect(key.rows[0].api_key_prefix).not.toBeNull()
  })
})
