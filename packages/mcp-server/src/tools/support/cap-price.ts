/**
 * Shared hosted-MCP support — selected-option cap and price selection.
 *
 * Extracted VERBATIM from `tools.ts` by #2808 (behavior-preserving move; the
 * doc comments are the load-bearing record of why this shape exists, so they
 * moved with the code). Three callers across planned capability slices
 * (#2809–#2812) read these: the cap contract spans multiple slices, so it
 * belongs in shared support, never copied per-capability.
 *
 * One-direction dependencies: this module imports only the SDK and
 * `../errors.js` (HostedToolError). It never imports a capability module.
 */
import {
  AgentPaymentFailureCode,
  AgentPaymentNextAction,
  AgentPaymentWarningCode,
  HavenApiError,
  HavenError,
  resolveTokenFromAddress,
  selectErc7710PaymentOption,
  selectX402SettlementScheme,
  x402AuthorizationAmount,
  type AgentPaymentWarning,
  type X402PaymentOption,
} from '@haven_ai/sdk'
import { HostedToolError } from './errors.js'

/**
 * #1351: how the caller expressed this purchase's pre-funding cap.
 *
 * `max_amount` is atomic units of the merchant's asset; `max_amount_human` is
 * the same cap written the way a user says it ("1" = 1 USDC). They differ by
 * 10^decimals, so an agent that means "no more than 1 USDC" and writes
 * `max_amount: "1"` has asked for a cap of 0.000001 USDC — the schema accepted
 * it, and #1275's guard compared it faithfully. Nothing overspends from that
 * mistake (it fails closed, too tight), but the agent cannot buy anything and
 * has no signal why. The fix is a field whose NAME carries the unit.
 */
export type MaxAmountCap =
  | { kind: 'none' }
  | { kind: 'atomic'; value: string }
  | { kind: 'human'; value: string }

/**
 * Pre-funding price guard. `authorizedAtomic` is the MERCHANT's own quoted
 * ceiling for the call — `maxAmountRequired ?? amount`, read straight off the
 * merchant's 402 response by the SDK's `x402AuthorizationAmount`
 * (`packages/sdk/src/x402.ts`). **Haven authorizes nothing here** (#2334,
 * #2347): the figure is what the merchant may settle up to, i.e. the user's
 * worst-case spend, which is the right figure to cap. "Authorization" in this
 * function's names is the x402/EIP-3009 FUNDING LEG the amount travels into,
 * never a grant of spend authority — that comes only from the owner-signed
 * `erc20PeriodTransfer` delegation (`rails/delegation-policy.ts`, built
 * unsigned and signed by the account owner) and the on-chain
 * `ERC20PeriodTransferEnforcer` caveat it is redeemed under.
 * Throws a typed PRICE_EXCEEDS_MAX (preserved by
 * normalizeError) when it exceeds the agent's cap, so the call fails
 * BEFORE any funding transfer. The on-chain allowance is still the hard gate;
 * this is an extra agent affordance against surprise overcharges within budget.
 * Compared in atomic BigInt units.
 */
export function assertWithinMaxAmount(
  authorizedAtomic: string,
  maxAmount: string | undefined,
  token: string | undefined,
  // #1351: how the CALLER expressed the cap, for the message only. The
  // comparison is always atomic-vs-atomic; echoing "1 USDC" back at an agent
  // that wrote `max_amount_human: "1"` beats echoing 1000000 it never typed.
  capLabel?: string,
): void {
  if (maxAmount === undefined) return
  let authorized: bigint
  let cap: bigint
  try {
    authorized = BigInt(authorizedAtomic)
    cap = BigInt(maxAmount)
  } catch {
    throw new HavenError(
      'max_amount and the authorized amount must be decimal atomic amounts.',
      'INVALID_MAX_AMOUNT',
      400,
    )
  }
  if (authorized > cap) {
    const unit = token ? `${token}, atomic units` : 'atomic units'
    const capText = capLabel ? `${capLabel} (= ${maxAmount} atomic)` : `max_amount ${maxAmount}`
    throw new HavenError(
      `Authorized amount ${authorizedAtomic} exceeds ${capText} (${unit}); ` +
        `this is the ceiling the merchant can settle at. No funds were moved. ` +
        `Confirm the higher amount with the user before retrying with a larger cap.`,
      AgentPaymentFailureCode.PriceExceedsMax,
      400,
    )
  }
}

/**
 * Phase 1 of the cap contract: validate the SHAPE of the caller's cap fields
 * with no network access at all, so a contradictory request is refused before
 * the merchant probe — let alone before a funding intent, a signature, or any
 * money movement. Phase 2 (`resolveCapAtomic`) needs the live quote and runs
 * after it.
 */
export function readMaxAmountCap(
  args: Record<string, unknown>,
  opts: { required: boolean },
): MaxAmountCap {
  const atomic = args.max_amount as string | undefined
  const human = args.max_amount_human as string | undefined

  if (atomic !== undefined && human !== undefined) {
    throw new HostedToolError({
      code: AgentPaymentFailureCode.AmbiguousMaxAmount,
      message:
        `Both max_amount ("${atomic}", atomic units) and max_amount_human ("${human}", ` +
        `whole tokens) were supplied for one purchase. These are different caps — they ` +
        `differ by a factor of 10^decimals — and Haven will not guess which one the user ` +
        `meant. No merchant was contacted and no funds were moved. Send exactly ONE: ` +
        `max_amount_human for a cap the user stated in tokens ("no more than 1 USDC" → ` +
        `max_amount_human: "1"), or max_amount when you already hold an exact atomic figure.`,
      statusCode: 400,
      nextAction: AgentPaymentNextAction.StopAndTellUser,
    })
  }
  if (atomic !== undefined) return { kind: 'atomic', value: atomic }
  if (human !== undefined) return { kind: 'human', value: human }
  if (opts.required) {
    // Same INVALID_INPUT code the schema itself would have produced when
    // max_amount was unconditionally required on this tool — the guided path
    // still refuses to run uncapped, it now accepts either spelling.
    throw new HostedToolError({
      code: 'INVALID_INPUT',
      message:
        'A spending cap is REQUIRED before a paid merchant call. Pass max_amount_human ' +
        '(whole tokens, e.g. "1" for 1 USDC — recommended) or max_amount (atomic units). ' +
        'No merchant was contacted and no funds were moved.',
      statusCode: 400,
      nextAction: AgentPaymentNextAction.StopAndTellUser,
    })
  }
  return { kind: 'none' }
}

/**
 * Exact decimal-string → atomic conversion. No floats anywhere: `Number("0.1")`
 * cannot represent a tenth, and this figure is a spending limit. Returns null
 * when the value carries more fraction digits than the asset can hold, because
 * the only alternatives there are rounding the user's cap up (unsafe) or down
 * (silently different) — the caller turns null into a refusal.
 */
export function humanToAtomic(human: string, decimals: number): bigint | null {
  const match = /^([0-9]+)(?:\.([0-9]+))?$/.exec(human)
  if (!match) return null
  const whole = match[1]
  const fraction = match[2] ?? ''
  if (fraction.length > decimals) return null
  return BigInt(whole + fraction.padEnd(decimals, '0'))
}

/**
 * Phase 2 of the cap contract: bind the cap to THIS quote. The quote's asset,
 * decimals and network stay authoritative — a human cap is only ever
 * interpreted through the decimals the live quote resolved for the asset the
 * merchant actually asked to be paid in, never through a caller-supplied token
 * name or an assumed 6. Returns the atomic cap to compare, plus the label to
 * quote back at the agent if it is exceeded.
 *
 * This NARROWS spend and can never widen it: the result feeds
 * `assertWithinMaxAmount`, which only ever throws. The on-chain allowance (or
 * delegation budget) remains the hard gate regardless of what is passed here.
 */
export function resolveCapAtomic(
  cap: MaxAmountCap,
  quote: { decimals: number | null; token: string; asset: string; network: string },
): { atomic: string | undefined; label?: string } {
  if (cap.kind === 'none') return { atomic: undefined }
  if (cap.kind === 'atomic') return { atomic: cap.value }

  if (quote.decimals === null) {
    throw new HostedToolError({
      code: AgentPaymentFailureCode.MaxAmountUnconvertible,
      message:
        `max_amount_human ("${cap.value}") cannot be applied to this quote: Haven does not ` +
        `recognise the merchant's asset ${quote.asset} on ${quote.network}, so the number of ` +
        `atomic units in one token is unknown and any conversion would be a guess. No funding ` +
        `intent was created and no funds were moved. Re-send the cap as max_amount in atomic ` +
        `units of that asset, or ask the user to confirm this merchant is expected.`,
      statusCode: 400,
      nextAction: AgentPaymentNextAction.StopAndTellUser,
    })
  }

  const atomic = humanToAtomic(cap.value, quote.decimals)
  if (atomic === null) {
    throw new HostedToolError({
      code: AgentPaymentFailureCode.MaxAmountUnconvertible,
      message:
        `max_amount_human ("${cap.value}") carries more decimal places than ${quote.token} ` +
        `supports (${quote.decimals}). Truncating it would silently change the user's cap, so ` +
        `Haven refuses instead. No funding intent was created and no funds were moved. Round ` +
        `the cap to ${quote.decimals} decimal places, or send an exact max_amount in atomic units.`,
      statusCode: 400,
      nextAction: AgentPaymentNextAction.StopAndTellUser,
    })
  }
  return { atomic: atomic.toString(), label: `max_amount_human ${cap.value} ${quote.token}` }
}

/**
 * Atomic → human display for an amount whose decimals were resolved from the
 * asset itself. The SDK's `decimalFromUsdcAtomic` hardcodes 6, which is right
 * for every asset Haven can settle today and wrong the moment that changes;
 * this one is handed the decimals the same `resolveTokenFromAddress` lookup
 * produced the cap conversion from, so the display and the cap can never
 * disagree about what a token is worth.
 */
export function atomicToDisplay(atomic: string, decimals: number): string {
  const value = BigInt(atomic)
  const unit = 10n ** BigInt(decimals)
  const whole = value / unit
  const fraction = (value % unit).toString().padStart(decimals, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

/**
 * #2051 — price the SELECTED payment option and bind the user's cap to it.
 *
 * The defect this exists to close: #1453 made `selectStandardPaymentOption`
 * and `selectErc7710PaymentOption` mutually exclusive by construction, so a
 * cap checked against the standard entry constrained a DIFFERENT `accepts[]`
 * entry than `prepareX402Erc7710` goes on to authorize — and nothing tied
 * their amounts together. Because `payment_required` is merchant-controlled,
 * the merchant got to choose which entry the cap was compared against: that
 * is a guard an attacker can STEER, not one that merely fails to bind.
 * Measured live on the shipped tools at 900 USDC authorized against a stated
 * 1 USDC cap, with the response reporting 1 USDC (#2051).
 *
 * Two properties, and both matter:
 *
 * 1. **Checked ONCE, against whichever option the selector actually
 *    returned.** Leaving the standard-entry check in place ahead of scheme
 *    selection leaves the mirror-image bug — an expensive standard entry
 *    beside a cheap erc7710 entry gets refused citing an amount that was
 *    never going to be authorized. Fail-safe, but it makes stating a
 *    spending limit the thing that breaks a payable purchase, which defeats
 *    the point of the cap working. (Proved live on #2052 at 3 USDC standard /
 *    0.50 USDC erc7710 against a 1 USDC cap.)
 *
 * 2. **Converted with the selected option's OWN asset and decimals.** A human
 *    cap ("1" = 1 USDC) is meaningless without them, and borrowing the other
 *    entry's is the same class of mistake one level down.
 *
 * The returned amounts are then what the response REPORTS, so the receipt an
 * agent logs is the amount that was actually authorized. The misreport shares
 * this root cause and is not fixed by fixing the cap alone.
 *
 * All THREE hosted call sites go through this one function —
 * `haven_pay_x402_quote` (#2041/#2052, which established the shape inline),
 * `haven_pay_mcp_tool` and `haven_prepare_catalog_purchase` — so the rule
 * cannot drift into three shapes of the same check. It got fixed in one place
 * and left standing in two exactly once already; that is what this extraction
 * is for.
 *
 * There is deliberately NO backend backstop for this: `runDelegationAuthorize`
 * takes `amountRaw` as given, so the client is the only place `max_amount`
 * exists at all. What still binds is the on-chain BUDGET at merchant
 * redemption, via the caveat enforcer — a different mechanism, and the reason
 * the blast radius is bounded rather than unbounded.
 */
/**
 * #2054 — a null scheme selection on the two MCP purchase tools is refused
 * HERE, with the real reason, before any pricing or intent construction.
 *
 * `selectX402SettlementScheme` returns null in exactly two situations:
 *
 *   1. The merchant advertises ONLY an erc7710-tagged entry and the account's
 *      rail did not qualify — it is legacy, or (pay tool only) the agent
 *      prefetch failed so the rail could not be read. The old behaviour fell
 *      through to a path that told the agent "no compatible payment option"
 *      (or, worse, priced the erc7710 entry it was never going to authorize).
 *      The option is there; the ACCOUNT cannot use it — say that.
 *
 *   2. Nothing payable of either kind exists. Unreachable from the two MCP
 *      tools (`buildX402Quote` already refused the quote), but kept as the
 *      byte-identical SDK refusal so this helper cannot mask a genuine
 *      no-option 402 if a future caller reaches it first.
 *
 * Returning the non-null selection (rather than asserting) is what lets the
 * call sites read `selection.option` with no `?? quote.accepted` fallback —
 * any fallback that can name a DIFFERENT entry than the one authorized is the
 * #2051 defect class again.
 */
export function requireSettleableSelection(
  selection: ReturnType<typeof selectX402SettlementScheme>,
  accepts: X402PaymentOption[],
  rail: { known: boolean; value: string | undefined },
): NonNullable<ReturnType<typeof selectX402SettlementScheme>> {
  if (selection) return selection

  if (selectErc7710PaymentOption(accepts)) {
    throw new HostedToolError({
      code: 'ERC7710_RAIL_REQUIRED',
      message:
        'The only payment option Haven can settle at this merchant is tagged ' +
        "extra.assetTransferMethod: 'erc7710' (direct settlement), which can only be redeemed " +
        'from a delegation-rail account. ' +
        (rail.known
          ? `This agent's account is on the '${rail.value ?? 'legacy'}' rail, which cannot ` +
            'settle erc7710. No payment intent was created and no funds moved. Tell the user: ' +
            'paying this merchant needs the agent re-onboarded on the delegation rail.'
          : "This agent's account rail could not be read from Haven, so Haven refuses rather " +
            'than proceed on a guess. No payment intent was created and no funds moved. ' +
            'Retry when haven_get_agent succeeds.'),
      statusCode: 403,
      nextAction: AgentPaymentNextAction.StopAndTellUser,
      suggestedTool: 'haven_get_agent',
    })
  }

  // Unreachable when the caller holds a successful quote (see above) — a
  // successful buildX402Quote proves at least one selector matches. Kept as
  // the SDK's base refusal so a future caller that reaches it first gets the
  // familiar message. (The SDK's tag-aware `noCompatiblePaymentOptionError`
  // is deliberately NOT published from the package entrypoint — the #1618
  // module boundary — and the erc7710 branch above already covers the only
  // case where the tag would be the reason.)
  throw new HavenApiError(
    'No compatible payment option found in x402 requirements. ' +
      'Haven supports standard x402 exact payments on Base USDC.',
    400,
  )
}

export function priceSelectedOption(
  cap: MaxAmountCap,
  option: X402PaymentOption,
): { amountAtomic: string; amount: string; token: string; decimals: number | null } {
  const amountAtomic = x402AuthorizationAmount(option)
  const token = resolveTokenFromAddress(option.asset, option.network)
  const decimals = token?.decimals ?? null
  const capAtomic = resolveCapAtomic(cap, {
    decimals,
    token: token?.symbol ?? 'the merchant asset',
    asset: option.asset,
    network: option.network,
  })
  assertWithinMaxAmount(amountAtomic, capAtomic.atomic, token?.symbol, capAtomic.label)
  return {
    amountAtomic,
    // `decimals === null` means Haven does not recognise the asset. A human
    // cap already refused above (`resolveCapAtomic` fails closed there); an
    // ATOMIC cap can still be enforced, so fall back to echoing the atomic
    // figure rather than converting against a guess.
    amount: decimals === null ? amountAtomic : atomicToDisplay(amountAtomic, decimals),
    token: token?.symbol ?? 'USDC',
    decimals,
  }
}

/**
 * The legacy `cap_warning` string and the structured MissingMaxAmount warning
 * say the same thing; #1351 keeps them on one constant so the two spellings of
 * the cap stay described identically in both.
 */
export const CAP_WARNING_TEXT =
  'No spending cap was set — the live quoted price was accepted as-is. Pass ' +
  'max_amount_human (whole tokens, e.g. "1" for 1 USDC) or max_amount (atomic units) ' +
  'on paid merchant calls so a changed quote cannot exceed what the user intended to spend.'

/**
 * #1308: quote-expiry warning horizon.
 */
export const QUOTE_EXPIRES_SOON_MS = 120_000

export function quoteWarnings(args: {
  // #1351: whether this purchase carried a cap AT ALL, in either spelling —
  // not which field expressed it.
  capped: boolean
  expiresAt: string | undefined
  discoveredFrom?: string
}): AgentPaymentWarning[] {
  const warnings: AgentPaymentWarning[] = []
  if (!args.capped) {
    warnings.push({
      code: AgentPaymentWarningCode.MissingMaxAmount,
      // Same substance as the legacy cap_warning field, which stays for compat.
      message: CAP_WARNING_TEXT,
    })
  }
  if (args.expiresAt) {
    const msLeft = Date.parse(args.expiresAt) - Date.now()
    if (Number.isFinite(msLeft) && msLeft > 0 && msLeft < QUOTE_EXPIRES_SOON_MS) {
      warnings.push({
        code: AgentPaymentWarningCode.QuoteExpiresSoon,
        message: `The signing window closes in ${Math.round(msLeft / 1000)}s — sign promptly or re-quote with the same idempotency_key.`,
      })
    }
  }
  if (args.discoveredFrom) {
    warnings.push({
      code: AgentPaymentWarningCode.MerchantUrlDiscovered,
      message: `merchant_url was resolved via the merchant discovery document (from ${args.discoveredFrom}) — pass the RESOLVED merchant_url forward.`,
    })
  }
  return warnings
}
