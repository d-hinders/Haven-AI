/**
 * BAS chart-of-accounts mapping for bookkeeping export (epic #462, P1 #464).
 *
 * BAS is the standard Swedish chart of accounts. This is a small seed map from
 * merchant category → expense account, plus the accounts the SIE exporter uses.
 * It is intentionally minimal: per-merchant overrides and reverse-charge VAT
 * accounts are P3 (#466). The accountant can remap on import.
 */

/** Debit side: where agent spend lands when no category match is found. */
export const DEFAULT_EXPENSE_ACCOUNT = '6540' // IT-tjänster

/**
 * Credit side: a clearing/settlement account standing in for the crypto wallet.
 * 1930 (Företagskonto) is the conventional default; an accountant may point this
 * at a dedicated crypto-asset account instead.
 */
export const DEFAULT_SETTLEMENT_ACCOUNT = '1930' // Företagskonto / checkkonto

/** Merchant category (from the catalog) → BAS expense account. */
const CATEGORY_TO_BAS: Record<string, string> = {
  media: '6540',
  api: '6540',
  data: '6540',
  compute: '6540',
  infrastructure: '6540',
  ai: '6540',
  search: '6540',
}

/** BAS account → human name, for the SIE `#KONTO` declarations. */
export const BAS_ACCOUNT_NAMES: Record<string, string> = {
  '6540': 'IT-tjänster',
  '1930': 'Företagskonto',
}

/** Resolve the expense account for a merchant category (falls back to default). */
export function basAccountForCategory(category: string | null | undefined): string {
  if (!category) return DEFAULT_EXPENSE_ACCOUNT
  return CATEGORY_TO_BAS[category.toLowerCase()] ?? DEFAULT_EXPENSE_ACCOUNT
}

/** Display name for an account number, falling back to the number itself. */
export function basAccountName(account: string): string {
  return BAS_ACCOUNT_NAMES[account] ?? account
}
