/**
 * The `delegation_budget_exceeded` 403 body builders (#3616, epic #3615 S-A).
 *
 * Today this body is hand-built at nine sites in three files — five response
 * bodies and four ledger `detail` objects (the sign-leg fallback books no
 * ledger row, `refuse(..., null)`):
 *
 * | # | Site | Kind |
 * |---|------|------|
 * | 1 | `routes/payments.ts:783` create-time period pre-check | `direct` body |
 * | 2 | `routes/payments.ts:818` create-time ledger detail | `periodExceededLedgerDetail` |
 * | 3 | `routes/payments.ts:1445` sign-leg period revert fallback (502) | `payments-sign-leg` body |
 * | 4 | `modules/x402/delegation-authorize.ts:486` EIP-3009 funding-leg pre-check | `x402` body |
 * | 5 | `modules/x402/delegation-authorize.ts:526` its ledger detail | `periodExceededLedgerDetail` |
 * | 6 | `modules/x402/delegation-authorize.ts:930` erc7710 pre-check | `x402` body |
 * | 7 | `modules/x402/delegation-authorize.ts:969` its ledger detail | `periodExceededLedgerDetail` |
 * | 8 | `modules/mpp/budget-precheck.ts:404` hosted prepare | `mpp` body |
 * | 9 | `modules/mpp/budget-precheck.ts:449` its ledger detail | `periodExceededLedgerDetail` |
 *
 * The hosted MCP parses this body (#3504), so field names and prose are WIRE:
 * S-B/S-C/S-D can adopt these builders only if the output equals, field for
 * field, what each site produces for the same inputs. Everything that
 * legitimately differs per entrypoint is an explicit parameter of the flavor;
 * everything else is fixed here so the sites cannot drift apart again.
 *
 * What differs per flavor (measured on cbb9817ce, verbatim from the sites):
 * - prose: the direct route says "This payment of … or wait for the period
 *   to reset." (no retry step exists on it); the x402 legs say "This x402
 *   payment of … then retry."; the hosted pre-check says "This payment of …
 *   then retry." and adds the symbol after the shortfall; the sign-leg
 *   fallback has its own past-tense prose ("exceeded the agent's remaining
 *   budget for this period by the time it was signed. … sign a NEW
 *   payment.") and wraps the refusal in `{ payment_id, status: 'failed' }`.
 * - human formatting: the direct route and the sign-leg fallback format
 *   remaining/shortfall with core's `formatTokenAmount` (bigint in, ≥1
 *   fraction digit); the x402 legs and the hosted pre-check with backend
 *   `formatTokenValue` (string in, ≥2 fraction digits). Both spellings are
 *   live wire behaviour.
 * - rail field: `direct` carries `AgentPaymentRail.Direct`, `x402` carries
 *   `AgentPaymentRail.X402`; the hosted pre-check never carried one; the
 *   sign-leg fallback carries the intent's own rail
 *   (`intent.payment_rail ?? intent.source ?? Direct` — never hardcoded).
 * - payee fields: the direct route carries `recipient`; the x402 legs carry
 *   `network` + `resource_url` + `merchant_address` (lowercased payee —
 *   `payTo` on erc7710, `merchantPayTo` on the funding leg); the hosted
 *   pre-check carries `resource_url` and `merchant_address` only when the
 *   quote named a payee, and no `network`.
 * - the hosted pre-check's #3518 budget-report block (`budget_id` …) is
 *   derived from ITS OWN budget view, not from scope resolution, so it rides
 *   `extraFields` verbatim instead of being re-derived here.
 */
import { formatTokenAmount } from '@haven_ai/core'
import { formatTokenValue } from '../../domain/tokens.js'
import { AgentPaymentNextAction, AgentPaymentPhase } from '../../domain/agent-payment-taxonomy.js'

export interface PeriodExceededBodyCommon {
  chainId: number
  tokenSymbol: string
  /** The registry address the body's `asset` carries (already lowercased by the callers' conventions). */
  tokenAddress: string
  /** Registry decimals for the human remaining/shortfall spelling. */
  decimals: number
  /** The atomic amount being paid, as the body's `amount_atomic` carries it. */
  amountAtomic: string
  /** The measured remaining — the smallest across the pre-check's readable links. */
  remainingAtomic: string
}

export interface DirectPeriodExceededInput extends PeriodExceededBodyCommon {
  flavor: 'direct'
  /** The human amount exactly as the request body carried it. */
  amount: string
  /** The lowercased payment recipient — the direct body's `recipient`. */
  recipient: string
}

export interface X402PeriodExceededInput extends PeriodExceededBodyCommon {
  flavor: 'x402'
  /** The human amount (`amountHuman`) the authorize input carried. */
  amount: string
  /** The network string only the x402 bodies carry. */
  network: string
  /** The merchant resource being bought. */
  resourceUrl: string
  /** The lowercased payee (`payTo` on erc7710, `merchantPayTo` on the funding leg). */
  merchantAddress: string
}

export interface MppPeriodExceededInput extends PeriodExceededBodyCommon {
  flavor: 'mpp'
  /** The hosted pre-check derives `amount` from the atomic figure — nothing is passed. */
  resourceUrl?: string
  /** Present only when the quote named a payee (lowercased, as the site lowercases it). */
  merchantAddress?: string
  /** #3518: the budget-report block rides verbatim (site-derived, never re-derived here). */
  extraFields?: Record<string, unknown>
}

export interface SignLegPeriodExceededInput extends PeriodExceededBodyCommon {
  flavor: 'payments-sign-leg'
  /** The intent's human amount. */
  amount: string
  /** The intent's own rail (`payment_rail ?? source ?? Direct`) — never hardcoded. */
  rail: string
  /** The intent's `to_address`. */
  recipient: string
}

export type PeriodExceededBodyInput =
  | DirectPeriodExceededInput
  | X402PeriodExceededInput
  | MppPeriodExceededInput
  | SignLegPeriodExceededInput

/**
 * The `delegation_budget_exceeded` refusal body, equal field for field to the
 * current site's output for the same inputs (table-tested in `__tests__`).
 * The sign-leg 502 wrapper (`payment_id`, `status: 'failed'`) stays at the
 * site — spread this builder's output under it, exactly as the site spreads
 * its own body today.
 */
export function buildPeriodExceededBody(input: PeriodExceededBodyInput): Record<string, unknown> {
  const remainingAtomic = BigInt(input.remainingAtomic)
  const amountAtomic = BigInt(input.amountAtomic)
  const shortfallAtomic = amountAtomic - remainingAtomic
  const symbol = input.tokenSymbol

  // The direct route and the sign-leg fallback format through core's
  // formatTokenAmount (bigint in); the x402 legs and the hosted pre-check
  // through formatTokenValue (string in). Flavor decides — both spellings
  // are live wire behaviour.
  const remainingHuman =
    input.flavor === 'direct' || input.flavor === 'payments-sign-leg'
      ? formatTokenAmount(remainingAtomic, input.decimals)
      : formatTokenValue(input.remainingAtomic, input.decimals)
  const shortfallHuman =
    input.flavor === 'direct' || input.flavor === 'payments-sign-leg'
      ? formatTokenAmount(shortfallAtomic, input.decimals)
      : formatTokenValue(shortfallAtomic.toString(), input.decimals)
  // The hosted pre-check derives the human amount from the atomic figure.
  const amount = input.flavor === 'mpp' ? formatTokenValue(input.amountAtomic, input.decimals) : input.amount

  let error: string
  if (input.flavor === 'direct') {
    error =
      `This payment of ${amount} ${symbol} exceeds the agent's remaining budget for this ` +
      `period (${remainingHuman} ${symbol}, short by ${shortfallHuman}). There is no approval ` +
      'queue on the delegation rail — an over-budget redemption reverts on-chain. Ask the wallet owner ' +
      'to grant or raise the budget in Haven, or wait for the period to reset.'
  } else if (input.flavor === 'x402') {
    error =
      `This x402 payment of ${amount} ${symbol} exceeds the agent's remaining ` +
      `budget for this period (${remainingHuman} ${symbol}, short by ${shortfallHuman}). ` +
      'There is no approval queue on the delegation rail — an over-budget redemption reverts ' +
      'on-chain. Ask the wallet owner to grant or raise the budget in Haven, then retry.'
  } else if (input.flavor === 'mpp') {
    error =
      `This payment of ${amount} ${symbol} exceeds the agent's remaining ` +
      `budget for this period (${remainingHuman} ${symbol}, short by ${shortfallHuman} ${symbol}). ` +
      'There is no approval queue on the delegation rail — an over-budget redemption reverts ' +
      'on-chain. Ask the wallet owner to grant or raise the budget in Haven, then retry.'
  } else {
    error =
      `This payment of ${amount} ${symbol} exceeded the agent's ` +
      'remaining budget for this period by the time it was signed. There is no approval ' +
      'queue on the delegation rail — ask the wallet owner to grant or raise the budget in ' +
      'Haven, or wait for the period to reset, then sign a NEW payment.'
  }

  const body: Record<string, unknown> = {
    error,
    error_code: 'delegation_budget_exceeded',
    phase: AgentPaymentPhase.InsufficientFunds,
    next_action: AgentPaymentNextAction.FundAccountOrRaiseAllowance,
  }
  // rail: the hosted pre-check never carried one.
  if (input.flavor === 'direct') body.rail = 'direct'
  if (input.flavor === 'x402') body.rail = 'x402'
  if (input.flavor === 'payments-sign-leg') body.rail = input.rail

  body.chain_id = input.chainId
  body.token = symbol
  body.asset = input.tokenAddress
  // network: only the x402 legs carry it.
  if (input.flavor === 'x402') body.network = input.network
  body.amount = amount
  body.amount_atomic = input.amountAtomic
  body.remaining = remainingHuman
  body.remaining_atomic = input.remainingAtomic
  body.shortfall = shortfallHuman
  body.shortfall_atomic = shortfallAtomic.toString()
  if (input.flavor === 'direct' || input.flavor === 'payments-sign-leg') {
    body.recipient = input.recipient
  } else {
    body.resource_url = input.resourceUrl
    // mpp carries merchant_address only when the quote named a payee; the x402
    // legs always carry it (their inputs always name one).
    if (input.merchantAddress !== undefined) body.merchant_address = input.merchantAddress
  }
  if (input.flavor === 'mpp' && input.extraFields) Object.assign(body, input.extraFields)
  return body
}

/**
 * The `payment_refusals` ledger `detail` every current
 * `delegation_budget_exceeded` writer books (the 086/087 allowlist keeps this
 * exact subset — `routes/payments.ts` periodBudgetLedger,
 * `delegation-authorize.ts` both pre-checks, `budget-precheck.ts`). The
 * entrypoint owns `source` (`payment` / `x402_authorize` / `hosted_prepare`)
 * and the ledger row's other columns; the module never knows them.
 */
export function periodExceededLedgerDetail(remainingAtomic: string): Record<string, unknown> {
  return {
    error_code: 'delegation_budget_exceeded',
    phase: AgentPaymentPhase.InsufficientFunds,
    next_action: AgentPaymentNextAction.FundAccountOrRaiseAllowance,
    remaining_atomic: remainingAtomic,
  }
}

/**
 * The `payment_refusals` ledger `detail` every current `task_budget_exceeded`
 * writer books (`routes/payments.ts` taskBudgetLedger, and the x402
 * `taskBudgetCapRefusal`'s `detail`): two keys only.
 */
export function taskCapExceededLedgerDetail(remainingAtomic: string): Record<string, unknown> {
  return {
    error_code: 'task_budget_exceeded',
    remaining_atomic: remainingAtomic,
  }
}
