/**
 * #1699 — the passport re-anchors on a re-key, with standing unbroken.
 *
 * A re-key rotates `agents.delegate_address` in place. `PASSPORT_SCHEMA`'s
 * first field is `address agentEoa` and EAS attestations are IMMUTABLE, so the
 * live attestation keeps naming the RETIRED key until it is revoked and a new
 * one is issued. #1847 is that state observed in the wild after #1698 shipped
 * the backend re-key without this half.
 *
 * ## Why this file is on the real database
 *
 * Nearly every claim here is a claim about what Postgres does, and per
 * `docs/contributing/testing-strategy.md` those belong on the harness:
 *
 * - the re-anchor QUEUE is a SQL predicate (`agent_eoa <> delegate_address`),
 *   not a flag anyone writes — a mock would only prove the mock was told the
 *   right answer, and the whole point of an invariant queue is that it is true
 *   of rows nobody remembered to enqueue;
 * - `claimReanchorRevocation` and `claimRevocation` must be mutually
 *   exclusive, which is a property of two WHERE clauses meeting one row;
 * - `resetForReanchor`'s refusals (unconfirmed revocation, wrong uid) are
 *   CHECK-shaped preconditions in the UPDATE itself.
 *
 * The chain is the collaborator, and it is mocked: `setAnchor`, `setRevoker`
 * and `setRevocationProbe` are the module's own injection seams.
 */
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import * as repo from '../../../infra/repositories/agent-passports.js'
import { setAnchor, setAnchorLiveness, setAnchorRecovery } from '../issuance.js'
import {
  anchorForPassport,
  isStaleAnchor,
  passportStanding,
  setRevocationProbe,
  setRevoker,
} from '../revocation.js'
import { setReceiptSigningKey } from '../receipt.js'
import { reconcileReanchor, reconcilePendingReanchors, listStuckReanchors } from '../reanchor.js'
import { rotateAgentCredentials } from '../../../infra/repositories/agent-rekeys.js'
import { verifyPassport } from '../verification.js'

const CHAIN = 84532
/** The key the passport was issued against. */
const OLD_DELEGATE = '0x' + 'a'.repeat(40)
/** The key the re-key rotated to. */
const NEW_DELEGATE = '0x' + 'c'.repeat(40)
const TREASURY = '0x' + 'b'.repeat(40)
const NEW_UID = '0x' + '22'.repeat(32)
/** `agent_passports_uid_idx` is unique, so each seeded agent needs its own. */
const oldUidFor = (n: number) => '0x' + n.toString(16).padStart(64, '1')
const RECEIPT_KEY = '0x' + '11'.repeat(32)
const REVOKE_TX = '0x' + '33'.repeat(32)
const ANCHOR_TX = '0x' + '44'.repeat(32)

let seq = 0

interface Seeded {
  agentId: string
  userId: string
  /** The uid of the attestation this agent was anchored with. */
  oldUid: string
}

/**
 * A LEGACY-rail agent on purpose, for the same reason `presumed-dropped-attest`
 * uses one: `issuePassport` derives a Hybrid account address for
 * delegation-rail agents, which is a chain call this file has no business
 * making. The binding logic is #971/#974's and is covered elsewhere.
 */
async function seedAnchoredAgent(): Promise<Seeded> {
  const n = ++seq
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`p1699-${n}-${Date.now()}@test.example`],
  )
  const userId = user.rows[0].id
  const safe = await db.query<{ id: string }>(
    `INSERT INTO user_safes (user_id, safe_address, chain_id) VALUES ($1, $2, $3) RETURNING id`,
    [userId, TREASURY, CHAIN],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name, safe_id, delegate_address, status)
     VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
    [userId, `rekey passport agent ${n}`, safe.rows[0].id, OLD_DELEGATE],
  )
  const agentId = agent.rows[0].id
  const oldUid = oldUidFor(n)
  await repo.insertRequested(agentId, CHAIN, 0)
  await repo.claimForAnchoring(agentId, OLD_DELEGATE)
  await repo.markAnchored(agentId, {
    attestationUid: oldUid,
    txHash: ANCHOR_TX,
    agentEoa: OLD_DELEGATE,
    smartAccount: null,
  })
  return { agentId, userId, oldUid }
}

/** Exactly what #1698's `rotateAgentCredentials` does to the column we key on. */
async function rekeyTo(agentId: string, delegate: string): Promise<void> {
  await db.query(`UPDATE agents SET delegate_address = $2 WHERE id = $1`, [agentId, delegate])
}

describeDb('#1699 — passport re-anchoring on re-key', () => {
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

  // ── The invariant queue ────────────────────────────────────────────────

  describe('the re-anchor queue is an invariant, not a flag', () => {
    it('a re-keyed agent enters the queue with nothing having enqueued it', async () => {
      const { agentId } = await seedAnchoredAgent()
      // Control: a healthy agent is NOT in the queue. Without this the next
      // assertion would pass against a query that returns every row.
      expect(await repo.listReanchorsDue(10)).toEqual([])

      await rekeyTo(agentId, NEW_DELEGATE)

      const due = await repo.listReanchorsDue(10)
      expect(due.map((r) => r.agent_id)).toEqual([agentId])
    })

    it('an agent that never anchored cannot be mistaken for a stale one', async () => {
      const { agentId } = await seedAnchoredAgent()
      // Back to the pre-anchor state: `agent_eoa` NULL is what distinguishes
      // "never anchored" from "anchored against a key that has since changed".
      await db.query(
        `UPDATE agent_passports SET status = 'pending', agent_eoa = NULL, attestation_uid = NULL
          WHERE agent_id = $1`,
        [agentId],
      )
      await rekeyTo(agentId, NEW_DELEGATE)
      expect(await repo.listReanchorsDue(10)).toEqual([])
    })

    it('a REVOKED agent belongs to the revocation queue, never this one', async () => {
      const { agentId } = await seedAnchoredAgent()
      await rekeyTo(agentId, NEW_DELEGATE)
      expect((await repo.listReanchorsDue(10)).length).toBe(1) // control

      await db.query(`UPDATE agents SET status = 'revoked' WHERE id = $1`, [agentId])

      // Mutually exclusive: out of one queue and into the other, never both.
      expect(await repo.listReanchorsDue(10)).toEqual([])
      expect((await repo.listRevocationsDue(10)).map((r) => r.agent_id)).toEqual([agentId])
    })

    it('a checksum-only casing difference is NOT stale', async () => {
      // The failure this guards is not cosmetic: a case-sensitive comparison
      // would put a healthy agent into a permanent loop, revoking and
      // re-minting its credential once per sweep.
      const { agentId } = await seedAnchoredAgent()
      await rekeyTo(agentId, OLD_DELEGATE.toUpperCase().replace('0X', '0x'))
      expect(await repo.listReanchorsDue(10)).toEqual([])
      expect(isStaleAnchor(OLD_DELEGATE, OLD_DELEGATE.toUpperCase().replace('0X', '0x'))).toBe(false)
    })
  })

  // ── The revoke-before-reissue order, enforced in SQL ────────────────────

  describe('resetForReanchor refuses to erase a live credential', () => {
    it('refuses while the retired attestation is not confirmed revoked', async () => {
      const { agentId, oldUid } = await seedAnchoredAgent()
      await rekeyTo(agentId, NEW_DELEGATE)

      expect(await repo.resetForReanchor(agentId, oldUid)).toBe(false)

      // The uid — the ONLY pointer Haven holds to a credential still live
      // on-chain — survives the refusal.
      const row = await repo.findByAgent(agentId)
      expect(row?.attestation_uid).toBe(oldUid)
      expect(row?.status).toBe('anchored')
    })

    it('refuses when the confirmed revocation is for a DIFFERENT uid', async () => {
      const { agentId, oldUid } = await seedAnchoredAgent()
      await rekeyTo(agentId, NEW_DELEGATE)
      await repo.claimReanchorRevocation(agentId)
      await repo.markRevocationConfirmed(agentId, REVOKE_TX)

      expect(await repo.resetForReanchor(agentId, NEW_UID)).toBe(false)
      expect(await repo.resetForReanchor(agentId, oldUid)).toBe(true) // control
    })

    it('clears every anchor column but keeps the passport IDENTITY', async () => {
      const { agentId, oldUid } = await seedAnchoredAgent()
      const before = await repo.findByAgent(agentId)
      await rekeyTo(agentId, NEW_DELEGATE)
      await repo.claimReanchorRevocation(agentId)
      await repo.markRevocationConfirmed(agentId, REVOKE_TX)

      expect(await repo.resetForReanchor(agentId, oldUid)).toBe(true)

      const after = await repo.findByAgent(agentId)
      expect(after).toMatchObject({
        status: 'pending',
        attestation_uid: null,
        tx_hash: null,
        agent_eoa: null,
        anchored_at: null,
        revocation_status: 'none',
        revocation_confirmed_at: null,
        // Reset, not carried: a fresh attestation is a new attempt, and
        // inheriting the old count would start it inside the 1h backoff cap
        // and trip the attention alarm on a perfectly healthy re-anchor.
        attempts: 0,
        revocation_attempts: 0,
      })
      // Identity and history run unbroken across the rotation — the point of
      // #1699. Same row, same request time, same chain, same level.
      expect(after?.agent_id).toBe(before?.agent_id)
      expect(after?.requested_at).toEqual(before?.requested_at)
      expect(after?.chain_id).toBe(before?.chain_id)
      expect(after?.assurance_level).toBe(before?.assurance_level)
    })
  })

  describe('claimReanchorRevocation is a separate gate, not a loosened one', () => {
    it('refuses a healthy agent — it cannot revoke an anchor that is not stale', async () => {
      const { agentId } = await seedAnchoredAgent()
      expect(await repo.claimReanchorRevocation(agentId)).toBe(false)
    })

    it('refuses a revoked agent, whose anchor belongs to claimRevocation', async () => {
      const { agentId } = await seedAnchoredAgent()
      await rekeyTo(agentId, NEW_DELEGATE)
      await db.query(`UPDATE agents SET status = 'revoked' WHERE id = $1`, [agentId])
      expect(await repo.claimReanchorRevocation(agentId)).toBe(false)
      expect(await repo.claimRevocation(agentId)).toBe(true) // the other gate takes it
    })

    it('leases the row so a second claimant submits nothing', async () => {
      const { agentId } = await seedAnchoredAgent()
      await rekeyTo(agentId, NEW_DELEGATE)
      expect(await repo.claimReanchorRevocation(agentId)).toBe(true)
      expect(await repo.claimReanchorRevocation(agentId)).toBe(false)
    })
  })

  // ── End to end ─────────────────────────────────────────────────────────

  describe('reconcileReanchor', () => {
    it('retires the old attestation and anchors the new key', async () => {
      const { agentId, userId, oldUid } = await seedAnchoredAgent()
      await rekeyTo(agentId, NEW_DELEGATE)

      const revoked: string[] = []
      setRevoker(async (_chain, uid) => {
        revoked.push(uid)
        return { txHash: REVOKE_TX }
      })
      const anchoredClaims: Array<{ agentEoa: string }> = []
      setAnchor(async (_chain, claim) => {
        anchoredClaims.push({ agentEoa: claim.agentEoa })
        return { attestationUid: NEW_UID, txHash: ANCHOR_TX }
      })

      expect(await reconcileReanchor(agentId, userId)).toBe('anchored')

      // Revoke happened, and it happened to the OLD uid.
      expect(revoked).toEqual([oldUid])
      // The new attestation names the NEW key. This is the whole feature.
      expect(anchoredClaims).toHaveLength(1)
      expect(anchoredClaims[0].agentEoa.toLowerCase()).toBe(NEW_DELEGATE.toLowerCase())

      const row = await repo.findByAgent(agentId)
      expect(row?.status).toBe('anchored')
      expect(row?.attestation_uid).toBe(NEW_UID)
      expect(row?.agent_eoa?.toLowerCase()).toBe(NEW_DELEGATE.toLowerCase())
      // And the queue is empty again — the invariant is what closes it.
      expect(await repo.listReanchorsDue(10)).toEqual([])
    })

    it('standing stays ACTIVE the whole way through, including mid-flight', async () => {
      const { agentId, userId } = await seedAnchoredAgent()
      expect((await passportStanding(agentId)).standing).toBe('active')

      await rekeyTo(agentId, NEW_DELEGATE)
      const midFlight = await passportStanding(agentId)
      expect(midFlight.standing).toBe('active')
      // …and the window is NAMED rather than mistaken for a healthy anchor.
      expect(midFlight.anchor).toBe('re_anchoring')
      // `chainLagging` is the REVOKED-agent warning and must stay false here,
      // or the UI would tell an owner to treat a live agent as revoked.
      expect(midFlight.chainLagging).toBe(false)

      setRevoker(async () => ({ txHash: REVOKE_TX }))
      setAnchor(async () => ({ attestationUid: NEW_UID, txHash: ANCHOR_TX }))
      await reconcileReanchor(agentId, userId)

      const after = await passportStanding(agentId)
      expect(after.standing).toBe('active')
      expect(after.anchor).toBe('anchored')
    })

    it('a chain failure costs the agent nothing and stays retryable', async () => {
      const { agentId, userId, oldUid } = await seedAnchoredAgent()
      await rekeyTo(agentId, NEW_DELEGATE)

      setRevoker(async () => {
        throw new Error('rpc down')
      })
      expect(await reconcileReanchor(agentId, userId)).toBe('re_anchoring')

      // Standing intact — the acceptance criterion that matters most.
      expect((await passportStanding(agentId)).standing).toBe('active')
      // The old uid is NOT erased: it is still live on-chain and losing the
      // pointer would strand it permanently.
      const row = await repo.findByAgent(agentId)
      expect(row?.attestation_uid).toBe(oldUid)
      expect(row?.status).toBe('anchored')

      // Retryable: the backoff parks it, and it is due again when that expires.
      expect(await repo.listReanchorsDue(10)).toEqual([])
      await db.query(
        `UPDATE agent_passports SET revocation_next_attempt_at = NOW() - INTERVAL '1 second'
          WHERE agent_id = $1`,
        [agentId],
      )
      expect((await repo.listReanchorsDue(10)).map((r) => r.agent_id)).toEqual([agentId])

      // And the retry converges once the chain recovers.
      setRevoker(async () => ({ txHash: REVOKE_TX }))
      setAnchor(async () => ({ attestationUid: NEW_UID, txHash: ANCHOR_TX }))
      expect(await reconcileReanchor(agentId, userId)).toBe('anchored')
    })

    it('closes on a revoke that already mined, without spending gas again', async () => {
      // #1758's convergence probe, inherited by re-anchoring because both
      // paths share `retireAttestationOnChain`. EAS reverts a second revoke of
      // the same uid, so without this the row could never converge.
      const { agentId, userId } = await seedAnchoredAgent()
      await rekeyTo(agentId, NEW_DELEGATE)

      setRevocationProbe(async () => ({ state: 'revoked', txHash: REVOKE_TX }))
      const revoker = vi.fn(async () => ({ txHash: REVOKE_TX }))
      setRevoker(revoker)
      setAnchor(async () => ({ attestationUid: NEW_UID, txHash: ANCHOR_TX }))

      expect(await reconcileReanchor(agentId, userId)).toBe('anchored')
      expect(revoker).not.toHaveBeenCalled()
    })

    it('an agent with NO passport is untouched by a re-key', async () => {
      const { agentId, userId } = await seedAnchoredAgent()
      await db.query(`DELETE FROM agent_passports WHERE agent_id = $1`, [agentId])
      await rekeyTo(agentId, NEW_DELEGATE)

      const revoker = vi.fn(async () => ({ txHash: REVOKE_TX }))
      const anchor = vi.fn(async () => ({ attestationUid: NEW_UID, txHash: ANCHOR_TX }))
      setRevoker(revoker)
      setAnchor(anchor)

      expect(await reconcileReanchor(agentId, userId)).toBe('not_anchored')
      // Opt-out means opt-out: re-key must not mint a credential nobody asked for.
      expect(revoker).not.toHaveBeenCalled()
      expect(anchor).not.toHaveBeenCalled()
      expect(await repo.findByAgent(agentId)).toBeNull()
    })

    it('an owner revoke DURING the retire mints nothing — fail-closed', async () => {
      // The nastiest interleaving available: the retire is in flight, the
      // owner hits Revoke, and the re-anchor is about to mint a replacement.
      // Minting here would hand a REVOKED agent a fresh, live credential —
      // the #973 divergence, created by the very machinery meant to close it.
      const { agentId, userId } = await seedAnchoredAgent()
      await rekeyTo(agentId, NEW_DELEGATE)

      setRevoker(async () => {
        await db.query(`UPDATE agents SET status = 'revoked' WHERE id = $1`, [agentId])
        return { txHash: REVOKE_TX }
      })
      const anchor = vi.fn(async () => ({ attestationUid: NEW_UID, txHash: ANCHOR_TX }))
      setAnchor(anchor)

      await reconcileReanchor(agentId, userId)

      // Nothing was minted. `issuePassport` refuses a revoked agent, and that
      // refusal is what closes this window — not anything in reanchor.ts,
      // which is why it is asserted here rather than assumed.
      expect(anchor).not.toHaveBeenCalled()
      const row = await repo.findByAgent(agentId)
      expect(row?.attestation_uid).toBeNull()

      // And the resting state is honest: the retired attestation IS revoked
      // on-chain, nothing replaced it, so there is no live credential for a
      // revoked agent and nothing for the stuck-revoke alarm to chase.
      const after = await passportStanding(agentId)
      expect(after.standing).toBe('revoked')
      expect(after.anchor).toBe('not_anchored')
      expect(after.chainLagging).toBe(false)
      expect(await repo.listRevocationsDue(10)).toEqual([])
      expect(await repo.listReanchorsDue(10)).toEqual([])
    })

    it('RESUMES a re-anchor abandoned between the retire and the reset', async () => {
      // Found in review of this slice. The retire and the reset are sequential
      // statements with a chain round-trip between them, so a crash, a deploy
      // or an expired lease can land in the gap. The row is then `anchored` +
      // `confirmed` on a LIVE agent with a stale EOA — and both the queue and
      // the claim gate originally treated `confirmed` as terminal, so nothing
      // ever picked it up again. The agent kept a dead attestation forever.
      const { agentId, userId, oldUid } = await seedAnchoredAgent()
      await rekeyTo(agentId, NEW_DELEGATE)

      // Reproduce the abandoned state exactly: retire confirmed, no reset.
      await repo.claimReanchorRevocation(agentId)
      await repo.markRevocationConfirmed(agentId, REVOKE_TX)
      expect((await repo.findByAgent(agentId))?.attestation_uid).toBe(oldUid)

      // 1. It is still DUE. This is the assertion that would have caught it.
      expect((await repo.listReanchorsDue(10)).map((r) => r.agent_id)).toEqual([agentId])

      // 2. And it finishes without re-submitting a revoke. EAS reverts a
      //    second revoke of the same uid `AlreadyRevoked`, so a
      //    restart-from-the-top would burn gas and never converge.
      const revoker = vi.fn(async () => ({ txHash: REVOKE_TX }))
      setRevoker(revoker)
      setAnchor(async () => ({ attestationUid: NEW_UID, txHash: ANCHOR_TX }))

      expect(await reconcileReanchor(agentId, userId)).toBe('anchored')
      expect(revoker).not.toHaveBeenCalled()
      expect((await repo.findByAgent(agentId))?.agent_eoa?.toLowerCase()).toBe(
        NEW_DELEGATE.toLowerCase(),
      )
    })

    it('never shows a live agent as revoked, in ANY state of the rotation', async () => {
      // The display half of the same finding, asserted at every step rather
      // than at the ends — the defect lived entirely in the middle.
      const { agentId, userId } = await seedAnchoredAgent()
      await rekeyTo(agentId, NEW_DELEGATE)

      const seen: string[] = []
      const record = async () => {
        const st = await passportStanding(agentId)
        seen.push(`${st.standing}/${st.anchor}`)
      }
      await record() // stale, revocation_status 'none'
      await repo.claimReanchorRevocation(agentId)
      await record() // stale, revocation_status 'pending'
      await repo.markRevocationConfirmed(agentId, REVOKE_TX)
      await record() // stale, revocation_status 'confirmed' — the gap

      setRevoker(async () => ({ txHash: REVOKE_TX }))
      setAnchor(async () => ({ attestationUid: NEW_UID, txHash: ANCHOR_TX }))
      await reconcileReanchor(agentId, userId)
      await record() // done

      expect(seen).toEqual([
        'active/re_anchoring',
        'active/re_anchoring',
        'active/re_anchoring',
        'active/anchored',
      ])
      // Stated as its own assertion because it is the acceptance criterion,
      // not a consequence: no window shows the agent as revoked.
      expect(seen.some((s) => s.includes('revoked'))).toBe(false)
    })

    it('binds whatever key is current, even if a SECOND re-key landed mid-flight', async () => {
      const { agentId, userId } = await seedAnchoredAgent()
      await rekeyTo(agentId, NEW_DELEGATE)

      const second = '0x' + 'd'.repeat(40)
      setRevoker(async () => {
        // The owner re-keys again while the retire is in flight.
        await rekeyTo(agentId, second)
        return { txHash: REVOKE_TX }
      })
      const claims: string[] = []
      setAnchor(async (_chain, claim) => {
        claims.push(claim.agentEoa)
        return { attestationUid: NEW_UID, txHash: ANCHOR_TX }
      })

      await reconcileReanchor(agentId, userId)
      // Re-read, not remembered: anchoring the intermediate key would leave
      // the row stale the moment it succeeded.
      expect(claims[0].toLowerCase()).toBe(second.toLowerCase())
      expect(await repo.listReanchorsDue(10)).toEqual([])
    })
  })

  // ── Coupled to #1698's REAL rotation, not a hand-written UPDATE ─────────

  describe('the coupling to the re-key itself', () => {
    it("#1698's own credential rotation is what puts the passport in this queue", async () => {
      // Every other test in this file writes `delegate_address` directly, which
      // proves the queue works against the state a re-key LEAVES — not that a
      // re-key actually produces that state. This one runs the production
      // statement `completeRekey` uses (`ROTATE_AGENT_CREDENTIALS_SQL`), so the
      // two halves are pinned together. If #1698 ever stopped writing that
      // column — or wrote it somewhere else — this is what would notice.
      const { agentId, userId } = await seedAnchoredAgent()
      expect(await repo.listReanchorsDue(10)).toEqual([]) // control

      const rotated = await rotateAgentCredentials({
        agentId,
        userId,
        oldDelegateAddress: OLD_DELEGATE,
        newDelegateAddress: NEW_DELEGATE,
        apiKeyHash: 'hash-new-1699',
        apiKeyPrefix: 'sk_agent_new',
      })
      expect(rotated).toBe(true)

      expect((await repo.listReanchorsDue(10)).map((r) => r.agent_id)).toEqual([agentId])
      // …and the re-key never touched standing, which is the criterion the
      // whole slice is judged on.
      expect((await passportStanding(agentId)).standing).toBe('active')
    })
  })

  // ── The sweep and its alarm ────────────────────────────────────────────

  describe('the sweep', () => {
    it('isolates a poison row so the rows behind it still get their turn', async () => {
      const a = await seedAnchoredAgent()
      const b = await seedAnchoredAgent()
      await rekeyTo(a.agentId, NEW_DELEGATE)
      await rekeyTo(b.agentId, NEW_DELEGATE)
      // Oldest-first ordering puts `a` first on every tick, so if a throw
      // escaped the loop `b` would never be reached — not now, not ever.
      await db.query(
        `UPDATE agent_passports SET anchored_at = NOW() - INTERVAL '1 hour' WHERE agent_id = $1`,
        [a.agentId],
      )

      let calls = 0
      setRevoker(async () => {
        calls++
        if (calls === 1) throw new Error('poison')
        return { txHash: REVOKE_TX }
      })
      setAnchor(async () => ({ attestationUid: NEW_UID, txHash: ANCHOR_TX }))

      const result = await reconcilePendingReanchors()
      expect(result.attempted).toBe(2)
      expect((await repo.findByAgent(b.agentId))?.agent_eoa?.toLowerCase()).toBe(
        NEW_DELEGATE.toLowerCase(),
      )
    })

    it('alarms on a stale anchor left unreconciled past the threshold', async () => {
      const { agentId } = await seedAnchoredAgent()
      await rekeyTo(agentId, NEW_DELEGATE)
      expect(await listStuckReanchors(3600)).toEqual([]) // control: fresh

      await db.query(
        `UPDATE agent_passports SET anchored_at = NOW() - INTERVAL '2 hours' WHERE agent_id = $1`,
        [agentId],
      )
      const stuck = await listStuckReanchors(3600)
      expect(stuck.map((r) => r.agent_id)).toEqual([agentId])
      // The alarm names both addresses — an operator reading it should not
      // have to query for what "stale" meant.
      expect(stuck[0].agent_eoa?.toLowerCase()).toBe(OLD_DELEGATE.toLowerCase())
      expect(stuck[0].delegate_address?.toLowerCase()).toBe(NEW_DELEGATE.toLowerCase())
    })
  })

  // ── What a merchant sees ───────────────────────────────────────────────

  describe('the verifier', () => {
    it('reports re_anchoring rather than calling a retired credential current', async () => {
      const { agentId } = await seedAnchoredAgent()
      await rekeyTo(agentId, NEW_DELEGATE)

      const result = await verifyPassport({ address: OLD_DELEGATE })
      expect(result.found).toBe(true)
      if (!result.found) throw new Error('unreachable')
      const receipt = result.signed.receipt
      // Standing is the answer and it is unchanged: the agent is authorised.
      expect(receipt.standing).toBe('active')
      // The anchor is not. Saying `anchored` here would tell a merchant a
      // credential is current when the address it names cannot spend (#1847).
      expect(receipt.anchor).toBe('re_anchoring')
      expect(receipt.agentId).toBe(agentId)
    })
  })
})

// ── The pure mapping, worth pinning on its own ──────────────────────────

describe('anchorForPassport with a stale anchor (#1699)', () => {
  it('outranks revocation_pending, because the re-anchor claim SETS that column', () => {
    // The ordering is load-bearing: `claimReanchorRevocation` writes
    // `revocation_status = 'pending'`, so a lower-ranked branch would make the
    // entire re-key window read as "this agent lost its standing".
    expect(anchorForPassport('anchored', 'pending', true)).toBe('re_anchoring')
    expect(anchorForPassport('anchored', 'pending', false)).toBe('revocation_pending')
  })

  it('ALSO outranks a confirmed revocation, for the same reason (review of #1699)', () => {
    // Amended after review. `confirmed` is terminal for an ordinary revoke but
    // INTERMEDIATE for a re-anchor — it is the state between the retire
    // landing and `resetForReanchor` clearing the row. Ranking it above
    // `staleAnchor` made a live, fully authorised agent read `revoked_onchain`
    // in that gap, which the dashboard renders as "Revoked on-chain" in the
    // danger tone. The window is short but it is not theoretical: the two
    // writes are sequential statements with no transaction around them.
    expect(anchorForPassport('anchored', 'confirmed', true)).toBe('re_anchoring')
    // The control, and the reason the reorder is safe: without a stale anchor
    // — i.e. for a genuinely revoked agent — `confirmed` still means revoked.
    expect(anchorForPassport('anchored', 'confirmed', false)).toBe('revoked_onchain')
  })

  it('is inert for a row that never anchored', () => {
    expect(anchorForPassport('pending', 'none', true)).toBe('not_anchored')
  })

  it('defaults to false, so no existing caller changes behaviour', () => {
    expect(anchorForPassport('anchored', 'none')).toBe('anchored')
  })
})

describe('isStaleAnchor', () => {
  it('is false when either side is unknown — absence is not disagreement', () => {
    expect(isStaleAnchor(null, NEW_DELEGATE)).toBe(false)
    expect(isStaleAnchor(OLD_DELEGATE, null)).toBe(false)
  })

  it('is true only for a genuinely different address', () => {
    expect(isStaleAnchor(OLD_DELEGATE, NEW_DELEGATE)).toBe(true)
    expect(isStaleAnchor(OLD_DELEGATE, OLD_DELEGATE)).toBe(false)
  })
})
