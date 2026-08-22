/**
 * #1758 — a revoke that mines AFTER its wait expired leaves the passport row
 * `revocation_status = 'pending'` permanently.
 *
 * Fourth member of the bounded-wait family (#1722/#1737, #1735/#1751,
 * #1742/#1759). #1742 bounded `revokeOnChain`'s wait, which was the right
 * call — the alternative hung the whole passport sweep and silenced the
 * stuck-revoke alarm for EVERY agent. What it left behind is this: nothing
 * re-observes the transaction once the wait has given up on it.
 *
 * Two gaps combine, and both are characterized below:
 *
 * 1. **A successful hand-off never teaches the passport row.** The bump
 *    worker's `markMined` closes the `outbound_txs` row and stops there — it
 *    has no join key to `agent_passports` and no business holding one.
 * 2. **The only path that CAN confirm is structurally guaranteed to fail.**
 *    `markRevocationConfirmed` is reachable only from a fresh `revokeOnChain`
 *    seeing `receipt.status === 1`, and once the UID is revoked on-chain every
 *    fresh attempt reverts `AlreadyRevoked` — recorded as a genuine revert,
 *    rescheduled, forever, at the 3600 s backoff cap.
 *
 * ## Why this file is on the real database
 *
 * Every claim here is a claim about what Postgres returns, not about control
 * flow: that the row stays `pending` across ticks, that `listRevocationsDue`
 * keeps handing it back, and — the sharp end — that `listStuckRevocations`
 * keeps firing an alarm for a condition that has already resolved on-chain.
 * Those are defined by the SQL's invariant predicates
 * (`revocation_status <> 'confirmed'`), so asserting them against a mock would
 * prove only that the mock returns what it was told. Per
 * `docs/contributing/testing-strategy.md`, the chain is the collaborator we
 * mock; the database is not.
 *
 * The FIRST commit of this file characterizes today's non-convergence, so the
 * fix has something to invert.
 */
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import * as repo from '../../../infra/repositories/agent-passports.js'
import {
  reconcileRevocation,
  revocationBackoffSeconds,
  setRevoker,
  listStuckRevocations,
} from '../revocation.js'

const CHAIN = 84532
const DELEGATE = '0x' + 'a'.repeat(40)
const TREASURY = '0x' + 'b'.repeat(40)
const UID = '0x' + 'cd'.repeat(32)
/** The revoke that was broadcast, timed out at 120 s, and then MINED. */
const REVOKE_TX = '0x' + '11'.repeat(32)

let seq = 0

/**
 * EAS reverts a second revoke of the same UID. This is what every retry after
 * the transaction mines gets back — a genuine-looking revert for a request
 * whose goal has already been achieved.
 */
function alreadyRevoked(): Error {
  const err = new Error('execution reverted (unknown custom error) — AlreadyRevoked()') as Error & {
    code: string
  }
  err.code = 'CALL_EXCEPTION'
  return err
}

async function seedRevokedAgentWithAnchoredPassport(): Promise<string> {
  const n = ++seq
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`p1758-${n}-${Date.now()}@test.example`],
  )
  const userId = user.rows[0].id
  const safe = await db.query<{ id: string }>(
    `INSERT INTO user_safes (user_id, safe_address, chain_id) VALUES ($1, $2, $3) RETURNING id`,
    [userId, TREASURY, CHAIN],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name, safe_id, delegate_address, status)
     VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
    [userId, `passport agent ${n}`, safe.rows[0].id, DELEGATE],
  )
  const agentId = agent.rows[0].id
  await repo.insertRequested(agentId, CHAIN, 0)
  await repo.markAnchored(agentId, {
    attestationUid: UID,
    txHash: '0x' + '99'.repeat(32),
    agentEoa: DELEGATE,
    smartAccount: null,
  })
  // The agent's own status IS the revocation (#973). `claimRevocation` checks
  // this invariant, so it must be true before the anchor can be pushed.
  await db.query(`UPDATE agents SET status = 'revoked' WHERE id = $1`, [agentId])
  await repo.enqueueRevocation(agentId)
  return agentId
}

/** Age the lease/backoff out so the next tick is due — one simulated hour. */
async function makeDue(agentId: string): Promise<void> {
  await db.query(
    `UPDATE agent_passports SET revocation_next_attempt_at = NOW() - INTERVAL '1 second'
      WHERE agent_id = $1`,
    [agentId],
  )
}

async function readPassport(agentId: string) {
  const row = await repo.findByAgent(agentId)
  if (!row) throw new Error('passport row vanished')
  return row
}

describeDb('#1758 — the revoke that mined too late, characterized on real Postgres', () => {
  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
    setRevoker(null)
    process.env.AGENT_PASSPORT_SCHEMA_UID_84532 = UID
  })
  afterEach(() => {
    setRevoker(null)
    vi.restoreAllMocks()
  })

  it('the AlreadyRevoked retry NEVER converges — five ticks, five broadcasts, still pending', async () => {
    const agentId = await seedRevokedAgentWithAnchoredPassport()
    // The transaction mined after the wait expired, so the UID is revoked
    // on-chain and every fresh attempt reverts.
    const revoker = vi.fn(async () => {
      throw alreadyRevoked()
    })
    setRevoker(revoker)

    for (let tick = 0; tick < 5; tick++) {
      await makeDue(agentId)
      expect(await reconcileRevocation(agentId)).toBe('revocation_pending')
    }

    const row = await readPassport(agentId)
    expect(row.revocation_status).toBe('pending')
    expect(row.revocation_confirmed_at).toBeNull()
    expect(row.revocation_tx_hash).toBeNull()
    // Gas burned on a doomed transaction, once per tick. The revert message is
    // recorded as though something had gone wrong; nothing had.
    expect(revoker).toHaveBeenCalledTimes(5)
    expect(row.revocation_last_error).toContain('AlreadyRevoked')
    expect(row.revocation_attempts).toBe(5)
  })

  it('the row stays DUE forever — the queue keeps handing it back', async () => {
    const agentId = await seedRevokedAgentWithAnchoredPassport()
    setRevoker(
      vi.fn(async () => {
        throw alreadyRevoked()
      }),
    )

    await makeDue(agentId)
    await reconcileRevocation(agentId)
    await makeDue(agentId)

    expect((await repo.listRevocationsDue(50)).map((r) => r.agent_id)).toContain(agentId)
  })

  it('the stuck-revoke alarm fires forever for an agent that IS revoked on-chain', async () => {
    // The alarm's whole purpose is "agents revoked in Haven still hold a live
    // attestation on-chain". Here the attestation is dead and the alarm still
    // fires — a false positive that never clears, for every affected agent,
    // which is what trains an operator to ignore the one signal that matters.
    const agentId = await seedRevokedAgentWithAnchoredPassport()
    setRevoker(
      vi.fn(async () => {
        throw alreadyRevoked()
      }),
    )
    await makeDue(agentId)
    await reconcileRevocation(agentId)

    await db.query(
      `UPDATE agent_passports SET revocation_requested_at = NOW() - INTERVAL '2 hours'
        WHERE agent_id = $1`,
      [agentId],
    )
    expect((await listStuckRevocations(3600)).map((r) => r.agent_id)).toContain(agentId)
  })

  it('a mined outbound row teaches the passport row NOTHING (gap 1)', async () => {
    // Exactly the successful hand-off: the bump worker adopted the `broadcast`
    // row, read a status-1 receipt and closed it `mined`. That is the whole of
    // what the worker does — it never reaches `agent_passports`.
    const agentId = await seedRevokedAgentWithAnchoredPassport()
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO outbound_txs (chain_id, submitter, to_address, data, value_atomic, status, tx_hash, nonce)
       VALUES ($1, 'passport_revoke', $2, $3, '0', 'mined', $4, '7') RETURNING id`,
      [CHAIN, '0x' + 'ee'.repeat(20), '0xdeadbeef', REVOKE_TX],
    )
    expect(rows).toHaveLength(1)

    const row = await readPassport(agentId)
    expect(row.revocation_status).toBe('pending')
    expect(row.revocation_confirmed_at).toBeNull()
  })

  it('the backoff is pinned at the 1 h cap — a doomed broadcast roughly hourly, forever', () => {
    // Capped rather than unbounded is correct for a revoke that must keep
    // trying; it is exactly wrong for one that can never succeed.
    expect(revocationBackoffSeconds(20)).toBe(3600)
  })
})

describe('#1758 — the residual is PERMANENT, not merely unresolved', () => {
  it('markRevocationConfirmed is reachable only from a fresh successful revoke', async () => {
    // A source assertion, and the reason the state above cannot self-heal: the
    // one call site sits after `await revokerImpl(...)` resolves, and once the
    // UID is revoked on-chain that call can never resolve again.
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const src = readFileSync(fileURLToPath(new URL('../revocation.ts', import.meta.url)), 'utf8')
    const callSites = src.match(/markRevocationConfirmed\(/g) ?? []
    expect(callSites).toHaveLength(1)
    expect(src).toMatch(/const \{ txHash \} = await revokerImpl\([\s\S]*?markRevocationConfirmed/)
  })
})
