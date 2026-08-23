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
 *
 * ## What CLOSES a revocation (#1758)
 *
 * "Retries until they agree" needs something that can observe agreement.
 * Until #1758 only one thing could: a fresh `revokeOnChain` returning a
 * status-1 receipt. That is unreachable in the case that matters — once the
 * attestation is revoked on-chain, EAS reverts every later revoke of the same
 * UID — so a revoke that mined after #1742's bounded wait expired left the row
 * `pending` FOREVER, alarming about a credential that was already dead and
 * burning gas hourly on a doomed transaction.
 *
 * `reconcileRevocation` now asks the chain directly, before it spends
 * anything: **is this attestation already revoked, as of a settled block?**
 * That fact closes the row regardless of which transaction set it or whether
 * Haven ever saw a receipt. Every other answer — live, unreadable, no probe
 * wired — behaves exactly as this module did before, so the probe can only
 * ever remove a stuck state, never create one.
 */

import * as repo from '../../infra/repositories/agent-passports.js'
import { redactVendorSecrets } from '../../rails/execution-rail.js'
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

/**
 * Progress of the on-chain anchor. Never the authority.
 *
 * `re_anchoring` (#1699) is the re-key window: the attestation on-chain is
 * live but names the RETIRED delegate key, because EAS attestations are
 * immutable and `PASSPORT_SCHEMA`'s first field is `address agentEoa`. It is
 * its own state rather than folded into `anchored` — the credential is real,
 * so calling it `not_anchored` would be false — and rather than folded into
 * `revocation_pending`, which says the agent LOST its standing. Here the agent
 * is live and fully authorised; only the anchor is behind.
 */
export type AnchorState =
  | 'not_anchored'
  | 'anchored'
  | 're_anchoring'
  | 'revocation_pending'
  | 'revoked_onchain'

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
  staleAnchor = false,
): AnchorState {
  if (passportStatus !== 'anchored') return 'not_anchored'
  // Ordered ABOVE BOTH revocation checks, and that is the whole subtlety of
  // this function. A re-anchor drives the row through the SAME
  // `revocation_status` column an ordinary revoke uses — `pending` while it
  // holds the lease, then `confirmed` for the moment between the retire
  // landing and `resetForReanchor` clearing the row. Read without this branch,
  // a routine re-key would report `revocation_pending` and then
  // `revoked_onchain` for an agent that is live and fully authorised, and the
  // dashboard would render "Revoked on-chain" in the danger tone at the exact
  // moment nothing is wrong.
  //
  // Safe because the two situations cannot overlap: `staleAnchor` is only ever
  // true for a LIVE agent (every caller gates it on `agents.status <>
  // 'revoked'`, and so does the SQL predicate that feeds the queue), while an
  // ordinary revocation only reaches `pending`/`confirmed` for a REVOKED one
  // (`claimRevocation` requires it). So a genuinely revoked agent can never
  // take this branch, and a live one has no other honest answer.
  if (staleAnchor) return 're_anchoring'
  if (revocationStatus === 'confirmed') return 'revoked_onchain'
  if (revocationStatus === 'pending') return 'revocation_pending'
  return 'anchored'
}

/**
 * Does the live attestation name a key the agent no longer holds? (#1699)
 *
 * Case-insensitive because neither column is normalised on write across every
 * path that has ever written them, and an address that differs only in EIP-55
 * checksum casing is the SAME address — treating it as stale would put a
 * healthy agent into a permanent re-anchor loop, revoking and re-minting a
 * credential once per sweep.
 */
export function isStaleAnchor(
  attestedEoa: string | null,
  currentDelegate: string | null,
): boolean {
  if (!attestedEoa || !currentDelegate) return false
  return attestedEoa.toLowerCase() !== currentDelegate.toLowerCase()
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
  const anchor = anchorForPassport(
    row.passport_status,
    row.revocation_status,
    standing !== 'revoked' && isStaleAnchor(row.agent_eoa, row.delegate_address),
  )

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
 * What the chain says about an attestation's revoked bit (#1758).
 *
 * `revoked` is POSITIVE EVIDENCE, read as of a settled block: the attestation
 * is revoked and will stay revoked. `live` is the attestation existing with
 * `revocationTime = 0`. `unknown` is the absence of an answer — no provider,
 * no settled vantage point, an unreadable UID — and is deliberately NOT a
 * third behaviour at the call site: it takes the same branch as `live`, which
 * is the branch this code took before the probe existed. Only `revoked`
 * concludes anything.
 *
 * `txHash` is the evidence pointer migration 049 requires before a row may
 * read `confirmed`; it is null when the chain agrees but Haven has no record
 * of the transaction that did it. Injected like {@link Revoker} so this module
 * stays free of ethers and the relayer.
 */
export type RevocationAnchorState = 'revoked' | 'live' | 'unknown'
export interface RevocationAnchorReading {
  state: RevocationAnchorState
  txHash: string | null
}
export type RevocationAnchorProbe = (
  chainId: number,
  attestationUid: string,
) => Promise<RevocationAnchorReading>

let revocationProbeImpl: RevocationAnchorProbe | null = null
export function setRevocationProbe(probe: RevocationAnchorProbe | null): void {
  revocationProbeImpl = probe
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

  return retireAttestationOnChain(
    agentId,
    row.chain_id,
    row.attestation_uid,
    row.revocation_attempts,
  )
}

/**
 * Retire ONE attestation on-chain and record the outcome. Shared by both
 * paths that retire a credential (#1699).
 *
 * Extracted verbatim from `reconcileRevocation` when re-anchoring needed the
 * same step, rather than reimplemented beside it. The #1758 probe-before-spend
 * reasoning and the #1745-shaped fail-safes below are subtle enough that a
 * second copy would be a second thing to keep correct — and the failure mode
 * of a drifted copy is a live credential nobody revokes.
 *
 * The CALLER owns the invariant check and the lease: this function assumes the
 * right to submit has already been claimed atomically
 * (`claimRevocation` for a revoked agent, `claimReanchorRevocation` for a
 * stale anchor). It never checks agent status itself, which is exactly why it
 * must not be exported beyond this module's own callers.
 */
export async function retireAttestationOnChain(
  agentId: string,
  chainId: number,
  attestationUid: string,
  revocationAttempts: number,
): Promise<'revoked_onchain' | 'revocation_pending'> {
  if (!isPassportConfigured(chainId)) {
    await repo.scheduleRevocationRetry(
      agentId,
      'revocation anchor unavailable (schema unregistered or no revoker configured)',
      revocationBackoffSeconds(revocationAttempts),
    )
    return 'revocation_pending'
  }

  // ── Converge before spending gas (#1758) ────────────────────────────────
  //
  // Ask the chain whether this attestation is ALREADY revoked, before
  // submitting a revoke that would be doomed if it is. This is the only path
  // that can close a revoke which mined after #1742's 120 s wait expired: the
  // bump worker closes the `outbound_txs` row and stops there, and a fresh
  // `revokeOnChain` can never succeed again once the UID is revoked, because
  // EAS reverts it `AlreadyRevoked`. Without this the row stayed `pending`
  // permanently — false stuck-revoke alarm, hourly gas burn, no self-heal.
  //
  // A PULL, not a push. Nothing teaches the passport row from the outbound
  // side: `outbound_txs` is the relayer's ledger and holds no agent id, so a
  // push would mean inventing a join and coupling the generic queue to this
  // module. The pull also covers what a push never could — an attestation
  // revoked by an operator by hand, by another deployment, or by a
  // transaction whose receipt Haven never saw.
  //
  // FAIL-SAFE, like #1745's liveness probe: unwired, throwing, or answering
  // `unknown` all fall through to the submit below, which is exactly what this
  // function did before the probe existed. Nothing here can conclude
  // `confirmed` from a read that did not happen.
  if (revocationProbeImpl) {
    let reading: RevocationAnchorReading = { state: 'unknown', txHash: null }
    try {
      reading = await revocationProbeImpl(chainId, attestationUid)
    } catch {
      // An unreadable chain is not an answer. Fall through and submit.
    }
    if (reading.state === 'revoked') {
      // Migration 049: `confirmed` is unrepresentable without a tx hash. The
      // row's own `revocation_tx_hash` is no help — it is written only BY the
      // confirmation, in the same statement, so on a pending row it is always
      // null — which leaves the probe's pointer as the only source. With none,
      // we do NOT invent one, and we do NOT broadcast a revoke the chain has
      // already made pointless: the row stays pending and keeps alarming,
      // which is the honest state for "the chain agrees, but Haven cannot say
      // what made it agree".
      if (!reading.txHash) {
        await repo.scheduleRevocationRetry(
          agentId,
          'attestation already revoked on-chain, but no revoke transaction is recorded for it — ' +
            'cannot record a confirmation without its evidence pointer (#1758)',
          revocationBackoffSeconds(revocationAttempts),
        )
        return 'revocation_pending'
      }
      await repo.markRevocationConfirmed(agentId, reading.txHash)
      return 'revoked_onchain'
    }
  }

  if (!revokerImpl) {
    await repo.scheduleRevocationRetry(
      agentId,
      'revocation anchor unavailable (schema unregistered or no revoker configured)',
      revocationBackoffSeconds(revocationAttempts),
    )
    return 'revocation_pending'
  }

  try {
    getEasDeployment(chainId)
    const { txHash } = await revokerImpl(chainId, attestationUid)
    await repo.markRevocationConfirmed(agentId, txHash)
    return 'revoked_onchain'
  } catch (err) {
    await repo.scheduleRevocationRetry(
      agentId,
      redactVendorSecrets(err instanceof Error ? err.message : String(err)),
      revocationBackoffSeconds(revocationAttempts),
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
