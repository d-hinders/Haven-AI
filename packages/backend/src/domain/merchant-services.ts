/**
 * Merchant services — the wire vocabulary shared by the routes, the OpenAPI
 * spec and the dialog (#4895, epic #4885).
 *
 * Kept in `domain/` rather than in the route module because three consumers
 * need the same strings and a second copy of a refusal code is how a dialog
 * ends up branching on a value the server no longer sends: the route module
 * sends them, `openapi/spec.ts` builds the idempotency-key pattern from the
 * prefix, and `routes/user-accounts.ts` answers two of the codes from the
 * unlink and make-default refusals.
 */

/**
 * The refusal codes the merchant-services dialog branches on. The dialog maps
 * each one; it never reads the sentence.
 *
 * - `MERCHANT_ACCOUNT_ON_OTHER_NETWORK` — the user already has a merchant
 *   account, on a different chain. The network is permanent for the pilot, so
 *   this is a refusal, not a migration.
 * - `MERCHANT_SETUP_DETAILS_REQUIRED` — the user has no merchant account yet
 *   and the turn-on request left out the network, the source account or the
 *   passkey id. All three are required the FIRST time and none is needed once
 *   the merchant account exists; `missing` names the absent fields.
 * - `MERCHANT_ACCOUNT_ADDRESS_UNAVAILABLE` / `MERCHANT_ACCOUNT_ALREADY_REGISTERED`
 *   — the two create-additional refusals that carry no code of their own (the
 *   address could not be derived; the derived address is already registered).
 *   The turn-on route names them so the dialog never has to read a sentence.
 * - `MERCHANT_ACCOUNT_UNLINK_REFUSED` — unlinking the merchant account would
 *   delete the account row and its indexed payments with it.
 * - `MERCHANT_ACCOUNT_DEFAULT_REFUSED` — the merchant account cannot be the
 *   default account.
 */
export const MERCHANT_ACCOUNT_ON_OTHER_NETWORK = 'MERCHANT_ACCOUNT_ON_OTHER_NETWORK'
export const MERCHANT_SETUP_DETAILS_REQUIRED = 'MERCHANT_SETUP_DETAILS_REQUIRED'
export const MERCHANT_ACCOUNT_ADDRESS_UNAVAILABLE = 'MERCHANT_ACCOUNT_ADDRESS_UNAVAILABLE'
export const MERCHANT_ACCOUNT_ALREADY_REGISTERED = 'MERCHANT_ACCOUNT_ALREADY_REGISTERED'
export const MERCHANT_ACCOUNT_UNLINK_REFUSED = 'MERCHANT_ACCOUNT_UNLINK_REFUSED'
export const MERCHANT_ACCOUNT_DEFAULT_REFUSED = 'MERCHANT_ACCOUNT_DEFAULT_REFUSED'

/**
 * The name the server gives the account it creates: "Sales", the name the
 * dialog and the Sales page use for it. Set on the server so the dialog does
 * not have to send one; the owner can rename it afterwards through the
 * ordinary rename route.
 */
export const MERCHANT_ACCOUNT_NAME = 'Sales'

/**
 * The idempotency-key namespace this feature derives its keys in.
 *
 * `POST /accounts/hybrid` REFUSES any client-supplied key in this namespace,
 * so a user cannot pre-create an account under the key the turn-on route will
 * derive and have the merchant marker land on it. Without that refusal the
 * marker would attach to an account the user chose, which is exactly what the
 * route's "the request names no account to mark" rule forbids.
 *
 * It is refused twice: by the spec's `pattern` on `idempotency_key`, built
 * from this constant, and by the handler itself
 * (`isReservedMerchantIdempotencyKey`). The handler check is the one that
 * holds when request validation is switched to `shadow` or `off`
 * (`HAVEN_REQUEST_VALIDATION`), where the schema refuses nothing.
 */
export const MERCHANT_IDEMPOTENCY_KEY_PREFIX = 'merchant-service:'

/** The code `POST /accounts/hybrid` answers a client key in that namespace with. */
export const RESERVED_IDEMPOTENCY_KEY = 'RESERVED_IDEMPOTENCY_KEY'

/** True for a client-supplied idempotency key in the reserved namespace. */
export function isReservedMerchantIdempotencyKey(key: string): boolean {
  return key.startsWith(MERCHANT_IDEMPOTENCY_KEY_PREFIX)
}

/**
 * The key the turn-on route derives: one per user per chain.
 *
 * Stable across retries and across a second tab, which is what makes the
 * create-additional idempotency contract do the work — a retry answers the
 * FIRST account instead of minting a second. The chain is in the key because
 * the account is created on a chain; the "already on another network" refusal
 * runs BEFORE the creation logic, so a different chain never reaches this key.
 */
export function merchantIdempotencyKey(chainId: number): string {
  return `${MERCHANT_IDEMPOTENCY_KEY_PREFIX}${chainId}`
}
