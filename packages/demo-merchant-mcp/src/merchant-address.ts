import { getAddress, isAddress, type Address } from 'viem'

/**
 * #5070: `MERCHANT_ADDRESS` is the default receiving address — the 402's
 * `payTo` for every product that does not name its own — so a value that is not
 * an address starts a merchant that advertises and cannot be paid. Startup
 * refuses it, naming the variable.
 *
 * Case: an all-lowercase address is accepted and normalised to its
 * checksummed form (every comparison downstream is case-insensitive, and a
 * deployment configured that way must keep starting). Any other casing must be
 * the correct EIP-55 checksum (viem's strict `isAddress`): a wrong checksum
 * means a mistyped address, and the refusal suggests nothing, since the
 * intended address cannot be known.
 */
export function resolveMerchantAddress(
  raw: string | undefined,
): { ok: true; address: Address } | { ok: false; message: string } {
  const value = raw?.trim()
  if (!value) {
    return {
      ok: false,
      message:
        'MERCHANT_ADDRESS env var is required.\n' + 'Set it to the Base wallet address that will receive USDC payments.',
    }
  }
  if (!isAddress(value)) {
    return {
      ok: false,
      message:
        'MERCHANT_ADDRESS is not a valid EVM address (0x followed by 40 hex characters, all lowercase or with a correct EIP-55 checksum).\n' +
        'It is the address every product without its own receiving address is paid to, so the merchant refuses to start.',
    }
  }
  return { ok: true, address: getAddress(value) }
}
