/**
 * Budget-schedule API for the dashboard (#770, backend half of the UX).
 *
 * Three endpoints under user auth (owner-facing, not agent-facing):
 *
 * - GET  /agents/:id/schedule          — schedule state for the renewal banner
 * - POST /agents/:id/schedule/build    — the inner txs the owner's EXISTING
 *   policy-save signature batches in (zero added signatures in the happy path)
 * - POST /agents/:id/schedule/confirm  — record the window after the tx lands
 *
 * Non-custody contract: this API only CONSTRUCTS and BOOKKEEPS. The build
 * response is a list of plain operation-0 calls the dashboard packs into the
 * MultiSend batch the owner already signs on policy save (the same pattern as
 * allowance setup); the backend never signs. Confirm only stores which window
 * the owner enabled — it grants nothing: the lazy rollover (#769) flips only
 * after a successful on-chain prepare, so recording a window that was never
 * actually enabled on-chain cannot move money (fail-closed).
 *
 * The schedule is built per (token, recipient) row from agent_recipients
 * (#784) — every row's sessions go into ONE combined enableSessions call. The
 * recorded pointer is set to the first row's current-period session; per-
 * payment rollover re-points as needed.
 */

import { FastifyInstance } from 'fastify'
import { createPublicClient, http, type Hex } from 'viem'
import { getAccount, isSessionEnabled } from '@rhinestone/module-sdk'
import pool from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import { getAddress } from 'ethers'
import { getChain } from '../lib/chains.js'
import { loadAgentRecipients } from '../lib/agent-recipients.js'
import { getEnableSessionsAction, getRemoveSessionAction } from '../lib/session-policies.js'
import { chainForId } from '../lib/session-rail.js'
import { buildSessionSchedule, buildScheduledSession } from '../lib/session-schedule.js'
import { periodIndexAt, type RotationPolicyArgs } from '../lib/session-rotation.js'

/** Default window: ~90 days of daily periods; clamped for shorter periods. */
const DEFAULT_PERIODS = 90
const MAX_PERIODS = 400

interface AgentPolicyRow {
  id: string
  user_id: string
  delegate_address: string | null
  chain_id: number
  safe_address: string | null
  execution_rail: string | null
  session_permission_id: string | null
  session_schedule_from_period: number | null
  session_schedule_period_count: number | null
}

/** The agent joined to its Safe's rail — owner-scoped (user_id must match). */
async function loadOwnedAgent(agentId: string, userId: string): Promise<AgentPolicyRow | null> {
  const result = await pool.query<AgentPolicyRow>(
    `SELECT a.id, a.user_id, a.delegate_address, us.chain_id, us.safe_address,
            us.execution_rail, a.session_permission_id,
            a.session_schedule_from_period, a.session_schedule_period_count
     FROM agents a
     LEFT JOIN user_safes us ON us.id = a.safe_id
     WHERE a.id = $1 AND a.user_id = $2`,
    [agentId, userId],
  )
  return result.rows[0] ?? null
}

/**
 * On-chain enablement check for a claimed window (#801, defense in depth).
 * Returns 'enabled' | 'not_enabled' | 'unknown' — 'unknown' (RPC failure)
 * falls back to the pre-#801 trust-the-client behavior: availability over
 * strictness, since the payment path is already fail-closed (#769 verifies
 * via prepare before any pointer flip).
 */
async function checkEnabledOnChain(
  chainId: number,
  safeAddress: string,
  permissionId: Hex,
): Promise<'enabled' | 'not_enabled' | 'unknown'> {
  try {
    const client = createPublicClient({
      chain: chainForId(chainId),
      transport: http(getChain(chainId).rpcUrl),
    })
    const account = getAccount({ address: safeAddress as `0x${string}`, type: 'safe' })
    const enabled = await isSessionEnabled({ account, client: client as never, permissionId })
    return enabled ? 'enabled' : 'not_enabled'
  } catch {
    return 'unknown'
  }
}

interface RecipientPolicy {
  policy: RotationPolicyArgs
  resetPeriodMin: number
}

/**
 * One RotationPolicyArgs per agent_recipients row (budget inheritance already
 * resolved by loadAgentRecipients). Empty = nothing to schedule.
 */
async function loadRecipientPolicies(agent: AgentPolicyRow): Promise<RecipientPolicy[]> {
  const tokens = await pool.query<{ token_address: string; reset_period_min: number }>(
    `SELECT token_address, reset_period_min FROM agent_allowances WHERE agent_id = $1`,
    [agent.id],
  )
  const policies: RecipientPolicy[] = []
  for (const token of tokens.rows) {
    if (!token.reset_period_min || token.reset_period_min <= 0) continue
    const recipients = await loadAgentRecipients(agent.id, token.token_address)
    for (const r of recipients) {
      if (r.budgetAtomic <= 0n || !agent.delegate_address) continue
      policies.push({
        policy: {
          sessionKeyAddress: agent.delegate_address as `0x${string}`,
          usdcAddress: r.tokenAddress as `0x${string}`,
          allowedRecipient: r.recipientAddress as `0x${string}`,
          budgetAtomic: r.budgetAtomic,
          chainId: BigInt(agent.chain_id),
        },
        resetPeriodMin: token.reset_period_min,
      })
    }
  }
  return policies
}

export default async function agentScheduleRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  // ── GET /:id/schedule — state for the renewal banner ──────────────────────
  app.get<{ Params: { id: string } }>('/:id/schedule', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const agent = await loadOwnedAgent(request.params.id, sub)
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })

    const sessionRail = agent.execution_rail === 'session_key'
    if (
      !sessionRail ||
      agent.session_schedule_from_period == null ||
      agent.session_schedule_period_count == null
    ) {
      return { session_rail: sessionRail, enabled: false }
    }

    const policies = await loadRecipientPolicies(agent)
    const resetPeriodMin = policies[0]?.resetPeriodMin ?? null
    if (!resetPeriodMin) return { session_rail: true, enabled: false }

    const nowSec = Math.floor(Date.now() / 1000)
    const currentPeriod = periodIndexAt(nowSec, resetPeriodMin)
    const lastPeriod = agent.session_schedule_from_period + agent.session_schedule_period_count - 1
    const periodsRemaining = Math.max(0, lastPeriod - currentPeriod + 1)

    return {
      session_rail: true,
      enabled: currentPeriod >= agent.session_schedule_from_period && periodsRemaining > 0,
      period_min: resetPeriodMin,
      periods_remaining: periodsRemaining,
      /** The banner threshold the dashboard uses (#770: prompt at ≤2 left). */
      renewal_due: periodsRemaining <= 2,
    }
  })

  // ── POST /:id/schedule/build — inner txs for the owner's batch ────────────
  app.post<{ Params: { id: string }; Body: { periods?: number } }>(
    '/:id/schedule/build',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const agent = await loadOwnedAgent(request.params.id, sub)
      if (!agent) return reply.code(404).send({ error: 'Agent not found' })
      if (agent.execution_rail !== 'session_key') {
        return reply.code(409).send({ error: 'Account is not on the session rail' })
      }

      const periods = Math.min(
        MAX_PERIODS,
        Math.max(1, Math.trunc(request.body?.periods ?? DEFAULT_PERIODS)),
      )
      const policies = await loadRecipientPolicies(agent)
      if (policies.length === 0) {
        return reply.code(409).send({
          error: 'Agent has no recipient policy to schedule (set a recipient and budget first)',
        })
      }

      const nowSec = Math.floor(Date.now() / 1000)
      const innerTxs: Array<{ to: string; data: string }> = []

      // Replacement (#769 design): remove the OLD window's still-current-or-
      // future sessions in the same batch, so budgets never double up.
      if (
        agent.session_schedule_from_period != null &&
        agent.session_schedule_period_count != null
      ) {
        for (const { policy, resetPeriodMin } of policies) {
          const currentPeriod = periodIndexAt(nowSec, resetPeriodMin)
          const from = agent.session_schedule_from_period
          const count = agent.session_schedule_period_count
          for (let p = Math.max(from, currentPeriod); p < from + count; p++) {
            const old = buildScheduledSession(agent.id, policy, resetPeriodMin, p)
            const remove = getRemoveSessionAction({ permissionId: old.permissionId })
            innerTxs.push({ to: getAddress(remove.target), data: remove.callData })
          }
        }
      }

      // ONE combined enableSessions call covering every recipient × period.
      const allSessions = []
      let fromPeriod: number | null = null
      let firstPermissionId: Hex | null = null
      for (const { policy, resetPeriodMin } of policies) {
        const schedule = buildSessionSchedule(
          agent.id,
          policy,
          resetPeriodMin,
          periodIndexAt(nowSec, resetPeriodMin),
          periods,
        )
        allSessions.push(...schedule.sessions.map((s) => s.session))
        fromPeriod ??= schedule.entries[0].periodIndex
        firstPermissionId ??= schedule.entries[0].permissionId
      }
      const enable = getEnableSessionsAction({ sessions: allSessions })
      innerTxs.push({ to: getAddress(enable.target), data: enable.callData })

      return {
        inner_txs: innerTxs, // all plain CALLs — pack into the policy-save MultiSend
        from_period: fromPeriod,
        period_count: periods,
        first_permission_id: firstPermissionId,
        replaced: agent.session_schedule_from_period != null,
      }
    },
  )

  // ── POST /:id/schedule/confirm — record the window after the tx lands ─────
  app.post<{
    Params: { id: string }
    Body: { from_period?: number; period_count?: number; first_permission_id?: string }
  }>('/:id/schedule/confirm', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const agent = await loadOwnedAgent(request.params.id, sub)
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })

    const { from_period, period_count, first_permission_id } = request.body ?? {}
    if (
      !Number.isInteger(from_period) ||
      !Number.isInteger(period_count) ||
      (period_count as number) < 1 ||
      typeof first_permission_id !== 'string' ||
      !/^0x[0-9a-fA-F]{64}$/.test(first_permission_id)
    ) {
      return reply.code(400).send({ error: 'from_period, period_count and first_permission_id are required' })
    }

    // Verification (#801, defense in depth — a bad record cannot move money,
    // but it lies to the UI until a payment corrects the picture):
    // (a) PURE: the claimed id must be one of THIS agent's deterministic
    //     sessions for the claimed period — recording someone else's enabled
    //     session, or a stale id after a policy edit, is rejected outright.
    const policies = await loadRecipientPolicies(agent)
    const expectedIds = policies.map(({ policy, resetPeriodMin }) =>
      buildScheduledSession(agent.id, policy, resetPeriodMin, from_period as number)
        .permissionId.toLowerCase(),
    )
    if (!expectedIds.includes(first_permission_id.toLowerCase())) {
      return reply.code(409).send({
        error:
          'first_permission_id does not match any deterministic session for this ' +
          'agent and period — stale policy inputs? Rebuild the schedule and retry.',
      })
    }
    // (b) ON-CHAIN: the session must actually be enabled. One RPC; an RPC
    //     failure falls back to recording (availability over strictness —
    //     the payment path is fail-closed regardless).
    if (agent.safe_address) {
      const onChain = await checkEnabledOnChain(
        agent.chain_id,
        agent.safe_address,
        first_permission_id as Hex,
      )
      if (onChain === 'not_enabled') {
        return reply.code(409).send({
          error:
            'Session is not enabled on-chain — the schedule transaction has not ' +
            'landed (or was never sent). Confirm after it executes.',
        })
      }
    }

    await pool.query(
      `UPDATE agents
       SET session_schedule_from_period = $1,
           session_schedule_period_count = $2,
           session_permission_id = $3
       WHERE id = $4 AND user_id = $5`,
      [from_period, period_count, first_permission_id, request.params.id, sub],
    )
    return { recorded: true }
  })
}
