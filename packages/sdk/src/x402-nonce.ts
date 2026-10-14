/**
 * The EIP-3009 nonce derived from a Haven payment id (#3888).
 *
 * ## Why the nonce is not random anymore
 *
 * On the eip3009 bridge the merchant's settlement is a second transaction
 * Haven never submits, and before #3888 the EIP-3009 nonce it redeems was
 * drawn randomly inside the x402 library — so when the agent never reported
 * the settlement, nothing could attribute it: the chain names only
 * `(authorizer, nonce)`, and Haven did not know the nonce. Deriving the
 * nonce from the payment id makes the settlement attributable BY THE PAYMENT
 * ITSELF: the backend re-derives the same nonce from the intent row and
 * finds the pinned token's `AuthorizationUsed(delegate, nonce)` log, the
 * same one-argument-keyed lookup the erc7710 sweeper gets from the
 * delegation hash.
 *
 * The derivation is a PURE function of `payment_id` and this fixed tag —
 * nothing else may enter it. `payment_id` is already inside the Haven-signed
 * binding the signer verifies, so the signer gains no new input from Haven
 * (#3888 threat model). It is exported from the edge surface because all
 * three parties — the signer, the SDK header builder and the backend — must
 * derive the SAME value from the SAME id.
 *
 * ## Encoding (pinned by test vector)
 *
 * `keccak256(utf8(tag) || utf8(payment_id))`, i.e. the UTF-8 bytes of
 * {@link X402_PAYMENT_NONCE_TAG} followed immediately by the UTF-8 bytes of
 * the payment id — no separator byte, no length prefix. The tag ends with
 * `:` so a tag/id boundary can never be confused across two ids whose
 * concatenations coincide (`"a:b" + "c"` vs `"a" + ":bc"`). `x402`'s own
 * nonce shape is `0x` + 64 hex (32 bytes), which `keccak256` returns
 * directly; the signer's typed data stays the library's own because the
 * nonce is only OVERWRITTEN on the unsigned payload
 * `preparePaymentHeader` produced, never hand-built.
 *
 * ## What a fixed nonce closes, and what it costs
 *
 * Closed: the #3475 re-pay hazard for new signers — a re-signed retry of a
 * settled payment carries the SAME nonce, so the merchant's facilitator
 * refuses it as already used; a settled payment can no longer settle twice.
 * Cost (accepted on #3888): payments become publicly linkable to Haven
 * through the nonce — the delegate EOA's funding legs already are — and a
 * party controlling `payment_id` can force a nonce collision with an
 * earlier authorization from the same delegate EOA, which makes EIP-3009
 * refuse the later settlement on-chain. That denies that ONE payment (its
 * funding stays sweepable in the delegate EOA); it is not a double spend.
 */
import { concatHex, keccak256, toHex } from 'viem'

/** The fixed domain tag. Changing it orphans every settlement not yet detected. */
export const X402_PAYMENT_NONCE_TAG = 'haven-x402-payment-nonce:'

/**
 * Derive the EIP-3009 nonce for a Haven payment id. Same input, same output,
 * on every surface that imports this — the signer, the SDK and the backend.
 */
export function deriveX402PaymentNonce(paymentId: string): `0x${string}` {
  return keccak256(concatHex([toHex(X402_PAYMENT_NONCE_TAG), toHex(paymentId)]))
}
