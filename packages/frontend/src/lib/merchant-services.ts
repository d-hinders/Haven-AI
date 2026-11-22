/**
 * The pure half of turning Sales on and off (#4904, epic #4885).
 *
 * The screen side of merchant services: the Settings → Business card, the
 * dialog with the network choice and the passkey prompt, the result state and
 * turning it off. The routes are #4895's (`GET`/`POST`/`DELETE
 * /merchant-services`); this module holds the decisions that do not need
 * React — the wire types, the refusal vocabulary the dialog branches on, and
 * the classification of a failed turn-on.
 *
 * ## Why the refusal codes live here, not in the dialog
 *
 * The dialog must never show a raw error code, and it must never read the
 * backend's sentence to decide what to say: the sentence is prose that can be
 * reworded, the code is the contract. `domain/merchant-services.ts` on the
 * backend is the source of the strings; this file is the frontend's copy of
 * the same vocabulary, and `classifyTurnOnError` maps each one to a `kind` the
 * dialog renders with its own words and its own next step.
 *
 * The six refusals the issue names are all here: no such account
 * (`SOURCE_ACCOUNT_NOT_FOUND`), no passkey on the existing account
 * (`SOURCE_HAS_NO_PASSKEY`), passkey not on that account (`KEY_NOT_ON_SOURCE`),
 * account limit reached (`ACCOUNT_CAP_REACHED`), unsupported network
 * (`UNSUPPORTED_NETWORK`), and merchant account already on another network
 * (`MERCHANT_ACCOUNT_ON_OTHER_NETWORK`). The rest are the codes the same route
 * can answer with, mapped so a future one is never rendered as a raw string.
 *
 * ## A repeat is not a refusal
 *
 * A double click, a retry or a second tab answers 200 with `created: false`
 * and the existing account — the backend derives its idempotency key in the
 * `merchant-service:` namespace and locks the setting row, so a second account
 * cannot be created. The dialog therefore shows the RESULT state for a repeat,
 * never an error: `created` is the only thing that differs, and it is not
 * something the user needs to read.
 */

import type { ApiOperations } from '@haven_ai/core'

/** The wire shape of `GET`/`POST`/`DELETE /merchant-services` (#4895). */
export type MerchantServicesState =
  ApiOperations['getMerchantServices']['responses']['200']['content']['application/json']

/** The merchant account, when one exists. */
export type MerchantAccount = NonNullable<MerchantServicesState['merchant_account']>

/** The turn-on body: all three fields the first time, none once the account exists. */
export type TurnOnBody = NonNullable<
  ApiOperations['turnOnMerchantServices']['requestBody']
>['content']['application/json']

// ── The refusal vocabulary (#4895) ────────────────────────────────────────
// Kept as literals rather than imported from the backend: the frontend does
// not depend on `packages/backend`, and the spec carries these as prose, not
// an enum. `lib/new-account.ts` holds the create-additional codes the same way.

/** The caller already has a merchant account, on a different chain. */
export const MERCHANT_ACCOUNT_ON_OTHER_NETWORK = 'MERCHANT_ACCOUNT_ON_OTHER_NETWORK'
/** No merchant account yet and the request left out a field it needs. */
export const MERCHANT_SETUP_DETAILS_REQUIRED = 'MERCHANT_SETUP_DETAILS_REQUIRED'
/** The account address could not be derived (502). */
export const MERCHANT_ACCOUNT_ADDRESS_UNAVAILABLE = 'MERCHANT_ACCOUNT_ADDRESS_UNAVAILABLE'
/** The derived address is already registered, or the account under the key cannot be marked. */
export const MERCHANT_ACCOUNT_ALREADY_REGISTERED = 'MERCHANT_ACCOUNT_ALREADY_REGISTERED'
/** The network is not served by the delegation rail. */
export const UNSUPPORTED_NETWORK = 'UNSUPPORTED_NETWORK'
/** The named source account is not one the caller owns. */
export const SOURCE_ACCOUNT_NOT_FOUND = 'SOURCE_ACCOUNT_NOT_FOUND'
/** The source account has no passkey to copy. */
export const SOURCE_HAS_NO_PASSKEY = 'SOURCE_HAS_NO_PASSKEY'
/** The asserted passkey is not one of the source account's. */
export const KEY_NOT_ON_SOURCE = 'KEY_NOT_ON_SOURCE'
/** The per-user per-chain account cap is reached. */
export const ACCOUNT_CAP_REACHED = 'ACCOUNT_CAP_REACHED'
/** The derived idempotency key already belongs to an account made by another request. */
export const IDEMPOTENCY_KEY_REUSED = 'IDEMPOTENCY_KEY_REUSED'

/**
 * A turn-on refusal, in the dialog's own terms. Every kind carries what the
 * dialog needs to say what the user can do about it — never the raw code.
 */
export type TurnOnRefusal =
  /** The source account is gone from the caller's list (a stale read). */
  | { kind: 'source_not_found' }
  /** The source account no longer has a passkey. */
  | { kind: 'source_has_no_passkey' }
  /** The passkey the device asserted is not on the source account. */
  | { kind: 'key_not_on_source' }
  /** This browser cannot use a passkey at all. */
  | { kind: 'passkey_unsupported' }
  /** The passkey prompt failed for a reason that is not a cancellation. */
  | { kind: 'passkey_failed' }
  /** The per-user per-chain cap. `cap` when the body carries it. */
  | { kind: 'cap_reached'; cap: number | null }
  /** The chosen network is not served yet; `supported` when the body names them. */
  | { kind: 'unsupported_network'; supported: number[] }
  /** The merchant account already exists on another network; `chainId` when named. */
  | { kind: 'other_network'; chainId: number | null }
  /** The request was missing a field the first turn-on needs. */
  | { kind: 'setup_details_required'; missing: string[] }
  /** The account address could not be derived. */
  | { kind: 'address_unavailable' }
  /** The derived address is already registered. */
  | { kind: 'already_registered' }
  /** The money-path rate limit. */
  | { kind: 'rate_limited' }
  /** A code-less 4xx: a definite refusal. The backend's sentence, bounded, or null. */
  | { kind: 'could_not_turn_on'; detail: string | null }
  /** No answer, or a 5xx: the account may exist. A retry is safe (the route is idempotent). */
  | { kind: 'unknown_outcome' }

/** Long enough for every sentence the route sends today; short enough to stay a line. */
const MAX_DETAIL_CHARS = 200

function readBody(err: unknown): Record<string, unknown> {
  const body = (err as { body?: unknown } | null)?.body
  return body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {}
}

function readNumberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)) : []
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/**
 * Map a failed turn-on to the dialog's vocabulary, by `error_code` FIRST and
 * never by matching the backend's sentence. Without a code — an older backend
 * — the status decides, and the line that matters is whether the outcome is
 * KNOWN: a 4xx is a definite refusal of this request (the route rolls its
 * transaction back), while no status or a 5xx means the account may exist.
 * A retry is safe either way because the route is idempotent, so the dialog
 * offers one rather than locking the form.
 */
export function classifyTurnOnError(err: unknown): TurnOnRefusal {
  const body = readBody(err)
  const status = (err as { status?: unknown } | null)?.status
  const code = typeof body.error_code === 'string' ? body.error_code : null

  switch (code) {
    case SOURCE_ACCOUNT_NOT_FOUND:
      return { kind: 'source_not_found' }
    case SOURCE_HAS_NO_PASSKEY:
      return { kind: 'source_has_no_passkey' }
    case KEY_NOT_ON_SOURCE:
      return { kind: 'key_not_on_source' }
    case ACCOUNT_CAP_REACHED: {
      const cap = typeof body.cap === 'number' && Number.isFinite(body.cap) ? body.cap : null
      return { kind: 'cap_reached', cap }
    }
    case UNSUPPORTED_NETWORK:
      return { kind: 'unsupported_network', supported: readNumberArray(body.supported) }
    case MERCHANT_ACCOUNT_ON_OTHER_NETWORK: {
      const chainId = typeof body.chain_id === 'number' && Number.isFinite(body.chain_id) ? body.chain_id : null
      return { kind: 'other_network', chainId }
    }
    case MERCHANT_SETUP_DETAILS_REQUIRED:
      return { kind: 'setup_details_required', missing: readStringArray(body.missing) }
    case MERCHANT_ACCOUNT_ADDRESS_UNAVAILABLE:
      return { kind: 'address_unavailable' }
    case MERCHANT_ACCOUNT_ALREADY_REGISTERED:
      return { kind: 'already_registered' }
    case IDEMPOTENCY_KEY_REUSED:
      // The route derives its own key, so this can only mean the account under
      // that key is not the one this request would have created. The dialog
      // says the account exists and offers a re-read, not a retry.
      return { kind: 'already_registered' }
  }

  if (typeof status !== 'number' || status < 400 || status >= 500) return { kind: 'unknown_outcome' }
  if (status === 429) return { kind: 'rate_limited' }
  const sentence = typeof body.error === 'string' ? body.error.trim() : ''
  return { kind: 'could_not_turn_on', detail: sentence ? sentence.slice(0, MAX_DETAIL_CHARS) : null }
}

/**
 * The card's one-line state. `off` and `never_on` are different sentences: a
 * user who never turned Sales on has nothing kept, while a user who turned it
 * off has an account and its history — and the card must say so (owner
 * decision 5 on #4894).
 */
export type SalesCardState = 'loading' | 'error' | 'never_on' | 'on' | 'off'

export function salesCardState(
  status: 'loading' | 'ready' | 'error',
  state: MerchantServicesState | null,
): SalesCardState {
  if (status === 'loading') return 'loading'
  if (status === 'error' || state === null) return 'error'
  if (state.enabled) return 'on'
  return state.merchant_account === null ? 'never_on' : 'off'
}

// ── Stripe deposit addresses (#4954, epic #4886; dev and Stripe sandbox) ────
// The owner's registry (#4952's `/merchant-deposit-addresses` routes). A sale
// paid to an active registered address is stored as a Stripe-held sale: it
// counts in the Sales revenue figures, split as "in Stripe" (#4981), and never
// in the Sales account's balance. The address is the owner's
// word: Haven cannot check a Stripe-controlled address is theirs, so every
// registration is "registered by you, not verified by Haven". #5028: the
// registry is open only on a testnet Sales account, and the routes answer 403
// `DEPOSIT_ADDRESSES_TESTNET_ONLY` on any other chain.

/** One registration, active or retired. */
export type DepositAddress = ApiOperations['registerMerchantDepositAddress']['responses']['201']['content']['application/json']

/** The list read: every registration, newest first. */
export type DepositAddressList =
  ApiOperations['listMerchantDepositAddresses']['responses']['200']['content']['application/json']

/** Not a 0x-prefixed 20-byte hex address (400). */
export const INVALID_DEPOSIT_ADDRESS = 'INVALID_DEPOSIT_ADDRESS'
/** One of the owner's own accounts, or a current or past agent delegate (409). */
export const DEPOSIT_ADDRESS_IS_OWN = 'DEPOSIT_ADDRESS_IS_OWN'
/** Already active on a Sales account on this chain (409). */
export const DEPOSIT_ADDRESS_ALREADY_REGISTERED = 'DEPOSIT_ADDRESS_ALREADY_REGISTERED'
/** Already retired (409, retire only). */
export const DEPOSIT_ADDRESS_RETIRED = 'DEPOSIT_ADDRESS_RETIRED'
/** No such registration on the account (404, retire only). */
export const DEPOSIT_ADDRESS_NOT_FOUND = 'DEPOSIT_ADDRESS_NOT_FOUND'
/** Merchant services are off, or there is no merchant account (409). */
export const MERCHANT_ACCOUNT_REQUIRED = 'MERCHANT_ACCOUNT_REQUIRED'
/** The Sales account is not on a test network, so the registry is closed (403, #5028). */
export const DEPOSIT_ADDRESSES_TESTNET_ONLY = 'DEPOSIT_ADDRESSES_TESTNET_ONLY'

/** The shape the route checks, so an obvious typo is caught before a round trip. */
export function isDepositAddressShape(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim())
}

/** A refused registration or retirement, in the section's own terms — never the raw code. */
export type DepositAddressRefusal =
  | { kind: 'invalid' }
  | { kind: 'own_address' }
  | { kind: 'already_registered' }
  | { kind: 'already_retired' }
  | { kind: 'not_found' }
  | { kind: 'sales_off' }
  /** The Sales account is not on a test network: the registry is closed (#5028). */
  | { kind: 'testnet_only' }
  | { kind: 'rate_limited' }
  /** A code-less 4xx: the route's sentence, bounded, or null. */
  | { kind: 'refused'; detail: string | null }
  /** No answer, or a 5xx: the outcome is not known; the list is read again. */
  | { kind: 'unknown_outcome' }

/**
 * Map a failed register or retire to the section's vocabulary, by
 * `error_code` first and never by the route's sentence — the same rule as
 * `classifyTurnOnError`.
 */
export function classifyDepositAddressError(err: unknown): DepositAddressRefusal {
  const body = readBody(err)
  const status = (err as { status?: unknown } | null)?.status
  const code = typeof body.error_code === 'string' ? body.error_code : null

  switch (code) {
    case INVALID_DEPOSIT_ADDRESS:
      return { kind: 'invalid' }
    case DEPOSIT_ADDRESS_IS_OWN:
      return { kind: 'own_address' }
    case DEPOSIT_ADDRESS_ALREADY_REGISTERED:
      return { kind: 'already_registered' }
    case DEPOSIT_ADDRESS_RETIRED:
      return { kind: 'already_retired' }
    case DEPOSIT_ADDRESS_NOT_FOUND:
      return { kind: 'not_found' }
    case MERCHANT_ACCOUNT_REQUIRED:
      return { kind: 'sales_off' }
    case DEPOSIT_ADDRESSES_TESTNET_ONLY:
      return { kind: 'testnet_only' }
  }

  if (typeof status !== 'number' || status < 400 || status >= 500) return { kind: 'unknown_outcome' }
  if (status === 429) return { kind: 'rate_limited' }
  const sentence = typeof body.error === 'string' ? body.error.trim() : ''
  return { kind: 'refused', detail: sentence ? sentence.slice(0, MAX_DETAIL_CHARS) : null }
}
