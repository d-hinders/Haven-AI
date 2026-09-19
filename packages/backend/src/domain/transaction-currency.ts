/**
 * The currencies a converted transaction amount may be struck in (#3127).
 *
 * Lives in `domain/` for the same reason `ledger-currency.ts` does: two layers
 * that must not import each other need the same list. `routes/user.ts`
 * validates the `PUT /user/preferences` body against it,
 * `infra/repositories/users.ts` writes it at signup, and the transactions
 * module reads it back when stamping a converted amount — none of which may
 * reach across a module boundary to fetch the list from a neighbour.
 *
 * The set is bounded on purpose. SEK is the column-backed half
 * (`machine_payment_evidence.amount_sek`, migration 026); USD and EUR are
 * answered from the per-row book-time rate map
 * (`machine_payment_evidence.fx_rates`, migration 082). DKK, NOK and GBP are
 * captured in that map too but are deliberately NOT offered here: widening
 * the preference is a product decision with enum, UI and copy fallout — and
 * the frontend spells the offered set out in its own copy — not a free loop
 * unroll. The conversion helper refuses them until this list is widened
 * deliberately.
 *
 * Before #3127 the offered set was `['USD', 'EUR']` and none of the three
 * currencies a user could pick (or be served) agreed: the transaction feed
 * converted everything to SEK with the currency baked into the field names.
 * SEK joining the list is what makes the enum and the served currency agree.
 */

/** Offered converted-amount currencies, ISO-4217, display order. */
export const TRANSACTION_CURRENCIES = ['SEK', 'USD', 'EUR'] as const

export type TransactionCurrency = (typeof TRANSACTION_CURRENCIES)[number]

/**
 * The currency a converted amount is struck in when the user has no
 * preference (or an unreadable one) — SEK, deliberately (#3127), not
 * inherited: it is the currency every row was already being served in, the
 * currency the CSV export reports fixed, and the accounting feed's own
 * default ledger currency. A user who never touched settings keeps the
 * figures they were getting; now the figure names its currency.
 */
export const DEFAULT_TRANSACTION_CURRENCY: TransactionCurrency = 'SEK'

export function isTransactionCurrency(value: string | null | undefined): value is TransactionCurrency {
  if (value == null) return false
  return (TRANSACTION_CURRENCIES as readonly string[]).includes(value)
}

/**
 * The stored `currency_preference` as a currency the transaction path can
 * convert to. Null (no preference, or no readable row) and an unsupported
 * value both fall back to the default — the unsupported case is unreachable
 * through `PUT /user/preferences`, which refuses it, and the fallback exists
 * so a hand-written or legacy column value can never crash a feed.
 * (`domain/ledger-currency.ts`'s `ledgerCurrencyOrDefault` is the same shape
 * for the accounting side; the two lists are different on purpose.)
 */
export function transactionCurrencyOrDefault(value: string | null | undefined): TransactionCurrency {
  return isTransactionCurrency(value) ? value : DEFAULT_TRANSACTION_CURRENCY
}
