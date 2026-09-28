/**
 * Tax declaration content and gating (#3426, wg-tax #5 §2.1).
 *
 * Pure rule layer for the per-agent x402 buyer-side tax declaration: given
 * the agent's opt-in bit and the owner's company-details facts, decide
 * whether a declaration is available and what its unsigned §2.1 content is.
 * NO signing and NO sending happens here — the declaration is never
 * transmitted by this slice (#3427 signs and sends it on EIP-3009 payments
 * only). The SDK computes `principalId`/`principalAttributionHash` locally
 * (#3427), so this module never sees or returns them.
 *
 * Every fact comes in as a parameter; there is no db handle, no config read
 * and no clock read — the route passes `nowMs`, which is what makes the two
 * `validUntil` bounds testable as pure arithmetic.
 */

// The two validity bounds, named so the route's OpenAPI description and the
// tests cannot drift from the implementation.

/** The declaration is never valid longer than this, even with a fresh VIES check. */
export const TAX_DECLARATION_MAX_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * The declaration is never valid longer than the VIES check's own freshness:
 * the §2.1 statement is evidence resting on the check, and a check older
 * than this caps the declaration no matter how recently the owner opted in.
 */
export const TAX_DECLARATION_MAX_VIES_AGE_MS = 24 * 60 * 60 * 1000

/** The §2.1 version discriminator of the first profile. */
export const TAX_DECLARATION_VERSION = 'x402-tax-1'

/** §2.1's closed `taxableStatus` enumeration — the only value this slice emits. */
export const TAX_DECLARATION_TAXABLE_STATUS = 'TAXABLE_PERSON'

/**
 * Why no declaration content is available. The wire shape is
 * `{ available: false, reason }` — one reason each, no prose; a client maps
 * reasons to its own words. The four reasons are the issue's closed list:
 *
 * - `feature_disabled` — the deployment's `HAVEN_OWNER_COMPANY_DETAILS` is
 *   off. Nothing about company details exists in this deployment.
 * - `disabled` — the owner never opted THIS agent in (or switched it off).
 * - `no_company_details` — the owner has not saved company details with a
 *   VAT number.
 * - `vies_not_valid` — the VAT number's VIES status is anything other than
 *   `valid` AT READ TIME (`pending`, `invalid`, `not_verifiable`). A check
 *   in flight and a negative answer are different reasons a declaration is
 *   unavailable, and both are this one from the agent's point of view: the
 *   status is not `valid` now.
 */
export type TaxDeclarationUnavailableReason =
  | 'feature_disabled'
  | 'disabled'
  | 'no_company_details'
  | 'vies_not_valid'

export interface TaxDeclarationUnavailable {
  available: false
  reason: TaxDeclarationUnavailableReason
}

export interface TaxDeclarationContent {
  available: true
  declaration: {
    /** §2.1: `x402-tax-1`. */
    version: typeof TAX_DECLARATION_VERSION
    /** ISO 3166-1 alpha-2 — the owner's `country`, never derived from the VAT prefix. */
    jurisdiction: string
    /** §2.1's closed enumeration; the only value this slice emits. */
    taxableStatus: typeof TAX_DECLARATION_TAXABLE_STATUS
    /** The owner's VAT number, normalised (uppercase, no spaces) since migration 098. */
    taxId: string
    /** Integer MILLISECONDS — the lesser of the two bounds, see below. */
    validUntil: number
  }
}

export type TaxDeclarationResult = TaxDeclarationContent | TaxDeclarationUnavailable

export interface TaxDeclarationFacts {
  /** The deployment flag (`config.ownerCompanyDetailsEnabled`), passed in. */
  featureEnabled: boolean
  /** The agent's `tax_declaration_enabled` opt-in bit. */
  taxDeclarationEnabled: boolean
  /** The owner's `country` (ISO 3166-1 alpha-2), when company details exist. */
  country: string | null
  /** The owner's normalised VAT number, when saved. */
  vat_number: string | null
  /** The VIES status at READ TIME — the gate is the read, not the opt-in moment. */
  vies_status: string | null
  /** When that VIES check completed (null while `pending`). */
  vies_checked_at: string | null
  /** Wall clock, in ms — a parameter, so the bounds are pure arithmetic. */
  nowMs: number
}

/**
 * Decides the declaration response for one agent. The order of the checks IS
 * the reason priority — each reason says the FIRST fact that failed, so the
 * four reasons stay mutually exclusive and a client never has to rank them:
 *
 * 1. flag off → `feature_disabled` (the deployment has no such surface);
 * 2. opt-in off → `disabled` (the owner's choice, independent of VIES);
 * 3. no VAT number → `no_company_details`;
 * 4. VIES not `valid` now → `vies_not_valid`.
 *
 * `validUntil` is integer milliseconds and double-bounded: the lesser of
 * `now + TAX_DECLARATION_MAX_WINDOW_MS` and
 * `vies_checked_at + TAX_DECLARATION_MAX_VIES_AGE_MS`. The check's age caps
 * the declaration because §2.1's facts rest on the check — a declaration
 * minted from a week-old `valid` result must not outlive the check's own
 * freshness window. An integer floor keeps the wire value an integer even
 * if `Date.now()` or the timestamp parse lands on a fraction.
 */
export function resolveTaxDeclaration(facts: TaxDeclarationFacts): TaxDeclarationResult {
  if (!facts.featureEnabled) {
    return { available: false, reason: 'feature_disabled' }
  }
  if (!facts.taxDeclarationEnabled) {
    return { available: false, reason: 'disabled' }
  }
  if (facts.vat_number === null || facts.vat_number === '') {
    return { available: false, reason: 'no_company_details' }
  }
  if (facts.vies_status !== 'valid' || facts.vies_checked_at === null) {
    return { available: false, reason: 'vies_not_valid' }
  }

  const viesCheckedMs = Date.parse(facts.vies_checked_at)
  const byWindow = facts.nowMs + TAX_DECLARATION_MAX_WINDOW_MS
  const byViesAge = viesCheckedMs + TAX_DECLARATION_MAX_VIES_AGE_MS
  const validUntil = Math.floor(Math.min(byWindow, byViesAge))
  return {
    available: true,
    declaration: {
      version: TAX_DECLARATION_VERSION,
      jurisdiction: facts.country ?? '',
      taxableStatus: TAX_DECLARATION_TAXABLE_STATUS,
      taxId: facts.vat_number,
      validUntil,
    },
  }
}
