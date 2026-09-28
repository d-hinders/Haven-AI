/**
 * Signature recovery for the payer's signed receipt drop (#3333, epic #3328).
 *
 * Chain-SDK use lives under `infra/chain/` by rule (`scripts/dep-lint.mjs`:
 * chain-sdk-not-in-routes). The drop is UNAUTHENTICATED-BUT-SIGNED: the payer
 * has no Haven account, so the payload's own EIP-191 signature IS the
 * authentication — the recovered address must be the payer the inbound
 * transfer names. Nothing here moves funds or grants authority; the recovered
 * address only pins which inbound row a receipt document may link to.
 */
import { verifyMessage } from 'ethers'

/**
 * Recover the signer of an EIP-191 personal signature over `message` and
 * return it lowercased ONLY when it equals `expectedAddress`
 * (case-insensitive). Returns null on any recovery failure or mismatch —
 * the caller cannot tell forged from malformed, and needs not: both are a
 * refused drop.
 */
export function recoverReceiptDropSigner(
  message: string,
  signature: string,
  expectedAddress: string,
): string | null {
  try {
    const recovered = verifyMessage(message, signature)
    return recovered.toLowerCase() === expectedAddress.toLowerCase() ? expectedAddress.toLowerCase() : null
  } catch {
    return null
  }
}
