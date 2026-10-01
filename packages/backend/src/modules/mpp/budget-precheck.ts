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
 * column), never the allowances read's URL.
 *
 * ## #3518: the compare uses the payment's OWN selection
 *
 * "The selected option's token" used to mean the FIRST budget row for the
 * token (`budgets.find(...)`), which is only correct while one budget per
 * token exists. The payment's own rule is
 * `SELECT_DELEGATION_FOR_PAYMENT_SQL` (`infra/repositories/
 * delegation-budgets.ts`): same token, `recipient = $3 OR NULL`, inside the
 * live `start_date`/`expires_at` window, `ORDER BY (recipient_address IS
 * NULL), expires_at ASC, created_at DESC` — a recipient-pinned budget for
 * THAT payee wins, a pin to a different payee is excluded, and the open
 * budget covers everything else. This is a REFUSAL GATE, not a report: with
 * an open 0.001 and a pinned 0.005 for the same token, the first-match
 * compare refused a pinned-merchant purchase the budget had funded (and the
 * on-chain enforcer would NOT have reverted), and the inverse — a large open
 * budget beside a small pin — passed a compare against the open row that the
 * pinned payment would exceed. `selectBudgetForPaymentReport` mirrors that
 * order over the already-read rows; when `merchantTo` is ABSENT the pinned
 * rows are ineligible (a pinless quote cannot claim a recipient-scoped
 * grant) and the open budget answers — the no-guess fallback the issue
 * states. The selected budget's identity rides the success body as
 * `budget_delegation_hash` / `budget_id` / `budget_recipient_address`, so
 * the caller's report and the refusal row describe the budget that pays.
 * `merchantTo` keeps its #3492 replay role unchanged (below).
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
 * ## #3492: a settled erc7710 replay is sufficient by construction
 *
 * When the caller names the quote's x402 `idempotencyKey` AND that key
 * resolves to an already-SETTLED erc7710 payment matching the SAME quote —
 * `merchantTo` now scopes this one match, unlike the ordinary compare above
 * — the answer is `{ sufficient: true, remaining_atomic, replay: true }`
 * WITHOUT running `refuse()`: the money already moved under the budget that
 * was live at authorization time, so re-refusing it against today's
 * (now-lower) remaining figure would be a false `delegation_budget_exceeded`
 * ledger row for a spend that is done, not pending. `remaining_atomic` on
 * this branch is still the TRUE post-settlement figure (it can read BELOW
 * `amountAtomic`) — only the refusal write is skipped, nothing is
 * fabricated. See `isSettledErc7710Replay` below for the exact predicate and
 * scope.
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
import { listDelegationJsonByIds, selectBudgetForPaymentReport } from '../../infra/repositories/delegation-budgets.js'
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
 *    done, not pending.
 *  - `settlement_scheme === 'erc7710'` (the captain's scope decision). A
 *    settled EIP-3009 row is deliberately EXCLUDED here, but NOT because
 *    `delegationReplay` would refuse it — it would not: the confirmed
 *    branch above answers its stored 200 for a 3009 row exactly the same
 *    way. A settled 3009 replay hitting THIS pre-check today still gets the
 *    same false over-budget refusal and ledger row this issue fixes for
 *    erc7710 — known, and deliberately left as a follow-up rather than
 *    widened here, because its funding leg is a SEPARATE budget-metered hop
 *    (the bridge, #946) and this endpoint has no way yet to tell whether the
 *    remaining figure it reads already reflects that leg's own settlement.
 *  - no task-budget or sub-budget pin on the stored row — the catalog-purchase
 *    preflight this endpoint serves never authorizes against either, so a
 *    row that carries one belongs to a different flow this compare should
 *    not short-circuit.
 *  - the SAME payee (`merchantTo`) and resource (`resourceUrl`) the request
 *    asks about — REQUIRED on both sides: an absent `merchantTo` or
 *    `resourceUrl` in the request never matches (nothing to scope the
 *    replay to), and a key collision against a different payee or resource
 *    must still run (and can still fail) today's compare.
 *  - the SAME token and amount the request asks about, for the same reason.
 */
function isSettledErc7710Replay(
  row: Record<string, unknown>,
  body: BudgetPrecheckBody,
): boolean {
  if (row.status !== 'confirmed' || !row.tx_hash) return false
  if (settlementSchemeOf(row.machine_metadata) !== 'erc7710') return false
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

  // #3492: a replayed idempotency key whose erc7710 payment already SETTLED
  // is sufficient by construction — the money already moved under the
  // budget that was live at the time, so re-running today's remaining-budget
  // compare (now lower, post-settlement) must never REFUSE it: that would
  // book a false `delegation_budget_exceeded` row for a spend that is done,
  // not pending. The same lookup the authorize path runs before
  // `delegationReplay` (`findX402IntentByIdempotencyKey`,
  // `delegation-authorize.ts`), scoped to THIS agent;
  // any other shape (no row, a pending child, a key collision on a
  // different payee/resource/token/amount, a task/sub-budget-scoped row, or
  // a settled EIP-3009 row — deliberately out of scope here, see
  // `isSettledErc7710Replay`'s own comment for why it still gets today's
  // false refusal) leaves this false and today's compare runs unchanged
  // below — including its refusal branch.
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
  // #3518: scope the selection to the QUOTED TOKEN first, then run the
  // payment's own selection inside it — the recipient match, window and
  // ordering of `SELECT_DELEGATION_FOR_PAYMENT_SQL`, not the first token
  // row (see the module comment for why the first match refused and
  // allowed the wrong payments). `merchantTo` is lowercased once here;
  // `selectBudgetForPaymentReport` compares case-insensitively and treats
  // null as "open budget only".
  const amountAtomic = BigInt(amountAtomicString)
  const merchantTo = body.merchantTo ? body.merchantTo.toLowerCase() : null
  const match = selectBudgetForPaymentReport(
    budgets.filter((b) => b.token_address.toLowerCase() === tokenAddress.toLowerCase()),
    merchantTo,
    Math.floor(Date.now() / 1000),
    (b) => Number(b.expires_at),
    (b) => Number(b.start_date),
  )
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
        // #3518: WHICH budget answered — the payment-selection mirror's
        // winner, so the caller's report (and the hosted tool's allowance
        // block) can name the budget that pays instead of letting a reader
        // assume the first per-token row. Absent when no row matched.
        ...(match
          ? {
              budget_id: match.id,
              budget_delegation_hash: match.delegation_hash,
              budget_recipient_address: match.recipient_address,
              budget_merchant_id: match.merchant_id,
            }
          : {}),
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
        // #3518: the refusal row and body name the budget whose remaining
        // figure the compare ran against — the payment-selection mirror's
        // winner. The detail allowlist (086/087) keeps the taxonomy subset
        // only; these ride the RESPONSE body (and the ledger row's merchant
        // column via `merchantTo`), not `detail`.
        ...(match
          ? {
              budget_id: match.id,
              budget_delegation_hash: match.delegation_hash,
              budget_recipient_address: match.recipient_address,
              budget_merchant_id: match.merchant_id,
            }
          : {}),
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
