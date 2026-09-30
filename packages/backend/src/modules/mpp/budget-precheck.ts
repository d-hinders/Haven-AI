/**
 * `POST /machine-payments/budget-precheck` orchestration (#3054, slice 3 of
 * epic #3056) — the server-side home of the budget compare the hosted MCP's
 * guided purchase used to run in the agent's runtime
 * (`catalog-purchase.ts`'s step 5b/6 local compare over its
 * `GET /machine-payments/allowances` read).
 *
 * ## Why this endpoint exists at all
 *
 * The hosted tool still refuses an over-budget quote BEFORE any intent is
 * created (owner decisions #1090/#2055 — unchanged), but the DECISION moves
 * here so the refusal reaches the `payment_refusals` ledger: this handler
 * refuses through the #3053 choke point (`refuse()`) with
 * `source: 'hosted_prepare'`, so the ledger stays a record of what Haven's
 * guardrail decided. It is deliberately NOT a self-report endpoint — an
 * agent asserting its own refusal would let any agent-key holder book
 * arbitrary amounts into the owner's Refused tile (Daniel S1, adopted).
 * Every wire field here is a measurement this module derives or compares;
 * nothing about the caller's claim is trusted beyond which quote it asks
 * about.
 *
 * ## The compare mirrors the hosted tool exactly
 *
 * Same derived-budget read `GET /machine-payments/allowances` uses
 * (`deriveDelegationBudgets` + the #1145 on-chain enforcer read, NEVER
 * `agent_allowances` — mutation-tested there), chain-scoped like that
 * read, and the same `>=` compare over the SELECTED option's token:
 * remaining >= amount is sufficient, anything else — including NO budget
 * row for the token — is insufficient, exactly as the hosted tool's
 * `match ? match.onchain.remaining : '0'` answered. `resourceUrl` is the
 * merchant resource being bought (the dedupe window's discriminating
 * column), never the allowances read's URL. `merchantTo` is advisory
 * metadata for the ledger row; it does not scope the compare — the
 * delegation budget is per-token, and the enforcer is the real gate on
 * recipients.
 *
 * ## The refusal is a taxonomy 403, the success is a bare boolean
 *
 * On insufficiency the body carries the same taxonomy fields
 * (`error_code`, `phase`, `next_action`) the x402 legs refuse with — the
 * hosted tool reconstructs its OWN byte-identical refusal from the
 * `remaining_atomic` value here, so the agent-facing shape never changes.
 * On sufficiency: `{ sufficient: true, remaining_atomic }` — the hosted
 * tool's `allowance` block needs the remaining figure to report it.
 *
 * ## Rail posture
 *
 * Same rail-aware read as `handleGetAllowances`: both retired rails get
 * the fail-closed 410 verbatim; only the delegation rail reaches the
 * derived-budget compare. On the legacy rail (pre-delegation accounts)
 * there is no budget concept left to pre-check — that agent's spend is
 * dead since #1986/#2020, and this endpoint answers 410 like every other
 * rail-aware surface.
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
import { formatTokenValue } from '../../domain/tokens.js'
import { AgentPaymentPhase, AgentPaymentNextAction } from '../../domain/agent-payment-taxonomy.js'
import { refuse, type DecidedResponse } from '../payments/refuse.js'
import { findX402IntentByIdempotencyKey } from '../../infra/repositories/x402-authorizations.js'
import type { AgentContext } from '../../middleware/agentAuth.js'
import type { BudgetPrecheckBody, MppHandlerResult } from './types.js'

/** `machine_metadata` is stored as text or already-parsed jsonb depending on the reader — same tolerant parse `settlement-observed.ts` and `agent-payment-status.ts` use. */
function parsedMachineMetadata(machineMetadata: unknown): Record<string, unknown> | null {
  if (!machineMetadata) return null
  if (typeof machineMetadata === 'string') {
    try {
      return JSON.parse(machineMetadata) as Record<string, unknown>
    } catch {
      return null
    }
  }
  return machineMetadata as Record<string, unknown>
}

/** `machine_metadata.settlement_scheme`, parsed the way every other reader of it does. */
function settlementSchemeOf(machineMetadata: unknown): string | null {
  const scheme = parsedMachineMetadata(machineMetadata)?.settlement_scheme
  return typeof scheme === 'string' ? scheme : null
}

/**
 * #3492: is `row` a SETTLED erc7710 replay of exactly the quote `body`
 * describes? The same predicate `delegationReplay` uses to answer its own
 * confirmed+tx_hash branch (`modules/x402/replay.ts:55-89`), narrowed to
 * erc7710 (the captain's scope decision — a settled EIP-3009 replay keeps
 * today's compare, since its funding leg is a SEPARATE budget-metered hop
 * the remaining figure must still reflect) and to the fields this
 * lighter-weight endpoint can compare:
 *
 *  - `confirmed` + a `tx_hash` — the payment already moved money; refusing
 *    it as over-budget now would be a false ledger row for a spend that is
 *    done, not pending.
 *  - `settlement_scheme === 'erc7710'` — the scope line above.
 *  - no task-budget or sub-budget pin on the stored row — the catalog-purchase
 *    preflight this endpoint serves never authorizes against either, so a
 *    row that carries one belongs to a different flow this compare should
 *    not short-circuit.
 *  - the SAME payee (`merchantTo`) and resource (`resourceUrl`) the request
 *    asks about — a key collision against a different payee or resource
 *    must still run (and can still fail) today's compare.
 */
function isSettledErc7710Replay(
  row: Record<string, unknown>,
  body: BudgetPrecheckBody,
): boolean {
  if (row.status !== 'confirmed' || !row.tx_hash) return false
  if (settlementSchemeOf(row.machine_metadata) !== 'erc7710') return false
  if (row.task_budget_id != null || row.sub_budget_id != null) return false

  const rowResource = (row.x402_resource_url ?? row.payment_resource_url) as string | null | undefined
  if (typeof rowResource === 'string' && body.resourceUrl !== undefined && rowResource !== body.resourceUrl) {
    return false
  }

  const rowMerchant = (row.x402_merchant_address as string | null | undefined) ?? null
  if (
    typeof rowMerchant === 'string' &&
    body.merchantTo !== undefined &&
    rowMerchant.toLowerCase() !== body.merchantTo.toLowerCase()
  ) {
    return false
  }

  const rowToken = row.token_address as string | null | undefined
  if (typeof rowToken === 'string' && body.token !== undefined && rowToken.toLowerCase() !== body.token.toLowerCase()) {
    return false
  }

  const rowAmount = row.amount_raw != null ? String(row.amount_raw) : null
  if (rowAmount !== null && body.amountAtomic !== undefined && rowAmount !== body.amountAtomic) {
    return false
  }

  return true
}

/**
 * Registry-derived token metadata for the address the caller asked about —
 * the same lookup `delegation-budget-view.ts`'s private `tokenView` runs for
 * the budget rows. Unknown chain or unlisted token falls back to the generic
 * view (18 decimals): a wrong scale beats a silently missing symbol on the
 * refusal row.
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

export async function handleBudgetPrecheck(
  agent: AgentContext,
  body: BudgetPrecheckBody,
): Promise<MppHandlerResult> {
  // Same rail resolution as handleGetAllowances — the retired rails fail
  // closed before anything is derived, and only the delegation rail has a
  // budget to compare against.
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

  // The route layer validates presence/types before calling; this guard is
  // the module's own fail-closed floor (the EvidenceBody handlers keep the
  // same shape of check) and gives the compare the narrowed strings it needs.
  // Moved ahead of the derived-budget read (#3492) so a malformed body still
  // 400s before either the replay lookup or the chain read runs.
  if (typeof body.token !== 'string' || typeof body.amountAtomic !== 'string') {
    return { statusCode: 400, body: { error: 'token and amountAtomic are required' } }
  }
  const tokenAddress = body.token
  const amountAtomicString = body.amountAtomic

  // #3492: a replayed idempotency key whose erc7710 payment already SETTLED
  // is sufficient by construction — the money already moved under the
  // budget that was live at the time, so re-running today's remaining-budget
  // compare (now lower, post-settlement) must never REFUSE it: that would
  // book a false `delegation_budget_exceeded` row for a spend that is done,
  // not pending. The same lookup `delegationAuthorize`'s replay runs
  // (`findX402IntentByIdempotencyKey`), scoped to THIS agent; any other
  // shape (no row, a pending child, a key collision on a different
  // payee/resource/token/amount, an eip3009 row, a task/sub-budget-scoped
  // row) leaves this false and today's compare runs unchanged below —
  // including its refusal branch.
  const settledReplay = body.idempotencyKey
    ? isSettledErc7710Replay(
        ((await findX402IntentByIdempotencyKey(agent.id, body.idempotencyKey)) ?? {}) as unknown as Record<
          string,
          unknown
        >,
        body,
      )
    : false

  // The SAME derivation the allowances read runs (comment there for the
  // #1090/#1145 provenance): active, owner-signed delegations, scoped to the
  // agent's chain, remaining from the ERC20PeriodTransferEnforcer's storage.
  const all = (await deriveDelegationBudgets([agent.id])).get(agent.id) ?? []
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

  // The hosted tool's compare, verbatim in semantics: match on the SELECTED
  // option's token, no match means the budget for this token is zero.
  const amountAtomic = BigInt(amountAtomicString)
  const merchantTo = body.merchantTo ? body.merchantTo.toLowerCase() : null
  const match = budgets.find((b) => b.token_address.toLowerCase() === tokenAddress.toLowerCase())
  const remainingAtomic = match ? (remainingById.get(match.id)?.remainingAtomic ?? match.budget_atomic) : '0'
  const token = tokenView(agent.chain_id, tokenAddress)
  // A budget row's registry-derived symbol wins when it names the same
  // token — the allowances view reports the budget under THAT symbol.
  const symbol = match ? match.token_symbol : token.symbol

  if (BigInt(remainingAtomic) >= amountAtomic || settledReplay) {
    // #1319 provenance, carried so the hosted tool's
    // ALLOWANCE_READ_OPTIMISTIC warning survives the move verbatim: an
    // optimistic remaining (the #1145 fallback, or a budget whose delegation
    // json could not be read) is reported as the configured full budget, not
    // a confirmed live figure. The allowances read sets this flag on every
    // delegation-rail row; it is absent here only when NO budget row matched
    // the token (nothing was read from anywhere).
    const fromChain = match ? (remainingById.get(match.id)?.fromChain ?? false) : null
    return {
      statusCode: 200,
      body: {
        sufficient: true,
        remaining_atomic: remainingAtomic,
        ...(fromChain !== null ? { remaining_is_from_chain: fromChain } : {}),
        // #3492: distinguishes "sufficient because it fit" from "sufficient
        // because this exact payment already settled" — the remaining
        // figure above can be BELOW amountAtomic on this branch (the
        // settlement already spent it) and callers should not read
        // `sufficient: true` here as "there is still headroom".
        ...(settledReplay ? { replay: true } : {}),
      },
    }
  }

  // Insufficient — refuse through the #3053 choke point. The decided
  // response is returned verbatim while the ledger row is recorded
  // fire-and-forget (the write can never change this response; see
  // refusal-ledger.ts). `source: 'hosted_prepare'` is the ONLY new thing
  // about this writer: same reason, same taxonomy detail keys as the x402
  // legs' pre-check refusals.
  const shortfallAtomic = amountAtomic - BigInt(remainingAtomic)
  const amountHuman = formatTokenValue(amountAtomicString, token.decimals)
  const remainingHuman = formatTokenValue(remainingAtomic, token.decimals)
  const shortfallHuman = formatTokenValue(shortfallAtomic.toString(), token.decimals)
  const decided: DecidedResponse = refuse(
    {
      code: 403,
      body: {
        error:
          `This payment of ${amountHuman} ${symbol} exceeds the agent's remaining ` +
          `budget for this period (${remainingHuman} ${symbol}, short by ${shortfallHuman} ${symbol}). ` +
          'There is no approval queue on the delegation rail — an over-budget redemption reverts ' +
          'on-chain. Ask the wallet owner to grant or raise the budget in Haven, then retry.',
        error_code: 'delegation_budget_exceeded',
        phase: AgentPaymentPhase.InsufficientFunds,
        next_action: AgentPaymentNextAction.FundAccountOrRaiseAllowance,
        chain_id: agent.chain_id,
        token: symbol,
        asset: tokenAddress,
        amount: amountHuman,
        amount_atomic: amountAtomicString,
        remaining: remainingHuman,
        remaining_atomic: remainingAtomic,
        shortfall: shortfallHuman,
        shortfall_atomic: shortfallAtomic.toString(),
        resource_url: body.resourceUrl,
        ...(merchantTo ? { merchant_address: merchantTo } : {}),
      },
    },
    {
      userId: agent.user_id,
      agentId: agent.id,
      chainId: agent.chain_id,
      tokenSymbol: symbol,
      amountAtomic: amountAtomicString,
      accountAddress: agent.account_address,
      merchantTo,
      resourceUrl: body.resourceUrl,
      reason: 'delegation_budget_exceeded',
      source: 'hosted_prepare',
      detail: {
        error_code: 'delegation_budget_exceeded',
        phase: AgentPaymentPhase.InsufficientFunds,
        next_action: AgentPaymentNextAction.FundAccountOrRaiseAllowance,
        remaining_atomic: remainingAtomic,
      },
    },
  )
  return { statusCode: decided.code, body: decided.body as Record<string, unknown> }
}
