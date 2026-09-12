/**
 * #2908 (naming epic #2906, phase 1): the account-vocabulary reads and the
 * dual-name emissions every published package shares during the one-release
 * compatibility window.
 *
 * The rule, stated once: READ both names and prefer the new; EMIT both names
 * with the same value; WRITE only the new. The old names on server responses
 * are removed by #2914, one release after the one that carries this module.
 * The credential-FILE fallbacks (`safe_address` / `safeAddress` in a file on
 * disk) are NOT part of that window — they are permanent, because a file that
 * was written before this release never rewrites itself.
 *
 * Kept as tiny pure functions so a reader has exactly one fallback chain per
 * shape and a test can mutate it: dropping the new name fails the new-shape
 * test, dropping the old name fails the old-shape test.
 */

/**
 * The account address off a snake_case server shape, new name first.
 *
 * `account_address` is the P0 (#2907) twin the server emits beside
 * `safe_address`; an older server emits only `safe_address`. A missing pair
 * resolves to `undefined` rather than an empty string so callers can tell
 * "absent" from "blank".
 */
export function readAccountAddress(raw: {
  account_address?: string | null
  safe_address?: string | null
}): string | undefined {
  return raw.account_address ?? raw.safe_address ?? undefined
}

/**
 * The account id off a snake_case server shape, new name first
 * (`account_id`, the #2907 twin of `safe_id`).
 */
export function readAccountId(raw: {
  account_id?: string | null
  safe_id?: string | null
}): string | undefined {
  return raw.account_id ?? raw.safe_id ?? undefined
}

/**
 * Both camelCase names for one address, for the SDK's public shapes (and the
 * hosted MCP outputs that spread them). Same value under both keys; the
 * `safeAddress` key is the deprecated one and goes at #2914.
 */
export function accountAddressTwins(
  address: string | undefined,
): { accountAddress: string; safeAddress: string } {
  // A server that sends NEITHER name is off-contract (both `safe_address`
  // and `account_address` are required on the wire); the field is then
  // `undefined` at runtime — exactly what the pre-#2908 `safeAddress:
  // raw.safe_address` read produced — and never a fabricated `''`, which
  // would read as a present-but-blank address downstream (the hosted MCP
  // outputs spread this object; the sweep uses it as a destination). The
  // declared type stays `string` because that is the contract; the cast is
  // the one place the off-contract case is allowed through unchanged.
  return { accountAddress: address, safeAddress: address } as { accountAddress: string; safeAddress: string }
}

/**
 * The x402 receipt's `payer` off a funding-authorization response, in the
 * order the issue pins (#2908): the explicit `payer`, then the top-level
 * account address (new name, then old), then the `sign_data.components`
 * twins — `payer_account` (the #2907 twin) before `safe`.
 *
 * `components.account` is deliberately NOT in this chain: on the funding
 * shapes it holds the DELEGATE account address, a different address, and
 * reading it here would silently corrupt the receipt's payer.
 */
export function readX402ReceiptPayer(raw: {
  payer?: string
  account_address?: string
  safe_address?: string
  sign_data?: { components?: { payer_account?: string; safe?: string; account?: string } }
}): string | undefined {
  return (
    raw.payer ??
    raw.account_address ??
    raw.sign_data?.components?.payer_account ??
    raw.safe_address ??
    raw.sign_data?.components?.safe
  )
}
