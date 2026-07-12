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
 * Sign a delegation-rail payment (#829).
 *
 * The delegate SMART ACCOUNT validates an EIP-712 signature over the packed
 * UserOperation — signing the bare 4337 hash would be rejected on-chain. The
 * backend sends the exact typed data in `sign_data.typed_data`; we sign it
 * verbatim and never reconstruct it (a second source of truth could drift
 * from the account's own rules).
 */
export async function signUserOpTypedDataForDelegation(
  privateKey: string,
  typedData: {
    domain: Record<string, unknown>
    types: Record<string, unknown>
    primaryType: string
    message: Record<string, unknown>
  },
): Promise<string> {
  try {
    const wallet = new ethers.Wallet(privateKey)
    // ethers derives EIP712Domain itself and rejects it in `types`.
    const types = { ...typedData.types }
    delete (types as Record<string, unknown>).EIP712Domain
    return await wallet.signTypedData(
      typedData.domain as never,
      types as never,
      typedData.message as never,
    )
  } catch (err) {
    throw new HavenSigningError(
      `Failed to sign delegation UserOperation: ${err instanceof Error ? err.message : String(err)}`,
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
