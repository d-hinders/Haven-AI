/**
 * Ethereum address validation — the single source of truth.
 *
 * Replaces ~9 copies of `isValidAddress` and ~6 inline copies of the 40-hex
 * regex that had drifted across routes and lib. This is a *format* check only
 * (40 hex chars), not EIP-55 checksum validation — for canonical checksumming
 * use `ethers.getAddress` (see `normaliseAddress` on the money-path routes).
 */

/** Canonical 40-hex Ethereum address pattern. No checksum validation. */
export const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

/** Type guard: `true` iff `value` is a string matching {@link ETH_ADDRESS_RE}. */
export function isAddress(value: unknown): value is string {
  return typeof value === 'string' && ETH_ADDRESS_RE.test(value)
}
