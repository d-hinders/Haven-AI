/**
 * Pre-signed session budget schedule (#769, epic #733) — the UX fix for
 * rotation friction.
 *
 * Per-period rotation (#734) is correct but needs an owner signature at EVERY
 * period boundary. With a daily reset that is a signature a day — unacceptable
 * for autonomous agents. Because rotation is deterministic (session N+k's
 * content and permissionId are computable today) and `getEnableSessionsAction`
 * takes an ARRAY, one owner signature can enable a whole quarter of sessions,
 * each time-locked to its own window. Then period rollover needs NO human at
 * all — the backend just switches which enabled session it uses.
 *
 * The security property that makes this safe: each scheduled session sets BOTH
 * `validAfter` (period start) and `validUntil` (period end + one period grace),
 * so a future session is DEAD before its window. Max exposure at any instant =
 * one period's budget (+ the one-period grace overlap) — identical to manual
 * rotation. A leaked session key drains at most the current window; the owner
 * can revoke the remainder at any time (kill switch below).
 *
 * Note vs #734: scheduled sessions carry `validAfter`, so their permissionId
 * differs from the single-rotation session for the same period. An account uses
 * ONE model — the schedule is the production path; #734's single rotation stays
 * for the pilot/simple case. Lazy rollover here computes the current period's
 * scheduled session with the SAME builder, so it stays self-consistent.
 *
 * Pure construction — unit-testable without a network. Haven only builds the
 * payloads; the owner signs them (the /safe-exec pattern).
 */

import { Interface, getAddress } from 'ethers'
import type { Hex } from 'viem'
import { getChain } from './chains.js'
import {
  buildHavenPolicySession,
  getEnableSessionsAction,
  getPermissionId,
  getRemoveSessionAction,
} from './session-policies.js'
import { encodeMultiSendTransactions, type InnerTx } from './safe7579-provisioning.js'
import { periodIndexAt, rotationSalt, type RotationPolicyArgs } from './session-rotation.js'

const multiSendIface = new Interface(['function multiSend(bytes transactions) payable'])

export interface ScheduledSession {
  session: ReturnType<typeof buildHavenPolicySession>
  permissionId: Hex
  periodIndex: number
  validAfterSec: number
  validUntilSec: number
}

/**
 * The session for a specific period index, time-locked to [start, end + grace].
 * Deterministic: same (agent, period) always yields the same session and id.
 */
export function buildScheduledSession(
  agentId: string,
  policy: RotationPolicyArgs,
  resetPeriodMin: number,
  periodIndex: number,
): ScheduledSession {
  if (!Number.isFinite(resetPeriodMin) || resetPeriodMin <= 0) {
    throw new Error(`schedule requires a positive reset period, got ${resetPeriodMin}`)
  }
  const periodSec = resetPeriodMin * 60
  const validAfterSec = periodIndex * periodSec
  // One period of grace past its own end — a slightly late rollover does not
  // strand the agent; the successor's window has already begun.
  const validUntilSec = (periodIndex + 2) * periodSec
  const { budgetAtomic, ...rest } = policy
  const session = buildHavenPolicySession({
    ...rest,
    perTxCapAtomic: policy.perTxCapAtomic ?? budgetAtomic,
    cumulativeLimitAtomic: budgetAtomic,
    validAfterSec,
    validUntilSec,
    salt: rotationSalt(agentId, periodIndex),
    chainId: policy.chainId,
  })
  return {
    session,
    permissionId: getPermissionId({ session }) as Hex,
    periodIndex,
    validAfterSec,
    validUntilSec,
  }
}

export interface SessionSchedule {
  sessions: ScheduledSession[]
  entries: Array<{ periodIndex: number; permissionId: Hex }>
  /** ONE owner tx: a single enableSessions call covering all periods. */
  enablePayload: { to: string; value: string; data: string; operation: 0 }
}

/**
 * Build a schedule of `count` consecutive periods starting at `fromPeriod`,
 * plus the SINGLE owner payload that enables them all (one enableSessions call —
 * no MultiSend needed).
 */
export function buildSessionSchedule(
  agentId: string,
  policy: RotationPolicyArgs,
  resetPeriodMin: number,
  fromPeriod: number,
  count: number,
): SessionSchedule {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`schedule count must be a positive integer, got ${count}`)
  }
  const sessions = Array.from({ length: count }, (_, k) =>
    buildScheduledSession(agentId, policy, resetPeriodMin, fromPeriod + k),
  )
  const enable = getEnableSessionsAction({ sessions: sessions.map((s) => s.session) })
  return {
    sessions,
    entries: sessions.map((s) => ({ periodIndex: s.periodIndex, permissionId: s.permissionId })),
    enablePayload: { to: getAddress(enable.target), value: '0', data: enable.callData, operation: 0 },
  }
}

/** Convenience: a schedule of `count` periods starting at the period containing `nowSec`. */
export function buildScheduleFromNow(
  agentId: string,
  policy: RotationPolicyArgs,
  resetPeriodMin: number,
  nowSec: number,
  count: number,
): SessionSchedule {
  return buildSessionSchedule(agentId, policy, resetPeriodMin, periodIndexAt(nowSec, resetPeriodMin), count)
}

/**
 * Replace a schedule (policy change mid-quarter, or renewal): remove the given
 * still-future sessions and enable the new schedule, ATOMICALLY, in one owner
 * tx. Folds into the same signature the user already makes when saving policy.
 */
export function buildScheduleReplacementPayload(
  chainId: number,
  removePermissionIds: Hex[],
  next: SessionSchedule,
): { to: string; value: string; data: string; operation: 0 | 1 } {
  const enable = getEnableSessionsAction({ sessions: next.sessions.map((s) => s.session) })

  if (removePermissionIds.length === 0) {
    return { to: getAddress(enable.target), value: '0', data: enable.callData, operation: 0 }
  }

  const batch: InnerTx[] = [
    ...removePermissionIds.map((permissionId): InnerTx => {
      const remove = getRemoveSessionAction({ permissionId })
      return { to: getAddress(remove.target), value: 0n, data: remove.callData, operation: 0 }
    }),
    { to: getAddress(enable.target), value: 0n, data: enable.callData, operation: 0 },
  ]
  return {
    to: getAddress(getChain(chainId).contracts.multiSendCallOnly),
    value: '0',
    data: multiSendIface.encodeFunctionData('multiSend', [encodeMultiSendTransactions(batch)]),
    operation: 1,
  }
}

/** Kill switch: remove all remaining scheduled sessions in one owner tx. */
export function buildScheduleRevokePayload(
  chainId: number,
  removePermissionIds: Hex[],
): { to: string; value: string; data: string; operation: 0 | 1 } {
  if (removePermissionIds.length === 0) {
    throw new Error('nothing to revoke')
  }
  if (removePermissionIds.length === 1) {
    const remove = getRemoveSessionAction({ permissionId: removePermissionIds[0] })
    return { to: getAddress(remove.target), value: '0', data: remove.callData, operation: 0 }
  }
  const batch: InnerTx[] = removePermissionIds.map((permissionId): InnerTx => {
    const remove = getRemoveSessionAction({ permissionId })
    return { to: getAddress(remove.target), value: 0n, data: remove.callData, operation: 0 }
  })
  return {
    to: getAddress(getChain(chainId).contracts.multiSendCallOnly),
    value: '0',
    data: multiSendIface.encodeFunctionData('multiSend', [encodeMultiSendTransactions(batch)]),
    operation: 1,
  }
}

export interface ScheduleRollover {
  /** The permissionId that should be active for the period containing nowSec. */
  currentPermissionId: Hex
  currentPeriodIndex: number
  /** True when the recorded id differs from the current period's — flip it. */
  rolloverDue: boolean
  /** Periods left in the enabled schedule (from current), for the renewal prompt. */
  periodsRemaining: number
}

/**
 * Lazy rollover decision — stateless, mirrors the schedule's determinism.
 * Given the schedule's entries and what's currently recorded, says which
 * session should be active now and whether a DB flip is due. No signature: the
 * owner already enabled every session in the schedule.
 */
export function resolveScheduleRollover(
  agentId: string,
  policy: RotationPolicyArgs,
  resetPeriodMin: number,
  scheduleEntries: Array<{ periodIndex: number; permissionId: Hex }>,
  recordedPermissionId: string | null,
  nowSec: number,
): ScheduleRollover | null {
  const currentPeriod = periodIndexAt(nowSec, resetPeriodMin)
  const entry = scheduleEntries.find((e) => e.periodIndex === currentPeriod)
  if (!entry) return null // current period is outside the enabled schedule → renew needed
  const lastPeriod = scheduleEntries.reduce((m, e) => Math.max(m, e.periodIndex), currentPeriod)
  return {
    currentPermissionId: entry.permissionId,
    currentPeriodIndex: currentPeriod,
    rolloverDue: (recordedPermissionId ?? '').toLowerCase() !== entry.permissionId.toLowerCase(),
    periodsRemaining: lastPeriod - currentPeriod + 1,
  }
}
