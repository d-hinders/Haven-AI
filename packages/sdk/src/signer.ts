import { ethers } from 'ethers'
import { HavenSigningError } from './types.js'

/**
 * Sign a hash using raw ECDSA (no Ethereum message prefix).
 *
 * This matches what Safe's AllowanceModule `checkSignature` expects —
 * a direct ecrecover over the hash, NOT the "\x19Ethereum Signed Message" variant.
 *
 * Uses ethers.SigningKey.sign() instead of wallet.signMessage() to avoid the prefix.
 */
export function signHash(privateKey: string, hash: string): string {
  try {
    const signingKey = new ethers.SigningKey(privateKey)
    const sig = signingKey.sign(hash)
    return sig.serialized // 0x + r(32) + s(32) + v(1)
  } catch (err) {
    throw new HavenSigningError(
      `Failed to sign hash: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * Sign a UserOperation hash for the session-key (Smart Sessions) rail.
 *
 * The deployed OwnableValidator recovers the signer over the **EIP-191**
 * personal-sign digest (`"\x19Ethereum Signed Message:\n32" + hash`), NOT the
 * raw hash. Signing the raw hash — as {@link signHash} does for the
 * AllowanceModule rail — returns SIG_VALIDATION_FAILED even when every session
 * policy passes (root-caused in #731). This function is intentionally separate
 * from `signHash` so the two rails cannot be confused: raw ECDSA is for
 * AllowanceModule, EIP-191 is for session keys.
 *
 * `wallet.signMessage(getBytes(hash))` produces the same EIP-191 signature the
 * pilot verified on-chain via viem's `signMessage({ message: { raw: hash } })`.
 */
export async function signUserOpHashForSession(
  privateKey: string,
  userOpHash: string,
): Promise<string> {
  try {
    const wallet = new ethers.Wallet(privateKey)
    return await wallet.signMessage(ethers.getBytes(userOpHash))
  } catch (err) {
    throw new HavenSigningError(
      `Failed to sign session UserOp hash: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * Derive the Ethereum address from a private key.
 */
export function addressFromKey(privateKey: string): string {
  try {
    return new ethers.Wallet(privateKey).address
  } catch (err) {
    throw new HavenSigningError(
      `Invalid private key: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * Verify that a signature over a hash recovers to the expected address.
 */
export function verifySignature(hash: string, signature: string, expectedAddress: string): boolean {
  try {
    const recovered = ethers.recoverAddress(hash, signature)
    return recovered.toLowerCase() === expectedAddress.toLowerCase()
  } catch {
    return false
  }
}
