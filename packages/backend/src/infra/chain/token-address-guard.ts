/**
 * The zero address, spelled once (#1149).
 *
 * Lives beside the two `ChainClient` implementations rather than in either,
 * so neither has to import the other to share the check.
 */
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/**
 * Shared guard for the two implementations (#1149): `getTokenBalance` is an
 * ERC-20 read, and the registry marks native with `address: null`. A
 * null/empty/zero token address means the caller skipped the native branch —
 * fail loudly and identically on both rails rather than inventing an answer.
 */
export function assertErc20TokenAddress(tokenAddress: string): void {
  if (!tokenAddress || tokenAddress.toLowerCase() === ZERO_ADDRESS) {
    throw new Error(
      'getTokenBalance requires an ERC-20 contract address; the chain-native ' +
        'currency is getNativeBalance (the token registry marks native as address: null)',
    )
  }
}
