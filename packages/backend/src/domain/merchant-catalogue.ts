/**
 * Refusal codes for the merchant catalogue's routes (#4899, epic #4885).
 *
 * Codes rather than sentences, because the owner's screens (#4900) branch on
 * them: a refused address is a field to fix, a missing address is a step to
 * take, and a mismatch is a deployment to check. The sentences travel beside
 * the code for the human reading the answer.
 */

/**
 * The address the owner saved is not one Haven reads: not https, an IP literal,
 * a locally-bound name, a non-default port, embedded credentials, or a redirect
 * that leaves the host. The guard's own `reason` travels with the refusal so the
 * screen can say which.
 */
export const MERCHANT_CATALOGUE_URL_REFUSED = 'MERCHANT_CATALOGUE_URL_REFUSED'

/** A refresh was asked for before the owner saved a deployment address. */
export const MERCHANT_CATALOGUE_NOT_CONFIGURED = 'MERCHANT_CATALOGUE_NOT_CONFIGURED'
