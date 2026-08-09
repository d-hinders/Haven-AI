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
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import {
  cancelSetup,
  findSetupByTokenHash,
  findSetupForUser,
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

async function seedUserAndSafe(): Promise<{ userId: string; safeId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`acs-${++seq}-${Date.now()}@test.example`],
  )
  const safe = await db.query<{ id: string }>(
    `INSERT INTO user_safes (user_id, safe_address, name, chain_id)
     VALUES ($1, $2, 'Main account', 84532) RETURNING id`,
    [user.rows[0].id, ADDR(String(seq % 10))],
  )
  return { userId: user.rows[0].id, safeId: safe.rows[0].id }
}

function newSetup(userId: string, safeId: string, overrides: Partial<NewSetup> = {}): NewSetup {
  return {
    id: randomUUID(),
    userId,
    safeId,
    name: 'Connect setup',
    description: null,
    runtime: null,
    setupTokenHash: `hash-${++seq}-${Date.now()}`,
    setupTokenPrefix: 'hvn_setup_ab',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    challengeId: randomUUID(),
    challengeMessage: 'sign me',
    issuePassport: false,
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
    const { userId, safeId } = await seedUserAndSafe()
    const setup = newSetup(userId, safeId)
    // Distinct token addresses — (setup_id, token_address) is unique.
    await insertSetupWithAllowances(setup, [
      USDC_ALLOWANCE,
      { ...USDC_ALLOWANCE, token_address: ADDR('1f'), token_symbol: 'EURe' },
    ])

    const row = await findSetupForUser(setup.id, userId)
    expect(row).not.toBeNull()
    expect(row!.status).toBe('awaiting_connection')
    expect(row!.safe_chain_id).toBe(84532) // the user_safes join carries the wallet
    expect(await listSetupAllowances(setup.id)).toHaveLength(2)
  })

  it('a failing allowance write rolls back the SETUP row too — no half-approved agent', async () => {
    const { userId, safeId } = await seedUserAndSafe()
    const setup = newSetup(userId, safeId)

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
    const { userId, safeId } = await seedUserAndSafe()
    const first = newSetup(userId, safeId, { setupTokenHash: 'hash-dup' })
    await insertSetupWithAllowances(first, [])

    await expect(
      insertSetupWithAllowances(newSetup(userId, safeId, { setupTokenHash: 'hash-dup' }), []),
    ).rejects.toMatchObject({ code: '23505' })
  })

  // ── FOR UPDATE OF s: the serialisation the epic names ──────────────────

  it('lockSetupByTokenHash SERIALISES two concurrent transactions — the second sees the first commit', async () => {
    const { userId, safeId } = await seedUserAndSafe()
    const setup = newSetup(userId, safeId)
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
    // Give tx1 a head start so it takes the lock first.
    await new Promise((r) => setTimeout(r, 50))
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
    const { userId, safeId } = await seedUserAndSafe()
    const setup = newSetup(userId, safeId)
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

  it('mergeInstallStatus MERGES jsonb keys — later steps never erase earlier ones', async () => {
    const { userId, safeId } = await seedUserAndSafe()
    const setup = newSetup(userId, safeId)
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
    const { userId, safeId } = await seedUserAndSafe()
    const setup = newSetup(userId, safeId)
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
    const { userId, safeId } = await seedUserAndSafe()
    const setup = newSetup(userId, safeId)
    await insertSetupWithAllowances(setup, [])
    await db.query(
      `UPDATE agent_connection_setups SET status = 'awaiting_wallet_approval', safe_tx_hash = '0xsafe' WHERE id = $1`,
      [setup.id],
    )

    expect(await inTransaction(async (tx) => cancelSetup(setup.id, userId, tx))).toBe(false)
    expect((await findSetupForUser(setup.id, userId))!.status).toBe('awaiting_wallet_approval')

    // …and the wrong user can never cancel someone else's setup.
    const stranger = await seedUserAndSafe()
    const own = newSetup(stranger.userId, stranger.safeId)
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
})
