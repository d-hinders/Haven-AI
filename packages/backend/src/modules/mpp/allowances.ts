/**
 * `GET /allowances` orchestration (#1135/#1144, moved by #997). The
 * agent-facing spend-authority report, rail-aware: on the legacy
 * AllowanceModule rail it reads the live on-chain state; on the delegation
 * rail it derives remaining budget from the agent's own active, owner-signed
 * delegations (#1090); a retired session-rail account gets the #993
 * fail-closed 410 rather than a state read. Behavior is pinned by
 * `routes/__tests__/machine-payments.test.ts`'s "GET /allowances — rail-aware
 * (#1135)" and "— legacy-rail characterization" suites — a delegation-rail
 * `onchain` row additionally carries `remaining_is_from_chain` (#1319).
 */
import { resolveExecutionRail, sessionRailRetired } from '../../rails/execution-rail.js'
import { listAllowanceConfigForAgent } from '../../infra/repositories/agents.js'
import { deriveDelegationBudgets } from '../../rails/delegation-budget-view.js'
import { listDelegationJsonByIds } from '../../infra/repositories/delegation-budgets.js'
import { readRemainingBudget } from '../../infra/chain/delegation-budget-reader.js'
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
    // onboarding budget forever). No active delegation → empty array, so
    // derived readiness stays needs_approval.
    //
    // `remaining` comes from the ERC20PeriodTransferEnforcer's own storage
    // (#1145). That contract is what reverts an over-budget redemption and
    // what re-arms at the period boundary, so reading it makes `remaining`
    // exactly what the chain will allow. It used to report the FULL budget
    // unconditionally, which told a mid-period exhausted agent it was ready
    // and let it loop attempts that revert — no fund risk, since the caveat
    // gates every redemption, but wrong guidance.
    const all = (await deriveDelegationBudgets([agent.id])).get(agent.id) ?? []

    // Scope to the agent's chain: the response carries ONE top-level
    // chain_id, and a delegation on another chain reported under it would be
    // a straightforwardly wrong number (#1145).
    const budgets = all.filter((b) => b.chain_id === agent.chain_id)

    const delegationJson = await listDelegationJsonByIds(budgets.map((b) => b.id))
    const remainingByIdEntries = await Promise.all(
      budgets.map(async (b) => {
        const json = delegationJson.get(b.id)
        if (!json) return [b.id, { remainingAtomic: b.budget_atomic, fromChain: false }] as const
        return [b.id, await readRemainingBudget(b.chain_id, json, b.budget_atomic)] as const
      }),
    )
    const remainingById = new Map(remainingByIdEntries)

    return {
      statusCode: 200,
      body: {
        agent_id: agent.id,
        safe_address: agent.safe_address,
        delegate_address: agent.delegate_address,
        chain_id: agent.chain_id,
        allowances: budgets.map((b) => {
          const { remainingAtomic, fromChain } = remainingById.get(b.id) ?? {
            remainingAtomic: b.budget_atomic,
            fromChain: false,
          }
          // #1319: the provenance IS on the wire now (`remaining_is_from_chain`,
          // additive/optional — the legacy branch below never sets it). An
          // agent still cannot act on it directly (no new refusal, no new
          // authority), but the #1306 preflight uses it to warn when the
          // number it is reporting is the #1145 fallback rather than a live
          // read, instead of silently presenting an optimistic number as
          // certain. The fallback IS the pre-#1145 answer, never a fabricated
          // zero that would stop a funded agent — this only makes it visibly
          // optimistic. Still logged for operators too.
          if (!fromChain) {
            console.warn(
              `delegation-budget: on-chain remaining unavailable for delegation ${b.id} ` +
                `(agent ${agent.id}, chain ${b.chain_id}) — reporting the full period budget`,
            )
          }
          // Derived, not tracked: the enforcer reports what is LEFT, and the
          // budget is what it re-arms to. Clamped at zero so a budget lowered
          // mid-period (the new budget below what the old one already spent)
          // reports 0 rather than a negative.
          const spent = BigInt(b.budget_atomic) - BigInt(remainingAtomic)
          const spentAtomic = (spent > 0n ? spent : 0n).toString()
          return {
            id: b.id,
            token_address: b.token_address,
            token_symbol: b.token_symbol,
            configured_amount: b.allowance_amount,
            reset_period_min: b.reset_period_min,
            onchain: {
              amount: b.budget_atomic,
              spent: spentAtomic,
              remaining: remainingAtomic,
              effective_spent: spentAtomic,
              reset_time_min: b.reset_period_min,
              last_reset_min: 0,
              // nonce has no analogue on this rail; the zero keeps the wire
              // shape the SDK already parses.
              nonce: 0,
              is_reset_pending: false,
              // #1319: provenance of `remaining` above — true when it came
              // from the live ERC20PeriodTransferEnforcer read, false when
              // the read failed and this is the #1145 fallback (the full
              // configured budget). Delegation-rail only; the legacy branch
              // below has no fallback concept and never sets this field.
              remaining_is_from_chain: fromChain,
            },
          }
        }),
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
