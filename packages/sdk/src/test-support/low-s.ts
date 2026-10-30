/**
 * Canonical (low-s) ECDSA signature assertions for the EIP-3009 bridge (#4550).
 *
 * x402 facilitators reject a non-canonical (high-s) 65-byte EOA signature in
 * `exact` EIP-3009 verify, before settlement (x402-foundation/x402#2728,
 * aligned across SDKs in x402-foundation/x402#3964; wire reason
 * `invalid_exact_evm_non_canonical_signature`). Haven's bridge complies today
 * only because viem's `privateKeyToAccount().sign()` passes `lowS: true` to
 * noble secp256k1 — nothing in Haven checks it. Swapping the signing account
 * (a KMS signer, a hardware key, a different library) could ship high-s
 * headers that every facilitator rejects.
 *
 * The malleable twin `(r, n - s, v ^ 1)` recovers to the SAME address, so a
 * recovery-only test cannot catch it. These helpers assert the wire bytes.
 *
 * Test fixtures only: nothing the SDK or signer runs imports this entry.
 */

/** secp256k1 group order divided by two — the canonical low-s ceiling. */
export const SECP256K1_HALF_N =
  0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n

export interface EcdsaSignatureParts {
  /** 32-byte `r`, big-endian. */
  r: bigint
  /** 32-byte `s`, big-endian. */
  s: bigint
  /** Recovery id as it appears on the wire: 27 or 28. */
  v: number
  /** Total signature length in bytes (65 for an EOA signature). */
  length: number
}

/**
 * Split a 65-byte `0x`-prefixed EOA signature into r/s/v.
 *
 * Throws on anything that is not exactly 65 bytes: a compact (64-byte) or
 * EIP-2098 signature is a different wire shape, and a low-s assertion that
 * silently accepted it would not be pinning the bytes the facilitator reads.
 */
export function parseEcdsaSignature(signature: string): EcdsaSignatureParts {
  if (!/^0x[0-9a-fA-F]*$/.test(signature)) {
    throw new Error(`signature is not 0x-prefixed hex: ${signature.slice(0, 20)}…`)
  }
  const hex = signature.slice(2)
  if (hex.length % 2 !== 0) {
    throw new Error(`signature has an odd number of hex digits (${hex.length})`)
  }
  const length = hex.length / 2
  if (length !== 65) {
    throw new Error(`signature must be 65 bytes, got ${length}`)
  }
  return {
    r: BigInt(`0x${hex.slice(0, 64)}`),
    s: BigInt(`0x${hex.slice(64, 128)}`),
    v: Number.parseInt(hex.slice(128, 130), 16),
    length,
  }
}

/**
 * Assert a wire signature is canonical low-s: 65 bytes, `v ∈ {27, 28}`,
 * `s ≤ n/2`. Throws with the offending value so a prove-red run names the
 * exact branch that regressed.
 */
export function assertLowSSignature(signature: string): EcdsaSignatureParts {
  const parts = parseEcdsaSignature(signature)
  if (parts.v !== 27 && parts.v !== 28) {
    throw new Error(`signature v must be 27 or 28, got ${parts.v}`)
  }
  if (parts.s > SECP256K1_HALF_N) {
    throw new Error(
      `signature is high-s (malleable): s=0x${parts.s.toString(16)} exceeds ` +
        `n/2=0x${SECP256K1_HALF_N.toString(16)}`,
    )
  }
  return parts
}
