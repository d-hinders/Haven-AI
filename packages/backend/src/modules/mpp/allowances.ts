/**
 * `GET /allowances` orchestration (#1135/#1144, moved by #997). The
 * agent-facing spend-authority report, rail-aware: on the legacy
 * AllowanceModule rail it reads the live on-chain state; on the delegation
 * rail it derives remaining budget from the agent's own active, owner-signed
 * delegations (#1090); a retired session-rail account gets the #993
 * fail-closed 410 rather than a state read. Preserve exactly — tests pass
 * unmodified (`routes/__tests__/machine-payments.test.ts`'s "GET /allowances
 * — rail-aware (#1135)" and "— legacy-rail characterization" suites).
 */
import { resolveExecutionRail, sessionRailRetired } from '../../rails/execution-rail.js'
import { listAllowanceConfigForAgent } from '../../infra/repositories/agents.js'
import { deriveDelegationBudgets } from '../../rails/delegation-budget-view.js'
import {
  getTokenAllowance,
  getLatestBlockTimeSec,
  computeEffectiveAllowance,
} from '../../rails/allowance-module.js'
import type { AgentContext } from '../../middleware/agentAuth.js'
import type { MppHandlerResult } from './types.js'

interface AgentAllowanceRow {
  id: string
  token_address: string
  token_symbol: string
  allowance_amount: string
  reset_period_min: number
}

export async function handleGetAllowances(agent: AgentContext): Promise<MppHandlerResult> {
  // #1135: this endpoint was rail-blind — it read the on-chain
  // AllowanceModule unconditionally, so a delegation-rail account (no Safe,
  // no AllowanceModule) reported zeros forever and the SDK derived
  // needs_approval for a fully funded agent. Resolve the rail FIRST.
  const railDecision = resolveExecutionRail({
    safeExecutionRail: agent.execution_rail ?? null,
    chainId: agent.chain_id,
  })
  if (railDecision.rail === 'retired_session') {
    // #993 fail-closed contract: a retired rail's state must not be
    // readable here either — the 410 verbatim, nothing read.
    const retired = sessionRailRetired('account')
    return { statusCode: retired.statusCode, body: retired.body }
  }

  if (agent.execution_rail === 'delegation') {
    // Delegation rail: the authority IS the active agent_delegations set,
    // derived through the #1090 shared view (agent_allowances is a frozen
    // onboarding mirror on this rail — reading it would report the
    // onboarding budget forever). remaining = the period budget: the
    // period-refill caveat re-arms on-chain each period and is enforced at
    // redemption, so an over-budget attempt reverts — nothing queues.
    // spent / nonce / reset bookkeeping have no AllowanceModule analogue
    // here; zeros keep the wire shape the SDK already parses. No active
    // delegation → empty array, so derived readiness stays needs_approval.
    const budgets = (await deriveDelegationBudgets([agent.id])).get(agent.id) ?? []
    return {
      statusCode: 200,
      body: {
        agent_id: agent.id,
        safe_address: agent.safe_address,
        delegate_address: agent.delegate_address,
        chain_id: agent.chain_id,
        allowances: budgets.map((b) => ({
          id: b.id,
          token_address: b.token_address,
          token_symbol: b.token_symbol,
          configured_amount: b.allowance_amount,
          reset_period_min: b.reset_period_min,
          onchain: {
            amount: b.budget_atomic,
            spent: '0',
            remaining: b.budget_atomic,
            effective_spent: '0',
            reset_time_min: b.reset_period_min,
            last_reset_min: 0,
            nonce: 0,
            is_reset_pending: false,
          },
        })),
      },
    }
  }

  // Legacy AllowanceModule rail — unchanged (characterization-pinned).
  const rows: AgentAllowanceRow[] = await listAllowanceConfigForAgent(agent.id)

  const allowances = []
  for (const row of rows) {
    try {
      const [onchain, chainTimeSec] = await Promise.all([
        getTokenAllowance(
          agent.chain_id,
          agent.safe_address,
          agent.delegate_address,
          row.token_address,
        ),
        getLatestBlockTimeSec(agent.chain_id),
      ])
      const effective = computeEffectiveAllowance(onchain, chainTimeSec)

      allowances.push({
        id: row.id,
        token_address: row.token_address,
        token_symbol: row.token_symbol,
        configured_amount: row.allowance_amount,
        reset_period_min: row.reset_period_min,
        onchain: {
          amount: onchain.amount.toString(),
          spent: onchain.spent.toString(),
          remaining: effective.remaining.toString(),
          effective_spent: effective.effectiveSpent.toString(),
          reset_time_min: onchain.resetTimeMin,
          last_reset_min: onchain.lastResetMin,
          nonce: onchain.nonce,
          is_reset_pending: effective.isResetPending,
        },
      })
    } catch (err) {
      return {
        statusCode: 502,
        body: {
          error: 'Failed to read on-chain allowance',
          token_address: row.token_address,
          details: err instanceof Error ? err.message : String(err),
        },
      }
    }
  }

  return {
    statusCode: 200,
    body: {
      agent_id: agent.id,
      safe_address: agent.safe_address,
      delegate_address: agent.delegate_address,
      chain_id: agent.chain_id,
      allowances,
    },
  }
}
