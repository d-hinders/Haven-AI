/**
 * #1847 — a recovered anchor is attributed to what the CHAIN says, never to
 * fresh facts.
 *
 * ## The window this file closes
 *
 * `issuePassport` builds its claim from the agent's CURRENT facts, then the
 * recover-before-re-mint path (#1043) may return a result for an OLD broadcast
 * whose on-chain bytes name the delegate the agent had back then. Before this
 * fix, `markAnchored(agentId, result, claim)` stamped the FRESH claim's
 * addresses onto the recovered attestation. When a re-key completed between
 * the broadcast and the recovery — exactly #2065's "attest lands late" race —
 * that wrote `agent_eoa = new delegate` for an attestation that names the
 * RETIRED one, which made `STALE_ANCHOR_PREDICATE` false forever:
 *
 * - the re-anchor sweep (#1699) never saw the row,
 * - the stuck-re-anchor alarm never fired,
 * - and the DB described the attestation wrongly, so every receipt built from
 *   it lied to the merchant it was handed to.
 *
 * The only #1847 window that did not self-heal, and it was silent. The fix is
 * attribution, not new machinery: record what was actually attested, and the
 * EXISTING invariant queue retires-and-reissues on its next tick.
 *
 * ## Why the real database
 *
 * The claim under test is a claim about `STALE_ANCHOR_PREDICATE` meeting a
 * row Postgres holds — a mock queue would only prove the mock was told the
 * right answer (`docs/contributing/testing-strategy.md`). The chain is the
 * collaborator and is stubbed through the module's own seams.
 */
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import * as repo from '../../../infra/repositories/agent-passports.js'
import {
  issuePassport,
  setAnchor,
  setAnchorLiveness,
  setAnchorRecovery,
  type RecoveredAnchor,
} from '../issuance.js'
import { setRevocationProbe, setRevoker } from '../revocation.js'
import { setReceiptSigningKey } from '../receipt.js'
import { reconcileReanchor } from '../reanchor.js'

const CHAIN = 84532
/** The key the lost broadcast attested. */
const OLD_DELEGATE = '0x' + 'a'.repeat(40)
/** The key a completed re-key rotated to while that broadcast sat unmined. */
const NEW_DELEGATE = '0x' + 'c'.repeat(40)
const TREASURY = '0x' + 'b'.repeat(40)
const ZERO_ADDRESS = '0x' + '0'.repeat(40)
const ANCHOR_TX = '0x' + '44'.repeat(32)
const REVOKE_TX = '0x' + '33'.repeat(32)
const NEW_UID = '0x' + '22'.repeat(32)
const oldUidFor = (n: number) => '0x' + n.toString(16).padStart(64, '1')
const RECEIPT_KEY = '0x' + '11'.repeat(32)

let seq = 0

/**
 * A LEGACY-rail agent whose passport BROADCAST an attestation and lost the
 * result — `tx_hash` persisted by `recordBroadcast`, no uid, row failed
 * retryably (the #1735 timeout shape). Legacy-rail for the same reason the
 * sibling files use one: no Hybrid-address chain call in `issuePassport`.
 */
async function seedBroadcastLostAgent() {
  const n = ++seq
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`p1847-${n}-${Date.now()}@test.example`],
  )
  const userId = user.rows[0].id
  const safe = await db.query<{ id: string }>(
    `INSERT INTO user_safes (user_id, safe_address, chain_id) VALUES ($1, $2, $3) RETURNING id`,
    [userId, TREASURY, CHAIN],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name, safe_id, delegate_address, status)
     VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
    [userId, `recovered anchor agent ${n}`, safe.rows[0].id, OLD_DELEGATE],
  )
  const agentId = agent.rows[0].id
  const oldUid = oldUidFor(n)
  await repo.insertRequested(agentId, CHAIN, 0)
  await repo.claimForAnchoring(agentId, OLD_DELEGATE)
  await repo.recordBroadcast(agentId, ANCHOR_TX)
  // The wait timed out: retryable failure, claim cleared, tx_hash KEPT (#1043).
  await repo.markFailed(agentId, 'passport attestation not confirmed (test seed)')
  return { agentId, userId, oldUid }
}

/** Exactly what #1698's `rotateAgentCredentials` does to the column we key on. */
async function rekeyTo(agentId: string, delegate: string): Promise<void> {
  await db.query(`UPDATE agents SET delegate_address = $2 WHERE id = $1`, [agentId, delegate])
}

/** A recovery stub that reports what the mined transaction ACTUALLY attested. */
function recoveryOf(uid: string, agentEoa: string): () => Promise<RecoveredAnchor | null> {
  return async () => ({
    attestationUid: uid,
    txHash: ANCHOR_TX,
    attested: { agentEoa, smartAccount: ZERO_ADDRESS },
  })
}

describeDb('#1847 — recovered anchors are attributed from the chain, not from fresh facts', () => {
  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
    setAnchor(null)
    setAnchorRecovery(null)
    setAnchorLiveness(null)
    setRevoker(null)
    setRevocationProbe(null)
    setReceiptSigningKey(RECEIPT_KEY)
    process.env.AGENT_PASSPORT_SCHEMA_UID_84532 = '0x' + '1'.repeat(64)
  })
  afterEach(() => {
    setAnchor(null)
    setAnchorRecovery(null)
    setAnchorLiveness(null)
    setRevoker(null)
    setRevocationProbe(null)
    setReceiptSigningKey(null)
    vi.restoreAllMocks()
  })

  it('a recovery that crosses a COMPLETED re-key leaves the stale anchor visible to the re-anchor queue', async () => {
    const { agentId, userId, oldUid } = await seedBroadcastLostAgent()
    // The re-key completes while the attest sits unmined — #2065's
    // "attest lands late" race feeding #1043's recovery.
    await rekeyTo(agentId, NEW_DELEGATE)

    // Recovery finds the mined tx; its bytes attest the OLD delegate. The
    // mint seam must never fire — recovery owns this row.
    setAnchorRecovery(recoveryOf(oldUid, OLD_DELEGATE))
    setAnchor(async () => {
      throw new Error('must not mint — a recoverable broadcast owns this row (#1043)')
    })

    const row = await issuePassport(agentId, userId)
    expect(row?.status).toBe('anchored')
    expect(row?.attestation_uid).toBe(oldUid)

    // THE fix: the DB records what the chain says — the OLD delegate — even
    // though the fresh claim named the new one.
    expect(row?.agent_eoa?.toLowerCase()).toBe(OLD_DELEGATE.toLowerCase())

    // …which is exactly what makes the #1699 invariant fire: the row is due
    // for a re-anchor on the next sweep tick instead of persisting forever.
    const due = await repo.listReanchorsDue(10)
    expect(due.map((d) => d.agent_id)).toContain(agentId)
  })

  it('POSITIVE CONTROL: a healthy recovery (no re-key) anchors and is NOT queued for re-anchoring', async () => {
    const { agentId, userId, oldUid } = await seedBroadcastLostAgent()
    setAnchorRecovery(recoveryOf(oldUid, OLD_DELEGATE))
    setAnchor(async () => {
      throw new Error('must not mint — a recoverable broadcast owns this row (#1043)')
    })

    const row = await issuePassport(agentId, userId)
    expect(row?.status).toBe('anchored')
    expect(row?.attestation_uid).toBe(oldUid)
    expect(row?.agent_eoa?.toLowerCase()).toBe(OLD_DELEGATE.toLowerCase())
    // The attested key IS the current key — nothing to re-anchor.
    expect(await repo.listReanchorsDue(10)).toEqual([])
  })

  it('POSITIVE CONTROL: the ordinary mint path still attributes from the fresh claim', async () => {
    // No prior broadcast: the row mints normally and the claim is the truth.
    const n = ++seq
    const user = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`p1847-mint-${n}-${Date.now()}@test.example`],
    )
    const userId = user.rows[0].id
    const safe = await db.query<{ id: string }>(
      `INSERT INTO user_safes (user_id, safe_address, chain_id) VALUES ($1, $2, $3) RETURNING id`,
      [userId, TREASURY, CHAIN],
    )
    const agent = await db.query<{ id: string }>(
      `INSERT INTO agents (user_id, name, safe_id, delegate_address, status)
       VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
      [userId, `mint path agent ${n}`, safe.rows[0].id, OLD_DELEGATE],
    )
    const agentId = agent.rows[0].id
    await repo.insertRequested(agentId, CHAIN, 0)
    setAnchor(async () => ({ attestationUid: NEW_UID, txHash: ANCHOR_TX }))

    const row = await issuePassport(agentId, userId)
    expect(row?.status).toBe('anchored')
    expect(row?.agent_eoa?.toLowerCase()).toBe(OLD_DELEGATE.toLowerCase())
    expect(await repo.listReanchorsDue(10)).toEqual([])
  })

  it('the recovered stale anchor then heals through the EXISTING #1699 machinery, unchanged', async () => {
    const { agentId, userId, oldUid } = await seedBroadcastLostAgent()
    await rekeyTo(agentId, NEW_DELEGATE)
    setAnchorRecovery(recoveryOf(oldUid, OLD_DELEGATE))
    setAnchor(async () => {
      throw new Error('must not mint yet')
    })
    await issuePassport(agentId, userId)

    // Next sweep tick: retire the recovered-but-stale attestation, reissue
    // for the key the agent actually holds. Nothing #1847-specific runs here.
    const revoked: string[] = []
    setRevoker(async (_chain, uid) => {
      revoked.push(uid)
      return { txHash: REVOKE_TX }
    })
    setAnchorRecovery(null)
    const anchoredClaims: Array<{ agentEoa: string }> = []
    setAnchor(async (_chain, claim) => {
      anchoredClaims.push({ agentEoa: claim.agentEoa })
      return { attestationUid: NEW_UID, txHash: ANCHOR_TX }
    })

    expect(await reconcileReanchor(agentId, userId)).toBe('anchored')
    expect(revoked).toEqual([oldUid])
    expect(anchoredClaims[0]?.agentEoa.toLowerCase()).toBe(NEW_DELEGATE.toLowerCase())

    const row = await repo.findByAgent(agentId)
    expect(row?.attestation_uid).toBe(NEW_UID)
    expect(row?.agent_eoa?.toLowerCase()).toBe(NEW_DELEGATE.toLowerCase())
    expect(await repo.listReanchorsDue(10)).toEqual([])
  })

  it('POSITIVE CONTROL: an ABANDONED (or mid-flight) re-key does NOT queue a re-anchor — the attestation still names the agent’s canonical key', async () => {
    // A re-key abandoned past the revoke leaves `agents.delegate_address`
    // UNCHANGED — rotation happens only inside `completeRekey`. The anchored
    // attestation therefore still names the agent's canonical current key:
    // its spend authority is empty (delegations revoked on-chain, said
    // plainly by the abandon response's `agent_has_no_authority`), but the
    // passport attests governance, never spend authority, and re-anchoring
    // to a replacement key that never ACTIVATED would be wrong. Fail closed:
    // nothing here may touch this row.
    const { agentId, userId, oldUid } = await seedBroadcastLostAgent()
    setAnchorRecovery(recoveryOf(oldUid, OLD_DELEGATE))
    setAnchor(async () => {
      throw new Error('must not mint — a recoverable broadcast owns this row (#1043)')
    })
    await issuePassport(agentId, userId)

    // The abandoned re-key row, exactly as the abandon route leaves it.
    await db.query(
      `INSERT INTO agent_rekeys (agent_id, initiated_by_user_id, old_delegate_address, new_delegate_address, stage)
       VALUES ($1, $2, $3, $4, 'abandoned')`,
      [agentId, userId, OLD_DELEGATE, NEW_DELEGATE],
    )

    expect(await repo.listReanchorsDue(10)).toEqual([])
    const revoker = vi.fn(async () => ({ txHash: REVOKE_TX }))
    setRevoker(revoker)
    expect(await reconcileReanchor(agentId, userId)).toBe('anchored')
    expect(revoker).not.toHaveBeenCalled()

    const row = await repo.findByAgent(agentId)
    expect(row?.status).toBe('anchored')
    expect(row?.attestation_uid).toBe(oldUid)
  })
})
