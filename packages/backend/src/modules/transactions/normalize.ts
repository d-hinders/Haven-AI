/**
 * Value normalisation at the transaction-row boundaries (#3129).
 *
 * ## Addresses
 *
 * `toCanonicalAddress` is re-exported from this module's `index.ts` because
 * `routes/agent-activity.ts` needs it too: it renders the SAME payment on
 * `/agents/[agentId]`. Normalising only the row producers made one payment
 * read `0xabcd…1234` on one screen and `0xAbCd…1234` on another — the defect
 * moved rather than closing. (It cannot live in `domain/`, which the
 * `domain-stays-pure` rule keeps free of `ethers`.)
 *
 * The two row-producing boundaries — `aggregate.ts` (explorer data) and
 * `x402.ts` (payment-intent rows) — copied addresses through exactly as their
 * source gave them, and the sources disagree:
 *
 * - Blockscout (`blockscout-v2` — **Base and Base Sepolia**, so the primary
 *   chain) returns EIP-55 **checksummed** addresses in `from.hash` /
 *   `to.hash` / `token.address_hash`.
 * - Etherscan (`etherscan-v2` — **Gnosis**) returns them **lowercase**.
 *
 * That mapping is the one to check first when reading this: `chains.ts` puts
 * Base on Blockscout (the v1 `tokentx` action times out with HTTP 524 there)
 * and Gnosis on Etherscan, which is the opposite of what the provider names
 * suggest.
 * - `payment_intents` stores a mix: `account_address` and `token_address`
 *   checksummed, `to_address` and `x402_merchant_address` lowercase.
 *
 * So one row could carry both forms at once — observed live on 2026-09-18,
 * `from` and `tokenAddress` checksummed beside `to` and `x402MerchantAddress`
 * lowercase — and the same field could differ by CHAIN, because the provider
 * differs. Any consumer comparing two of these with `===`, which is the
 * obvious thing to do and what a naive agent does, gets a false negative on a
 * payment record: "did this go to the merchant I expected" is exactly that
 * comparison.
 *
 * Checksummed is the target form. `packages/core`'s `address.ts` is a FORMAT
 * check only and says so — "for canonical checksumming use
 * `ethers.getAddress`" — so this wraps that rather than adding a second
 * opinion, and stays in the backend because `ethers` does not belong in core.
 */
import { ethers } from 'ethers'

/**
 * `value` as an EIP-55 checksummed address, or unchanged when it is not one.
 *
 * Deliberately total, never throwing, because two non-address values reach
 * these fields legitimately and a throw here would take down a history read:
 *
 * - `''` — the spec documents `from`/`to` as "the empty string when the
 *   explorer reported none", and `explorer-api.ts` emits exactly that for a
 *   null counterparty (`tx.from?.hash ?? ''`).
 * - `null` / `undefined` — `x402MerchantAddress` is nullable on the wire.
 *
 * Anything else that is not a well-formed address is returned as-is rather
 * than coerced: this function's job is to settle CASING, not to validate, and
 * silently rewriting an unexpected value would hide the real defect.
 */
export function toCanonicalAddress<T extends string | null | undefined>(value: T): T {
  if (typeof value !== 'string' || value === '') return value
  try {
    // `getAddress` rejects a mixed-case string whose checksum is wrong, which
    // is a genuinely corrupt address rather than a casing difference — lower
    // first so a merely-miscased value canonicalises instead of throwing.
    return ethers.getAddress(value.toLowerCase()) as T
  } catch {
    return value
  }
}

/**
 * An explorer-supplied block number as an integer, or `null` when the string
 * does not parse (#3129).
 *
 * The same boundary sweep as `toCanonicalAddress`, on the other class the
 * issue names: `parseInt(tx.blockNumber, 10)` was unvalidated, so a row whose
 * `blockNumber` an Etherscan-shaped provider returned empty or malformed
 * produced `NaN` — which `JSON.stringify` writes as `null` on the wire while
 * the spec declared the field a required integer. The value is now `null`
 * deliberately rather than by accident, and that is the SAME `null` the
 * x402-synthesized row carries: one "no block recorded" value, not two.
 *
 * Blockscout cannot hit this (`V2Transaction.block_number` is non-optional and
 * is `String()`-ed at the boundary). This guards the Etherscan-shaped legs
 * (Gnosis), whose rows are passed through from the provider's JSON
 * unvalidated.
 */
export function toBlockNumber(value: string): number | null {
  return strictInteger(value)
}

/**
 * An explorer-supplied unix timestamp as a number, `0` when it does not parse.
 *
 * Third field of the same class, and the only one where the fallback is NOT
 * `null`: `timestamp` is a required non-nullable integer that
 * `compareTransactions` does arithmetic on, and `NaN` there makes the
 * comparator return `NaN` — an inconsistent comparator, whose sort result is
 * implementation-defined. `0` is what the sibling paths already chose for an
 * unparseable time (`isoToUnix` in `explorer-api.ts`, `parseIsoTimestamp` in
 * `ordering.ts`), so this makes the v1 legs agree with them rather than
 * introducing a fourth behaviour.
 */
export function toUnixSeconds(value: string): number {
  return strictInteger(value) ?? 0
}

/**
 * A decimal integer string as a number, or `null` when the string is not
 * WHOLLY one.
 *
 * `parseInt` is prefix-greedy: `parseInt('0x1f', 10)` is `0`, and so is
 * `parseInt('12abc', 10)`'s sibling case in reverse. A value that parses only
 * in part is an unknown value, and answering `0` for it is the exact defect
 * this issue exists to remove — a zero that means "missing" while reading as
 * block zero. Rejecting the whole string keeps "0" (a real block, and a real
 * epoch second) distinct from "could not read this".
 */
function strictInteger(value: string): number | null {
  if (!/^-?\d+$/.test(value.trim())) return null
  const parsed = Number(value.trim())
  return Number.isSafeInteger(parsed) ? parsed : null
}
