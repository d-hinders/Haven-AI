/**
 * Session rotation — the refill mechanism for the session-key rail
 * (Stage 2 gate #734, epic #733).
 *
 * Smart Sessions' `usage.limit` is a lifetime cumulative, so the
 * AllowanceModule's defining feature — "N USDC, refills every M minutes" —
 * has no native policy. Rotation reproduces it with zero own Solidity: time
 * is cut into fixed periods derived from the agent's existing
 * `reset_period_min`, each period gets its own session with a fresh budget,
 * and rotating = ONE owner-signed tx that atomically removes the old session
 * and enables the new one.
 *
 * Design properties:
 *
 * - **Deterministic per-period identity.** The session salt is derived from
 *   (agent id, period index), so the period-N session — and therefore its
 *   `permissionId` — is computable statelessly by anyone at any time.
 *   "Is rotation due?" is a pure comparison: expected current-period
 *   permissionId vs the one on record. No schedule state to store or drift.
 * - **No double-spend, no dead window.** The rotation batch removes the old
 *   session and enables the new one in the SAME transaction — the old dies at
 *   the exact moment the new lives. A session stays valid one period past its
 *   own (`validUntil` = end of the NEXT period), so a slightly late owner
 *   signature does not strand the agent; the worst case across a boundary is
 *   old-remaining + new budget, the same boundary semantics the
 *   AllowanceModule reset has.
 * - **Non-custody preserved.** Haven only CONSTRUCTS the rotation payload.
 *   The owner signs it (the /safe-exec pattern — see safe-owner-tx.ts); the
 *   backend never holds a key that could rotate or widen a session. A leaked
 *   session key is bounded by the period budget and expires with the session.
 *
 * Pure construction — unit-testable without a network.
 */

import { keccak256, toUtf8Bytes, Interface, getAddress } from 'ethers'
import type { Hex } from 'viem'
import pool from '../db.js'
import { getChain } from './chains.js'
import {
  buildHavenPolicySession,
  getEnableSessionsAction,
  getPermissionId,
  getRemoveSessionAction,
  type HavenPolicySessionArgs,
} from './session-policies.js'
import { encodeMultiSendTransactions, type InnerTx } from './safe7579-provisioning.js'

const MULTI_SEND_ABI = ['function multiSend(bytes transactions) payable']
const multiSendIface = new Interface(MULTI_SEND_ABI)

/** The agent's policy shape, minus the fields rotation derives per period. */
export type RotationPolicyArgs = Omit<
  HavenPolicySessionArgs,
  'salt' | 'validUntilSec' | 'validAfterSec' | 'cumulativeLimitAtomic' | 'perTxCapAtomic'
> & {
  /** The per-period budget — maps 1:1 to the AllowanceModule allowance_amount. */
  budgetAtomic: bigint
  /** Optional tighter per-tx cap; defaults to the full period budget. */
  perTxCapAtomic?: bigint
}

export interface RotationSession {
  session: ReturnType<typeof buildHavenPolicySession>
  permissionId: Hex
  periodIndex: number
  /** Unix seconds — end of the FOLLOWING period (one period of grace). */
  validUntilSec: number
}

/** Which fixed period a timestamp falls in. Periods start at the Unix epoch. */
export function periodIndexAt(nowSec: number, resetPeriodMin: number): number {
  if (!Number.isFinite(resetPeriodMin) || resetPeriodMin <= 0) {
    throw new Error(`rotation requires a positive reset period, got ${resetPeriodMin}`)
  }
  return Math.floor(nowSec / (resetPeriodMin * 60))
}

/** Deterministic per-(agent, period) salt — see the design notes above. */
export function rotationSalt(agentId: string, periodIndex: number): Hex {
  return keccak256(toUtf8Bytes(`haven-session-rotation:${agentId}:${periodIndex}`)) as Hex
}

/**
 * Build the session for the period containing `nowSec`. Deterministic: the
 * same inputs always yield the same session and permissionId.
 */
export function buildRotationSession(
  agentId: string,
  policy: RotationPolicyArgs,
  resetPeriodMin: number,
  nowSec: number,
): RotationSession {
  const periodIndex = periodIndexAt(nowSec, resetPeriodMin)
  const periodSec = resetPeriodMin * 60
  // Valid through the end of the NEXT period — grace for a late owner
  // signature; the rotation batch removes it the moment the successor enables.
  const validUntilSec = (periodIndex + 2) * periodSec
  const { budgetAtomic, ...rest } = policy
  const session = buildHavenPolicySession({
    ...rest,
    // Per-tx cap = the period budget (AllowanceModule parity: any single
    // payment may use up to the remaining allowance).
    perTxCapAtomic: policy.perTxCapAtomic ?? budgetAtomic,
    cumulativeLimitAtomic: budgetAtomic,
    validUntilSec,
    salt: rotationSalt(agentId, periodIndex),
    chainId: policy.chainId,
  })
  return { session, permissionId: getPermissionId({ session }), periodIndex, validUntilSec }
}

/**
 * Rotation is due when the period has advanced past the session on record —
 * i.e. the CURRENT period's deterministic permissionId no longer matches.
 * Stateless: no rotation schedule is stored anywhere.
 */
export function isRotationDue(
  agentId: string,
  policy: RotationPolicyArgs,
  resetPeriodMin: number,
  currentPermissionId: string | null,
  nowSec: number,
): boolean {
  if (!currentPermissionId) return true
  const expected = buildRotationSession(agentId, policy, resetPeriodMin, nowSec)
  return expected.permissionId.toLowerCase() !== currentPermissionId.toLowerCase()
}

export interface RotationPayload {
  /** MultiSendCallOnly for the chain (single-call rotations target Smart Sessions directly). */
  to: string
  value: string
  data: string
  /** 1 = delegatecall into MultiSendCallOnly; 0 = plain CALL (first enable). */
  operation: 0 | 1
  /** The successor session's permissionId — record it once the tx confirms. */
  newPermissionId: Hex
}

/**
 * The ONE owner transaction that rotates: remove the previous session and
 * enable the successor, atomically. With no previous session (first rotation
 * after provisioning, or a fully expired predecessor) it is a single enable.
 * Haven constructs; the owner signs.
 */
export function buildRotationPayload(
  chainId: number,
  previousPermissionId: Hex | null,
  next: RotationSession,
): RotationPayload {
  const enable = getEnableSessionsAction({ sessions: [next.session] })

  if (!previousPermissionId) {
    return {
      to: getAddress(enable.target),
      value: '0',
      data: enable.callData,
      operation: 0,
      newPermissionId: next.permissionId,
    }
  }

  const remove = getRemoveSessionAction({ permissionId: previousPermissionId })
  const batch: InnerTx[] = [
    { to: getAddress(remove.target), value: 0n, data: remove.callData, operation: 0 },
    { to: getAddress(enable.target), value: 0n, data: enable.callData, operation: 0 },
  ]
  return {
    to: getAddress(getChain(chainId).contracts.multiSendCallOnly),
    value: '0',
    data: multiSendIface.encodeFunctionData('multiSend', [encodeMultiSendTransactions(batch)]),
    operation: 1,
    newPermissionId: next.permissionId,
  }
}

/**
 * Record the rotated session on the agent AFTER the owner tx confirms.
 * Guarded on the previous value so a stale/concurrent rotation cannot
 * clobber a newer one (returns false if nothing matched).
 */
export async function recordRotatedSession(
  agentId: string,
  previousPermissionId: string | null,
  newPermissionId: string,
): Promise<boolean> {
  const result = await pool.query<{ id: string }>(
    `UPDATE agents
     SET session_permission_id = $1
     WHERE id = $2
       AND session_permission_id IS NOT DISTINCT FROM $3
     RETURNING id`,
    [newPermissionId, agentId, previousPermissionId],
  )
  return result.rows.length > 0
}
