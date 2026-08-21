/**
 * #1745 — "presumed dropped" is a presumption, and it can mint a SECOND live
 * credential for one agent.
 *
 * `issuePassport` recovers before it re-mints (#1043), but the recovery is a
 * receipt read, and `getTransactionReceipt` returns `null` for a transaction
 * that is **still pending** exactly as it does for one that was genuinely
 * dropped. Ethers cannot tell them apart, so the code presumes dropped and
 * anchors again — at a fresh relayer nonce, behind a transaction that may
 * still mine. If it does, both mine: two real, revocable attestations for the
 * same claim, which is the failure #1042/#1043 exist to prevent.
 *
 * ## Why this file is on the real database
 *
 * The presumption is only reachable because of what Postgres does. Two of the
 * three legs are data-layer claims, not logic:
 *
 * - `markFailed` sets `anchoring_started_at = NULL`, so `claimForAnchoring`'s
 *   600 s stale window — the bound the code comment implies — is VACUOUS on
 *   the failure path;
 * - `listRetryable`'s backoff is `30 * 2^attempts` seconds, so a row that has
 *   failed once is due again after 60 s.
 *
 * 120 s confirmation wait + 60 s backoff ≈ **180 s** from broadcast to the
 * re-mint. Asserting that against a mock would prove only that the mock
 * returns what it was told to. Per `docs/contributing/testing-strategy.md`,
 * these run against the harness; the chain is the collaborator we mock.
 *
 * The FIRST commit of this file characterizes today's behaviour, including the
 * duplicate mint, so the fix has something to invert.
 */
import { beforeAll, beforeEach, afterEach, expect, it, vi } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import * as repo from '../../../infra/repositories/agent-passports.js'
import { issuePassport, setAnchor, setAnchorLiveness, setAnchorRecovery } from '../issuance.js'
import type { AnchorResult } from '../issuance.js'

const CHAIN = 84532
const DELEGATE = '0x' + 'a'.repeat(40)
const TREASURY = '0x' + 'b'.repeat(40)
/** The attest that was broadcast and never confirmed — fee-stuck or dropped. */
const STUCK_TX = '0x' + '11'.repeat(32)

let seq = 0

interface Seeded {
  agentId: string
  userId: string
}

/**
 * A LEGACY-rail agent on purpose: `issuePassport` derives a Hybrid account
 * address for delegation-rail agents, which is a chain call this file has no
 * business making. The binding logic is #971/#974's and is covered elsewhere.
 */
async function seedAgentWithPassport(opts: { txHash?: string | null } = {}): Promise<Seeded> {
  const n = ++seq
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`p1745-${n}-${Date.now()}@test.example`],
  )
  const userId = user.rows[0].id
  const safe = await db.query<{ id: string }>(
    `INSERT INTO user_safes (user_id, safe_address, chain_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [userId, TREASURY, CHAIN],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name, safe_id, delegate_address, status)
     VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
    [userId, `passport agent ${n}`, safe.rows[0].id, DELEGATE],
  )
  const agentId = agent.rows[0].id
  await repo.insertRequested(agentId, CHAIN, 0)
  if (opts.txHash !== undefined && opts.txHash !== null) {
    // Exactly the state `onBroadcast` leaves behind: a hash, no UID (#1043).
    await repo.recordBroadcast(agentId, opts.txHash)
  }
  return { agentId, userId }
}

async function readPassport(agentId: string) {
  const row = await repo.findByAgent(agentId)
  if (!row) throw new Error('passport row vanished')
  return row
}

describeDb('#1745 — the presumed-dropped re-mint, characterized on real Postgres', () => {
  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
    setAnchor(null)
    setAnchorRecovery(null)
    setAnchorLiveness(null)
    // Issuance fails before reaching the claim without a configured schema.
    process.env.AGENT_PASSPORT_SCHEMA_UID_84532 = '0x' + '1'.repeat(64)
  })
  afterEach(() => {
    setAnchor(null)
    setAnchorRecovery(null)
    setAnchorLiveness(null)
    vi.restoreAllMocks()
  })

  // ── Leg 1: the 600 s window the comment leans on is not there ──────────

  it('markFailed CLEARS the anchoring claim — the 600 s stale window is vacuous on the failure path', async () => {
    const { agentId } = await seedAgentWithPassport()

    expect(await repo.claimForAnchoring(agentId, DELEGATE)).toBe('claimed')
    // A second claimant is correctly refused while the claim stands: the
    // window is real for a LIVE attempt. That is the control for the next
    // assertion — without it, "reclaimable" could just mean "never claimed".
    expect(await repo.claimForAnchoring(agentId, DELEGATE)).toBe('not_claimed')

    await repo.markFailed(agentId, 'anchor did not confirm')

    // …and immediately reclaimable. Not after 600 s — NOW.
    expect(await repo.claimForAnchoring(agentId, DELEGATE)).toBe('claimed')
    const { rows } = await db.query<{ anchoring_started_at: Date | null }>(
      `SELECT anchoring_started_at FROM agent_passports WHERE agent_id = $1`,
      [agentId],
    )
    expect(rows[0].anchoring_started_at).not.toBeNull() // re-set by the new claim
  })

  it('the retry backoff is 60 s at attempt 1 — so the sweep is back ~180 s after broadcast', async () => {
    const { agentId } = await seedAgentWithPassport()
    await repo.claimForAnchoring(agentId, DELEGATE) // attempts -> 1
    await repo.markFailed(agentId, 'anchor did not confirm')

    // 59 s after the failure: not yet due. 61 s: due. The boundary IS the
    // claim — a test that only asserted the second half would pass against a
    // repository with no backoff at all.
    await db.query(
      `UPDATE agent_passports SET updated_at = NOW() - INTERVAL '59 seconds' WHERE agent_id = $1`,
      [agentId],
    )
    expect((await repo.listRetryable(50)).map((r) => r.agent_id)).not.toContain(agentId)

    await db.query(
      `UPDATE agent_passports SET updated_at = NOW() - INTERVAL '61 seconds' WHERE agent_id = $1`,
      [agentId],
    )
    expect((await repo.listRetryable(50)).map((r) => r.agent_id)).toContain(agentId)
  })

  // ── Leg 2: the presumption itself ──────────────────────────────────────

  it('a null receipt with a LIVE prior transaction does NOT re-mint — it stays retryable', async () => {
    const { agentId, userId } = await seedAgentWithPassport({ txHash: STUCK_TX })

    // The stuck transaction is still in the mempool. `getTransactionReceipt`
    // has nothing to return for it — and returns exactly what it returns for
    // a dropped one. Before #1745 this minted a second credential.
    const recovery = vi.fn(async (): Promise<AnchorResult | null> => null)
    const anchor = vi.fn(async () => ({
      attestationUid: '0x' + 'u'.repeat(64),
      txHash: '0x' + '22'.repeat(32),
    }))
    setAnchorRecovery(recovery)
    setAnchor(anchor)
    setAnchorLiveness(vi.fn(async () => 'live' as const))

    await issuePassport(agentId, userId)

    expect(recovery).toHaveBeenCalledWith(CHAIN, STUCK_TX)
    expect(anchor).not.toHaveBeenCalled() // the whole point

    const row = await readPassport(agentId)
    expect(row.status).toBe('failed') // retryable, not terminal
    expect(row.last_error).toContain('#1745')
    // The row still points at the ORIGINAL, so the next tick re-reads that
    // receipt rather than losing track of the transaction that may mine.
    expect(row.tx_hash).toBe(STUCK_TX)
    expect(row.attestation_uid).toBeNull()
  })

  it('withholding is a STALL, not a wedge — the row is immediately due again', async () => {
    const { agentId, userId } = await seedAgentWithPassport({ txHash: STUCK_TX })
    setAnchorRecovery(vi.fn(async (): Promise<AnchorResult | null> => null))
    setAnchor(vi.fn())
    setAnchorLiveness(vi.fn(async () => 'live' as const))

    await issuePassport(agentId, userId)

    // The anchoring claim was RELEASED, not held: a withheld re-mint must not
    // leave the passport locked out of its own retry for the 600 s window.
    const { rows } = await db.query<{ anchoring_started_at: Date | null }>(
      `SELECT anchoring_started_at FROM agent_passports WHERE agent_id = $1`,
      [agentId],
    )
    expect(rows[0].anchoring_started_at).toBeNull()

    // And it is back in the due list once its backoff elapses.
    await db.query(
      `UPDATE agent_passports SET updated_at = NOW() - INTERVAL '1 hour' WHERE agent_id = $1`,
      [agentId],
    )
    expect((await repo.listRetryable(50)).map((r) => r.agent_id)).toContain(agentId)
  })

  it('a DEAD prior transaction unlocks the re-mint — the stall is escapable', async () => {
    const { agentId, userId } = await seedAgentWithPassport({ txHash: STUCK_TX })
    const fresh: AnchorResult = {
      attestationUid: '0x' + 'u'.repeat(64),
      txHash: '0x' + '22'.repeat(32),
    }
    const anchor = vi.fn(async () => fresh)
    setAnchorRecovery(vi.fn(async (): Promise<AnchorResult | null> => null))
    setAnchor(anchor)
    setAnchorLiveness(vi.fn(async () => 'dead' as const))

    await issuePassport(agentId, userId)

    expect(anchor).toHaveBeenCalledTimes(1)
    const row = await readPassport(agentId)
    expect(row.status).toBe('anchored')
    expect(row.tx_hash).toBe(fresh.txHash)
  })

  it('NO probe wired = no re-mint — the default is fail-safe, not fall-through', async () => {
    const { agentId, userId } = await seedAgentWithPassport({ txHash: STUCK_TX })
    const anchor = vi.fn()
    setAnchorRecovery(vi.fn(async (): Promise<AnchorResult | null> => null))
    setAnchor(anchor)
    setAnchorLiveness(null) // nothing can prove death

    await issuePassport(agentId, userId)

    expect(anchor).not.toHaveBeenCalled()
    expect((await readPassport(agentId)).status).toBe('failed')
  })

  it('no recovery wired either — an unrecoverable hash still cannot be presumed dropped', async () => {
    // The gap a `recoveryImpl &&` guard used to leave: with no recovery
    // configured the whole block was skipped and the anchor ran unconditionally.
    const { agentId, userId } = await seedAgentWithPassport({ txHash: STUCK_TX })
    const anchor = vi.fn()
    setAnchorRecovery(null)
    setAnchor(anchor)
    setAnchorLiveness(vi.fn(async () => 'live' as const))

    await issuePassport(agentId, userId)

    expect(anchor).not.toHaveBeenCalled()
  })

  it('a recoverable receipt is still recovered, never re-minted (#1043, must not regress)', async () => {
    const { agentId, userId } = await seedAgentWithPassport({ txHash: STUCK_TX })
    const recovered: AnchorResult = {
      attestationUid: '0x' + 'c'.repeat(64),
      txHash: STUCK_TX,
    }
    const anchor = vi.fn()
    setAnchorRecovery(vi.fn(async () => recovered))
    setAnchor(anchor)

    await issuePassport(agentId, userId)

    expect(anchor).not.toHaveBeenCalled()
    const row = await readPassport(agentId)
    expect(row.status).toBe('anchored')
    expect(row.attestation_uid).toBe(recovered.attestationUid)
    expect(row.tx_hash).toBe(STUCK_TX)
  })

  it('a passport that never broadcast anchors normally — no hash, nothing to presume about', async () => {
    const { agentId, userId } = await seedAgentWithPassport({ txHash: null })
    const recovery = vi.fn(async (): Promise<AnchorResult | null> => null)
    const minted: AnchorResult = {
      attestationUid: '0x' + 'd'.repeat(64),
      txHash: '0x' + '33'.repeat(32),
    }
    setAnchorRecovery(recovery)
    setAnchor(vi.fn(async () => minted))

    await issuePassport(agentId, userId)

    // Recovery is not even consulted: there is no prior hash.
    expect(recovery).not.toHaveBeenCalled()
    expect((await readPassport(agentId)).status).toBe('anchored')
  })
})
