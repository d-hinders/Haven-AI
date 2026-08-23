/**
 * Re-anchor an Agent Passport after a re-key (#1699, epic #1694).
 *
 * ## Why an attestation cannot simply be updated
 *
 * `PASSPORT_SCHEMA`'s first field is `address agentEoa` (`schema.ts`), and EAS
 * attestations are IMMUTABLE. A re-key rotates `agents.delegate_address` in
 * place — same agent id, same name, same history — so the moment it completes,
 * the live attestation names a key the agent no longer holds. There is no
 * mutable-anchor option to reach for: the only way to make the chain agree is
 * to revoke the old attestation and issue a new one.
 *
 * ## What stays continuous, and what does not
 *
 * **Standing is untouched.** It derives from `agents.status`
 * (`revocation.ts:standingForStatus`), which a re-key never writes. Nothing in
 * this file can change it, and that is deliberate: an acceptance criterion of
 * #1699 is that a chain problem must never cost an agent its standing. The
 * worst outcome available here is a stale anchor that keeps retrying.
 *
 * **The passport row's identity is untouched.** `resetForReanchor` clears the
 * anchor columns and nothing else — `agent_id`, `requested_at`, `chain_id` and
 * `assurance_level` survive, so the passport is the same passport across the
 * rotation rather than a new one that happens to look similar.
 *
 * **The on-chain anchor is NOT continuous, and cannot be.** Between the revoke
 * and the new attestation there is a window with no live credential. That is
 * forced by the epic's revoke-before-issue order, adopted here for the reason
 * it was adopted at the authority layer (#1694): the alternative — mint first,
 * revoke second — leaves TWO live credentials for one agent, one of which
 * names a retired key, and a partial failure makes that state permanent. A
 * window with no credential fails to "this agent has no passport right now",
 * which is recoverable and honest. A window with two fails to a credential
 * nobody can account for.
 *
 * The window is what `re_anchoring` exists to render (`AgentPassportCard`), so
 * it is visible rather than mistaken for `anchored`.
 *
 * ## Why the queue is an invariant, not a flag
 *
 * `listReanchorsDue` asks "does the anchored attestation name an address the
 * agent no longer uses?" rather than reading a flag someone had to remember to
 * write. Same reasoning as `LIST_REVOCATIONS_DUE_SQL`: a re-key that completed
 * before this code existed, or one whose process died between the credential
 * swap and the enqueue, would never have had the flag written — and would
 * strand a live credential for a retired key forever. The invariant is
 * self-healing. The best-effort kick on the completion path is an OPTIMISATION
 * on top of it, never the mechanism.
 */

import * as repo from '../../infra/repositories/agent-passports.js'
import { issuePassport } from './issuance.js'
import {
  isStaleAnchor,
  retireAttestationOnChain,
  type AnchorState,
} from './revocation.js'

/**
 * Push one stale anchor toward agreeing with the agent's current key.
 *
 * Safe to call repeatedly — that IS the retry mechanism — and safe to call for
 * an agent that was never re-keyed: `claimReanchorRevocation` re-checks the
 * stale-anchor invariant as part of the same atomic UPDATE, so this cannot
 * revoke a healthy agent's attestation no matter who calls it.
 *
 * Returns the resulting anchor state so a sweep can report progress.
 */
export async function reconcileReanchor(agentId: string, userId: string): Promise<AnchorState> {
  const row = await repo.findByAgent(agentId)
  // No passport row at all: the agent opted out (#970 made issuance opt-in).
  // A re-key must leave it exactly that way — issuing one here would grant a
  // credential nobody asked for.
  if (!row) return 'not_anchored'

  // Not anchored yet — nothing on-chain to retire. A `pending` row is already
  // owned by the ISSUANCE sweep, which reads `agents.delegate_address` fresh
  // when it builds the claim, so it will anchor the new key without help.
  if (row.status !== 'anchored' || !row.attestation_uid) return 'not_anchored'

  const facts = await repo.findAgentFacts(agentId, userId)
  if (!facts) return 'not_anchored'

  // A revoked agent belongs to `reconcileRevocation`, not here. The two queues
  // are mutually exclusive in SQL as well (`a.status = 'revoked'` vs
  // `<> 'revoked'`); this is the same boundary stated at the call site, so a
  // revoke landing mid-re-anchor hands the row over rather than racing.
  if (facts.agent_status === 'revoked') return 'revocation_pending'

  if (!isStaleAnchor(row.agent_eoa, facts.delegate_address)) return 'anchored'

  // ── Resume, do not restart ──────────────────────────────────────────────
  //
  // `confirmed` means the retire already landed. For an ordinary revocation
  // that is terminal; here it is the MIDDLE of the operation, because the row
  // still has to be handed back to issuance. The two steps are sequential
  // statements with no transaction around them — deliberately, since one of
  // them is a chain round-trip — so a crash, a deploy or a lease expiry can
  // land squarely between them. Re-submitting a revoke for an already-revoked
  // uid is not an option either: EAS reverts it `AlreadyRevoked`, so a
  // restart-from-the-top would burn gas and never converge.
  //
  // Skipping straight to the reset is safe precisely because `resetForReanchor`
  // re-checks `revocation_status = 'confirmed'` and the uid itself, atomically.
  // This branch cannot invent a confirmation it did not find.
  if (row.revocation_status !== 'confirmed') {
    // The single gate: invariant + lease, atomically. A loser submits NOTHING.
    if (!(await repo.claimReanchorRevocation(agentId))) return 're_anchoring'

    const retired = await retireAttestationOnChain(
      agentId,
      row.chain_id,
      row.attestation_uid,
      row.revocation_attempts,
    )
    // The retire scheduled its own backoff and stays due. Critically, the row
    // is NOT reset — the old uid is still the only pointer Haven holds to a
    // credential that is still live on-chain, and losing it would strand it.
    if (retired !== 'revoked_onchain') return 're_anchoring'
  }

  // Hand the row back to the issuance state machine. Refuses unless the
  // revocation is confirmed AND the uid matches the one just retired.
  if (!(await repo.resetForReanchor(agentId, row.attestation_uid))) return 're_anchoring'

  // Anchor the new key now rather than waiting for the issuance sweep's next
  // tick. `issuePassport` is idempotent and re-reads the agent's facts, so it
  // binds whatever `delegate_address` currently is — including a SECOND
  // re-key that landed while this one was retiring.
  const reissued = await issuePassport(agentId, userId)
  return reissued?.status === 'anchored' ? 'anchored' : 'not_anchored'
}

/**
 * Fire-and-forget hook for the re-key completion path.
 *
 * Returns `void` and swallows everything ON PURPOSE, exactly like
 * `issuePassportBestEffort`: the re-key has already committed — new
 * delegations active, credentials rotated — and a slow or failing EAS write
 * must never turn a completed re-key into an error the owner sees. The
 * invariant-based queue is what makes that safe: the work is derivable from
 * the agent's own row, so a swallowed error is still visible to the sweep and
 * still retryable.
 */
export function reanchorPassportBestEffort(agentId: string, userId: string): void {
  void reconcileReanchor(agentId, userId).catch(() => {})
}

/**
 * Retry sweep for stale anchors. Idempotent and resumable.
 *
 * **Each row is isolated**, for the same reason as the revocation sweep:
 * `reconcileReanchor` leaves `findByAgent`, `findAgentFacts` and the claim
 * outside any try block, so one bad row or a transient pool error throws all
 * the way out. The queue is ordered oldest-first, so without this catch the
 * same row would be first on every tick and one poison row would stop every
 * re-anchor in the system, permanently.
 */
export async function reconcilePendingReanchors(
  limit = 50,
): Promise<{ attempted: number; failed: number }> {
  const due = await repo.listReanchorsDue(limit)
  let failed = 0
  for (const row of due) {
    try {
      await reconcileReanchor(row.agent_id, row.user_id)
    } catch {
      // The row still matches the invariant, so the next tick retries it — and
      // the rows behind it still get their turn now.
      failed++
    }
  }
  return { attempted: due.length, failed }
}

/**
 * Stale anchors unreconciled past `olderThanSeconds` — the stuck-re-anchor
 * alarm.
 *
 * A live agent whose credential names a retired key is an operational
 * incident, not merely untidy: a merchant reading the chain would resolve a
 * passport for an address that can no longer spend, and #1690's payer-identity
 * guard is a backstop for exactly the confusion that creates.
 */
export async function listStuckReanchors(olderThanSeconds = 3600) {
  return repo.listStuckReanchors(olderThanSeconds)
}
