/**
 * The authorization digest of docs/architecture/12-merchant-kit.md §6: the
 * SHA-256 of the SIGNED authorization as presented (from, to, value,
 * validAfter, validBefore, nonce and the signature), not of the whole payment
 * header. A header that carries the same signed authorization in a different
 * envelope (extra extensions, another key order, another base64 padding) has
 * the same digest; any change to a signed field or to the signature changes
 * it. The paywall proxy stores it with a payment and answers a known key only
 * to a request whose digest matches (#4893).
 */
import { createHash } from 'node:crypto'
import type { Eip3009Authorization } from './payment-checks.js'

/** Decimal form of an on-chain integer, so `"0x10"` and `"16"` agree; the raw text when it is not an integer. */
function canonicalInteger(value: string): string {
  try {
    return BigInt(value).toString()
  } catch {
    return value
  }
}

export function authorizationDigest(authorization: Eip3009Authorization, signature: string): string {
  const canonical = JSON.stringify([
    authorization.from.toLowerCase(),
    authorization.to.toLowerCase(),
    canonicalInteger(authorization.value),
    canonicalInteger(authorization.validAfter),
    canonicalInteger(authorization.validBefore),
    authorization.nonce.toLowerCase(),
    signature.toLowerCase(),
  ])
  return createHash('sha256').update(canonical).digest('hex')
}
