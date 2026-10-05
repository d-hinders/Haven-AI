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
 * ## The refusal body is the #3616 builder's (`mpp` flavor, #3619)
 *
 * On insufficiency the 403 body is built by `buildPeriodExceededBody`
 * (`modules/budget-scope/refusal-body.ts`, the `mpp` flavor), byte-equal to
 * the body this file hand-built until #3619 — the hosted tool parses the
 * body (#3504) and reconstructs its OWN byte-identical refusal from the
 * `remaining_atomic` value here, so field names and prose are wire. The
 * pre-#3616 hand-built copy is preserved in
 * `modules/budget-scope/__tests__/refusal-body.test.ts`'s characterization
 * table. The ledger `detail` comes from `periodExceededLedgerDetail` — the
 * 086/087 allowlist's exact subset. On sufficiency:
 * `{ sufficient: true, remaining_atomic, remaining_is_from_chain? }`
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
 * already treats as replayable for every scheme, so it must never be
 * REFUSED here as over-budget — that would book a false ledger row for a
 * spend that already moved.
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
import {
  listDelegationJsonByIds,
  liveRecipientPins,
  selectBudgetForPaymentReport,
} from '../../infra/repositories/delegation-budgets.js'
import { readRemainingBudget } from '../../infra/chain/delegation-budget-reader.js'
import {
  buildPeriodExceededBody,
  periodExceededLedgerDetail,
} from '../budget-scope/index.js'
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
 * The settled-replay RULE this endpoint runs — `confirmed` + `tx_hash` means
 * "the money already moved, re-refusing is a false ledger row" — is the SAME
 * rule `delegationReplay`'s confirmed branch answers 200 by
 * (`modules/x402/replay.ts`), deliberately. What differs is the MATCH each
 * caller requires around it, and #3619 pins those differences cell by cell in
 * `routes/__tests__/replay-rules-parity.test.ts` (the same seeded row runs
 * through this predicate, `delegationReplay`, and `findPaymentReplay` via the
 * route, so a change to either side reddens the table). What differs here:
 *
 *  - `settlement_scheme` is `erc7710` or `eip3009` (#3492 scoped this to
 *    erc7710 only; #3527 is the follow-up that extended it to eip3009 on the
 *    SAME rule). `delegationReplay` has no scheme condition.
 *  - no task-budget or sub-budget pin on the stored row — the catalog-purchase
 *    preflight this endpoint serves never authorizes against either, so a
 *    row that carries one belongs to a different flow this compare should
 *    not short-circuit. `delegationReplay` runs the pin the other way: the
 *    request's ids must EQUAL the row's (a mismatch is a 409), it never
 *    excludes pinned rows.
 *  - the SAME payee (`merchantTo`) and resource (`resourceUrl`) the request
 *    asks about — REQUIRED on both sides: an absent `merchantTo` or
 *    `resourceUrl` in the request never matches (nothing to scope the
 *    replay to), and a key collision against a different payee or resource
 *    must still run (and can still fail) today's compare. `delegationReplay`
 *    does not compare payee or resource on confirmed rows at all. The
 *    resource comparison is scheme-agnostic BY CONSTRUCTION: it compares
 *    `body.resourceUrl` against whichever value the row's own
 *    `x402_resource_url` column stores, and that storage is already
 *    scheme-aware at authorize time — erc7710 persists the caller's
 *    `resourceUrl` (`merchantUrl` on the hosted path), eip3009 persists
 *    `paymentRequired.resource.url` — the SDK's `createX402Intent` sends
 *    that as the `url` field of its `POST /x402` body unconditionally, with
 *    no caller override — so the CALLER is responsible for sending the value
 *    that matches what will be stored for the scheme it is replaying
 *    (`catalog-purchase.ts` step 5b, #3527).
 *  - the SAME token and amount the request asks about, for the same reason
 *    (also unmatched by `delegationReplay` on confirmed rows).
 *  - `findPaymentReplay` (`routes/payments.ts`, NOT edited in this slice —
 *    #3618 owns that file) is the BROADEST reading: any row no longer
 *    `pending_signature` that its key lookup still finds answers its stored
 *    status with no `tx_hash`, scheme or match-field condition (its pin runs
 *    as a key-collision 409 first). The lookup skips `failed` and `expired`
 *    rows (`FIND_SEND_INTENT_BY_KEY_SQL`), so those free the key (#3620).
 *    A confirmed row with a `tx_hash` therefore replays there too — but
 *    nothing about a replay decision is refused as over-budget on that
 *    surface, so the false-ledger-row hazard the first bullet guards does
 *    not arise there.
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
  // #3518: scope the selection to the QUOTED TOKEN first, then run the
  // payment's own selection inside it — the recipient match, window and
  // ordering of `SELECT_DELEGATION_FOR_PAYMENT_SQL`, not the first token
  // row (see the module comment for why the first match refused and
  // allowed the wrong payments). `merchantTo` is lowercased once here;
  // `selectBudgetForPaymentReport` compares case-insensitively and treats
  // null as "open budget only".
  const amountAtomic = BigInt(amountAtomicString)
  const merchantTo = body.merchantTo ? body.merchantTo.toLowerCase() : null
  const nowSec = Math.floor(Date.now() / 1000)
  const tokenBudgets = budgets.filter((b) => b.token_address.toLowerCase() === tokenAddress.toLowerCase())
  const match = selectBudgetForPaymentReport(
    tokenBudgets,
    merchantTo,
    nowSec,
    (b) => Number(b.expires_at),
    (b) => Number(b.start_date),
    (b) => b.created_at.getTime(),
  )

  // #3518 review: no payee named, no open budget, but live merchant-locked
  // budgets for this token. That is an INCOMPLETE question, not an exhausted
  // budget: answering "remaining 0 — ask the owner to raise the budget" (and
  // ledgering a delegation_budget_exceeded refusal) misstates why, while the
  // agent holds a funded pin. Answer 409 naming the pins, write nothing; the
  // caller repeats the check with merchantTo. A replay of a settled payment
  // never reaches here (it requires merchantTo).
  if (!match && merchantTo === null) {
    const pins = liveRecipientPins(tokenBudgets, nowSec, (b) => Number(b.expires_at), (b) => Number(b.start_date))
    if (pins.length > 0) {
      return {
        statusCode: 409,
        body: {
          error:
            "This agent's budget for this token is locked to specific recipients, and the check named none. " +
            'Repeat it with merchantTo set to the payee; a payment to any other address has no budget.',
          error_code: 'budget_requires_recipient',
          next_action: 'retry_with_explicit_context',
          chain_id: agent.chain_id,
          asset: tokenAddress,
          budget_recipient_addresses: pins,
        },
      }
    }
  }
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
  // legs' pre-check refusals. #3619: the body is the #3616 builder's `mpp`
  // flavor, equal field for field to the body this file hand-built (the
  // hosted tool parses it — #3504 — so the equality is wire).
  const refusalBody = buildPeriodExceededBody({
    flavor: 'mpp',
    chainId: agent.chain_id,
    tokenSymbol: symbol,
    tokenAddress,
    decimals: token.decimals,
    amountAtomic: amountAtomicString,
    remainingAtomic,
    resourceUrl: body.resourceUrl,
    merchantAddress: merchantTo ?? undefined,
    // #3518: the refusal row and body name the budget whose remaining figure
    // the compare ran against — the payment-selection mirror's winner. The
    // detail allowlist (086/087) keeps the taxonomy subset only; these ride
    // the RESPONSE body (and the ledger row's merchant column via
    // `merchantTo`), not `detail`.
    extraFields: match
      ? {
          budget_id: match.id,
          budget_delegation_hash: match.delegation_hash,
          budget_recipient_address: match.recipient_address,
          budget_merchant_id: match.merchant_id,
        }
      : undefined,
  })
  const decided: DecidedResponse = refuse(
    {
      code: 403,
      body: refusalBody,
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
      detail: periodExceededLedgerDetail(remainingAtomic),
    },
  )
  return { statusCode: decided.code, body: decided.body as Record<string, unknown> }
}
