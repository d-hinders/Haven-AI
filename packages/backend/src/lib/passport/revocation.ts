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

/** How the caller should treat this agent, right now. */
export type Standing = 'active' | 'revoked' | 'unknown'

/** Progress of the on-chain anchor. Never the authority. */
export type AnchorState = 'not_anchored' | 'anchored' | 'revocation_pending' | 'revoked_onchain'

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
  const standing: Standing = row.agent_status === 'revoked' ? 'revoked' : 'active'

  let anchor: AnchorState = 'not_anchored'
  if (row.passport_status === 'anchored') {
    anchor =
      row.revocation_status === 'confirmed'
        ? 'revoked_onchain'
        : row.revocation_status === 'pending'
          ? 'revocation_pending'
          : 'anchored'
  }

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
 * Safe to call repeatedly — that is the retry mechanism. Returns the resulting
 * anchor state so a sweep can report progress.
 */
export async function reconcileRevocation(agentId: string): Promise<AnchorState> {
  const row = await repo.findByAgent(agentId)
  if (!row) return 'not_anchored'
  if (row.status !== 'anchored' || !row.attestation_uid) return 'not_anchored'
  if (row.revocation_status === 'confirmed') return 'revoked_onchain'
  if (row.revocation_status !== 'pending') return 'anchored'

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

/** Retry sweep for due revocations. Idempotent and resumable. */
export async function reconcilePendingRevocations(limit = 50): Promise<{ attempted: number }> {
  const due = await repo.listRevocationsDue(limit)
  for (const row of due) await reconcileRevocation(row.agent_id)
  return { attempted: due.length }
}

/**
 * Revocations unreconciled past `olderThanSeconds` — the stuck-revoke alarm.
 * A stuck revoke is an operational incident: merchants reading only the chain
 * still see the agent as valid.
 */
export async function listStuckRevocations(olderThanSeconds = 3600) {
  return repo.listStuckRevocations(olderThanSeconds)
}
