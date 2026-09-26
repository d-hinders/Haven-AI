/**
 * `GET /machine-payments/balance-coverage` orchestration (#3126) — the
 * agent-facing answer to "is there money actually held behind my budget?",
 * answered as a sufficiency signal, never as the account's balance.
 *
 * ## Why this exists, and why it is NOT a balance tool
 *
 * Every other agent-readable figure in this package describes SPEND
 * AUTHORITY: how much the agent is permitted to move this period
 * (`GET /machine-payments/allowances`, `POST
 * /machine-payments/budget-precheck`). None of them say whether the account
 * holds funds behind that authority, so an agent with a funded budget
 * against an empty account discovers the gap only when a payment fails
 * on-chain (#3126's field observation). This endpoint answers the DIFFERENT
 * question — is `amount_atomic` of `token` actually HELD on the agent's own
 * account right now — and deliberately answers it as `covered: boolean`,
 * never as a figure: a constrained actor has no business reading the
 * treasury total, and a boolean answers the only decision an agent has
 * ("attempt the payment, or tell the user funds are missing"). The read
 * grants no authority and moves nothing; enforcement stays where it was —
 * the on-chain delegation enforcer.
 *
 * ## `covered` is tri-state, and null means UNVERIFIABLE
 *
 * The chain read can fail (RPC down, unsupported chain). Returning `false`
 * then would tell an agent money is missing when we do not know that — the
 * same honesty rule `x402-funding-leg.ts`'s `delegateCanFund` established
 * (#1521: "callers must treat that as 'unverifiable', not as 'funded'").
 * `covered: null` carries `coverage_error` and the agent-facing description
 * says to treat it as unverifiable rather than as absence.
 *
 * ## The compare mirrors the budget compare, on the other side
 *
 * Rail handling is verbatim `handleGetAllowances` / `handleBudgetPrecheck`:
 * both retired rails get the fail-closed 410 before anything is derived;
 * only the delegation rail answers. The budget figure in the response comes
 * from the SAME #1090 derived-budget read (`deriveDelegationBudgets` + the
 * #1145 enforcer read, never `agent_allowances`), chain-scoped — but it is
 * REPORTED context (`budget_remaining_atomic`), not the compare. The compare
 * itself is `chainBalanceOf(account) >= amount_atomic`.
 *
 * ## Naming keeps the two concepts apart (#3126's binding constraint)
 *
 * Nothing here is named like the authority figures: no `remaining` without
 * the `budget_` prefix, no `available`, no balance field at all. `covered`
 * is about HELD funds; `budget_remaining_atomic` is about PERMITTED spend,
 * the same value `GET /machine-payments/allowances` reports under
 * `onchain.remaining` — an agent that wants the authority question's full
 * answer still goes there.
 */
import { getChainData } from '@haven_ai/core'
import {
  resolveExecutionRail,
  sessionRailRetired,
  allowanceModuleRailRetired,
} from '../../rails/execution-rail.js'
import { deriveDelegationBudgets } from '../../rails/delegation-budget-view.js'
import { listDelegationJsonByIds } from '../../infra/repositories/delegation-budgets.js'
import { readRemainingBudget } from '../../infra/chain/delegation-budget-reader.js'
import { getChainClient } from '../../infra/chain/index.js'
import { toCanonicalAddress } from '../transactions/index.js'
import type { AgentContext } from '../../middleware/agentAuth.js'
import type { MppHandlerResult } from './types.js'

/**
 * Registry-derived token metadata for the address the caller asked about —
 * the same lookup `budget-precheck.ts` runs for its refusal rows. Unknown
 * chain or unlisted token falls back to the generic view (18 decimals): a
 * wrong scale beats a silently missing symbol.
 */
function tokenView(chainId: number, tokenAddress: string): { symbol: string; decimals: number } {
  try {
    const token = getChainData(chainId).tokens.find(
      (t) => t.address !== null && t.address.toLowerCase() === tokenAddress.toLowerCase(),
    )
    if (token) return { symbol: token.symbol, decimals: token.decimals }
  } catch {
    // Unknown chain — fall through to the generic view.
  }
  return { symbol: 'TOKEN', decimals: 18 }
}

export interface BalanceCoverageQuery {
  token: string
  amountAtomic: string
}

export async function handleBalanceCoverage(
  agent: AgentContext,
  query: BalanceCoverageQuery,
): Promise<MppHandlerResult> {
  // Same rail resolution as handleGetAllowances / handleBudgetPrecheck — the
  // retired rails fail closed before anything is read, and only the
  // delegation rail has a budget (and an account this surface can describe).
  const railDecision = resolveExecutionRail({
    executionRail: agent.execution_rail ?? null,
    chainId: agent.chain_id,
  })
  if (railDecision.rail === 'retired_session') {
    const retired = sessionRailRetired('account')
    return { statusCode: retired.statusCode, body: retired.body }
  }
  if (railDecision.rail === 'retired_allowance') {
    const retired = allowanceModuleRailRetired('account')
    return { statusCode: retired.statusCode, body: retired.body }
  }

  // Route-level validation runs first; this is the module's own fail-closed
  // floor (the same shape of check handleBudgetPrecheck keeps). The amount
  // must be a plain decimal atomic string — a negative or malformed amount
  // has no honest answer, and `>=` against BigInt('12abc') throws.
  if (!/^[0-9]+$/.test(query.amountAtomic)) {
    return { statusCode: 400, body: { error: 'amount_atomic must be a decimal atomic amount' } }
  }
  const amountAtomic = BigInt(query.amountAtomic)
  const tokenAddress = query.token

  // The SAME derivation the allowances read runs (comment there for the
  // #1090/#1145 provenance), chain-scoped like that read. One budget per
  // agent is enforced upstream (agent-connection-setups); the token match
  // below stays explicit rather than relying on that invariant.
  const all = (await deriveDelegationBudgets([agent.id])).get(agent.id) ?? []
  const budgets = all.filter((b) => b.chain_id === agent.chain_id)
  const match = budgets.find((b) => b.token_address.toLowerCase() === tokenAddress.toLowerCase())

  // The AUTHORITY figure (permitted), from the same read GET /allowances
  // reports: enforcer-derived when the delegation json is readable, the
  // #1145 optimistic fallback (full configured budget) when it is not, and
  // zero when no budget row names this token. No row for the token means
  // remaining 0 — exactly what handleBudgetPrecheck's compare answers.
  const delegationJson = match ? await listDelegationJsonByIds([match.id]) : new Map()
  let budgetRemainingAtomic = '0'
  let budgetFromChain: boolean | null = null
  if (match) {
    const json = delegationJson.get(match.id)
    const remaining = json
      ? await readRemainingBudget(match.chain_id, json, match.budget_atomic)
      : { remainingAtomic: match.budget_atomic, fromChain: false }
    budgetRemainingAtomic = remaining.remainingAtomic
    budgetFromChain = remaining.fromChain
  }

  // The HOLDINGS read — the one thing this endpoint adds. Asked of the chain
  // for the agent's OWN account (the treasury the budget draws on), through
  // the #994 ChainClient port; `ethers` is the same implementation the
  // user-facing balance read keeps (`routes/balances.ts`).
  let covered: boolean | null
  let coverageError: string | undefined
  try {
    const chainClient = getChainClient('ethers')
    const balance = await chainClient.getTokenBalance(agent.chain_id, tokenAddress, agent.account_address)
    covered = balance >= amountAtomic
  } catch (error) {
    covered = null
    coverageError = error instanceof Error ? error.message : String(error)
  }

  const token = tokenView(agent.chain_id, tokenAddress)
  const symbol = match ? match.token_symbol : token.symbol

  return {
    statusCode: 200,
    body: {
      covered,
      ...(coverageError ? { coverage_error: coverageError } : {}),
      chain_id: agent.chain_id,
      // #3319: echoed checksummed so `haven_check_funds` returns ONE casing
      // whether the caller passed a lowercase address, a checksummed one or a
      // symbol (resolved from the checksummed allowances read). The match and
      // the chain read above keep using the value as sent — the echo is the
      // only thing canonicalised.
      token_address: toCanonicalAddress(tokenAddress),
      token_symbol: symbol,
      checked_amount_atomic: amountAtomic.toString(),
      budget_remaining_atomic: budgetRemainingAtomic,
      // #1319 provenance, carried like budget-precheck carries it: present
      // only when a budget row matched (the no-row case read nothing from
      // anywhere, so there is no provenance to state).
      ...(budgetFromChain !== null ? { budget_remaining_is_from_chain: budgetFromChain } : {}),
    },
  }
}
