/**
 * #2914 (naming epic #2906, phase 5 — the CONTRACTION): the compatibility
 * window #2908 opened (read both server-response names, prefer the new;
 * emit both camelCase names; write only the new) closed with the
 * `0.2.0-alpha.0` release reaching `main` on 2026-09-14 and a further
 * promotion on 2026-09-16. The account-vocabulary name is now the ONLY name
 * on every wire shape this module touches; `safe_address` / `safe_id` /
 * `sign_data.components.safe` are no longer read from a server response.
 *
 * `readAccountAddress` and `readAccountId` collapsed to a single field read
 * once the fallback was removed, so they are gone — read `raw.account_address`
 * / `raw.account_id` directly. `accountAddressTwins` is gone too: the SDK's
 * public shapes carry `accountAddress` only, never a `safeAddress` twin.
 *
 * `readX402ReceiptPayer` survives because it still has a real multi-step
 * chain (`payer`, then the top-level account address, then the nested
 * `sign_data.components` twin) once the old names are dropped from it.
 */

/**
 * The x402 receipt's `payer` off a funding-authorization response: the
 * explicit `payer`, then the top-level `account_address`, then
 * `sign_data.components.payer_account`.
 *
 * `components.account` is deliberately NOT in this chain: on the funding
 * shapes it holds the DELEGATE account address, a different address, and
 * reading it here would silently corrupt the receipt's payer.
 */
export function readX402ReceiptPayer(raw: {
  payer?: string
  account_address?: string
  sign_data?: { components?: { payer_account?: string; account?: string } }
}): string | undefined {
  return raw.payer ?? raw.account_address ?? raw.sign_data?.components?.payer_account
}
