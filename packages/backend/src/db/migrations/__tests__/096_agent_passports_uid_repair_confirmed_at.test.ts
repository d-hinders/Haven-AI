/**
 * Real-Postgres proof for migration 096 — the anchor-UID repair sweep's
 * confirmed-repair marker (#3342). No mocks — #1219's rule.
 *
 * Pins the issue's acceptance criteria at the schema level: the column exists
 * and is nullable (the pre-marker population self-heals onto the bounded
 * selector without a backfill), the repair/confirm writes land on it, the
 * sweep selector excludes a marked row (the bounded-reads criterion the
 * `updated_at` churn could not meet), the cancellation points restore it to
 * NULL (a re-anchored row is re-checked from scratch), and `down()` drops
 * exactly what `up()` created.
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
import * as repo from '../../../infra/repositories/agent-passports.js'
import { down, up, version } from '../096_agent_passports_uid_repair_confirmed_at.js'

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

async function seedAnchoredRow(): Promise<string> {
  seq += 1
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`mig096-${seq}-${Date.now()}@test.example`],
  )
  const safe = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id) VALUES ($1, $2, $3) RETURNING id`,
    [user.rows[0].id, '0x' + 'b'.repeat(40), 84532],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name, account_id, delegate_address, status)
     VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
    [user.rows[0].id, `mig096 agent ${seq}`, safe.rows[0].id, '0x' + 'a'.repeat(40)],
  )
  const agentId = agent.rows[0].id
  await repo.insertRequested(agentId, 84532, 0)
  await repo.markAnchored(agentId, {
    attestationUid: '0x' + (100 + seq).toString(16).padStart(2, '0').repeat(32),
    txHash: '0x' + (200 + seq).toString(16).padStart(2, '0').repeat(32),
    agentEoa: '0x' + 'a'.repeat(40),
    smartAccount: null,
  })
  await db.query(
    `UPDATE agent_passports SET anchored_at = NOW() - INTERVAL '2 hours',
       updated_at = NOW() - INTERVAL '2 hours' WHERE agent_id = $1`,
    [agentId],
  )
  return agentId
}

async function readMarker(agentId: string): Promise<string | null> {
  const { rows } = await db.query<{ uid_repair_confirmed_at: string | null }>(
    `SELECT uid_repair_confirmed_at FROM agent_passports WHERE agent_id = $1`,
    [agentId],
  )
  return rows[0]?.uid_repair_confirmed_at ?? null
}

describeDb('migration 096_agent_passports_uid_repair_confirmed_at', () => {
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
    expect(version).toBe('096_agent_passports_uid_repair_confirmed_at')
  })

  it('adds a nullable column and down() drops exactly it', async () => {
    const present = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'agent_passports'
         AND column_name = 'uid_repair_confirmed_at'`,
    )
    expect(present.rows[0].count).toBe('1')
    await withMigrationReverted(
      () => runDown(),
      async () => {
        const gone = await db.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'agent_passports'
             AND column_name = 'uid_repair_confirmed_at'`,
        )
        expect(gone.rows[0].count).toBe('0')
      },
      () => runUp(),
    )
  })

  it('is idempotent (IF NOT EXISTS re-run)', async () => {
    await runUp()
    await runUp()
  })

  it('existing rows read NULL — the pre-marker population stays due until confirmed', async () => {
    const agentId = await seedAnchoredRow()
    expect(await readMarker(agentId)).toBeNull()
    // Still due: the marker exclusion passes NULL rows through.
    const due = await repo.listAnchorRepairsDue(10)
    expect(due.map((r) => r.agent_id)).toContain(agentId)
  })

  it('a confirmed/repaired row is excluded from the sweep selector — bounded reads (#3342)', async () => {
    const agentId = await seedAnchoredRow()
    // The repair write stamps the marker (the CAS carries it since 096).
    const applied = await repo.repairAnchoredUid(
      agentId,
      '0x' + (100 + seq).toString(16).padStart(2, '0').repeat(32),
      '0x' + 'ef'.repeat(32),
      '0x' + (200 + seq).toString(16).padStart(2, '0').repeat(32),
    )
    expect(applied).toBe(true)
    expect(await readMarker(agentId)).not.toBeNull()
    // ...even aged past the freshness guard, the row is NOT re-selected.
    await db.query(
      `UPDATE agent_passports SET updated_at = NOW() - INTERVAL '3 hours' WHERE agent_id = $1`,
      [agentId],
    )
    const due = await repo.listAnchorRepairsDue(10)
    expect(due.map((r) => r.agent_id)).not.toContain(agentId)
  })

  it('confirmAnchorUid stamps the marker without touching attestation_uid; refusal leaves it NULL', async () => {
    const agentId = await seedAnchoredRow()
    const before = await repo.findByAgent(agentId)
    const stamped = await repo.confirmAnchorUid(agentId, before!.tx_hash!)
    expect(stamped).toBe(true)
    expect(await readMarker(agentId)).not.toBeNull()
    // Idempotent: already marked refuses.
    expect(await repo.confirmAnchorUid(agentId, before!.tx_hash!)).toBe(false)
    // A row that moved (tx changed) refuses and stays unmarked.
    const other = await seedAnchoredRow()
    expect(await repo.confirmAnchorUid(other, '0x' + 'ff'.repeat(32))).toBe(false)
    expect(await readMarker(other)).toBeNull()
  })

  it('a new anchor cancels the marker — the row is re-checked from scratch', async () => {
    const agentId = await seedAnchoredRow()
    await repo.confirmAnchorUid(
      agentId,
      '0x' + (200 + seq).toString(16).padStart(2, '0').repeat(32),
    )
    expect(await readMarker(agentId)).not.toBeNull()
    await repo.markAnchored(agentId, {
      attestationUid: '0x' + 'ee'.repeat(32),
      txHash: '0x' + 'dd'.repeat(32),
      agentEoa: '0x' + 'a'.repeat(40),
      smartAccount: null,
    })
    expect(await readMarker(agentId)).toBeNull()
  })

  it('a re-anchor reset cancels the marker', async () => {
    const agentId = await seedAnchoredRow()
    await repo.confirmAnchorUid(
      agentId,
      '0x' + (200 + seq).toString(16).padStart(2, '0').repeat(32),
    )
    expect(await readMarker(agentId)).not.toBeNull()
    // The reset is only reachable through the real lifecycle: revoke,
    // confirm the revoke, then reset for re-anchor.
    expect(await repo.enqueueRevocation(agentId)).toBe(true)
    await repo.markRevocationConfirmed(agentId, '0x' + (300 + seq).toString(16).padStart(2, '0').repeat(32))
    const reset = await repo.resetForReanchor(
      agentId,
      '0x' + (100 + seq).toString(16).padStart(2, '0').repeat(32),
    )
    expect(reset).toBe(true)
    expect(await readMarker(agentId)).toBeNull()
  })

  it('deferAnchorRepair bumps updated_at without stamping the marker', async () => {
    const agentId = await seedAnchoredRow()
    await repo.deferAnchorRepair(agentId)
    expect(await readMarker(agentId)).toBeNull()
    // Bumped past the freshness guard: not due again this hour (#3342).
    const due = await repo.listAnchorRepairsDue(10)
    expect(due.map((r) => r.agent_id)).not.toContain(agentId)
  })
})
