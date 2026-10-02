/**
 * Refusal classification (#3516): the closed `reason` set
 * (`infra/repositories/payment-refusals.ts`, mirroring migration 086's CHECK)
 * mapped onto the buckets the issue names — over budget, wrong recipient,
 * expired. `onchain_revert` is NOT silently folded into a wrong bucket: it
 * renders as "Other refusal" with its raw reason beside it.
 */
export type RefusalClass = 'over_budget' | 'wrong_recipient' | 'expired' | 'other'

export function classifyRefusal(reason: string): RefusalClass {
  switch (reason) {
    case 'delegation_budget_exceeded':
    case 'relayer_budget':
      return 'over_budget'
    case 'no_delegation_for_target':
      return 'wrong_recipient'
    case 'delegation_expired':
      return 'expired'
    default:
      return 'other'
  }
}

export const REFUSAL_CLASS_LABEL: Record<RefusalClass, string> = {
  over_budget: 'Over budget',
  wrong_recipient: 'Wrong recipient',
  expired: 'Expired',
  other: 'Other refusal',
}

export const REFUSAL_CLASS_TONE: Record<RefusalClass, 'warning' | 'danger' | 'neutral'> = {
  over_budget: 'warning',
  wrong_recipient: 'danger',
  expired: 'warning',
  other: 'neutral',
}
