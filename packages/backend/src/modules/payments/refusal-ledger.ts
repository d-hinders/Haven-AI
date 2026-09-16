/**
 * The fire-and-forget write side of the `payment_refusals` ledger (#2945,
 * slice A of epic #2944).
 *
 * ## The one rule: the ledger can never change a refusal
 *
 * Every writer calls this AFTER its refusal response is decided, and the
 * call is `void`-ed: a slow or failing ledger write is logged and swallowed,
 * never surfaced to the caller, never allowed to reject into a route handler
 * that has already (or is about to) send the refusal. Characterization tests
 * pin the refusal responses byte-identical with the ledger succeeding AND
 * failing, because a telemetry write that could turn a 403 into a 500 would
 * put the audit trail above the guardrail it audits.
 *
 * ## What gets booked
 *
 * - `usd_value`/`eur_value` via the SAME price path settled payments book
 *   (`getFiatValuesForTokenAmount`, the `payment-intents.ts:538` settlement
 *   write's helper) — one read, cached upstream, and a price outage books
 *   NULLs rather than zeros (the fiat helper's own contract).
 * - `account_id` resolved from the agent's `account_address` + chain against
 *   `smart_accounts` (the post-084 account vocabulary the FK targets).
 *   NULL when the account row is gone — the ledger records the refusal even
 *   when the account has since been unbound; the FK is on the row that
 *   exists, not on the agent's current state.
 * - `detail` through the migration 086 allowlist (`pickRefusalDetail`): only
 *   `error_code`, `phase`, `next_action`, `remaining_atomic`,
 *   `budget_atomic` survive, whatever the caller passed. The #2907/#2908
 *   review found account-confusions exactly where whole bodies were copied.
 *
 * ## The revert classification
 *
 * `prepareRedemption`'s gas estimation throws the caveat enforcers' revert
 * text as a raw viem error string — there is no typed error to switch on.
 * `classifyRevertForLedger` is deliberately four-way: the timestamp
 * enforcer's revert text (`beforeThreshold` / `Enforcer:expired-delegation`
 * in the flattened error chain) is `delegation_expired`; the period-budget
 * enforcer's custom error (`Enforcer:transfer-amount-exceeded`) is
 * `delegation_budget_exceeded` — the DIRECT `POST /payments` route has no
 * fail-fast pre-check, so that revert IS its over-budget answer and the
 * classification is what gives the value its named writer there; any OTHER
 * estimation revert (viem's `EstimateGasExecutionError`, or a bundled revert
 * reason) is `onchain_revert` — rare since #2706, the pre-checks catch
 * over-budget on both x402 legs first; and anything that is not a revert
 * (transport failure, RPC auth/config error) returns `null` — the guardrails
 * refused nothing, an outage must not be recorded as a refusal, and the
 * caller skips the write.
 */

import { getFiatValuesForTokenAmount } from '../../infra/fiat-values.js'
import { findOwnedAccountIdByAddressAndChain } from '../../infra/repositories/smart-accounts.js'
import {
  recordPaymentRefusal,
  REFUSAL_DETAIL_KEYS,
  type PaymentRefusalDetail,
  type PaymentRefusalReason,
  type PaymentRefusalSource,
} from '../../infra/repositories/payment-refusals.js'
import { getChain } from '../../domain/chains.js'
import { formatTokenValue } from '../../domain/tokens.js'
import { EstimateGasExecutionError } from 'viem'

export type { PaymentRefusalDetail, PaymentRefusalReason, PaymentRefusalSource }

/** The subset of a fastify-style logger the fire-and-forget catch needs. */
export interface RefusalLog {
  error: (msg: string) => void
}

export interface RefusalLedgerInput {
  userId: string
  agentId: string
  chainId: number
  tokenSymbol: string
  amountAtomic: string
  /** Pre-computed human amount; derived from the token's decimals when omitted. */
  amountHuman?: string
  merchantTo?: string | null
  resourceUrl?: string | null
  /** The agent's account address — resolved to smart_accounts.id for the FK. */
  accountAddress?: string | null
  reason: PaymentRefusalReason
  source: PaymentRefusalSource
  /** Raw refusal-body fragment; only the migration 086 allowlist survives. */
  detail?: Record<string, unknown> | null
  /**
   * Test seam (and future caller convenience): skip the `smart_accounts`
   * lookup and pass the account id directly. Production writers omit it.
   */
  accountId?: string | null
}

/**
 * Copy ONLY the allowlisted keys, and only string values, from a refusal
 * body fragment. `amount` is deliberately not on the list — `amount_atomic`
 * already carries it, and the #2907/#2908 review found the copy-whole-body
 * drift this pick exists to make impossible.
 */
export function pickRefusalDetail(detail: Record<string, unknown> | null | undefined): PaymentRefusalDetail {
  if (!detail) return {}
  const picked: PaymentRefusalDetail = {}
  for (const key of REFUSAL_DETAIL_KEYS) {
    const value = detail[key]
    if (typeof value === 'string') picked[key] = value
  }
  return picked
}

/** The timestamp caveat's revert text, in the kit's own spelling. */
const DELEGATION_EXPIRED_REVERT_PATTERNS = [
  /before execution's timestamp is before this caveat's beforeThreshold/i,
  /beforeThreshold/i,
  // The enforcer's own custom-error name (the spelling that appears in the
  // repo's fixtures and QA evidence: `Enforcer:expired-delegation`).
  /Enforcer:expired-delegation/i,
]

/**
 * The period-budget enforcer's revert text. `ERC20PeriodTransferEnforcer`
 * refuses an over-redemption with `Enforcer:transfer-amount-exceeded` — the
 * on-chain answer to the same question the fail-fast pre-check asks, and the
 * only answer the DIRECT `POST /payments` route ever gets (it has no
 * pre-check in front of it). Without this pattern the common case — the
 * direct over-budget payment — would classify as `onchain_revert`, which
 * contradicts the enum's named-writer rule (the pre-check on both x402 legs
 * already owns `delegation_budget_exceeded`) and would make
 * `onchain_revert` anything but rare.
 */
const BUDGET_ENFORCER_REVERT_PATTERNS = [/Enforcer:transfer-amount-exceeded/i]

/**
 * Flatten an error and its `cause` chain into one searchable string. Caveat
 * reverts arrive wrapped: viem's `EstimateGasExecutionError` carries the
 * contract error as `cause`, and a bundler relays the revert reason inside
 * its own RPC error — the enforcer text can sit at any depth.
 */
function flattenErrorText(err: unknown, depth = 0): string {
  if (err == null || depth > 5) return ''
  if (typeof err === 'string') return err
  if (typeof err !== 'object') return String(err)
  const withMessage = err as { message?: unknown; cause?: unknown }
  const own = typeof withMessage.message === 'string' ? withMessage.message : ''
  return `${own}\n${flattenErrorText(withMessage.cause, depth + 1)}`
}

/**
 * Which ledger reason a gas-estimation failure names — or `null` when the
 * failure is NOT a policy refusal and must not be recorded.
 *
 * The four-way contract, grounded in what the stack can actually produce:
 *
 * - The timestamp caveat's revert text (the enforcer's own spelling, the
 *   `Enforcer:expired-delegation` custom-error name, or any `beforeThreshold`
 *   occurrence) is `delegation_expired`.
 * - The period-budget enforcer's custom error (`Enforcer:transfer-amount-
 *   exceeded`, the on-chain answer the DIRECT `POST /payments` route gets
 *   when it has no pre-check in front of it) is `delegation_budget_exceeded`.
 * - Any OTHER estimation revert — viem's `EstimateGasExecutionError`, or an
 *   error whose flattened text says the execution reverted (bundlers echo
 *   the enforcer revert reason inside the RPC error) — is `onchain_revert`.
 *   Rare since #2706: the pre-checks catch over-budget on both legs first.
 * - Everything else — a transport failure, an RPC auth/config error, an
 *   unknown shape — is NOT a refusal: the guardrails did not refuse
 *   anything, the infrastructure broke. Recording it would pollute the
 *   refusal ledger with outages. Callers skip the write on `null`.
 */
export function classifyRevertForLedger(
  err: unknown,
): Extract<PaymentRefusalReason, 'delegation_expired' | 'onchain_revert' | 'delegation_budget_exceeded'> | null {
  const text = flattenErrorText(err)
  if (DELEGATION_EXPIRED_REVERT_PATTERNS.some((re) => re.test(text))) return 'delegation_expired'
  if (BUDGET_ENFORCER_REVERT_PATTERNS.some((re) => re.test(text))) return 'delegation_budget_exceeded'
  const isEstimationRevert =
    err instanceof EstimateGasExecutionError ||
    /revert/i.test(text)
  return isEstimationRevert ? 'onchain_revert' : null
}

function humanAmount(chainId: number, tokenSymbol: string, amountAtomic: string): string {
  try {
    const chain = getChain(chainId)
    const token = Object.values(chain.tokens).find((t) => t.symbol === tokenSymbol)
    if (token) return formatTokenValue(amountAtomic, token.decimals)
  } catch {
    // Unknown chain or token — the atomic string is the honest fallback and
    // the fiat lookup below keys on the symbol either way.
  }
  return amountAtomic
}

async function resolveAccountId(userId: string, accountAddress: string | null | undefined, chainId: number): Promise<string | null> {
  if (!accountAddress) return null
  try {
    return await findOwnedAccountIdByAddressAndChain(userId, accountAddress, chainId)
  } catch {
    // The lookup must never make the ledger write (or the refusal) fail.
    return null
  }
}

async function writeRefusal(input: RefusalLedgerInput): Promise<void> {
  const amountHuman = input.amountHuman ?? humanAmount(input.chainId, input.tokenSymbol, input.amountAtomic)
  // Same price path the settled-payment booking uses (payment-intents.ts
  // settlement write). A price outage books NULLs — the helper's own
  // contract — never a fabricated zero.
  const fiat = await getFiatValuesForTokenAmount(input.tokenSymbol, amountHuman)
  const accountId =
    input.accountId !== undefined ? input.accountId : await resolveAccountId(input.userId, input.accountAddress, input.chainId)
  await recordPaymentRefusal({
    userId: input.userId,
    accountId,
    agentId: input.agentId,
    chainId: input.chainId,
    tokenSymbol: input.tokenSymbol,
    amountAtomic: input.amountAtomic,
    usdValue: fiat.usd,
    eurValue: fiat.eur,
    merchantTo: input.merchantTo ?? null,
    resourceUrl: input.resourceUrl ?? null,
    reason: input.reason,
    source: input.source,
    detail: pickRefusalDetail(input.detail),
  })
}

/**
 * Record a refusal without any possibility of changing it. Returns
 * immediately; the write runs detached and its failure is logged, never
 * thrown. Every writer calls this after the refusal response is decided.
 */
export function recordRefusalFireAndForget(input: RefusalLedgerInput, log?: RefusalLog): void {
  void writeRefusal(input).catch((err: unknown) => {
    const message =
      'payment_refusals ledger write failed (fire-and-forget; the refusal response the caller received is unchanged): ' +
      (err instanceof Error ? err.message : String(err))
    if (log) log.error(message)
    else console.error(message)
  })
}
