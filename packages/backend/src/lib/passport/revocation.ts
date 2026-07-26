/**
 * L0 Agent Passport — revocation and live standing (#973, epic #970).
 *
 * ## The consistency model (v6 review point 1 — THE critical seam)
 *
 * The entire pitch rests on merchants trusting **live revocation**, but an EAS
 * revoke is a transaction: it can lag, fail, or sit unmined. So the authority
 * is split deliberately and asymmetrically:
 *
 * - **Haven's DB is AUTHORITATIVE.** `agents.status = 'revoked'` IS the
 *   revocation, effective the instant it is written. `passportStanding()` — and
 *   through it the verifier (#974) — answers from that alone.
 * - **The EAS anchor is EVENTUALLY CONSISTENT.** `revocation_status` tracks how
 *   far the on-chain flag has got. It never gates the answer.
 *
 * If that were inverted, a merchant checking on-chain during the lag window
 * would serve an agent Haven had already revoked. Hence the merchant-facing
 * rule, documented in `docs/architecture/11-agent-passport-schema.md`:
 * **check the verifier, not only the chain.**
 *
 * A failed revoke RETRIES with backoff until the two agree (owner decision
 * 2026-07-24). There is deliberately no terminal `failed` revocation state —
 * a struggling revoke stays `pending` and due, and one that stays unreconciled
 * past a threshold is surfaced as an operational incident, never dropped.
 */

import * as repo from '../../infra/repositories/agent-passports.js'
import { redactVendorSecrets } from '../execution-rail.js'
import { getEasDeployment, isPassportConfigured } from './schema.js'

/**
 * How the caller should treat this agent, right now.
 *
 * `suspended` covers every non-active, non-revoked agent status (`paused`
 * today, plus anything a later migration adds). It is deliberately NOT folded
 * into `active`: a paused agent must not transact, and defaulting an
 * unrecognised status to `active` would mean any future status silently
 * became a permission. Only the literal string `'active'` reads as active.
 *
 * Unlike `revoked`, `suspended` is reversible and does NOT revoke the anchor —
 * un-pausing must not require re-issuing a passport, and an EAS revoke is
 * one-way.
 */
export type Standing = 'active' | 'suspended' | 'revoked' | 'unknown'

/** Progress of the on-chain anchor. Never the authority. */
export type AnchorState = 'not_anchored' | 'anchored' | 'revocation_pending' | 'revoked_onchain'

/**
 * Agent status → standing. THE allow-list, and the only one.
 *
 * Exported and shared with the merchant-facing verifier (#974) rather than
 * duplicated there. A copy would be free to drift the moment a migration adds
 * an agent status — and the failure mode is the receipt Haven hands a merchant
 * disagreeing with Haven's own answer for the same agent, which is the exact
 * inconsistency #973 exists to eliminate, recreated one layer up.
 *
 * Allow-list, not deny-list: ONLY 'active' reads as active. A deny-list
 * (`!== 'revoked' ? 'active' : …`) makes every present and future status a
 * permission by default — it already read `paused` as active once.
 */
export function standingForStatus(agentStatus: string): Standing {
  if (agentStatus === 'revoked') return 'revoked'
  if (agentStatus === 'active') return 'active'
  return 'suspended'
}

/**
 * Passport row state → anchor progress. Shared with the verifier for the same
 * reason as `standingForStatus`.
 *
 * Takes the two columns rather than a row type so both callers' differently
 * shaped query results can use it.
 */
export function anchorForPassport(
  passportStatus: string | null,
  revocationStatus: string | null,
): AnchorState {
  if (passportStatus !== 'anchored') return 'not_anchored'
  if (revocationStatus === 'confirmed') return 'revoked_onchain'
  if (revocationStatus === 'pending') return 'revocation_pending'
  return 'anchored'
}

export interface PassportStanding {
  agentId: string
  /** THE answer. Derived from the DB alone. */
  standing: Standing
  /** Describes the chain, for transparency — not for deciding. */
  anchor: AnchorState
  attestationUid: string | null
  /**
   * True when the DB says revoked but the chain has not caught up. A merchant
   * reading only the chain during this window would be WRONG.
   */
  chainLagging: boolean
  revocationConfirmedAt: Date | null
}

/**
 * The single source of truth for "is this agent authorized right now?".
 *
 * Returns `unknown` for an agent that does not exist — never `active`. Failing
 * open on a missing agent would let a deleted or mistyped id read as usable.
 */
export async function passportStanding(agentId: string): Promise<PassportStanding> {
  const row = await repo.standingForAgent(agentId)
  if (!row) {
    return {
      agentId,
      standing: 'unknown',
      anchor: 'not_anchored',
      attestationUid: null,
      chainLagging: false,
      revocationConfirmedAt: null,
    }
  }

  // The DB decides. Note this reads `agents.status`, NOT any passport column:
  // an agent revoked before its passport ever anchored is still revoked.
  const standing = standingForStatus(row.agent_status)
  const anchor = anchorForPassport(row.passport_status, row.revocation_status)

  return {
    agentId,
    standing,
    anchor,
    attestationUid: row.attestation_uid,
    chainLagging: standing === 'revoked' && anchor !== 'revoked_onchain' && anchor !== 'not_anchored',
    revocationConfirmedAt: row.revocation_confirmed_at,
  }
}

/** The on-chain revoke, injectable like the issuance anchor. */
export type Revoker = (chainId: number, attestationUid: string) => Promise<{ txHash: string }>

let revokerImpl: Revoker | null = null
export function setRevoker(revoker: Revoker | null): void {
  revokerImpl = revoker
}

/**
 * Exponential backoff, capped. Attempt 0 → 30s, then 1m, 2m, 4m … up to 1h.
 * Capped rather than unbounded because revocation must keep trying: a schedule
 * that grows forever is indistinguishable from giving up.
 */
export function revocationBackoffSeconds(attempts: number): number {
  return Math.min(30 * 2 ** Math.max(0, attempts), 3600)
}

/**
 * Hook for the agent-revoke path. Fire-and-forget, like issuance: the DB
 * standing has already flipped and IS the revocation, so the anchor must never
 * delay or fail the user's revoke.
 */
export function revokePassportBestEffort(agentId: string): void {
  void reconcileRevocation(agentId).catch(() => {})
}

/**
 * Push the on-chain anchor one step toward agreeing with the DB.
 *
 * Safe to call repeatedly — that is the retry mechanism, and it is also safe
 * to call for an agent that is NOT revoked: `claimRevocation` checks the
 * invariant (`agents.status = 'revoked'`) as part of the same atomic UPDATE,
 * so this cannot revoke a live agent's anchor no matter who calls it.
 *
 * Returns the resulting anchor state so a sweep can report progress.
 */
export async function reconcileRevocation(agentId: string): Promise<AnchorState> {
  const row = await repo.findByAgent(agentId)
  if (!row) return 'not_anchored'
  if (row.status !== 'anchored' || !row.attestation_uid) return 'not_anchored'
  if (row.revocation_status === 'confirmed') return 'revoked_onchain'

  // The single gate: invariant + lease, atomically. A loser submits NOTHING —
  // EAS reverts a second revoke with `AlreadyRevoked`, so two concurrent
  // attempts would burn gas and then fail on every backoff cycle forever
  // instead of converging.
  if (!(await repo.claimRevocation(agentId))) {
    return row.revocation_status === 'pending' ? 'revocation_pending' : 'anchored'
  }

  if (!isPassportConfigured(row.chain_id) || !revokerImpl) {
    await repo.scheduleRevocationRetry(
      agentId,
      'revocation anchor unavailable (schema unregistered or no revoker configured)',
      revocationBackoffSeconds(row.revocation_attempts),
    )
    return 'revocation_pending'
  }

  try {
    getEasDeployment(row.chain_id)
    const { txHash } = await revokerImpl(row.chain_id, row.attestation_uid)
    await repo.markRevocationConfirmed(agentId, txHash)
    return 'revoked_onchain'
  } catch (err) {
    await repo.scheduleRevocationRetry(
      agentId,
      redactVendorSecrets(err instanceof Error ? err.message : String(err)),
      revocationBackoffSeconds(row.revocation_attempts),
    )
    return 'revocation_pending'
  }
}

/** Enqueue the anchor flip. Called after the DB standing has already changed. */
export async function enqueuePassportRevocation(agentId: string): Promise<boolean> {
  return repo.enqueueRevocation(agentId)
}

/**
 * Retry sweep for due revocations. Idempotent and resumable.
 *
 * **Each row is isolated.** `reconcileRevocation` does not catch everything —
 * its `findByAgent` and `claimRevocation` calls sit outside its try block, so a
 * transient pool error or one malformed row throws all the way out. Without
 * this catch that would abort the whole batch, and because the queue is ordered
 * OLDEST FIRST the same row would be first again on every tick: one bad row
 * silently stops every revocation in the system, forever. That is the exact
 * failure this sweep exists to prevent, so it must not be how the sweep itself
 * fails.
 *
 * Failures are counted and returned rather than swallowed — a sweep that
 * reports `attempted: 50` while failing all 50 is worse than one that says so.
 */
export async function reconcilePendingRevocations(
  limit = 50,
): Promise<{ attempted: number; failed: number }> {
  const due = await repo.listRevocationsDue(limit)
  let failed = 0
  for (const row of due) {
    try {
      await reconcileRevocation(row.agent_id)
    } catch {
      // The row stays due (nothing was marked confirmed), so the next tick
      // retries it — and the rows behind it still get their turn now.
      failed++
    }
  }
  return { attempted: due.length, failed }
}

/**
 * Revocations unreconciled past `olderThanSeconds` — the stuck-revoke alarm.
 * A stuck revoke is an operational incident: merchants reading only the chain
 * still see the agent as valid.
 */
export async function listStuckRevocations(olderThanSeconds = 3600) {
  return repo.listStuckRevocations(olderThanSeconds)
}
