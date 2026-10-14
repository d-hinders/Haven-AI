/**
 * Shared hosted-MCP support — quote-response construction, payment-status
 * predicates, wrong-tool failures, and resume-state resolution.
 *
 * Extracted VERBATIM from `tools.ts` by #2808 (behavior-preserving move).
 * `buildMcpToolQuoteResponse` serves both quote tools and the generic x402
 * quote (#2054 same-field contract); `isPendingApproval` is the retained
 * fail-closed predicate (#2101) read from handler bodies in every planned
 * capability slice (#2809–#2812); `resolveResumeState` validates an
 * explicitly-passed resume_state's rail instead of trusting it.
 * `settlementPredictionFields` (#2999) is the same #2991 prediction, exported
 * so `haven_quote_x402` in `plain-http-x402.ts` (#2811) carries it too — a
 * third caller alongside `buildMcpToolQuoteResponse`'s own two. All live in
 * shared support — never copied.
 *
 * One-direction dependencies: imports the SDK, the #2807 contract seam, and
 * the sibling transport serializer. Never imports a capability module.
 */
import {
  AgentPaymentNextAction,
  AgentPaymentWarningCode,
  HavenApiError,
  HavenClient,
  selectErc7710PaymentOption,
  selectX402SettlementScheme,
  x402AuthorizationAmount,
  type AgentPaymentWarning,
  type HavenAgent,
  type HavenCatalogEntry,
  type X402McpTransport,
  type X402PaymentOption,
  type X402Quote,
  type X402ResumeState,
} from '@haven_ai/sdk'
import type { ToolFailure } from '../contracts.js'
import { serializeMcpTransport } from './mcp-context.js'

/**
 * #2991 — predict the settlement scheme `haven_prepare_catalog_purchase` /
 * `haven_pay_mcp_tool` will ACTUALLY select for this account, using the
 * IDENTICAL `selectX402SettlementScheme` call those tools run at prepare/pay
 * time (`catalog-purchase.ts` steps 3-4 / the pay tool's #1456 selection) —
 * so a quote can never disagree with what prepare does next. `agent` is
 * `undefined` exactly when the `getAgent` prefetch failed (same non-throwing
 * `.then(a => a, () => undefined)` convention prepare/pay use), and this
 * returns `null` rather than guess a rail it could not read.
 *
 * A `null` selection from the selector itself (an erc7710-ONLY merchant next
 * to an account whose rail does not qualify) is NOT "unknown" — the scheme
 * that merchant will settle with, if it settles at all, is still erc7710;
 * the rail mismatch is what `requireSettleableSelection` refuses at
 * prepare/pay, not the existence of a predictable scheme. This mirrors
 * `buildX402Quote`'s own `acceptedScheme`, which already reports 'erc7710'
 * for such a merchant regardless of the (unknown, at quote time) rail.
 */
function predictSettlementScheme(
  accepts: X402PaymentOption[],
  agent: HavenAgent | undefined,
): {
  scheme: 'erc7710' | 'eip3009'
  fundingLeg: boolean
  settleable?: false
  /**
   * #3967: the option the selection picked — the one pay will actually
   * authorize, so the quote-time budget pre-check and the `expected_amount`
   * comparison ask about IT (`amount`, `payTo`, `asset`), never about
   * `quote.accepted`, which describes the merchant's preferred entry and can
   * differ from what a delegation-rail account selects (#2051).
   */
  option: X402PaymentOption
} | null {
  if (!agent) return null
  const selection = selectX402SettlementScheme(accepts, {
    delegationRail: agent.executionRail === 'delegation',
  })
  if (selection) {
    // #2993 review: the selector still yields eip3009 for a non-delegation
    // account, but Haven's x402 entry points refuse every retired rail with
    // 410 before anything is written (`modules/x402/authorize.ts`) — only the
    // delegation rail executes. So the prediction is the selector's scheme,
    // and `settleable` is whether Haven will actually take it.
    return {
      scheme: selection.scheme,
      fundingLeg: selection.scheme === 'eip3009',
      ...(agent.executionRail === 'delegation' ? {} : { settleable: false as const }),
      option: selection.option,
    }
  }
  // No settleable option for THIS agent's rail: an erc7710-only merchant and
  // an agent not on the delegation rail. Prepare/pay will refuse this with
  // ERC7710_RAIL_REQUIRED (`requireSettleableSelection`), so the honest
  // prediction is the scheme the merchant demands plus `settleable: false`
  // — not a bare 'erc7710' that reads as "prepare will settle it".
  const erc7710 = selectErc7710PaymentOption(accepts)
  return erc7710
    ? { scheme: 'erc7710', fundingLeg: false, settleable: false, option: erc7710 }
    : null
}

/**
 * #3967: what `haven_prepare_catalog_purchase` / `haven_pay_mcp_tool` /
 * `haven_pay_x402_quote` will ACTUALLY authorize for this account — the same
 * `selectX402SettlementScheme` selection `predictSettlementScheme` above runs,
 * exposed so the quote surfaces can aim the quote-time budget pre-check and
 * the `expected_amount` comparison at the option pay selects (#2051) rather
 * than at `quote.accepted`. `null` exactly when the prediction above is null
 * (the agent read failed, or no compatible option exists).
 */
export function selectedSettlement(
  accepts: X402PaymentOption[],
  agent: HavenAgent | undefined,
): { scheme: 'erc7710' | 'eip3009'; option: X402PaymentOption } | null {
  const prediction = predictSettlementScheme(accepts, agent)
  return prediction ? { scheme: prediction.scheme, option: prediction.option } : null
}

/**
 * #2999 — the `expected_settlement_scheme` / `expected_funding_leg` /
 * `expected_settleable` / `warnings` field set #2991 gave the two MCP quote
 * tools, built from the SAME `predictSettlementScheme` call above so a third
 * quote surface (the plain-HTTP `haven_quote_x402`) can carry the identical
 * prediction without re-deriving the field shape or the warning text. Kept
 * here rather than inlined at each call site because the warning message is
 * part of the prediction's contract, not the caller's — the two existing
 * callers of `predictSettlementScheme` (`buildMcpToolQuoteResponse` below,
 * and `haven_quote_x402` in `plain-http-x402.ts`) now go through this instead
 * of duplicating the null-check/warning pairing.
 */
export function settlementPredictionFields(
  accepts: X402PaymentOption[],
  agent: HavenAgent | undefined,
  // #3007 review: the warning names the pay sibling(s) that will select the
  // scheme — different per quote surface.
  paySiblings = 'haven_prepare_catalog_purchase / haven_pay_mcp_tool',
): {
  expected_settlement_scheme: 'erc7710' | 'eip3009' | null
  expected_funding_leg: boolean | null
  expected_settleable?: boolean
  warnings?: AgentPaymentWarning[]
} {
  const prediction = predictSettlementScheme(accepts, agent)
  const warnings: AgentPaymentWarning[] = []
  if (prediction === null) {
    warnings.push({
      code: AgentPaymentWarningCode.X402SchemeUnknown,
      message:
        "This agent's account rail could not be read from Haven, so the settlement scheme " +
        `${paySiblings} will select cannot be predicted here. Retry when haven_get_agent ` +
        'succeeds, or proceed to prepare/pay directly — that step reads the rail fresh regardless.',
    })
  }
  return {
    expected_settlement_scheme: prediction?.scheme ?? null,
    expected_funding_leg: prediction ? prediction.fundingLeg : null,
    ...(prediction ? { expected_settleable: prediction.settleable !== false } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

/**
 * #3967 — the outcome of the quote-time budget pre-check, in the three-outcome
 * shape `catalog-purchase.ts`'s prepare preflight established (sufficient /
 * decided refusal / unavailable degrade) plus `skipped` for when the check was
 * not ASKED (chain or token mismatch, no agent, retired rail): a quote must
 * never refuse on a question it did not ask, so a skip reports
 * `sufficient: null` with no warning.
 */
export type QuoteBudgetPrecheckOutcome =
  | { kind: 'sufficient'; requestedAtomic: string; remainingAtomic?: string }
  | { kind: 'refused'; requestedAtomic: string; remainingAtomic: string }
  | { kind: 'unavailable'; requestedAtomic: string; detail?: string }
  | { kind: 'skipped'; requestedAtomic: string }

/**
 * #3967: the `budget_check` block and its advisory warning, shared by ALL
 * THREE quote surfaces (`haven_quote_x402`, `haven_quote_mcp_tool`,
 * `haven_quote_catalog_purchase`). The figures ride in the block —
 * `AgentPaymentWarning` is `{ code, message }` — in the same shape as catalog
 * prepare's allowance block. The warning is advisory and never replaces the
 * next step; the stop decision is the caller's, read off
 * `budget_check.sufficient === false`.
 */
export function quoteBudgetCheckFields(outcome: QuoteBudgetPrecheckOutcome): {
  budget_check: {
    sufficient: boolean | null
    remaining_atomic?: string
    requested_atomic: string
  }
  warnings: AgentPaymentWarning[]
} {
  if (outcome.kind === 'refused') {
    return {
      budget_check: {
        sufficient: false,
        remaining_atomic: outcome.remainingAtomic,
        requested_atomic: outcome.requestedAtomic,
      },
      warnings: [
        {
          code: AgentPaymentWarningCode.QuoteExceedsRemainingBudget,
          message:
            `The quoted amount (${outcome.requestedAtomic} atomic) exceeds the agent's remaining ` +
            `delegation budget (${outcome.remainingAtomic} atomic), decided by Haven's server-side ` +
            'budget pre-check — the same compare the payment path runs before funding. An ' +
            'over-budget redemption would revert on-chain. Stop and tell the user before any ' +
            'payment; the wallet owner can grant or raise the budget in Haven.',
        },
      ],
    }
  }
  if (outcome.kind === 'unavailable') {
    return {
      budget_check: { sufficient: null, requested_atomic: outcome.requestedAtomic },
      warnings: [
        {
          code: AgentPaymentWarningCode.AllowanceCheckUnavailable,
          message:
            'The quote-time budget pre-check could not be read' +
            (outcome.detail ? ` (${outcome.detail})` : '') +
            ' — no budget figure is reported. FAILING OPEN: the quote proceeds as if the check ' +
            'had passed, and the on-chain policy remains the actual spend gate. This degrades ' +
            'guidance only, never a refusal.',
        },
      ],
    }
  }
  // sufficient, or skipped (chain/token mismatch, no agent, retired rail):
  // no warning — a skipped check was never asked, and a sufficient one needs
  // no caveat beyond the block itself.
  return {
    budget_check: {
      sufficient: outcome.kind === 'sufficient' ? true : null,
      ...(outcome.kind === 'sufficient' && outcome.remainingAtomic !== undefined
        ? { remaining_atomic: outcome.remainingAtomic }
        : {}),
      requested_atomic: outcome.requestedAtomic,
    },
    warnings: [],
  }
}

/**
 * #3967 — the denial keys Haven recognizes in `accepts[].extra`. The list
 * STARTS with `issuanceDenied` (the Bitrefill x402 invoice denial that
 * motivated the check: a 402 advertising 1000 USDC whose Lightning entry
 * carried `extra.issuanceDenied: "invoice_not_found"`) and is deliberately a
 * named, extensible list — not "any key" — so merchant-internal metadata that
 * happens to look like a denial never reads as one. A hit is INFORMATIONAL
 * ONLY: it flips neither `safe_to_continue` nor `expected_settleable`.
 */
const MERCHANT_DENIAL_KEYS: readonly string[] = ['issuanceDenied']

/**
 * #3967: surface a known merchant-reported denial from any `accepts[].extra`
 * as an informational warning naming the key, its value and the entry's
 * network. One warning per hit; an entry with no `extra`, or `extra` without
 * a listed key, contributes nothing.
 */
export function merchantDenialWarnings(accepts: X402PaymentOption[]): AgentPaymentWarning[] {
  const warnings: AgentPaymentWarning[] = []
  for (const option of accepts ?? []) {
    if (option === null || typeof option !== 'object') continue
    const extra = (option as { extra?: Record<string, unknown> }).extra
    if (extra === null || typeof extra !== 'object') continue
    for (const key of MERCHANT_DENIAL_KEYS) {
      if (!(key in extra)) continue
      const value = extra[key]
      warnings.push({
        code: AgentPaymentWarningCode.MerchantReportedDenial,
        message:
          `The merchant itself reported '${key}: ${String(value)}' on its ${option.network} ` +
          'payment option — a denial the MERCHANT recorded, not Haven. Informational only: ' +
          'it does not change whether this quote is safe to continue or settleable, but the ' +
          'agent should surface it to the user before paying.',
      })
    }
  }
  return warnings
}

/**
 * #3967: RUN the quote-time budget pre-check and map it to the shared outcome,
 * the three-outcome pattern `catalog-purchase.ts`'s prepare preflight
 * established, plus `skipped` for a question that was never askable. Shared by
 * all three quote surfaces.
 *
 * Money-path gates this implements (issue #3967):
 * - It can only ever STOP the agent (a decided refusal) — never widen
 *   authority. The later on-chain `evaluatePeriodPrecheck` is untouched and
 *   remains the actual gate.
 * - An unavailable check degrades with a warning, NEVER a refusal.
 * - The chain/token guards exist so the quote does not refuse FALSELY: the
 *   backend compares against the agent's own chain budgets, so a quote whose
 *   chain differs from the agent's must not be measured against them. The
 *   token asked about is the SELECTED option's asset — the option pay will
 *   authorize (#2051) — and only when it is a well-formed address the route
 *   can accept.
 * - `record_refusal: false` — a quote is not a payment attempt and never
 *   writes to the refusals ledger; a later prepare records its own refusal.
 * - NO idempotency key: a quote is a fresh read, and passing the quote's key
 *   could match an earlier settled row and answer `replay: true` for what is
 *   really a repeat purchase.
 */
export async function runQuoteBudgetPrecheck(
  haven: HavenClient,
  quote: X402Quote,
  agent: HavenAgent | undefined,
): Promise<QuoteBudgetPrecheckOutcome> {
  if (!agent) {
    return {
      kind: 'unavailable',
      requestedAtomic: quote.amountAtomic,
      detail: 'the agent could not be read from Haven',
    }
  }
  if (agent.executionRail !== 'delegation') {
    // The route 410s retired rails (`budget-precheck-guards.ts`), so asking
    // would be a wasted round trip that always degrades — say so directly.
    return {
      kind: 'unavailable',
      requestedAtomic: quote.amountAtomic,
      detail: `the agent's account is on the '${agent.executionRail}' rail, which is retired and cannot purchase`,
    }
  }
  if (quote.chainId === null || quote.chainId !== agent.chainId) {
    // Chain mismatch — the backend derives budgets scoped to the AGENT's
    // chain; measuring this quote against them would answer a question about
    // a different network. Skip: sufficient null, no warning, no call.
    return { kind: 'skipped', requestedAtomic: quote.amountAtomic }
  }
  const selection = selectedSettlement(quote.paymentRequired.accepts, agent)
  if (!selection) return { kind: 'skipped', requestedAtomic: quote.amountAtomic }
  let optionAmount: bigint
  try {
    // The AUTHORIZATION amount — `maxAmountRequired` when the merchant names
    // one, exactly what prepare/pay would authorize (x402AuthorizationAmount).
    optionAmount = BigInt(x402AuthorizationAmount(selection.option))
  } catch {
    // A non-integer option amount is unpayable data — the pay path refuses it
    // on its own; the budget question is not askable about it.
    return { kind: 'skipped', requestedAtomic: quote.amountAtomic }
  }
  const requestedAtomic = optionAmount.toString()
  if (!/^0x[0-9a-fA-F]{40}$/.test(selection.option.asset)) {
    // The route refuses a non-address token with a 400 — a question that can
    // never be answered is a skip, not an unavailable check.
    return { kind: 'skipped', requestedAtomic }
  }
  try {
    const precheck = await haven.precheckBudget({
      chainId: agent.chainId,
      token: selection.option.asset,
      amountAtomic: requestedAtomic,
      merchantTo: selection.option.payTo,
      // Same per-scheme resource rule the prepare preflight follows (#3527):
      // the value authorize will persist for THIS scheme — erc7710 the quote's
      // resourceUrl, eip3009 the challenge's own resource.url.
      resourceUrl:
        selection.scheme === 'erc7710'
          ? quote.resourceUrl
          : (quote.paymentRequired.resource?.url ?? quote.resourceUrl),
      recordRefusal: false,
    })
    // Only an EXPLICIT answer is trusted: a 200 whose body carries no
    // sufficient flag (an old backend, a stub) is a malformed answer, not a
    // decision — degrade, never refuse on a shape we cannot read.
    if (precheck.sufficient === true) {
      return { kind: 'sufficient', requestedAtomic, remainingAtomic: precheck.remaining_atomic }
    }
    if (precheck.sufficient === false) {
      return {
        kind: 'refused',
        requestedAtomic,
        remainingAtomic: precheck.remaining_atomic ?? '0',
      }
    }
    return {
      kind: 'unavailable',
      requestedAtomic,
      detail: 'the pre-check answer carried no sufficient decision',
    }
  } catch (err: unknown) {
    // The decided over-budget refusal is the ONE failure that is not a
    // degrade (catalog-purchase.ts, verbatim in semantics): a typed 403
    // delegation_budget_exceeded. Everything else — transport down, a retired
    // rail's 410, an older backend without the route — fails OPEN.
    const decided =
      err instanceof HavenApiError &&
      err.statusCode === 403 &&
      (err.body as { error_code?: string } | undefined)?.error_code ===
        'delegation_budget_exceeded'
    if (decided) {
      return {
        kind: 'refused',
        requestedAtomic,
        remainingAtomic:
          (err.body as { remaining_atomic?: string } | undefined)?.remaining_atomic ?? '0',
      }
    }
    return {
      kind: 'unavailable',
      requestedAtomic,
      detail: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Build the compact, non-authorizing response shared by the generic and
 * catalog MCP quote tools. Deliberately omit payment_required, idempotency,
 * and every signing/funding field: callers must start a fresh paid flow after
 * the user chooses a cap, and that flow obtains its own live quote.
 */
export function buildMcpToolQuoteResponse(input: {
  quote: X402Quote
  merchantUrl: string
  requestedMerchantUrl: string
  toolName: string
  toolArguments: Record<string, unknown>
  catalog?: HavenCatalogEntry
  // #2991: the prefetched agent (undefined when the read failed) — used ONLY
  // to predict expected_settlement_scheme/expected_funding_leg below, never
  // to change accepted_scheme/erc7710_only, which describe the MERCHANT's
  // offer and stay exactly as `buildX402Quote` computed them.
  agent: HavenAgent | undefined
  // #3967: the quote-time budget pre-check's outcome, when the caller ran it
  // (the two handlers do, with `record_refusal: false` — a quote never writes
  // to the refusals ledger). Absent: no budget_check block and
  // `safe_to_continue` reads only the rest of this builder — the shape stays
  // honest for any caller that has not migrated.
  budgetPrecheck?: QuoteBudgetPrecheckOutcome
}) {
  const { quote, merchantUrl, requestedMerchantUrl, toolName, toolArguments, catalog, agent } = input
  const prediction = settlementPredictionFields(quote.paymentRequired.accepts, agent)
  // #3967: the budget pre-check's block and warning, plus the merchant
  // denial hints, MERGED with the prediction's own warnings — never a second
  // `warnings` key overwriting `X402_SCHEME_UNKNOWN`.
  const budget = input.budgetPrecheck ? quoteBudgetCheckFields(input.budgetPrecheck) : null
  const denialWarnings = merchantDenialWarnings(quote.paymentRequired.accepts)
  const mergedWarnings = [
    ...(prediction.warnings ?? []),
    ...(budget?.warnings ?? []),
    ...denialWarnings,
  ]
  const overBudget = budget?.budget_check.sufficient === false
  return {
    rail: quote.rail,
    merchant_url: merchantUrl,
    merchant_url_was_discovered: merchantUrl !== requestedMerchantUrl,
    tool_name: toolName,
    arguments: toolArguments,
    resource_url: quote.resourceUrl,
    description: quote.description,
    mime_type: quote.mimeType,
    amount_atomic: quote.amountAtomic,
    amount: quote.amount,
    token: quote.token,
    decimals: quote.decimals,
    asset: quote.asset,
    network: quote.network,
    chain_id: quote.chainId,
    merchant_address: quote.merchantAddress,
    max_timeout_seconds: quote.maxTimeoutSeconds,
    // #2054: which accepts[] entry the amounts above describe. 'erc7710'
    // means the merchant advertises NO standard entry — the purchase tools
    // can settle it only from a delegation-rail account, so an agent can
    // tell the user BEFORE calling them.
    accepted_scheme: quote.acceptedScheme,
    ...(quote.acceptedScheme === 'erc7710' ? { erc7710_only: true } : {}),
    // #2991: what prepare/pay will ACTUALLY do for this account, computed by
    // the identical selector — never derived from accepted_scheme, which
    // describes the merchant's offer and can legitimately disagree (a
    // delegation-rail account is quoted accepted_scheme: 'standard' at a
    // merchant advertising both, but prepare/pay still PREFER erc7710).
    // #2991 review: expected_settleable is false when prepare/pay will REFUSE
    // for this agent's rail — ERC7710_RAIL_REQUIRED at an erc7710-only
    // merchant, or Haven's own 410 on any retired (non-delegation) rail — the
    // scheme above is then what the selector picks, not what Haven will do.
    // Omitted when the rail is unknown. #2999: these four fields now come
    // from settlementPredictionFields (see above) instead of being derived
    // inline, so a third quote surface can share the exact same shape.
    ...prediction,
    // #3967: merged, never overwritten — see mergedWarnings above.
    ...(mergedWarnings.length > 0 ? { warnings: mergedWarnings } : {}),
    // #3967: always present on the MCP quote tools. `false` when the budget
    // pre-check refused — the agent should stop and involve the user before
    // continuing. The tools stay INFORMATIONAL: no next-step block is added
    // either way (quote_is_informational below is unchanged).
    safe_to_continue: !overBudget,
    ...(budget ? { budget_check: budget.budget_check } : {}),
    ...(quote.mcpTransport ? { mcp_transport: serializeMcpTransport(quote.mcpTransport) } : {}),
    ...(catalog
      ? {
          catalog_id: catalog.id,
          catalog_name: catalog.name,
          catalog_price_atomic: catalog.priceAtomic,
          catalog_price_display: catalog.priceDisplay,
          catalog_price_is_indicative: true,
          catalog_price_differs: catalog.priceAtomic !== null && catalog.priceAtomic !== quote.amountAtomic,
        }
      : {}),
    quote_is_informational: true,
  }
}

/**
 * RETAINED DELIBERATELY, and unreachable from any live rail (#2101).
 *
 * No Haven rail mints a payment-level `pending` / `pending_approval` any more:
 * the legacy AllowanceModule rail answers 410 at every agent-payment entry
 * point (#1986, `rails/execution-rail.ts`), the delegation rail refuses an
 * out-of-policy payment during prepare with 403/502 and nothing written
 * (`routes/payments.ts`), and #2055 dropped the `approval_requests` table the
 * status was read back from. `pending_approval` appears in no migration, so no
 * `payment_intents` row can carry it either.
 *
 * The branches guarded by this helper are kept because they are fail-CLOSED —
 * they stop the agent and hand the payment_id back instead of delivering a
 * merchant header for funding that did not confirm. Deleting them would trade
 * a defined stop for an undefined fall-through on a stored row from before the
 * retirement, which is strictly worse on a money surface. What was removed is
 * the agent-visible PROMISE: no description or instruction tells a model to
 * expect this status or to wait for an approval, so a model that ever meets it
 * follows the general "a status you do not recognise → stop and tell the user"
 * rule in the server instructions. The wire-type question (whether the status
 * union itself should shrink) belongs with the OpenAPI schema decision in
 * #2105, not with a prose fix.
 */
export function isPendingApproval(status: string | undefined): boolean {
  return status === 'pending' || status === 'pending_approval'
}

export function wrongTool(code: string, message: string, suggested_tool?: string): ToolFailure {
  return { success: false, code, message, suggested_tool }
}

// #1328: the 'mpp' rail branch (and its haven_resume_mpp_payment caller) is
// retired — this now only ever resolves x402 resume state. Still validates
// an explicitly-passed resume_state's rail rather than trusting it blindly:
// a caller holding a pre-retirement 'mpp' resume_state gets a clear mismatch
// error instead of silently proceeding against the wrong protocol context.
export async function resolveResumeState(
  haven: HavenClient,
  args: { payment_id?: string; resume_state?: unknown },
  rail: 'x402',
): Promise<X402ResumeState> {
  if (args.resume_state && typeof args.resume_state === 'object') {
    const stateRail = (args.resume_state as { rail?: unknown }).rail
    if (stateRail !== undefined && stateRail !== rail) {
      throw new HavenApiError(`Resume state is not for the ${rail} rail.`, 409, args.resume_state)
    }
    return args.resume_state as X402ResumeState
  }
  if (args.payment_id) {
    return haven.getResumeState(args.payment_id) as Promise<X402ResumeState>
  }
  throw new HavenApiError(
    `haven_resume_${rail}_payment requires resume_state or payment_id.`,
    400,
  )
}
