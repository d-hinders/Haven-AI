/**
 * Schedule → authorize-path wiring (#769, epic #733): lazy rollover with no
 * owner signature.
 *
 * The pure schedule builders (session-schedule.ts) make every session in an
 * enabled window deterministic, so this module only has to (1) load the
 * stored inputs — the window (agents.session_schedule_*, #769), the recipient
 * policy (agent_recipients, #784) and the per-token reset period
 * (agent_allowances) — (2) recompute which permissionId the CURRENT period
 * should use, and (3) flip `agents.session_permission_id` to it, guarded and
 * race-safe via the existing recordRotatedSession.
 *
 * Fail-closed at every seam: no schedule window, no matching recipient row,
 * no allowance, a zero budget or a period outside the window all yield null —
 * the authorize path proceeds exactly as before (recorded session only, #734
 * behavior). This is bookkeeping, not authority: the owner signed every
 * session in the window up front; the flip only changes which of the
 * already-enabled sessions the backend points at.
 *
 * On-chain verification is the prepare step itself: the caller flips the
 * record only AFTER `prepareSessionTransfer` succeeds against the scheduled
 * permissionId — bundler gas estimation exercises the real Smart Sessions
 * config, so a schedule that was never actually enabled on-chain can never
 * capture the pointer (the payment 502s and the DB stays untouched).
 */

import pool from '../db.js'
import { loadAgentRecipients } from './agent-recipients.js'
import { resolveScheduleRollover, buildSessionSchedule } from './session-schedule.js'
import { recordRotatedSession, type RotationPolicyArgs } from './session-rotation.js'

export interface ScheduledAuthorization {
  /** The permissionId the current period's payment should prepare against. */
  permissionId: `0x${string}`
  /** What the agent row currently records (the guard for the flip). */
  recordedPermissionId: string | null
  /** True when a successful prepare should be followed by commitScheduleRollover. */
  rolloverDue: boolean
  /** Periods left in the window — surfaces the renewal prompt (#770). */
  periodsRemaining: number
}

interface ScheduleWindowRow {
  session_schedule_from_period: number | null
  session_schedule_period_count: number | null
  session_permission_id: string | null
  delegate_address: string | null
  reset_period_min: number | null
}

/**
 * Recompute the schedule for the payment's (agent, token, recipient) and say
 * which permissionId this period uses. Null = no applicable schedule — caller
 * keeps its current behavior (fail-closed).
 */
export async function resolveScheduledAuthorization(
  agent: { id: string; chain_id: number },
  tokenAddress: string,
  toAddress: string,
  nowSec: number,
): Promise<ScheduledAuthorization | null> {
  const result = await pool.query<ScheduleWindowRow>(
    `SELECT a.session_schedule_from_period, a.session_schedule_period_count,
            a.session_permission_id, a.delegate_address,
            al.reset_period_min
     FROM agents a
     LEFT JOIN agent_allowances al
       ON al.agent_id = a.id AND LOWER(al.token_address) = LOWER($2)
     WHERE a.id = $1`,
    [agent.id, tokenAddress],
  )
  const row = result.rows[0]
  if (
    !row ||
    row.session_schedule_from_period == null ||
    row.session_schedule_period_count == null ||
    row.session_schedule_period_count < 1 ||
    !row.delegate_address ||
    !row.reset_period_min ||
    row.reset_period_min <= 0
  ) {
    return null
  }

  // The recipient policy for THIS payment's target (#784). No row = the
  // schedule does not cover this recipient — fail closed to recorded behavior
  // (the on-chain session policy would reject the transfer anyway).
  const recipients = await loadAgentRecipients(agent.id, tokenAddress)
  const recipient = recipients.find(
    (r) => r.recipientAddress.toLowerCase() === toAddress.toLowerCase(),
  )
  if (!recipient || recipient.budgetAtomic <= 0n) return null

  const policy: RotationPolicyArgs = {
    sessionKeyAddress: row.delegate_address as `0x${string}`,
    usdcAddress: tokenAddress as `0x${string}`,
    allowedRecipient: recipient.recipientAddress as `0x${string}`,
    budgetAtomic: recipient.budgetAtomic,
    chainId: BigInt(agent.chain_id),
  }

  const schedule = buildSessionSchedule(
    agent.id,
    policy,
    row.reset_period_min,
    row.session_schedule_from_period,
    row.session_schedule_period_count,
  )
  const rollover = resolveScheduleRollover(
    agent.id,
    policy,
    row.reset_period_min,
    schedule.entries,
    row.session_permission_id,
    nowSec,
  )
  if (!rollover) return null // current period outside the window → renew (#770)

  return {
    permissionId: rollover.currentPermissionId,
    recordedPermissionId: row.session_permission_id,
    rolloverDue: rollover.rolloverDue,
    periodsRemaining: rollover.periodsRemaining,
  }
}

/**
 * Flip the recorded session to the scheduled one — call ONLY after the
 * prepare step succeeded against `scheduled.permissionId` (that success is
 * the on-chain proof the session is enabled). Guarded on the previous value;
 * a lost race just means another request already flipped it.
 */
export async function commitScheduleRollover(
  agentId: string,
  scheduled: ScheduledAuthorization,
): Promise<boolean> {
  return recordRotatedSession(agentId, scheduled.recordedPermissionId, scheduled.permissionId)
}

/**
 * Whether the agent is on the session rail with an enabled schedule window
 * (#802): policy mutations on such an agent take on-chain effect only after
 * the owner's next schedule signature — callers surface a warning so an
 * unapplied edit does not silently stall payments (the recompute diverges
 * from the enabled sessions and prepare fails, fail-closed).
 */
export async function agentHasEnabledSchedule(agentId: string): Promise<boolean> {
  const result = await pool.query<{
    execution_rail: string | null
    session_schedule_from_period: number | null
  }>(
    `SELECT us.execution_rail, a.session_schedule_from_period
     FROM agents a
     LEFT JOIN user_safes us ON us.id = a.safe_id
     WHERE a.id = $1`,
    [agentId],
  )
  const row = result.rows[0]
  return row?.execution_rail === 'session_key' && row.session_schedule_from_period != null
}

/** The warning text mutation responses carry when a schedule is enabled (#802). */
export const SCHEDULE_APPLY_WARNING =
  'This agent pays from a pre-approved budget schedule — the change takes effect ' +
  'on-chain after your next budget signature (Update budget or Sign to apply). ' +
  'Until then, payments continue on the previously signed policy.'
