/**
 * Haven's own fallback words for an unnamed counterparty (#4932).
 *
 * When nothing in the one recipient-naming order (#4882) names the other side
 * of a payment, the frontend renders one of these literals instead. They are
 * Haven's words, not a merchant's — so a receipt whose seller name happens to
 * BE one of them names nobody, and the backend refuses it exactly as it
 * refuses an empty name (`RECEIPT_MERCHANT_NAMES_SQL`,
 * `infra/repositories/analytics.ts`). Without that refusal a seller could make
 * a named payment read as unnamed (`TransactionDetailPanel`'s `unnamed` check
 * drops the monogram for "New recipient") or as a different kind of payment.
 *
 * ONE definition, two consumers: the frontend renders these literals (so a
 * changed string cannot drift from the list), and the backend builds its
 * refusal SQL from {@link HAVEN_FALLBACK_NAMES}. The set is the literal
 * fallback titles and labels the frontend renders for an unnamed counterparty:
 *
 * - `counterpartyLabel` (`lib/transaction-presentation.tsx`) — "New
 *   recipient", "Deposit", "Sale" (#5000), "Agent payment", and the templated
 *   "From …" / "Returned from …" / "Sale · …";
 * - `paymentSourceTitle` (`lib/transaction-labels.ts`) — "Agent payment",
 *   "Machine payment";
 * - `MerchantsTable` / `AgentsTable` — "Unknown recipient", "None in this
 *   range";
 * - `TransactionDetailPanel` — "Moved between your accounts", and its
 *   `unnamed` check on "New recipient".
 *
 * The backend compares ASCII case-folded and whitespace-collapsed, so
 * "  deposit " is refused too. That fold is deliberately ASCII-only: a
 * full-width look-alike ("Ｄｅｐｏｓｉｔ") and trailing punctuation
 * ("Deposit.") pass through. Accepted residual, stated in the CASP shard.
 */

/**
 * The literal fallback titles and labels, by the surface that renders them.
 * Import these rather than re-typing the string: the backend's refusal list is
 * derived from this object, so a literal that is not here is a name Haven
 * would show as if a merchant had written it.
 */
export const HAVEN_FALLBACK_NAME = {
  /** `counterpartyLabel`'s outgoing fallback, and the detail panel's `unnamed` check. */
  newRecipient: 'New recipient',
  /** `MerchantsTable` / `AgentsTable`'s unresolved-label fallback. */
  unknownRecipient: 'Unknown recipient',
  /** `counterpartyLabel`'s inbound fallback when the sender is not one of your accounts. */
  deposit: 'Deposit',
  /**
   * #5000: `counterpartyLabel`'s inbound title for a sale into the Sales
   * account (the Sales page's rule) with no recorded product.
   */
  sale: 'Sale',
  /** `paymentSourceTitle('x402')`, and `counterpartyLabel`'s machine-payment fallback. */
  agentPayment: 'Agent payment',
  /** `paymentSourceTitle('mpp_demo')`. */
  machinePayment: 'Machine payment',
  /** `TransactionDetailPanel`'s title for a move between your own accounts. */
  movedBetweenAccounts: 'Moved between your accounts',
  /** `AgentsTable`'s "no top merchant in this window" label. */
  noneInRange: 'None in this range',
} as const

/** One of Haven's own fallback words. */
export type HavenFallbackName = (typeof HAVEN_FALLBACK_NAME)[keyof typeof HAVEN_FALLBACK_NAME]

/**
 * Every fallback literal, in one list — the backend builds its refusal SQL
 * from this (`RECEIPT_MERCHANT_NAMES_SQL`). Derived from
 * {@link HAVEN_FALLBACK_NAME} so the two cannot disagree.
 */
export const HAVEN_FALLBACK_NAMES: readonly HavenFallbackName[] = Object.values(HAVEN_FALLBACK_NAME)

/**
 * The templated fallbacks, by the surface that renders them: `counterpartyLabel`
 * renders "From <account>" for a deposit from another of your own accounts,
 * "Returned from <agent>" for a sweep and "Sale · <product>" for a recorded sale
 * (#5000). A receipt seller name that STARTS with any of them is refused too — the rest of the string is merchant-written, so the
 * row would read as Haven's own template. The trailing space is part of the
 * prefix: a seller named "Fromage AB" is a real name and stays.
 */
export const HAVEN_FALLBACK_NAME_PREFIX = {
  /** `counterpartyLabel`'s deposit-from-your-own-account template. */
  from: 'From ',
  /** `counterpartyLabel`'s sweep template. */
  returnedFrom: 'Returned from ',
  /** #5000: `counterpartyLabel`'s recorded-sale template, before the product label. */
  sale: 'Sale · ',
} as const

/** One of the templated fallback prefixes. */
export type HavenFallbackNamePrefix = (typeof HAVEN_FALLBACK_NAME_PREFIX)[keyof typeof HAVEN_FALLBACK_NAME_PREFIX]

/**
 * Every templated prefix, in one list — the backend builds its refusal SQL
 * from this. Derived from {@link HAVEN_FALLBACK_NAME_PREFIX} so the two cannot
 * disagree.
 */
export const HAVEN_FALLBACK_NAME_PREFIXES: readonly HavenFallbackNamePrefix[] = Object.values(
  HAVEN_FALLBACK_NAME_PREFIX,
)
