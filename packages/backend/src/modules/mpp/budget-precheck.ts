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
 * On sufficiency: `{ sufficient: true, remaining_atomic, remaining_is_from_chain? }`
 * — the hosted tool's `allowance` block needs the remaining figure to
 * report it.
 *
 * ## #3492/#3527: a settled x402 replay is sufficient by construction
 *
 * When the caller names the quote's x402 `idempotencyKey` AND that key
 * resolves to an already-SETTLED x402 payment matching the SAME quote —
 * `merchantTo` now scopes this one match, unlike the ordinary compare above
 * — the answer is `{ sufficient: true, remaining_atomic, replay: true }`
 * WITHOUT running `refuse()`: the money already moved under the budget that
 * was live at authorization time, so re-refusing it against today's
 * (now-lower) remaining figure would be a false `delegation_budget_exceeded`
 * ledger row for a spend that is done, not pending. `remaining_atomic` on
 * this branch is still the TRUE post-settlement figure (it can read BELOW
 * `amountAtomic`) — only the refusal write is skipped, nothing is
 * fabricated. #3492 scoped this to erc7710 only; #3527 extended it to a
 * settled EIP-3009 row on the SAME rule — on that scheme `confirmed` +
 * `tx_hash` is the FUNDING leg (treasury → delegate), which is exactly what
 * `delegationReplay`'s own confirmed+tx_hash branch (`modules/x402/replay.ts`)
 * already treats as replayable for every scheme, so refusing it here as
 * over-budget was always a false ledger row, the same as the erc7710 case.
 * See `isSettledX402Replay` below for the exact predicate and scope.
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
 * #3492/#3527: is `row` a SETTLED x402 replay of exactly the quote `body`
 * describes?
 *
 * This is STRICTER than `delegationReplay`'s own confirmed+tx_hash branch
 * (`modules/x402/replay.ts:89-110`), which answers its stored 200 for ANY
 * `confirmed` row with a `tx_hash` regardless of settlement scheme, payee or
 * resource — those fields are compared only by `existingX402IntentMismatch`,
 * which runs AFTER the confirmed branch and on `pending_signature` rows only.
 * This endpoint instead checks:
 *
 *  - `confirmed` + a `tx_hash` — the payment already moved money; refusing
 *    it as over-budget now would be a false ledger row for a spend that is
 *    done, not pending. On EIP-3009 this `tx_hash` is the FUNDING leg
 *    (treasury → delegate, `x402-authorizations.ts:455-458`), not a merchant
 *    settlement — but it is exactly the fact `delegationReplay`'s confirmed
 *    branch already treats as replayable for this scheme too (#3527), so the
 *    same "money already moved, re-refusing is false" argument applies.
 *  - `settlement_scheme` is `erc7710` or `eip3009` (#3492 scoped this to
 *    erc7710 only; #3527 is the follow-up that extended it to eip3009 on the
 *    SAME rule — see this function's old #3492 revision for the narrower
 *    predicate this replaced).
 *  - no task-budget or sub-budget pin on the stored row — the catalog-purchase
 *    preflight this endpoint serves never authorizes against either, so a
 *    row that carries one belongs to a different flow this compare should
 *    not short-circuit.
 *  - the SAME payee (`merchantTo`) and resource (`resourceUrl`) the request
 *    asks about — REQUIRED on both sides: an absent `merchantTo` or
 *    `resourceUrl` in the request never matches (nothing to scope the
 *    replay to), and a key collision against a different payee or resource
 *    must still run (and can still fail) today's compare. The resource
 *    comparison is scheme-agnostic BY CONSTRUCTION: it compares `body.resourceUrl`
 *    against whichever value the row's own `x402_resource_url` column stores,
 *    and that storage is already scheme-aware at authorize time — erc7710
 *    persists the caller's `resourceUrl` (`merchantUrl` on the hosted path),
 *    eip3009 persists `paymentRequired.resource.url` (`createX402Intent`,
 *    `client.ts:452-453`) — so the CALLER is responsible for sending the
 *    value that matches what will be stored for the scheme it is replaying
 *    (`catalog-purchase.ts` step 5b, #3527).
 *  - the SAME token and amount the request asks about, for the same reason.
 */
function isSettledX402Replay(
  row: Record<string, unknown>,
  body: BudgetPrecheckBody,
): boolean {
  if (row.status !== 'confirmed' || !row.tx_hash) return false
  const scheme = settlementSchemeOf(row.machine_metadata)
  if (scheme !== 'erc7710' && scheme !== 'eip3009') return false
  if (row.task_budget_id != null || row.sub_budget_id != null) return false

  // #3492 review N1: resourceUrl and merchantTo are REQUIRED in the request
  // for a replay match — an absent one never matches, so "the same payee
  // and resource" is true of every replay this function accepts, not just
  // the ones that happened to name them.
  if (typeof body.resourceUrl !== 'string') return false
  const rowResource = (row.x402_resource_url ?? row.payment_resource_url) as string | null | undefined
  if (rowResource !== body.resourceUrl) return false

  if (typeof body.merchantTo !== 'string') return false
  const rowMerchant = (row.x402_merchant_address as string | null | undefined) ?? null
  if (typeof rowMerchant !== 'string' || rowMerchant.toLowerCase() !== body.merchantTo.toLowerCase()) {
    return false
  }

  const rowToken = row.token_address as string | null | undefined
  if (typeof rowToken !== 'string' || body.token === undefined || rowToken.toLowerCase() !== body.token.toLowerCase()) {
    return false
  }

  const rowAmount = row.amount_raw != null ? String(row.amount_raw) : null
  if (rowAmount === null || body.amountAtomic === undefined || rowAmount !== body.amountAtomic) {
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

  // #3492/#3527: a replayed idempotency key whose erc7710 OR eip3009 payment
  // already SETTLED is sufficient by construction — the money already moved
  // under the budget that was live at the time, so re-running today's
  // remaining-budget compare (now lower, post-settlement) must never REFUSE
  // it: that would book a false `delegation_budget_exceeded` row for a spend
  // that is done, not pending. The same lookup the authorize path runs before
  // `delegationReplay` (`findX402IntentByIdempotencyKey`,
  // `delegation-authorize.ts`), scoped to THIS agent;
  // any other shape (no row, a pending child, a key collision on a
  // different payee/resource/token/amount, or a task/sub-budget-scoped row)
  // leaves this false and today's compare runs unchanged below — including
  // its refusal branch.
  const settledReplay = body.idempotencyKey
    ? isSettledX402Replay(
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
