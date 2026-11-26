/**
 * Checkout-details sharing content and gating (#4871, epic #4868).
 *
 * Pure rule layer for the per-agent checkout-details read: given the agent's
 * sharing switch and the owner's stored checkout details, decide whether the
 * details are available to the agent and what the unsigned content is. NO
 * sending happens here — #4872 attaches the answer to the paid request, and
 * this slice only answers the agent's own read.
 *
 * Every fact comes in as a parameter; there is no db handle, no config read
 * and no clock read, which is what makes the rule testable without booting
 * the app (the same shape as `tax-declaration.ts`).
 *
 * ## The wire shape
 *
 * The field names and the address shape are owned by
 * `docs/architecture/13-checkout-details.md` §2 — `receipt_email`,
 * `billing_address`, `shipping_address`, and the address object
 * `{ line1, line2?, line3?, city, postCode?, subdivision?, country }`. This
 * module returns them verbatim; it never renames, reshapes or re-derives
 * them.
 *
 * A field the owner has not saved is OMITTED from the content, never sent as
 * `null` — the same discipline the address shape states for its optional
 * members. That is also what makes the "no sign-up email fallback" rule
 * visible on the wire: with sharing on and no receipt email saved, the
 * content has no `receipt_email` key at all.
 */

/**
 * Why no checkout details are available. The wire shape is
 * `{ available: false, reason }` — one reason each, no prose; a client maps
 * reasons to its own words. The three reasons are mutually exclusive and
 * ordered, so a client never has to rank them:
 *
 * - `feature_disabled` — the deployment's `HAVEN_OWNER_COMPANY_DETAILS` is
 *   off. Nothing about company details exists in this deployment.
 * - `disabled` — the owner has not turned sharing on for THIS agent (or has
 *   switched it off).
 * - `no_details` — sharing is on, but the owner has saved none of the three
 *   fields. The switch may be on with nothing stored (issue #4871), so this
 *   is a normal state, not a refusal.
 */
export type CheckoutDetailsUnavailableReason = 'feature_disabled' | 'disabled' | 'no_details'

export interface CheckoutDetailsUnavailable {
  available: false
  reason: CheckoutDetailsUnavailableReason
}

/**
 * The stored address shape, owned by
 * `docs/architecture/13-checkout-details.md` § *The address shape*. Declared
 * structurally here rather than imported from the repository so this module
 * stays free of I/O imports; the repository's `OwnerAddress` is the same
 * shape and the route passes it straight through.
 */
export interface CheckoutDetailsAddress {
  line1: string
  line2?: string
  line3?: string
  city: string
  postCode?: string
  subdivision?: string
  /** ISO 3166-1 alpha-2, uppercase. */
  country: string
}

/**
 * The details the agent may share. Every member is optional because the owner
 * may have saved only some of them; an absent member is omitted from the
 * JSON, never `null`.
 */
export interface CheckoutDetailsContent {
  receipt_email?: string
  billing_address?: CheckoutDetailsAddress
  shipping_address?: CheckoutDetailsAddress
}

export interface CheckoutDetailsAvailable {
  available: true
  checkout_details: CheckoutDetailsContent
}

export type CheckoutDetailsResult = CheckoutDetailsAvailable | CheckoutDetailsUnavailable

export interface CheckoutDetailsFacts {
  /** The deployment flag (`config.ownerCompanyDetailsEnabled`), passed in. */
  featureEnabled: boolean
  /** The agent's `checkout_details_sharing_enabled` switch. */
  sharingEnabled: boolean
  /** The owner's saved receipt email, when one exists. */
  receipt_email: string | null
  /** The owner's saved billing address, when one exists. */
  billing_address: CheckoutDetailsAddress | null
  /** The owner's saved shipping address, when one exists. */
  shipping_address: CheckoutDetailsAddress | null
}

/**
 * Decides the checkout-details response for one agent. The order of the
 * checks IS the reason priority — each reason says the FIRST fact that
 * failed:
 *
 * 1. flag off → `feature_disabled` (the deployment has no such surface);
 * 2. switch off → `disabled` (the owner's choice);
 * 3. nothing stored → `no_details`.
 *
 * The receipt email is returned ONLY when the owner saved one. There is no
 * fallback to the sign-up email anywhere in this path (owner decision
 * 2026-11-17, epic #4868): the sign-up email is a form prefill, never a
 * shared value.
 */
export function resolveCheckoutDetails(facts: CheckoutDetailsFacts): CheckoutDetailsResult {
  if (!facts.featureEnabled) {
    return { available: false, reason: 'feature_disabled' }
  }
  if (!facts.sharingEnabled) {
    return { available: false, reason: 'disabled' }
  }

  const content: CheckoutDetailsContent = {}
  if (facts.receipt_email !== null && facts.receipt_email !== '') {
    content.receipt_email = facts.receipt_email
  }
  if (facts.billing_address !== null) {
    content.billing_address = facts.billing_address
  }
  if (facts.shipping_address !== null) {
    content.shipping_address = facts.shipping_address
  }

  if (
    content.receipt_email === undefined &&
    content.billing_address === undefined &&
    content.shipping_address === undefined
  ) {
    return { available: false, reason: 'no_details' }
  }

  return { available: true, checkout_details: content }
}
