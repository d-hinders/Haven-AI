/**
 * #2960 — one party vocabulary for "who paid" a Haven payment, emitted
 * additively on every surface that today names a lone `payer*` address.
 *
 * This was a SIBLING to `wire-aliases.ts` (deleted by #2914), not an addition
 * to it, for a
 * reason worth stating: `wire-aliases.ts`'s own header scopes it to the
 * `safe` -> `account` dual-emit, where every mapper produces a SAME-VALUE
 * twin of one existing field. The four parties here are not same-value
 * twins of one field — `treasury_account`, `delegate`, `delegate_account`
 * and `merchant` are four DISTINCT addresses, several of which (`delegate`,
 * `delegate_account`) have no existing wire field at all on some surfaces.
 * Folding that into the rename file would misdescribe both.
 *
 * `withParties` is the ONE mapper for this shape, reused by every call site
 * (receipts, payment status, the payment-receipt bundle) rather than each
 * building its own object literal — the thing #2960's own finding (F1)
 * diagnoses as the bug.
 */

export interface Parties {
  /** The owner's smart account the funds actually left. */
  treasury_account: string | null
  /** The agent's signing EOA. */
  delegate: string | null
  /**
   * The agent's delegate SMART account (erc7710 `delegator`; the merchant's
   * `PAYMENT-RESPONSE.payer` and invoice buyer on that scheme). Persisted at
   * authorize time on `payment_intents.machine_metadata.delegate_account_address`
   * (both delegation-rail legs write it, `modules/x402/delegation-authorize.ts`).
   * Null for rows authorized before #2960, and on the legacy rail, where no
   * such account exists — never derived live at read time.
   */
  delegate_account: string | null
  /** `payTo`. */
  merchant: string | null
  /**
   * #3332: the paying agent's OWNER's company details — additive, and
   * ABSENT (never present-but-null) unless `HAVEN_OWNER_COMPANY_DETAILS` is
   * on AND the owner has saved details. A merchant reading this on a receipt
   * the agent chose to hand over sees who the agent is paying for; Haven
   * never renders `vies_status: 'valid'` as "verified" anywhere this reaches
   * (`docs/product/agent-passport.md`).
   */
  buyer?: PartiesBuyer
}

export interface PartiesBuyer {
  legal_name: string
  /** ISO 3166-1 alpha-2. */
  country: string
  /** For a sole trader this IS the personal identity number. */
  org_number: string
  vat_number: string | null
  vies_status: 'pending' | 'valid' | 'invalid' | 'not_verifiable' | null
  vies_checked_at: string | null
}

/**
 * The row shape every party-bearing surface can supply, in the row's own
 * canonical column names — deliberately NOT normalised to camelCase or to
 * `Parties`' own key names, so a caller passes exactly what it already has
 * without an intermediate remapping step.
 */
export interface PartySourceFields {
  /** Treasury: `smart_accounts.account_address` / `machine_payment_evidence.payer_address`. */
  account_address: string | null
  /** Delegate: `agents.delegate_address` for the agent's CURRENT delegate; the intent-captured delegate for a receipt/status row. */
  delegate_address: string | null
  /** Delegate account, from `machine_metadata.delegate_account_address`; null on rows authorized before #2960 or on the legacy rail. */
  delegate_account_address: string | null
  /** Merchant / `payTo`. */
  merchant_address: string | null
  /**
   * #3332: the paying agent's owner's company details, when the caller has
   * already decided they belong on the wire (flag on AND a row exists) —
   * `undefined`/omitted means "leave `parties.buyer` absent", never `null`.
   * Callers join `infra/repositories/owner-company-details.ts`'s
   * `OWNER_COMPANY_DETAILS_JOIN_COLUMNS` on the row's own `user_id` to get
   * this.
   */
  buyer_details?: PartiesBuyer
}

/** The one mapper: derive `parties` from a row's party-bearing fields, additive alongside it. */
export function withParties<T extends object>(
  row: T,
  parties: PartySourceFields,
): T & { parties: Parties } {
  const base: Parties = {
    treasury_account: parties.account_address,
    delegate: parties.delegate_address,
    delegate_account: parties.delegate_account_address,
    merchant: parties.merchant_address,
  }
  return {
    ...row,
    parties: parties.buyer_details ? { ...base, buyer: parties.buyer_details } : base,
  }
}
