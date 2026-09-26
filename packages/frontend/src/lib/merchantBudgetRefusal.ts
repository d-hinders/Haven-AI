/**
 * Shared classification for the named 409/404 refusals `POST
 * /agents/{id}/delegations/build` can answer for a merchant-locked budget
 * (#3331), plus the ordinary grant refusals any caller of that endpoint can
 * hit (a revoked agent, an account off the delegation rail, a chain the rail
 * is not enabled on, an in-flight re-key). One regex set, read by both
 * `FundMerchantModal` (granting a NEW budget) and `EditBudgetModal` (editing
 * an EXISTING merchant-locked one in place) — round 2 review finding R2-2:
 * the two modals used to duplicate this matching, and a caller (`EditBudgetModal`)
 * showed the raw backend sentence instead of mapping it.
 *
 * `detail` is the backend's own sentence (`BudgetResult.detail` /
 * `EditBudgetResult.detail`); a caller never surfaces it verbatim.
 */
export type MerchantBudgetRefusalKind =
  | 'no_verified_pay_to'
  | 'not_erc7710'
  | 'own_address'
  | 'pay_to_changed'
  | 'merchant_not_found'
  | 'revoked_agent'
  | 'rekey_in_flight'
  | 'account_unavailable'
  | 'off_rail'
  | 'unknown'

export function classifyMerchantBudgetRefusal(detail: string | undefined): MerchantBudgetRefusalKind {
  const d = detail ?? ''
  if (/no verified payTo/i.test(d)) return 'no_verified_pay_to'
  if (/does not accept ERC-7710/i.test(d) || /not.*erc-7710/i.test(d)) return 'not_erc7710'
  if (/agent's own addresses/i.test(d)) return 'own_address'
  if (/does not match the merchant's current verified payTo/i.test(d)) return 'pay_to_changed'
  if (/merchant not found/i.test(d)) return 'merchant_not_found'
  if (/revoked agents cannot receive/i.test(d)) return 'revoked_agent'
  if (/key rotation is in flight/i.test(d)) return 'rekey_in_flight'
  if (/account or re-key is unavailable/i.test(d)) return 'account_unavailable'
  if (/not on the delegation rail/i.test(d) || /delegation rail not enabled/i.test(d) || /no delegate key or treasury/i.test(d)) {
    return 'off_rail'
  }
  return 'unknown'
}

/**
 * True for a refusal a same-input retry cannot ever turn into a success
 * (design review round 2, finding 2): the merchant's payTo moved, the
 * merchant vanished, the agent itself is the payTo, the offer stopped
 * advertising ERC-7710, the agent has no verified payTo to pin to, the agent
 * was revoked, or the account is off the delegation rail entirely. A caller
 * must not offer "Try again" as the primary action for these — "Try again"
 * stays reserved for `rekey_in_flight` / `account_unavailable` (both
 * transient — finishable or retryable shortly) and `unknown` (an
 * unrecognised/future refusal, where retry is the only guess available).
 */
export function isPermanentMerchantBudgetRefusal(kind: MerchantBudgetRefusalKind): boolean {
  return (
    kind === 'no_verified_pay_to' ||
    kind === 'not_erc7710' ||
    kind === 'own_address' ||
    kind === 'pay_to_changed' ||
    kind === 'merchant_not_found' ||
    kind === 'revoked_agent' ||
    kind === 'off_rail'
  )
}
