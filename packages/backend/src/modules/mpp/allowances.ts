/**
 * `GET /allowances` orchestration (#1135/#1144, moved by #997). The
 * agent-facing spend-authority report, rail-aware: on the delegation rail it
 * derives remaining budget from the agent's own active, owner-signed
 * delegations (#1090); both retired rails — session (#834/#993) and the
 * AllowanceModule rail (#2020, reversing #1986's left-readable decision) —
 * get the fail-closed 410 rather than a state read. Behavior is pinned by
 * `routes/__tests__/machine-payments.test.ts`'s "GET /allowances — rail-aware
 * (#1135)" suite — a delegation-rail `onchain` row additionally carries
 * `remaining_is_from_chain` (#1319).
 */
import {
  resolveExecutionRail,
  sessionRailRetired,
  allowanceModuleRailRetired,
} from '../../rails/execution-rail.js'
import { deriveDelegationBudgets } from '../../rails/delegation-budget-view.js'
import { listDelegationJsonByIds } from '../../infra/repositories/delegation-budgets.js'
import { sumOpenReservedAtomic } from '../../infra/repositories/task-budgets.js'
import { sumOpenReservedForBudgetDelegation } from '../../infra/repositories/sub-budgets.js'
import { readRemainingBudget } from '../../infra/chain/delegation-budget-reader.js'
import { getChainClient } from '../../infra/chain/index.js'
import { toCanonicalAddress } from '../transactions/index.js'
import type { AgentContext } from '../../middleware/agentAuth.js'
import type { MppHandlerResult } from './types.js'

export async function handleGetAllowances(agent: AgentContext): Promise<MppHandlerResult> {
  // #1135: this endpoint was rail-blind — it read the on-chain
  // AllowanceModule unconditionally, so a delegation-rail account (no Safe,
  // no AllowanceModule) reported zeros forever and the SDK derived
  // needs_approval for a fully funded agent. Resolve the rail FIRST.
  const railDecision = resolveExecutionRail({
    executionRail: agent.execution_rail ?? null,
    chainId: agent.chain_id,
  })
  if (railDecision.rail === 'retired_session') {
    // #993 fail-closed contract: a retired rail's state must not be
    // readable here either — the 410 verbatim, nothing read.
    const retired = sessionRailRetired('account')
    return { statusCode: retired.statusCode, body: retired.body }
  }

  // #2020, reversing #1986's leave-it-readable decision (owner call recorded
  // 2026-08-25 on the issue): a `retired_allowance` account now gets the same
  // fail-closed 410 as the spend paths. The read-regression argument #1986
  // weighed no longer holds — the accounts are emptied and unsupported (the
  // #2021 readability waiver), and this read was the last thing pinning
  // `agent_allowances` and the legacy on-chain allowance reader into the
  // codebase. It also ends the accepted-misleading state #1986 documented,
  // where an agent could read a live allowance it could never spend.
  if (railDecision.rail === 'retired_allowance') {
    const retired = allowanceModuleRailRetired('account')
    return { statusCode: retired.statusCode, body: retired.body }
  }

  if (agent.execution_rail === 'delegation') {
    // Delegation rail: the authority IS the active agent_delegations set,
    // derived through the #1090 shared view (since #2020 the only source —
    // the agent_allowances onboarding mirror is retired). No active
    // delegation → empty array, so derived readiness stays needs_approval.
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

    // #3731: whether the account's balance can back each row's WHOLE remaining
    // period budget — one `balanceOf` read per DISTINCT token, then
    // `balance >= remaining` compared per ROW. `false` means the treasury
    // cannot back that row's whole remaining budget; it does NOT mean the
    // next payment will fail (a budget larger than the balance is a normal
    // setup — an owner may top up weekly) and it is not a refusal: the
    // descriptions say to mention it to the user and still try. Only the
    // boolean is exposed, never the balance — the same posture
    // `balance-coverage.ts` applies to `covered`. `null`: the chain read
    // failed, or the row's remaining was not read live (`fromChain` false —
    // the #1145 fallback figure cannot answer a holdings question), per the
    // `delegateCanFund` honesty rule (#1521). A remaining of 0 omits the key
    // entirely: `balance >= 0` would be a vacuous true. Rows are compared
    // ALONE — several rows for one token (open + pinned, #3518) do not add
    // up, so two `true` rows do not mean both are backed at once.
    const tokensToRead = new Map<string, string>()
    for (const b of budgets) {
      const remaining = remainingById.get(b.id)
      if (remaining?.fromChain && remaining.remainingAtomic !== '0') {
        tokensToRead.set(b.token_address.toLowerCase(), b.token_address)
      }
    }
    const balancesByToken = new Map<string, bigint | null>()
    await Promise.all(
      [...tokensToRead.values()].map(async (tokenAddress) => {
        try {
          const chainClient = getChainClient('ethers')
          const balance = await chainClient.getTokenBalance(agent.chain_id, tokenAddress, agent.account_address)
          balancesByToken.set(tokenAddress.toLowerCase(), balance)
        } catch {
          // Unverifiable, never fabricated into false (#1521's rule).
          balancesByToken.set(tokenAddress.toLowerCase(), null)
        }
      }),
    )

    return {
      statusCode: 200,
      body: {
        agent_id: agent.id,
        // #3319: the agent-side identity/allowance read checksums its
        // Haven-owned addresses at the response boundary, the same rule the
        // receipt (#3307) and the transactions feed (#3129) apply — storage
        // (agents.delegate_address, agent_delegations.token_address under its
        // LOWER CHECK) stays untouched. Canonicalised HERE, not inside
        // `deriveDelegationBudgets`: its other callers (budget-precheck,
        // balance-coverage) compare the value and one echoes it, so the view
        // keeps the stored casing.
        account_address: toCanonicalAddress(agent.account_address),
        delegate_address: toCanonicalAddress(agent.delegate_address),
        chain_id: agent.chain_id,
        allowances: await Promise.all(budgets.map(async (b) => {
          const { remainingAtomic, fromChain } = remainingById.get(b.id) ?? {
            remainingAtomic: b.budget_atomic,
            fromChain: false,
          }
          // #3518: what the open task- and sub-budgets reserve from THIS
          // budget — Haven-side bookkeeping, reported BESIDE the on-chain
          // remaining and never folded into it (the enforcer's figure stays
          // authoritative; a reservation is released on close/expire without
          // any chain event). Task budgets key directly on the parent
          // DELEGATION hash (`parent_delegation_hash`); sub-budget grants key
          // one tree level down, so their sum walks grant → parent-child →
          // `parent_delegation_hash` (`sumOpenReservedForBudgetDelegation` —
          // NOT `sumOpenReservedForParent`, whose key is the parent-child
          // row's OWN hash and which would answer 0 here). Best-effort and
          // read-only: a failed sum answers 0 rather than failing the read,
          // the same soft-degrade the #1145 fallback applies to the
          // remaining figure itself.
          let reservedAtomic = '0'
          try {
            const nowSec = Math.floor(Date.now() / 1000)
            const [taskReserved, subReserved] = await Promise.all([
              sumOpenReservedAtomic(agent.id, b.delegation_hash, nowSec),
              sumOpenReservedForBudgetDelegation(agent.id, b.delegation_hash, nowSec),
            ])
            reservedAtomic = (taskReserved + subReserved).toString()
          } catch (error) {
            console.warn(
              `delegation-budget: reservation sum unavailable for delegation ${b.id} ` +
                `(agent ${agent.id}, chain ${b.chain_id}) — reporting 0 reserved: ` +
                `${error instanceof Error ? error.message : String(error)}`,
            )
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
          // #3731: undefined = omit the key (remaining 0 — `balance >= 0`
          // would be a vacuous true); null = unverifiable (the balance read
          // failed, or `remaining` was not read live, the #1145 fallback —
          // a fallback figure cannot answer a holdings question); otherwise
          // `balance >= remaining` for THIS row alone.
          const balance = fromChain && remainingAtomic !== '0' ? balancesByToken.get(b.token_address.toLowerCase()) : undefined
          const fundsCoverRemaining: boolean | null | undefined =
            remainingAtomic === '0'
              ? undefined
              : !fromChain || balance === undefined || balance === null
                ? null
                : balance >= BigInt(remainingAtomic)
          return {
            id: b.id,
            // #3319: checksummed at the response boundary like the
            // top-level identity fields above; storage stays lowercase.
            token_address: toCanonicalAddress(b.token_address),
            token_symbol: b.token_symbol,
            configured_amount: b.allowance_amount,
            reset_period_min: b.reset_period_min,
            // #3518: the budget's identity and SCOPE — the delegation hash
            // reservations below join on, the recipient pin (null = open),
            // and the #3331 merchant lock (a merchant-issued row always
            // carries a recipient). Lowercase like storage; the SDK layers
            // any display casing. Additive fields on the delegation-rail
            // wire only; the retired rails answer 410 above and never
            // reach this map.
            delegation_hash: b.delegation_hash,
            recipient_address: b.recipient_address,
            merchant_id: b.merchant_id,
            // #3518: the Haven-side reservation figure (task + sub-budget
            // children, joined by delegation_hash) — additive, labelled
            // Haven-side by its name (`reserved_haven_atomic`), NEVER
            // folded into `onchain.remaining`: the enforcer's figure stays
            // the authoritative one and a reservation releases without any
            // chain event.
            reserved_haven_atomic: reservedAtomic,
            // #3731: the holdings answer for THIS row's remaining budget —
            // true when the account holds at least the row's whole remaining
            // period budget, false when it does not (a heads-up to mention to
            // the user, never a refusal: a budget above the balance is a
            // normal setup), null when the balance read failed or the
            // remaining figure was not read live (`onchain.remaining_is_from_chain`
            // false). Absent when `onchain.remaining` is 0 — `balance >= 0`
            // would be a vacuous true. Only the boolean rides the wire; the
            // balance itself never does (the #3126 posture). Each row is
            // compared ALONE: rows for one token do not add up.
            ...(fundsCoverRemaining === undefined ? {} : { funds_cover_remaining: fundsCoverRemaining }),
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
        })),
      },
    }
  }

  // Unreachable: `resolveExecutionRail` returns exactly three rails and the
  // two retired ones returned above, so only 'delegation' reaches here — and
  // its `execution_rail` matches the branch above. Fail closed anyway rather
  // than fall through to a read that no longer exists (#2020 deleted the
  // legacy AllowanceModule on-chain report that stood here).
  const retired = allowanceModuleRailRetired('account')
  return { statusCode: retired.statusCode, body: retired.body }
}
